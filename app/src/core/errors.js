/**
 * Domain errors.
 *
 * The api layer is the only place allowed to turn these into HTTP status codes.
 * Everything below the api layer throws and catches these types, which is what
 * keeps business rules free of transport concerns.
 */

export class DomainError extends Error {
  constructor(message, { code = 'domain_error', details = null, cause } = {}) {
    super(message, { cause })
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

/** Input failed a core-layer rule. Always the caller's fault. */
export class ValidationError extends DomainError {
  constructor(message, details = null) {
    super(message, { code: 'validation_failed', details })
  }
}

/** The caller is not authenticated. */
export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required.') {
    super(message, { code: 'unauthenticated' })
  }
}

/** The caller is authenticated but lacks the required role. */
export class ForbiddenError extends DomainError {
  constructor(message = 'Insufficient permissions.') {
    super(message, { code: 'forbidden' })
  }
}

/** The referenced record does not exist. */
export class NotFoundError extends DomainError {
  constructor(entity, id) {
    super(`${entity} not found.`, {
      code: 'not_found',
      details: { entity, id: id ?? null },
    })
  }
}

/** The record already exists (uniqueness constraint at the domain level). */
export class ConflictError extends DomainError {
  constructor(message, details = null) {
    super(message, { code: 'conflict', details })
  }
}

/**
 * Raised when a privacy rule blocks an action, for example serving an aggregate
 * that would expose fewer than k distinct actors. This is deliberately its own
 * type so it can never be swallowed by generic error handling and quietly
 * returned as unfiltered data.
 */
export class PrivacyThresholdError extends DomainError {
  constructor(suppressed, kThreshold) {
    super('Aggregate suppressed to protect privacy.', {
      code: 'privacy_threshold',
      details: { suppressed, kThreshold },
    })
  }
}
