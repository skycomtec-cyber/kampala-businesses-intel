# Kampala Businesses Intelligence Platform

A reference directory of businesses in Kampala and the districts around it, plus the demand
engine that shows where the gaps are.

The platform answers two questions that a phone-based directory usually cannot:

- **Who is there?** A curated, verified set of businesses with their services, products, skills
  and coverage, down to ward level, with private contact details kept private.
- **What is missing?** Every search someone makes becomes an anonymised demand signal. Where
  enough people search for the same thing and nobody lists it, that is a gap, and the gap engine
  ranks it.

Both are served by one Node service over SQLite. There is no external service, no API key, and
nothing leaves the machine.

## What it does

- **Reference data, shipped and seeded.** 32 locations (country, region, district, sub-county,
  town, ward, parish) across Kampala, Wakiso, Mukono and the surrounding districts, 90 categories
  and 65 skills, all idempotently importable with one command.
- **No invented businesses.** The directory starts empty. Business content is never seeded, because
  a directory that fills itself with plausible-looking entries is worse than an empty one: it looks
  like a reference and is not one.
- **Full-text search** over businesses, services and products (SQLite FTS5), with a
  name/phone/website matcher to stop duplicate listings.
- **A marketplace of requests.** Anyone can post what they are looking for without an account and
  gets back a reference plus a one-time access token to manage it. Providers browse open work.
- **A gap engine.** Daily rollups of search demand, scored gaps and opportunities with the inputs
  they were derived from stored alongside them, so a conclusion stays explainable after the data
  moves on.
- **Operator accounts with capabilities.** No public registration. Accounts are created by whoever
  has shell access, and every editorial action is written to an audit log with a before and after.

## The privacy contract

This is the part worth reading before deploying it anywhere public.

- **k-anonymity floor.** Any aggregate computed over fewer than `KIP_K_THRESHOLD` (default 5)
  distinct people is marked `suppressed` and its counts are withheld. Not rounded, not capped, not
  approximated. The engine knows the answer and tells the caller it is not publishable yet, so a
  small group cannot subtract its own search out of a total of three.
- **Daily pseudonyms.** A search is attributed to a bucket derived from a salt that rotates every
  day. The platform can count "how many people searched X in this district this week" and is
  structurally unable to follow one person from one day to the next.
- **Raw queries are quarantined.** The only table that can identify a person is
  `search_query_raw`, it is written separately from the aggregate, and it is deleted after
  `KIP_RAW_SEARCH_RETENTION_DAYS` (default 180). No route reads it.
- **Navigation is not demand.** "login", a pasted URL and a bare UUID are recorded as searches for
  the search index but never as demand, because counting them would poison every trend.
- **Contact details are private by default.** A phone number added to a listing is invisible to
  public routes until somebody marks it publishable.

## Requirements

- Node.js 20.11 or newer (Pinokio provides this)
- No database server, no GPU, no Python

## How to use it

### From Pinokio

1. **Install** from the menu. This installs dependencies, applies migrations, imports the
   reference data and runs the test suite so you know the install works.
2. **Create Admin Account** from the menu. There is no public sign-up; this prompts for an email
   and a password (typed characters are not echoed) and is the only way an account is created.
3. **Start** from the menu. Pinokio assigns a free port and opens the status page.

Menu items: `Start`, `Create Admin Account`, `Update`, `Reset`. Stopping the server is done from
the Pinokio terminal, as with any other script.

### From a shell

```bash
cd app
npm install
npm run bootstrap     # migrations + reference data + the first-admin instructions
npm start             # http://127.0.0.1:4310
```

Override anything through the environment:

```bash
KIP_PORT=5000 KIP_K_THRESHOLD=10 npm start
```

