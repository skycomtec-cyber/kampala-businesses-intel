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
3. **Start** from the menu. Pinokio assigns a free port and opens the front page.

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

## Importing businesses

Indexing Kampala is a spreadsheet problem before it is a code problem. The importer takes a CSV and
gives you back a report of what it would create, what it recognised as already in the directory, and
what it could not make sense of, with the line number for every row it rejected.

```bash
npm run import -- businesses.csv --dry-run    # report only, writes nothing
npm run import -- businesses.csv              # import
npm run import -- businesses.csv --source field-survey-2026-09
cat businesses.csv | npm run import -- -      # read from stdin
```

The exit status is `1` when any row failed, so a scheduled import fails loudly rather than importing
the 96% of a sheet that happened to be valid. Importing the same file twice is safe: the second run
creates nothing.

### The columns

`name`, `category` and `location` are required. Everything else is optional and takes the
platform's own conservative default, so a three-column file still imports.

| Column | Notes |
| --- | --- |
| `name` | 2 to 160 characters. Becomes the slug, disambiguated if needed. |
| `category` | A path slug (`services/beauty-and-personal-care/barbering`), a name that is unique in the taxonomy, or an id. |
| `location` | A full path, a trailing part of one (`Kampala/Nakawa Division`), a name that is unique in the reference data, or an id. |
| `description`, `address` | Free text. |
| `latitude`, `longitude` | Decimal degrees. |
| `phone`, `whatsapp`, `email`, `website`, `facebook` | Contact points, normalised on the way in. A phone number typed as `0772 111 222` and as `+256772111222` is the same number. |
| `services`, `skills` | Separated by `,`, `;` or `\|`. A name that itself contains a comma has to use a semicolon or a pipe: splitting happens after the cell is read, so quoting does not protect it. |
| `founded_year` | 1800 to 2100. |
| `status`, `verification_state`, `capability_level` | Omit these and the listing arrives as a draft awaiting verification. Setting `status=active` does not make it public while it is unverified. |
| `source` | Recorded on the listing, so you can tell which sheet it came from. |

Header names are matched loosely: `Phone Number`, `phone_number` and `phoneNumber` are the same
column. A column the platform does not recognise is ignored rather than treated as an error. Quoted
fields, embedded commas and newlines, CRLF line endings and a UTF-8 byte order mark are all handled,
so a file saved by Excel reads correctly.

### What it will not do

**It does not invent anything.** A row whose category or location cannot be resolved is reported, not
placed somewhere plausible, and a row filed under a category that still has children is reported too.
This matters more than it sounds: the gap engine publishes conclusions about which markets are
underserved, and a listing quietly filed under the wrong division, or counted in two trades at once,
corrupts every number computed from it.

