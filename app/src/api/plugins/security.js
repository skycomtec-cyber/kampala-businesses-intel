import fp from 'fastify-plugin'

/**
 * Baseline response headers.
 *
 * The api returns JSON and nothing else, so the browser-hardening headers that
 * matter for a document (CSP, frame rules for a page you navigate to) are
 * mostly irrelevant here. What is left is worth setting anyway: this is a public
 * API over people's business listings, and it is very likely to be called from a
 * third-party page later.
 */

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
}

async function securityPlugin(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    for (const [header, value] of Object.entries(HEADERS)) {
      reply.header(header, value)
    }

    // Anything authenticated must not sit in a shared cache, and neither must
    // anything that changes state. Search results are the exception: they are
    // public, identical for everyone, and caching them is the difference between
    // a usable API and one that hammers SQLite.
    //
    // A route that has already decided gets to keep its decision. A marketplace
    // request read whose owner is proven by an access token is neither a session
    // nor a public document, and only the route knows that, so it sets its own
    // `no-store` and is not overruled here.
    if (!reply.hasHeader('cache-control')) {
      const cacheable = request.method === 'GET' && !request.authenticated
      reply.header(
        'cache-control',
        cacheable ? 'public, max-age=30' : 'no-store',
      )
    }
    reply.header('vary', 'cookie, authorization')

    // HSTS only once we know the caller is actually on TLS. Sending it over plain
    // http is ignored by browsers anyway, and sending it wrongly is worse than
    // not sending it.
    if (request.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains')
    }

    return payload
  })
}

export default fp(securityPlugin, { name: 'kip-security' })