| Variable | Default | What it does |
| --- | --- | --- |
| `KIP_HOST` | `127.0.0.1` | Bind address. Keep it on loopback. |
| `KIP_PORT` | `4310` | Port to listen on. |
| `KIP_DATA_DIR` | `app/data` | Where the database and the session secret live. |
| `KIP_DB_FILE` | `<data dir>/kampala.db` | SQLite file. |
| `KIP_K_THRESHOLD` | `5` | Distinct actors required before an aggregate is published. |
| `KIP_RAW_SEARCH_RETENTION_DAYS` | `180` | How long raw query text survives. |
| `KIP_EVENT_RETENTION_DAYS` | `90` | How long search and interaction events survive. |
| `KIP_SESSION_SECRET` | generated | Session signing secret. Generated and persisted on first run if unset. |
| `KIP_SESSION_TTL_HOURS` | `12` | Session lifetime. |
| `KIP_TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. Only enable behind a proxy you control. |
| `KIP_LOG_LEVEL` | `info` | Pino log level. |
| `KIP_SEED_REFERENCE` | `true` | Import reference data on start. |

### Scheduled work

```bash
npm run maintenance                  # roll up the last 2 days, enforce retention
npm run maintenance -- --days 7      # the last 7 days
npm run maintenance -- --from 2026-01-01 --to 2026-01-31
npm run maintenance -- --no-rollup   # retention only
```

The insights routes only read the daily rollup, so without this the opportunity view stays empty.
`start.js` runs it before the port opens, because a launcher with no scheduler still needs the
rollup to happen.

## API

Base URL `http://127.0.0.1:4310`. Every response uses the same envelope:

```json
{ "data": {}, "meta": {} }
{ "error": { "code": "forbidden", "message": "...", "requestId": "req-12", "details": {} } }
```

`/healthz` sits outside the version prefix on purpose: a supervisor should not have to know which
API version is deployed to know whether the process is alive.

### Public

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness, database reachability, applied migrations. |
| `GET` | `/api/v1/meta` | Identity, configuration, privacy floor, counts. |
| `GET` | `/api/v1/locations` | Every level. `?kind=ward`, `?limit=`, `?offset=`. |
| `GET` | `/api/v1/locations/:id` | One location with its ancestry, subtree and rollup options. |
| `GET` | `/api/v1/locations/:id/descendants` | Everything below a location. |
| `GET` | `/api/v1/categories` | The category tree. `?includeCounts=true`. |
| `GET` | `/api/v1/categories/:id` | One node with its children and linked skills. |
| `GET` | `/api/v1/skills` | The skill vocabulary. `?q=` required; searches names and synonyms. |
| `GET` | `/api/v1/businesses` | The directory. `?locationId=`, `?categoryId=`, `?skillId=`, `?capabilityLevel=`, `?verificationState=`, `?status=`, `?search=`, `?sort=`. |
| `GET` | `/api/v1/businesses/:idOrSlug` | A public profile. Never includes private contact points. |
| `GET` | `/api/v1/businesses/match` | `?q=name` or `?phone=` to catch duplicates before adding a listing. |
| `GET` | `/api/v1/search` | `?q=` required. Records a demand signal; see the header `x-demand-signal`. |
| `GET` | `/api/v1/insights/opportunities` | Ranked gaps. `?includeSuppressed=true` to see withheld ones. |
| `GET` | `/api/v1/insights/opportunities/:id` | One gap with the snapshot it was derived from. |
| `GET` | `/api/v1/insights/signals` | Aggregated demand. `?from=` required. |
| `GET` | `/api/v1/insights/summary` | Demand totals for a window. `?from=` required. |
| `GET` | `/api/v1/requests` | Open requests, for providers to fulfil. |
| `GET` | `/api/v1/requests/:reference` | One request, its items, its offers, its status history. |
| `POST` | `/api/v1/requests` | Post a request. No account needed. |
| `POST` | `/api/v1/requests/:reference/withdraw` | With your access token, or as the signed-in requester. |
| `POST` | `/api/v1/auth/login` | Returns a bearer token and sets a session cookie. |
| `POST` | `/api/v1/auth/logout` | Ends the session. |
| `POST` | `/api/v1/auth/change-password` | Requires the current password. |
| `POST` | `/api/v1/auth/password-reset` | Starts a reset. |
| `POST` | `/api/v1/auth/password-reset/confirm` | Completes one. |
| `GET` | `/api/v1/auth/me` | The signed-in operator. |
| `GET` | `/api/v1/auth/roles` | Roles and their capabilities. |
| `GET` | `/api/v1/counts` | Supply counts for `?categoryId=` and/or `?locationId=`, optionally `?includeSubtree=true`. |