**It does not guess what kind of place a name is.** "Kireka" could be a subcounty, a ward or a shop.
Every count downstream is grouped by the kind, so the importer says the name and the parent it was
headed for and leaves the kind to a person. See [Fixing what a file gets wrong](#fixing-what-a-file-gets-wrong).

**It does not publish what it collects.** Imported contact points are recorded as private, because an
operator typing a number off a shopfront has not verified that the shop wants it published. A listing
becomes public when somebody makes that decision, not when a spreadsheet lands.

**It does not merge businesses on a similar name.** A row is treated as a duplicate when it matches an
existing listing on a contact point, or, if it has no contact details at all, on the same name in the
same location. Everything else is a separate business, because two real traders can share a name.

### Fixing what a file gets wrong

A survey of an area nobody has mapped fails on a handful of places, not four hundred different ones, so
the report groups them:

```json
"unresolved": [
  {
    "type": "location",
    "value": "Kampala/Nakawa Division/Kireka",
    "name": "Kireka",
    "parentId": "...",
    "parentPath": "Uganda / Central Region / Kampala District / Kampala / Nakawa Division",
    "lines": [2, 3]
  },
  {
    "type": "category_branch",
    "value": "services/beauty-and-personal-care",
    "parentId": "...",
    "children": "Barbering, Hairdressing, Nail And Spa",
    "lines": [4]
  }
]
```

`location` and `category` entries can be posted straight to the bulk reference routes once you have
supplied the `kind`, which is the one field the importer refused to decide:

```bash
curl -sS -X POST http://127.0.0.1:4310/api/v1/admin/reference/locations/bulk \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"locations":[{"name":"Kireka","kind":"subcounty","parentId":"..."}]}'
# {"counts":{"created":1,"skipped":0,"failed":0}, ...}
```

Then import the same file again: the rows that succeeded are reported as duplicates, so nothing is
written twice. The batch is per entry rather than all-or-nothing, because sending the same report twice
is the one failure this has to survive — an entry already present is a `skipped`, not an error, and an
entry the hierarchy refuses, such as a ward under a division, is a `failed` that does not stop the rest.

A `category_branch` is not something to create. The row named a branch rather than a trade, so it has to
be re-filed under one of the children, or the missing child added under the branch.

For a new machine, put the same entries in the seed data instead, so every install starts from the same
reference trees.

### Reporting

```json
{
  "summary": { "total": 412, "created": 388, "updated": 0, "skipped": 21, "failed": 3, "dryRun": true },
  "rows": [
    { "line": 2, "name": "Nakawa Hair Studio", "outcome": "created", "detail": "would create", "id": null },
    { "line": 17, "name": "Kololo Cycles", "outcome": "skipped", "detail": "phone matches \"Kololo Cycles\"", "id": "..." }
  ],
  "unresolved": []
}
```

A row that fails is contained: it is reported and the rest of the file is still imported. A row is
also atomic — a listing whose contact details turn out to be invalid is not left behind without them.
`unresolved` is always present, sorted and deduplicated, so re-running a file produces an identical
report and a reviewer can diff the two.

### Over HTTP

The same importer, behind the `import:write` capability. `dryRun` defaults to **true** here, so a
payload nobody has read cannot create a hundred listings by accident.

```bash
curl -sS -X POST http://127.0.0.1:4310/api/v1/admin/imports/businesses \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -Rn --rawfile csv businesses.csv '{csv: $csv}')"
```

`GET /api/v1/admin/imports/businesses/schema` returns the column contract as JSON, so a client does
not have to parse this page.

### Reviewing what a file imported

An import is the only thing here that creates listings in hundreds, and every one of them arrives
unverified and with its contact points private, because nobody has decided they are real. Reviewing
them one request at a time is the difference between finishing a survey and abandoning it.

The queue is one call, and each row carries the contact evidence the decision depends on:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:4310/api/v1/admin/businesses?verificationState=unverified&sort=newest&limit=25'
# data[].contacts[], data[].contactCount, data[].publicContactCount
```

Then the same decision for the page. The `reason` is required, and it is written to the audit log
against every listing, because "verified" with no stated basis is indistinguishable from "verified"
because somebody pressed a button:

```bash
curl -sS -X POST http://127.0.0.1:4310/api/v1/admin/businesses/verification \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ids":["..."],"verificationState":"verified","reason":"Walked Nakawa on 2026-09-25; every shop confirmed it."}'
# {"counts":{"updated":24,"unchanged":1,"missing":0},"rows":[{"id":"...","name":"...","outcome":"updated"}]}
```

Three things it will not do. It caps the batch at 100 ids, so one request cannot quietly decide the
whole directory. An id already in that state is reported as `unchanged` and not rewritten, so a retried
request does not churn the log. And it does not publish contact points: verifying a listing makes the
business visible, and the phone number somebody typed off a shopfront stays private until it is
published on its own.

The contact evidence on those rows is operator-only. `GET /api/v1/businesses` carries no `contacts`
field and no counts, so a caller cannot read a private number out of a listing page by accident.

### The same queue, in a browser

`http://127.0.0.1:4310/operator.html` is the queue as a page, so working through an import does not
mean pasting ids into curl. It is one static file with no build step and no dependencies, served from
the same origin as the api, and every page links to it from the topbar.

Sign in with an account from `create-admin` or the `create-admin.js` launcher. There is no sign-up,
deliberately: a public form that creates accounts would collect the very addresses this platform
exists not to collect. The page holds no token. The session is an HttpOnly cookie, so the browser
cannot hand it to a cross-site bug, and every page load asks `GET /api/v1/auth/me` who it is talking
to rather than trusting anything in local storage.

Each row carries what the decision turns on: the contact points as they were imported, marked
private or public, the category and the place resolved to the names a person would say, and nothing
that has already been decided. Tick the rows, choose `Verified`, `Rejected` or `Needs checking`, write
one reason, and the page sends the same batch endpoint the curl example above uses, up to 100 rows at a
time. The reason is required, for the same reason it is required in the api: an audit line that says
only "verified" is worth very little later.

### The pages, and what they share

Four static files, no build step, no framework, served from the same origin as the api and linked
from the same topbar, so any of them can be bookmarked or reloaded on its own:

| Page | What it is for |
| --- | --- |
| `/` | The front door: what the platform is, and the sequence a listing goes through to get published |
| `/directory.html` | Public search. Filters, then the results list, then a page for one listing |
| `/business.html?b=<slug>` | One listing: contacts marked public or private, services, skills, and the source it came from |
| `/operator.html` | The review queue, above |

Everything the four pages agree on lives in `app/web/theme.css` as tokens, so light and dark are two
readings of one set of rules rather than two stylesheets, and a page cannot drift from its neighbours.
`theme.js` only reads and writes the saved appearance; the choice is inlined into each page's `<head>`
so a dark-mode visitor never sees a white flash, and with JavaScript off the rest of each page still
works. The fonts are self-hosted (`fonts.css` and `fonts/`), so the app has no runtime CDN dependency.

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
| `POST` | `/api/v1/admin/businesses/verification` | `business:verify` (one decision applied to up to 100 listings; `reason` required) |
| `POST` | `/api/v1/admin/businesses/:id/status` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/services[/:serviceId]` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/products[/:productId]` | `business:write` |
| `POST`/`PATCH`/`DELETE` | `/api/v1/admin/businesses/:id/contacts[/:contactId]` | `business:write` |
| `POST`/`DELETE` | `/api/v1/admin/businesses/:id/skills[/:skillId]` | `business:write` |
| `GET` | `/api/v1/admin/imports/businesses/schema` | `import:read` |
| `POST` | `/api/v1/admin/imports/businesses` | `import:write` |
| `POST` | `/api/v1/admin/reference/locations` | `reference:write` |
| `POST` | `/api/v1/admin/reference/locations/bulk` | `reference:write` |
| `POST` | `/api/v1/admin/reference/categories` | `reference:write` |
| `POST` | `/api/v1/admin/reference/categories/bulk` | `reference:write` |
| `GET` | `/api/v1/admin/catalogue/sources` | `source:read` |
| `POST` | `/api/v1/admin/catalogue/sources` | `source:write` |
| `GET` | `/api/v1/admin/catalogue/sources/:id` | `source:read` |
| `PATCH` | `/api/v1/admin/catalogue/sources/:id` | `source:write` |
| `GET` | `/api/v1/admin/catalogue/queue` | `business:verify` |
| `POST` | `/api/v1/admin/catalogue/intake` | `business:write` |
| `POST` | `/api/v1/admin/catalogue/records/:id/review` | `business:verify` (actions: `claim`, `submit`, `verify`, `approve`*, `unapprove`*, `reject`, `archive`, `reopen`; *requires `business:publish`) |
| `GET` | `/api/v1/admin/catalogue/records/:id/history` | `business:read` |

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
│   │   ├── import/           csv reader, row resolution, the importer itself
│   │   ├── api/              plugins, routes, response envelope
│   │   └── server.js         the process
│   ├── scripts/              migrate, seed, bootstrap, maintenance, create-admin, import
│   ├── test/                 89 tests, no network, temporary folders only
│   └── web/                  the four pages, and the stylesheet they share
│       ├── index.html            the front door: what this is and how a listing gets in
│       ├── directory.html        search, filters and the results list
│       ├── business.html         one listing, with its contacts, services and provenance
│       ├── operator.html         the review queue
│       ├── theme.css             every shared token and component, light and dark
│       ├── theme.js              the appearance toggle, and nothing else
│       ├── fonts.css             self-hosted Figtree and IBM Plex Mono, no CDN
│       ├── fonts/                the woff2 subsets and their OFL notices
│       └── img/                  the hero image
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

89 tests, no network access, each against its own temporary database. The API tests mount the real
Fastify app with `inject()`, so routes are exercised through the real router, schema validation,
session plugin and error mapping without binding a port. They cover the behaviours that are
decisions rather than plumbing: the catalogue ingestion pipeline, provenance recording, the rule
that only approved records reach public search, the response envelope, the k-anonymity floor, private contact
points, the capability table, the rate limiter, that every documented filter actually filters and an
undocumented one is refused, that every signed-in route refuses an anonymous caller, that a bug in
our own code is answered as a 500 rather than as the caller's mistake, that every location level the
data holds is filterable, and the rule that a bad sign-in cannot be used to find out which addresses
exist. The CLI tests run `create-admin` and `import` as real child processes, since the interesting
ways for them to fail — a launcher step that pipes nothing, a piped email with no password, an import
whose sheet has one bad row in it — are all about how they read stdin and what they do with a file
somebody else wrote.

The operator page has no build step and therefore no unit tests, so it is driven the only way that
says anything: a real Chromium against a real server on a throwaway database, signing in, working a
batch, and reading the rows back. That pass is what caught `preHandler` being written inside a
`schema` object, where Fastify ignored it and four routes answered anonymous callers.

