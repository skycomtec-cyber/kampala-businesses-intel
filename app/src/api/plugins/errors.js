import fp from 'fastify-plugin'
import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  PrivacyThresholdError,
  UnauthenticatedError,
  ValidationError,
} from '../../core/errors.js'

/**
 * The one place domain errors become HTTP.
 *
 * Below this plugin everything throws typed domain errors that know nothing about
 * transport. Here they are mapped to status codes, and anything unrecognised is
 * logged in full but reported to the caller as a bare 500, so an internal message
 * (a file path, a SQL fragment) can never leak through an unexpected throw.
 */

const STATUS_BY_CODE = {
  validation_failed: 400,
  domain_error: 400,
  unauthenticated: 401,
  forbidden: 403,
  privacy_threshold: 403,
  not_found: 404,
  conflict: 409,
  request_invalid: 400,
  rate_limited: 429,
  unsupported_media_type: 415,
  payload_too_large: 413,
  internal_error: 500,
}

export class HttpError extends DomainError {
  constructor(status, code, message, details = null) {
    super(message, { code, details })
    this.status = status
  }
}

export function httpError(status, code, message, details = null) {
  return new HttpError(status, code, message, details)
}

/** Maps a domain error onto a status, defaulting to 400 for the unlisted ones. */
export function statusForDomainError(error) {
  if (error instanceof HttpError) return error.status
  return STATUS_BY_CODE[error?.code] ?? 400
}

/** The error body. Identical in shape on every failure, whatever caused it. */
function errorBody(error, requestId) {
  const status = statusForDomainError(error)
  const code = STATUS_BY_CODE[error?.code] ? error.code : 'internal_error'
  return {
    statusCode: status,
    payload: {
      error: {
        code,
        message: safeMessage(error, status),
        ...(error?.details ? { details: error.details } : {}),
        requestId,
      },
    },
  }
}

/**
 * Domain errors carry messages written for a human at a keyboard, so they are safe
 * to forward. Everything else is a bug, and a bug's message is not.
 */
function safeMessage(error, status) {
  const known =
    error instanceof DomainError ||
    error instanceof HttpError ||
    (error?.code && STATUS_BY_CODE[error.code] !== undefined)
  if (known) return error.message
  return 'The request could not be completed.'
}

async function errorPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = request.id
    const status = statusForDomainError(error)
    const body = errorBody(error, requestId)

    // 5xx is our fault and needs the stack; 4xx is the caller's and does not.
    if (status >= 500) {
      request.log.error({ err: error, requestId }, 'unhandled error')
    } else {
      request.log.info({ code: error.code, status, requestId }, 'request rejected')
    }

    // Fastify's own failures (schema validation, body limits, 404) are shaped
    // differently from ours, so translate rather than forward.
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'request_invalid',
          message: 'The request did not match the expected shape.',
          details: {
            issues: error.validation.map((issue) => ({
              path: issue.instancePath || issue.schemaPath,
              keyword: issue.keyword,
              message: issue.message,
            })),
          },
          requestId,
        },
      })
    }
    if (error.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'payload_too_large',
          message: 'The request body is too large.',
          requestId,
        },
      })
    }
    if (error.statusCode === 415) {
      return reply.status(415).send({
        error: {
          code: 'unsupported_media_type',
          message: 'Send this request as application/json.',
          requestId,
        },
      })
    }

    return reply.status(body.statusCode).send(body.payload)
  })

  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route matches ${request.method} ${request.url.split('?')[0]}.`,
        requestId: request.id,
      },
    })
  })
}

export { STATUS_BY_CODE, ForbiddenError, NotFoundError, PrivacyThresholdError, UnauthenticatedError, ValidationError }

export default fp(errorPlugin, { name: 'kip-errors' })