### Operator (capability required)

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/api/v1/admin/businesses` | `business:read` (includes private contact points) |
| `GET` | `/api/v1/admin/businesses/:id` | `business:read` |
| `POST` | `/api/v1/admin/businesses` | `business:write` |
| `PATCH` | `/api/v1/admin/businesses/:id` | `business:write` |
| `POST` | `/api/v1/admin/businesses/:id/verification` | `business:verify` |
| `POST` | `/api/v1/admin/businesses/:id/status` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/services[/:serviceId]` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/products[/:productId]` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/contacts[/:contactId]` | `business:write` |
| `POST`/`DELETE` | `/api/v1/admin/businesses/:id/skills[/:skillId]` | `business:write` |

Roles, from `GET /api/v1/auth/roles`:

| Role | Capabilities |
| --- | --- |
| `admin` | Everything, including users, imports, opportunities and the lab. |
| `editor` | Read, write and verify businesses; read requests and analytics; import. |
| `analyst` | Read-only: businesses, requests, analytics, lab, opportunities. |
| `viewer` | Read-only businesses and analytics. |

A missing session is `401 unauthenticated`. A session without the capability is `403 forbidden`, so
a client can always tell "sign in" from "you may not".

### Rate limits

Fixed windows, in process memory, keyed by account when signed in and by address when not.

| Scope | Limit |
| --- | --- |
| Sign-in and password reset | 10 per 15 minutes |
| `POST /requests`, withdraw | 5 per minute |
| `GET /search` | 30 per minute |
| Everything else | 240 per minute |

A refused request answers `429 rate_limited` with `retry-after`, `x-ratelimit-limit`,
`x-ratelimit-remaining` and `x-ratelimit-reset`.

## Using it from code

### curl

```bash
BASE=http://127.0.0.1:4310

# Is it alive?
curl -s $BASE/healthz

# What does it hold?
curl -s $BASE/api/v1/meta

# Every division in the reference set
curl -s "$BASE/api/v1/locations?kind=division&limit=5"

# Sign in once and reuse the token
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | jq -r .data.token)

# Who lists what in one place, as an operator (this is the only view that
# includes unpublished contact points). A business needs a leaf category, and
# the tree is not a fixed depth, so walk it rather than counting on children.
LOCATION=$(curl -s "$BASE/api/v1/locations?kind=district" | jq -r '.data[0].id')
CATEGORY=$(curl -s "$BASE/api/v1/categories" | jq -r '[recurse(.children[]?) | select(.children | length == 0)][0].id')

curl -s -H "authorization: Bearer $TOKEN" \
  "$BASE/api/v1/admin/businesses?locationId=$LOCATION&categoryId=$CATEGORY"

# What is missing there, including the gaps too small to publish
curl -s "$BASE/api/v1/insights/opportunities?locationId=$LOCATION&includeSuppressed=true"

# Post a request without an account, keep the token
curl -s -X POST $BASE/api/v1/requests \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Borehole pump needed for a school\",\"categoryId\":\"$CATEGORY\",\"locationId\":\"$LOCATION\"}"
```

### JavaScript

```js
const BASE = 'http://127.0.0.1:4310'

// Envelope-aware fetch: errors come back as `{ error }` with a real status, so
// every call site checks the same way.
async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json()
  if (!response.ok) throw Object.assign(new Error(payload.error?.message), { code: payload.error?.code })
  return payload
}

const { data: meta } = await api('/api/v1/meta')
console.log(meta.counts.locations, meta.privacy.kThreshold)

// Search records a demand signal, so this call has a side effect worth knowing
// about. The response header says whether it counted.
const search = await fetch(`${BASE}/api/v1/search?q=wheel+alignment`)
console.log(search.headers.get('x-demand-signal')) // 'recorded' or 'ignored'

// Every gap, including the ones too small to publish. A client is expected to
// skip the suppressed ones rather than render a broken chart.
const { data: gaps } = await api('/api/v1/insights/opportunities?includeSuppressed=true')
const publishable = gaps.filter((gap) => !gap.suppressed)
for (const gap of publishable) {
  console.log(gap.score, gap.keyword, gap.locationName, gap.severity, gap.rationale)
}
```

### Python

```python
import requests

BASE = "http://127.0.0.1:4310"
session = requests.Session()

health = session.get(f"{BASE}/healthz").json()["data"]
assert health["status"] == "ok"

# Sign in once and keep the session cookie. The response also carries a bearer
# token, which is what the operator routes want.
login = session.post(f"{BASE}/api/v1/auth/login", json={
    "email": "you@example.com",
    "password": "your-password",
}).json()["data"]
token = login["token"]

r = session.get(f"{BASE}/api/v1/search", params={"q": "phone screen replacement"})
print("demand signal:", r.headers.get("x-demand-signal"))

gaps = session.get(f"{BASE}/api/v1/insights/opportunities", params={
    "includeSuppressed": "true",
}).json()["data"]

publishable = [gap for gap in gaps if not gap["suppressed"]]
print(f"{len(publishable)} publishable gaps, {len(gaps) - len(publishable)} below the floor")

# An operator write.
created = session.post(f"{BASE}/api/v1/admin/businesses", json={
    "name": "Nsambya Mobile Fixers",
    "categoryId": CATEGORY_ID,
    "locationId": LOCATION_ID,
}, headers={"authorization": f"Bearer {token}"})
created.raise_for_status()
print(created.json()["data"]["slug"])
```

## Layout

```
.
├── app/                      the app, self-contained
│   ├── package.json
│   ├── src/
│   │   ├── config.js         every value resolvable from the environment
│   │   ├── core/             domain rules: auth, demand, privacy, identifiers, errors
│   │   ├── db/               driver, migrations, repositories
│   │   ├── seed/             idempotent reference import
│   │   ├── api/              plugins, routes, response envelope
│   │   └── server.js         the process
│   ├── scripts/              migrate, seed, bootstrap, maintenance, create-admin
│   ├── test/                 41 tests, no network, temporary folders only
│   └── web/index.html        the status page served at /
├── install.js                Pinokio: dependencies, migrations, reference data, tests
├── start.js                  Pinokio: maintenance, then the server
├── create-admin.js           Pinokio: the only way an account is created
├── update.js                 Pinokio: dependencies, migrations, maintenance, tests
├── reset.js                  Pinokio: removes node_modules and the database
├── pinokio.js                the menu
└── pinokio.json              metadata
```

`app/data/` holds the SQLite database and the generated session secret. Both are disposable: delete
the folder and run `npm run bootstrap` to get the same platform back with no listings.

## Tests

```bash
cd app
npm test
```

41 tests, no network access, each against its own temporary database. The API tests mount the real
Fastify app with `inject()`, so routes are exercised through the real router, schema validation,
session plugin and error mapping without binding a port. They cover the behaviours that are
decisions rather than plumbing: the response envelope, the k-anonymity floor, private contact
points, the capability table, the rate limiter, that every documented filter actually filters, that
every location level the data holds is filterable, and the rule that a bad sign-in cannot be used
to find out which addresses exist. The CLI tests run `create-admin` as a real child process, since
the interesting ways for it to fail — a launcher step that pipes nothing, a piped email with no
password — are all about how it reads stdin.
