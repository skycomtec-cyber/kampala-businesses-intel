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
- **Second Life Electronics, the first vertical.** Six electronics activities — repair,
  refurbishment, parts recovery, resale, recycling and data services — filed as real taxonomy, plus a
  device intake that follows one item from the counter to a named outcome and enforces its data-wipe
  promise.
- **Ask Kampala.** A plain-language question is read into an intent, a category and a location by a
  deterministic parser in `core/ask.js`, answered from the same engine everything else uses, and shown
  back to the asker so a misreading is visible rather than silent. Nothing leaves the machine.
- **Operator accounts with capabilities.** No public registration. Accounts are created by whoever
  has shell access, and every editorial action is written to an audit log with a before and after.
- **Provider self-service.** A business owner claims their own listing without signing up, an
  operator decides from the evidence, and only a grant creates the account and hands over the
  listing. The owner then maintains its details and its contacts, services and products — and only
  ever those listings.

## The privacy contract

This is the part worth reading before deploying it anywhere public.

- **k-anonymity floor.** Any aggregate computed over fewer than `KIP_K_THRESHOLD` (default 5)
  distinct people is marked `suppressed` and its counts are withheld. Not rounded, not capped, not
  approximated. The engine knows the answer and tells the caller it is not publishable yet, so a
  small group cannot subtract its own search out of a total of three.
- **Daily pseudonyms.** A search is attributed to a bucket derived from a salt that rotates every
  day. The platform can count "how many people searched X in this district this week" and is
  structurally unable to follow one person from one day to the next.
- **Raw queries are quarantined, and go first.** The only table that can identify a person is
  `search_query_raw`, it is written separately from the aggregate, and it is deleted after
  `KIP_RAW_SEARCH_RETENTION_DAYS` (default 30). No route reads it. It is deliberately kept for a
  *shorter* time than the pseudonymous events beside it (default 90): data that can name someone
  must not outlive data that cannot. Note that `search_query_raw.search_event_id` is
  `ON DELETE CASCADE`, so this is also the only ordering the schema can honour — a raw row cannot
  outlive its own event, so raising the raw setting above the event setting would not extend its
  life, it would just make the setting do nothing. A raw window above the event window is therefore
  clamped down to match it, and a window of `0`, a negative number or an unparseable one falls back
  to its default. Retention settings are the one place a bad value is caught at load rather than at
  use: nothing downstream re-checks a window, so a window of `0` would make every row look expired
  the moment it was written and the next maintenance run would delete the entire demand history
  while reporting success. `/api/v1/meta` publishes both values, so the number in force is the
  number you get.
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
2. **Create Admin Account** from the menu. There is no public sign-up; this opens a form for the
   operator's email and password (the password is masked) and is the only way an account is created.
   The form's answers are handed to the CLI through the environment, so nothing is typed into a shell.
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

Overriding `npm start` through the environment:

```bash
KIP_PORT=5000 KIP_K_THRESHOLD=10 npm start
```

Creating the first account from a shell. The password is never an argument, because an argument is
visible in the process table and lands in shell history, so it is passed through the environment (or
piped, or typed at a hidden prompt):

```bash
cd app
KIP_ADMIN_EMAIL=you@example.com KIP_ADMIN_PASSWORD='at-least-12-characters' npm run create-admin
```

`--email` and `KIP_ADMIN_EMAIL` are interchangeable; the same applies to the password's sources. The
Pinokio launcher uses the environment pair so that neither answer touches the command line.

### Configuration

Every setting is in `app/.env.example`, which is the annotated reference and the file to copy:

```bash
cd app
cp .env.example .env    # then edit it
```

Anything already in the environment wins over `.env`, so a systemd `EnvironmentFile`, a Compose
`env_file`, or `docker run -e` all override it without editing the file. A test asserts that the
example and `src/config.js` agree in both directions, so a variable added to one and not the other
fails CI rather than being silently ignored.

The ones that matter most:

| Variable | Default | What it does |
| --- | --- | --- |
| `KIP_HOST` | `127.0.0.1` | Bind address. Keep it on loopback. |
| `KIP_PORT` | `4310` | Port to listen on. |
| `KIP_DATA_DIR` | `app/data` | Where the database, session secret, live-process lock and backups live. The only path worth setting on a server. |
| `KIP_DB_FILE` | `<data dir>/kampala.db` | SQLite file. |
| `KIP_K_THRESHOLD` | `5` | Distinct actors required before an aggregate is published. |
| `KIP_RAW_SEARCH_RETENTION_DAYS` | `30` | How long raw query text survives. Must stay within the event window; see the privacy notes. |
| `KIP_EVENT_RETENTION_DAYS` | `90` | How long search and interaction events survive. |
| `KIP_SESSION_SECRET` | generated | Session signing secret. Generated and persisted on first run if unset. |
| `KIP_SESSION_TTL_HOURS` | `12` | Session lifetime. |
| `KIP_TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. Only enable behind a proxy you control. |
| `KIP_LOG_LEVEL` | `info` | Pino log level. |
| `KIP_SEED_REFERENCE` | `true` | Import reference data on start. |
| `KIP_SEED_CATALOGUE_DEMO` | `true` | Import the one demonstration organisation. Turn off once the install has its own listing. |
| `KIP_GAP_WINDOW_DAYS` | `30` | Default window the gap engine measures. |
| `KIP_GAP_TREND_WINDOW_DAYS` | `7` | Days on each side of a window's midpoint used to detect rising or falling demand. |
| `KIP_GAP_MAX_SIGNALS` | `200` | Most signals a single run will measure, highest-searching first. |
| `KIP_GAP_OPPORTUNITY_FLOOR` | `moderate` | Lowest severity promoted to an opportunity. Below it, a gap stays a gap. |

`KIP_HOST` and `KIP_TRUST_PROXY` are the two that are dangerous to set carelessly. `KIP_HOST=0.0.0.0`
puts the operator sign-in on every address the machine has, and `KIP_TRUST_PROXY=true` with nothing
in front actually setting `X-Forwarded-For` lets a client forge its own address past the per-IP rate
limiter. Both are correct only in the specific deployment they describe.

### Backups

```bash
npm run backup                      # -> <data dir>/backups, keeping 14
npm run backup -- --list            # what is there, and whether each file is sound
npm run backup -- --verify          # check every backup, write nothing
npm run backup -- --dir /mnt/backups --keep 30
```

The command is safe to run while the server is up, because it does not copy the file. `kampala.db`
runs in WAL mode, so recent writes live in a side file until a checkpoint, and `cp kampala.db` gives
you a file that opens cleanly, passes an integrity check and is missing every write since the last
checkpoint — silently, with nothing about the copy to say so. This uses SQLite's online backup API
instead: it reads through a consistent snapshot while the server keeps serving, and writes a single
complete file with no siblings to lose.

Every backup gets a `.json` manifest beside it recording the schema it was taken at, row counts, the
k-anonymity floor in force when it was measured, and a SHA-256 of the file. The backup verifies itself
immediately after writing, and `restore` refuses anything whose checksum does not match, so a file
that is a good copy of the wrong thing cannot replace a good database. The manifest also states what
is *not* in the backup: the session secret.

Pruning is on by default rather than being a flag, because a backup directory nobody prunes is a full
disk discovered at the worst time.

### Restoring

Stop the server first. The restore refuses while a process holds the data directory, because
replacing the file under a running server succeeds on Linux and produces the worst possible outcome:
the rename works, the server keeps serving from its open handle to a file that is no longer on disk,
and the platform reports a successful restore while serving a database that does not exist.

```bash
npm run restore -- --list
npm run restore -- --file kampala-20261001T031500Z.db
npm run restore -- --latest
```

It then:

1. Verifies the file — integrity check plus checksum — *before* touching anything.
2. Moves the current database to `kampala.db.replaced-<timestamp>` rather than deleting it, and prints
   the path. A restore you cannot undo is not a recovery step.
3. Deletes the session secret, so every operator signs in again. This is deliberate: keeping the old
   secret would leave every session cookie signed before the restore still valid after it, which is the
   wrong direction for the operation you reach for after an incident.

Start the server afterwards and it migrates the restored database to the current schema.

### Scheduled work

```bash
npm run maintenance                  # roll up the last 2 days, measure gaps, enforce retention
npm run maintenance -- --days 7      # the last 7 days
npm run maintenance -- --from 2026-01-01 --to 2026-01-31
npm run maintenance -- --no-rollup   # retention only
npm run maintenance -- --no-gaps     # roll up and enforce retention, but do not measure
npm run maintenance -- --window 60   # measure over 60 days instead of 30
```

Both jobs run in the right order, because the engine measures supply against demand that has already
been counted. Rollup first, then gaps, then retention, so a run never scores a day that is about to
be purged. Every run is recorded whether it succeeded or not, so a window that was never measured is
distinguishable from a window that was measured and found nothing.

The insights routes only read the rollup, so without this the opportunity view stays empty. `start.js`
runs it before the port opens, because a launcher with no scheduler still needs the rollup to happen.

### Measuring gaps on demand

Maintenance is for the schedule. When you want to look at a window without waiting for one:

```bash
npm run analyse                      # 30-day window, what is running
npm run analyse -- --window 90
npm run analyse -- --top 10          # more rows
npm run analyse -- --floor high      # promote only high findings
```

Same engine, same tables, same k-anonymity floor as the scheduled run — the difference is only that
the window is yours rather than the default, and that it prints what it found instead of logging it.

It measures the last N days **ending yesterday**, not today, because today is usually still
accumulating raw events. A window that includes a partial day scores demand that has not happened yet
as if it had, which quietly biases every finding downward. For the same reason, a day whose rollup is
missing contributes no demand rather than being treated as a day of silence.

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

**It does not record where the row came from.** A file can name a source in a column, and that name
lands in the legacy free-text `business.source_id`. The controlled reference the review pipeline reads,
`business.catalogue_source_id`, stays null, so a listing imported from a file cannot answer "who
published this?" on the page that shows its provenance. See
[Where a record's provenance comes from](#where-a-records-provenance-comes-from).

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

### Where a record's provenance comes from

Two different things write a listing, and only one of them records its origin.

`POST /api/v1/admin/catalogue/intake` is the controlled path. It takes a registered source key, the
record and the evidence string, and in one transaction it writes the business, its `record_provenance`
row and an intake event. It creates the record, so it cannot be used to explain one that already
exists. The CSV importer is the other path, and it writes no provenance at all: a source named in a
column is free text in `business.source_id`, `business.catalogue_source_id` stays null, and nothing
records which page any given phone number was read off. There is no HTTP route for closing that gap,
because quietly attaching an origin to a record is not something a client should be able to do — so it
is a repository call, `catalogue.recordProvenance(businessId, { sourceId, externalRef, evidence,
notes, attachToBusiness })`, and a script is how it gets run.

`app/scripts/backfill-provenance.mjs` is that script, written for the five listings imported from pages
harvested off KampalaBiz.Space. It does three things and stops there:

- Attaches a `record_provenance` row to each listing, quoting the harvested page and the line the
  number was on, with `attachToBusiness: true` so the listing's source column points at the source
  that produced it rather than at whoever last touched a detail.
- Adds the phone numbers those pages publish, **private**. A number read off a scraped page is a claim
  waiting for a reviewer, not something the directory may publish.
- Writes the two judgement calls into the notes instead of resolving them. The Eder and Lake Victoria
  View listings publish the same estate line, so it is stored twice and flagged as a possible
  duplicate rather than merged. Mama's Food is given no contact point at all, because the page is an
  unmodified template whose number is the placeholder `+00`; its note says a reviewer should expect it
  to be unpublishable as it stands.

It changes no review state. Every listing stays in the queue, because a provenance row says where a
claim came from, not that the claim is true.

```bash
cd app && node scripts/backfill-provenance.mjs
```

It is idempotent, and that is the property worth insisting on: `recordProvenance` upserts on
(source, externalRef) rather than stacking a second claim, and a contact that is already there is
skipped instead of duplicated. Running it twice writes nothing the second time, so it is safe to point
at a database somebody has been working in.

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

Four of the decisions are consequential, and those four are the only ones that ask first:
`approve`, `unapprove`, `reject` and `archive` change what the public can see. The box restates the
decision, how many listings it covers, and the reason that will be written permanently against each
one, because the audit row is what anybody will read later. A refusal is treated as a dismissal rather
than a cancellation of the batch, so the selection, the decision and the typed reason all survive a
mis-click and a second attempt costs one press instead of the retyping. A step inside the review
(`verify`, `claim`, `submit`, `reopen`, `restore`) asks for nothing, because a box in front of every
button would teach the operator that a box means "careful" and then not be careful.

### The confirmation boxes

`app/web/sheet.js` is the one `<dialog>` component, built once and reused, and it is what makes those
boxes behave without being written each time. `<dialog>` supplies the parts that are easy to forget:
the focus trap, the inert page behind, Escape, and a top layer that ignores the stacking context of
whatever it opened over. What is left is the three decisions the element cannot make:

| Decision | What it settles here |
| --- | --- |
| Which button is focused first | The way back, whenever there is one. A box that opens with the dangerous button under the operator's finger has already caused the accident it exists to prevent. |
| What a click outside means | Go back. The browser has no opinion, and a box that cannot be dismissed from the page around it reads as a dead end on a trackpad. |
| What the caller is told | A promise that is `true` only if the committing button was pressed. Escape and the backdrop are both `false`, so a caller cannot read "dismissed" as "confirmed". |

Tones are borrowed rather than invented: `success` takes `--good`, `danger` takes `--gap`, `warning`
takes the new `--warn`, and `neutral` takes plain `--ink-3`, so a result read in a box and the same
result read in the line at the bottom of the screen look alike. No tone is ever the only cue — each
carries its own glyph and its own sentence, so a box read by somebody who cannot separate the hues says
the same thing.

One subtlety is worth recording, because it is silent when it goes wrong. `close` is delivered as a
task, not synchronously, so the event raised by dismissing one box arrives *after* the next `open()`
has attached its own listener. A listener that merely checked whether it was still the current one
would settle the new box with the old box's exit: the new box would answer `false` the moment it
appeared, and its button would do nothing for the rest of the page's life — an operator would press
"Approve and publish" and the batch would simply never be recorded. The component therefore counts the
closures it causes itself and spends that count instead of settling on it.

### The pages, and what they share

Nine static files, no build step, no framework, served from the same origin as the api and linked
from the same topbar, so any of them can be bookmarked or reloaded on its own:

| Page | What it is for |
| --- | --- |
| `/` | The front door: what the platform is, and the sequence a listing goes through to get published |
| `/directory.html` | Public search. Filters, then the results list, then a page for one listing |
| `/business.html?b=<slug>` | One listing: contacts marked public or private, services, skills, and the source it came from |
| `/insights.html` | The ranked gaps: what people search for and nobody lists, each card carrying the sentence it was ranked by |
| `/operator.html` | The review queue, above |
| `/requests.html` | The marketplace of requests: post one without an account, read it back with its token, accept an offer |
| `/provider.html` | The provider desk: a published business answering open requests |
| `/ask.html` | Ask Kampala: a plain-language question, the reading of it, and the answer |
| `/second-life.html` | The Second Life Electronics vertical: its six activities and the intake lifecycle |

`/insights.html` is the other half of `/directory.html`, and reads the same
`/api/v1/insights/opportunities` the api documents. Its floor toggle is the page form of
`?includeSuppressed=true`: on, it lists the findings computed over too few distinct people and withholds
their counts, which is what the flag means everywhere else in this platform.

Everything the pages agree on lives in `app/web/theme.css` as tokens, so light and dark are two
readings of one set of rules rather than two stylesheets, and a page cannot drift from its neighbours.
`theme.js` only reads and writes the saved appearance; the choice is inlined into each page's `<head>`
so a dark-mode visitor never sees a white flash, and with JavaScript off the rest of each page still
works. `sheet.js` is the one confirmation box, shared so the operator queue and any later page cannot
disagree about what a box means. The fonts are self-hosted (`fonts.css` and `fonts/`), so the app has
no runtime CDN dependency.

### What the colour is for

Both long lists on this site — public results and the review queue — are rows that all look alike, and
on both of them the row's own attribute is the thing being judged. A result card is filed under a
category; a queue row is at some point in a review. Colouring a row by anything else would be
decoration, so exactly one thing is coloured, and it is that. The gaps page is a third long list and
follows the same rule, colouring by severity: the question a reader asks of a gap is how bad it is, so
that is what the bar answers.

One attribute, one rule, four surfaces:

| Attribute | Set on | Reads as |
| --- | --- | --- |
| `data-branch` | a result card, from the branch its category sits under | which of the five top-level categories this is |
| `data-state` | a queue row, from `verificationState` | how far through review it is |
| `data-tone` | a dialog, an outcome line, a decision pill, a gap card from its severity | what the action it offers does, or how bad the gap is |
| — (`data-tone` absent) | a `low` gap, and any record with no attribute | plain card surface, no bar |

All three resolve to the same two variables, `--branch` and `--branch-wash`, and one rule paints the
bar and the fill. That is the whole mechanism, and it is why the pill offering "Reject" and the box
asking about it cannot drift into two different reds: they are named by the same attribute and read
from the same rules.

**The bar is the hue, the fill is the wash.** The bar is what survives on a page where one row's wash
sits next to another row's wash, and the wash is what makes a long list scannable. Neither carries
meaning alone — the branch name and the state label are both printed on the record — so nothing here is
decidable by colour. A record with no attribute keeps the plain card surface and no bar at all, which
is the same gap the "no address recorded" line already admits to. A state the stylesheet has not heard
of falls through to the same plain ink, so a new state in the state machine appears uncoloured rather
than wrong.

**The branch hues are not the signal palette.** `--good`, `--gap` and `--warn` already mean "published",
"refused" and "look again", and a category wearing one of them would be making a claim it has not
earned. The five roots get five hues of their own, indexed by the root's position in the editorial sort
the api returns (`sort_weight`, then name) rather than by anything derived from the data, so adding a
sixth root does not recolour the five already on screen. A card is coloured by the **branch**, not by
its own category: there are ninety categories and five branches, and tinting a card by which leaf it is
would produce ninety colours nobody can hold in their head.

**The queue reads by state, and archive is deliberately quiet.**

| `verificationState` | Wears | Why |
| --- | --- | --- |
| `imported`, `pending_review` | plain ink on the neutral wash | nobody has looked at it yet, so it has no opinion |
| `under_review` | `--info` | a colleague has taken it. Blue is the one signal on this site that is not a verdict |
| `verified`, `approved` | `--good` | the facts are checked and it is published |
| `rejected` | `--gap` | closed, and closed as a refusal |
| `archived` | plain ink | out of the way, and not itself a judgement on the listing. The grey of a closed drawer is not the grey of a record somebody should still look at |

**The decision pills wear the tone their box will open in,** which is what `ACTION_TONES` in
`operator.html` is for. It is one map feeding both surfaces, so the press and the confirmation cannot
disagree. The four consequential actions are all distinct: `approve` is `--good`, `unapprove` is
`--warn`, `reject` is `--gap`, and `archive` is plain ink. Archive used to share the amber with
withdraw, which put the two decisions an operator is most likely to reach for next to each other in the
same colour. The five steps inside a review — `verify`, `claim`, `submit`, `reopen`, `restore` — are
bookkeeping, and wear plain ink for the same reason.

The one thing a pill does **not** wear is the tone, and that is measured. At 13px the label is the
smallest text on the page, and after the washes were strengthened a tone ink is no longer a text pair
on its own wash: `--warn` sits at 3.77:1 and `--good` at 4.43:1. Darkening the inks was the other
option and it is the wrong one — `--warn` is already only ΔE 23 from `--gap` and ΔE 26 from
`--gold-ink`, and those two separations are what keep "look again" and "refused" from being the same
sentence. So the tone stays on the wash, the border, the ring and the tick, and the word is read in the
page's own ink. Measured the other way, every branch ink clears 4.5:1 on its own wash in both themes
(5.13 to 8.23) and 6.8:1 or better on `--card`, so the one place a tint did cost contrast — the
"not recorded" line, which is the last thing on a card that should be hard to read — borrows its own
branch's ink rather than the grey.

A hover bends towards the row rather than the other way round. An attributed record that reverted to
plain `--card` under the pointer would lose its colour at the exact moment somebody is reading it, so
it deepens towards its own hue instead, and only a record with no attribute gets the card white.

### The photograph

The landing band is a real photograph of Kampala, in colour, and the credit is rendered in the page
under the text it sits below rather than only in a file. That is a licence obligation, not a courtesy:
the image is *View of Kampala city 1* by Dr. S-mon from Wikimedia Commons under CC BY 4.0, and CC BY
asks for credit a reader can actually reach. If the photograph is ever replaced, the credit line in
`index.html` has to be replaced with it, and the replacement's licence is what decides whether the
derivative is admissible at all — the graded and resized versions here are adaptations, which is why
CC BY-SA was avoided: share-alike would carry that obligation into a repository that carries no licence
of its own.

`app/web/img/CREDITS.md` records the original, the author, the licence, the exact `ffmpeg` chain both
derivatives come from, and why that chain is what it is. The short version: this is a dense,
high-frequency cityscape whose size curve is nearly flat, so a blur pays for a low quality setting
instead of a high one, and colour costs about 13% more bytes than the grayscale treatment that
preceded it. It is worth reading before changing the band, because re-measuring is cheaper than
rediscovering it.

## Second Life Electronics

The first specialised vertical, and the one that shows what a vertical is for. Its six activities are
real category nodes under `second-life-electronics` in the taxonomy, so a listing filed under one is
browsable like any other part of the directory. On top of that sits an **intake book**: a record that
follows a single device — its make, model, condition and the activity it is being handled under — from
the counter to a named outcome. A directory entry can say a workshop exists; an intake is the only
thing that can say this phone came in cracked on Tuesday and left with its data wiped.

The intake lifecycle is one-way: `received → diagnosed → in_progress → ready`, and then `closed` with
one of seven outcomes (`repaired`, `refurbished`, `parts_recovered`, `resold`, `recycled`, `returned`,
`scrapped`). Every move is written to an append-only `device_intake_event` history. The rules live in
`app/src/core/secondLife.js` and are enforced by the repository, not restated in the route, so the
buttons the api offers and the moves it accepts cannot drift apart.

The one promise this vertical *enforces* rather than merely intends is the data wipe. An intake can be
opened with `dataWipeRequested`, and it cannot be closed as `resold`, `parts_recovered`, `recycled` or
`returned` while that wipe is outstanding — the record must either have the wipe completed first, or
choose an outcome that keeps custody of the device (`repaired`, `refurbished`, `scrapped`). The
database `CHECK` refuses a completed wipe that was never requested, so the constraint holds even if a
future caller skips the repository.

```bash
# the vertical's public table of contents (activity -> live category id)
curl -s http://127.0.0.1:4310/api/v1/second-life/activities

# take a device in (operator, business:write)
curl -s -X POST http://127.0.0.1:4310/api/v1/second-life/businesses/$BUSINESS_ID/intakes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"activity":"repair","deviceType":"smartphone","receivedCondition":"cracked","dataWipeRequested":true}'
# -> data.reference "SL-2026-00001"

# close it — refused while the wipe is outstanding, allowed once recorded
curl -s -X POST http://127.0.0.1:4310/api/v1/second-life/intakes/SL-2026-00001/wipe \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
curl -s -X POST http://127.0.0.1:4310/api/v1/second-life/intakes/SL-2026-00001/close \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"outcome":"repaired"}'
```

The public page is `/second-life.html`.

## Ask Kampala

A plain-language question — *"how many laptop repairers are there in Nakawa?"* — answered from the
same engine every other surface uses, with the reading of the question shown back. It is deliberately
**not a chatbot and not a model call**: `app/src/core/ask.js` is a pure, deterministic parser that
extracts an intent (`find` or `count`), at most one category from the real taxonomy, at most one
location from the real geography, and leaves whatever is left as free text. A word it does not
recognise stays in the free text rather than being dropped, so an unfamiliar place narrows the search
instead of silently vanishing. Nothing leaves the machine, and the same question always produces the
same plan.

```bash
curl -s "http://127.0.0.1:4310/api/v1/ask?q=how%20many%20device%20repair%20businesses%20are%20in%20Kampala%20District"
```

```json
{
  "data": [],
  "meta": {
    "total": 12,
    "intent": "count",
    "query": "how many device repair businesses are in Kampala District",
    "answer": "12 listings for Device Repair in Kampala District.",
    "understood": {
      "text": null,
      "category": { "id": "…", "name": "Device Repair", "slug": "device-repair" },
      "location": { "id": "…", "name": "Kampala District", "kind": "district" },
      "categoryPhrase": "device repair",
      "locationPhrase": "kampala district"
    }
  }
}
```

A `find` question runs the free text through the search index with the recognised category and
location as filters; a `count` question returns the number and no rows. Either way the question is
recorded as an anonymised demand signal exactly as a search is, because a question is what a person
wanted and the gap engine should see it. The public page is `/ask.html`.

## Provider self-service

A business owner can ask to look after their own listing. This is the one place a member of the
public becomes an account holder, and it is deliberately indirect, because this platform does not do
public registration.

The flow is: **claim → review → grant → sign in → maintain**. A claimant does not sign up for
anything. They state who they are and how they can be reached (`POST /api/v1/claims`), prove the
claim is theirs with a token returned exactly once, and an operator decides from the evidence whether
to believe them. Only a **grant** creates the account and hands over the listing. There is no route
that turns a submission into ownership on its own.

- **One open claim per listing.** A pending or granted claim blocks a new one, so a listing cannot be
  flooded and "the pending claim" is a singular thing a reviewer can point at.
- **The evidence is snapshotted.** At submission the repository records `matchesContact`: did the
  claimant's own phone or email already appear on the listing? It is stored, never recomputed, so an
  operator editing the contact points afterwards cannot manufacture a match after the fact.
- **A grant is a decision with consequences.** It creates a `provider` account (the narrowest role
  there is), sets the listing's `capabilityLevel` to `claimed` when it was `unverified`, and issues a
  one-time password-reset token. The password itself is random and discarded — the only way in is the
  reset token, which is returned to the approving operator once because **no mail transport exists
  yet**. Hand it to the owner out of band.
- **Revoking** takes the listing back and returns the capability level to `unverified`, but leaves the
  account in place, because an owner may hold more than one listing.

A provider may only ever reach the listings it owns. It does not get `business:read` — granting that
would open the admin routes, which return unpublished contact points for *any* business. Instead it
holds `provider:write`, and every `/provider/*` route additionally checks ownership against the
claims table. The desk is also narrower than an editor's: a provider may edit the words that describe
their business and maintain contacts, services and products, but **not** rename it, move it, change
its status, its review state or its capability level. Those are decisions about what the directory
is, and the platform does not delegate them to the person with an interest in the answer.

The public pages are `/claim.html` (claim, and follow a claim by reference) and `/my-business.html`
(the signed-in desk).

## Opening hours

The most common reason somebody looks a business up is to decide whether to go there now, so a
listing records a recurring weekly schedule and says whether the doors are open at this moment.

Hours are stored as a week: seven rows keyed by ISO weekday (1 is Monday, 7 is Sunday), each either
closed or open with an `opens` and a `closes` time (`HH:MM`, 24-hour). A closed day carries no times
and an open day carries both, and the rule layer refuses the ambiguous pair — an opening time equal
to a closing time, or an open day missing a time — rather than guessing. A closing time earlier than
its opening time is not an error: it is a night shift, and the reader understands it as running past
midnight, including on the following day.

The week is replaced whole (`PUT .../hours`), not patched day by day, because a schedule that changes
one day at a time cannot express "closed on Sunday" without a delete for every day that moved; omitted
days read as closed.

Times are Uganda time. East Africa Time is UTC+3 and has never observed daylight saving, so the offset
is a fixed constant in `app/src/core/hours.js` (`TZ_OFFSET_MINUTES = 180`) rather than a per-record
column. The platform does not pretend to support a business that keeps its hours in another zone,
because none of the ones it indexes do.

`openState` is **derived, never stored**. The public profile and every directory row compute it at read
time from the stored week and the current moment (in EAT), so there is no cached flag to go stale and no
job that has to run for the badge to change. It is a small object: `{ open, recorded, label, closesAt?,
nextOpens? }`, where `recorded` is false when no hours were ever entered, and `label` is the whole
sentence — `Open now · closes 17:00`, `Closed · opens tomorrow 09:00`, `Closed · opens Monday 09:00`, or
`Opening hours not recorded`. The same sentence is what the badge, the listing and any future client
display, so they cannot disagree about whether the same business is open.

A provider owns these outright through `/provider/businesses/:id/hours` — unlike the review state or
the category, opening hours are a fact about the owner's day and not a decision about what the
directory is — and an operator can set or clear them from the admin routes.

## Near me

The area picker answers "what is in Nakawa". The question a person actually asks, with a phone in
their hand, is "what is close to where I am standing" — and a ward boundary is not an answer to
that. `GET /api/v1/businesses` therefore accepts `lat`, `lng` and `radiusKm`; when a centre is
present the listing is ordered by distance and each row gains `distanceKm`, and `meta.geo` echoes the
centre and radius back so a page can render "within 3 km of you" without keeping its own copy.

The distance is computed in `app/src/core/geo.js` in JavaScript rather than in SQL, because SQLite
has no haversine and the two honest ways around that are to register a custom function or to do the
arithmetic where the rule already lives. The second was chosen deliberately: a second copy of the
formula inside a SQL string could drift from the one in `core/`, and a test could then only ever
check one of the two. Candidate rows are pulled back with the ordinary filters already applied —
the directory is a city, not a planet — and the radius and the ordering are applied to that set,
before pagination, so a page shows the nearest overall rather than the nearest of an arbitrary slice.

A listing whose primary location has no coordinates is left out of a proximity answer entirely
rather than shown with a guessed or infinite distance, so every row in a distance-sorted list can be
reached on a map. `lat` and `lng` are validated as a pair: half a coordinate is not a place, and
quietly defaulting the missing half to Kampala would answer a question about somebody's own street
with somebody else's. A radius above 500 km is refused rather than turned into a full-table list
sorted by a number that means nothing at that scale.

The reader's position is never recorded. It travels as query parameters on a listing request —
exactly like a district — and is not written to any listing or to a demand signal. A person who
wants their business to be found by their patch of Kampala says so by entering an address; a person
who only wants to walk to a shop should not leave a home coordinate in a business directory.

`sort=distance` is browse-only and is honoured only while a centre is present; the ordinary sort
keys still work when no centre is given, and an unknown key falls back to the default order rather
than to nothing. The directory's "Use my location" button drives this, and it offers no fallback
location when the browser refuses: guessing is worse than saying so.

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
| `GET` | `/api/v1/businesses` | The directory. `?locationId=`, `?categoryId=`, `?skillId=`, `?capabilityLevel=`, `?verificationState=`, `?status=`, `?search=`, `?sort=`. Each row carries an `openState`. For proximity, add `?lat=`, `?lng=`, `?radiusKm=` and `?sort=distance`; each row then also carries `distanceKm` and `meta.geo` reports the centre and radius used. |
| `GET` | `/api/v1/businesses/:idOrSlug` | A public profile, with its weekly `hours` and a derived `openState`. Never includes private contact points. |
| `GET` | `/api/v1/businesses/match` | `?q=name` or `?phone=` to catch duplicates before adding a listing. |
| `GET` | `/api/v1/search` | `?q=` required. Records a demand signal; see the header `x-demand-signal`. |
| `GET` | `/api/v1/ask` | `?q=` required. Reads a plain-language question and answers it; `meta.understood` shows the reading. Records a demand signal like `/search`. |
| `GET` | `/api/v1/second-life/activities` | The vertical's six activities and the category each is filed under. |
| `GET` | `/api/v1/insights/opportunities` | Ranked gaps. `?includeSuppressed=true` to see withheld ones. |
| `GET` | `/api/v1/insights/opportunities/:id` | One gap with the snapshot it was derived from. |
| `GET` | `/api/v1/insights/signals` | Aggregated demand. `?from=` required. |
| `GET` | `/api/v1/insights/summary` | Demand totals for a window. `?from=` required. |
| `GET` | `/api/v1/requests` | Open requests, for providers to fulfil. |
| `GET` | `/api/v1/requests/:reference` | One request, its items, its offers, its status history. |
| `POST` | `/api/v1/requests` | Post a request. No account needed. |
| `POST` | `/api/v1/requests/:reference/withdraw` | With your access token, or as the signed-in requester. |
| `POST` | `/api/v1/requests/:reference/offers/:offerId/accept` | Accept one offer. With your access token, or as the signed-in requester. |
| `POST` | `/api/v1/auth/login` | Returns a bearer token and sets a session cookie. |
| `POST` | `/api/v1/auth/logout` | Ends the session. |
| `POST` | `/api/v1/auth/change-password` | Requires the current password. |
| `POST` | `/api/v1/auth/password-reset` | Starts a reset. |
| `POST` | `/api/v1/auth/password-reset/confirm` | Completes one. |
| `GET` | `/api/v1/auth/me` | The signed-in operator. |
| `GET` | `/api/v1/auth/roles` | Roles and their capabilities. |
| `GET` | `/api/v1/counts` | Supply counts for `?categoryId=` and/or `?locationId=`, optionally `?includeSubtree=true`. |
| `POST` | `/api/v1/claims` | Claim a listing as its owner. No account needed; body names `businessId`, `claimedAs`, `relation` and optionally `contactEmail`, `contactPhone`, `evidence`. Returns a `reference` and a one-time `accessToken`. |
| `GET` | `/api/v1/claims/:reference` | Follow a claim. Send `x-claim-token` with the token to see your own contact details and evidence. |
| `POST` | `/api/v1/claims/:reference/withdraw` | Withdraw a pending claim, with your token (header or body) or as the signed-in owner. |
| `GET` | `/api/v1/claims/status/:businessId` | Whether a listing is open to a new claim. |

### Provider (capability `provider:write`, plus per-listing ownership)

A provider is a business owner, not staff. Every route below additionally refuses a listing the
caller does not own, and the reachable surface is narrower than an editor's: a provider edits the
words that describe the business and its contacts, services and products, but cannot rename it, move
it, or change its status, review state or capability level.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/provider/businesses` | The listings this provider owns. |
| `GET` | `/api/v1/provider/businesses/:id` | One own listing, including its private contact points. |
| `PATCH` | `/api/v1/provider/businesses/:id` | Edit `description`, `website`, `foundedYear` only. Anything else is refused. |
| `POST`/`PATCH`/`DELETE` | `/api/v1/provider/businesses/:id/contacts[/:contactId]` | Contact points. New ones are public by default; patch `isPublic`/`isPrimary`. |
| `POST`/`PATCH`/`DELETE` | `/api/v1/provider/businesses/:id/services[/:serviceId]` | Services. |
| `POST`/`PATCH`/`DELETE` | `/api/v1/provider/businesses/:id/products[/:productId]` | Products. |
| `PUT` | `/api/v1/provider/businesses/:id/hours` | Replace the weekly opening hours. Body `{ "week": [{ "weekday": 1, "opens": "09:00", "closes": "17:00" }, { "weekday": 7, "isClosed": true }] }`. |
| `DELETE` | `/api/v1/provider/businesses/:id/hours` | Remove the recorded hours. |

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
| `PUT`/`DELETE` | `/api/v1/admin/businesses/:id/hours` | `business:write` (replace or remove the weekly opening hours) |
| `GET` | `/api/v1/admin/businesses/:id/offers` | `business:read` (offers a business has made) |
| `GET` | `/api/v1/admin/businesses/:id/matching-requests` | `business:read` (open requests it has not answered) |
| `POST` | `/api/v1/second-life/businesses/:id/intakes` | `business:write` (take a device in; body names `activity`, `deviceType`, `receivedCondition`) |
| `GET` | `/api/v1/second-life/businesses/:id/intakes` | `business:read` (a business's intake book; `?stage=`, `?outcome=`, `?activity=`, `?deviceType=`, `?search=`) |
| `GET` | `/api/v1/second-life/businesses/:id/summary` | `business:read` (counts by stage, outcome and activity, including wipes) |
| `GET` | `/api/v1/second-life/intakes/:reference` | `business:read` (one intake, its history and its `nextStages`) |
| `POST` | `/api/v1/second-life/intakes/:reference/advance` | `business:write` (forward only; a skip straight to `closed` is refused) |
| `POST` | `/api/v1/second-life/intakes/:reference/close` | `business:write` (close with an `outcome`; the data-wipe rule is applied here) |
| `POST` | `/api/v1/second-life/intakes/:reference/wipe` | `business:write` (record that a requested data wipe was completed) |
| `POST` | `/api/v1/requests/:reference/offers` | `business:write` (offer as a published business; `businessId` in the body) |
| `POST` | `/api/v1/requests/:reference/offers/:offerId/withdraw` | `business:write` (retract one of its offers) |
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
| `GET` | `/api/v1/admin/claims` | `business:read` (`?status=`, `?businessId=`, `?search=`, `?sort=`) |
| `GET` | `/api/v1/admin/claims/:id` | `business:read` |
| `POST` | `/api/v1/admin/claims/:id/decide` | `business:verify`, plus `user:write` for `grant`/`revoke` (a grant creates an account). Body `decision` (`grant`, `reject`, `revoke`); `reason` required for reject and revoke. A grant returns the new `owner` and a one-time `passwordResetToken`. |

Roles, from `GET /api/v1/auth/roles`:

| Role | Capabilities |
| --- | --- |
| `admin` | Everything, including users, imports, opportunities and the lab. |
| `editor` | Read, write and verify businesses; read requests and analytics; import. |
| `analyst` | Read-only: businesses, requests, analytics, lab, opportunities. |
| `viewer` | Read-only businesses and analytics. |
| `provider` | `provider:write` only — the listings the account owns, and nothing else. |

A missing session is `401 unauthenticated`. A session without the capability is `403 forbidden`, so
a client can always tell "sign in" from "you may not".

### Validation vocabularies

Some fields are closed sets. Sending a value outside one of them is `400 validation_failed` with
`error.details.allowed` listing what was accepted, and `error.details.field` naming the input where
the rule knows which field it came from, so a form can render the problem against the box the
operator actually typed into.

| Field | Values |
| --- | --- |
| `status` on a business | `draft`, `active`, `suspended`, `closed` |
| `verificationState` | `imported`, `pending_review`, `under_review`, `verified`, `approved`, `rejected`, `archived` |
| `capabilityLevel` | `unverified`, `claimed`, `documented`, `operating`, `established` |
| `condition` on a product | `new`, `refurbished`, `used_good`, `used_fair`, `for_parts`, `unknown` |
| `priceUnit` on a service | `hour`, `job`, `item`, `day`, `month`, `quote`, or absent |
| `kind` on a contact | `phone`, `whatsapp`, `email`, `website`, `facebook`, `tiktok`, `physical` |

Only `approved` is public, and a business also has to be `active`; a record can be approved and
suspended at the same time, and then the public sees nothing. The review transitions are a pipeline
rather than a free set: `POST /api/v1/admin/catalogue/records/:id/review` refuses any move the state
graph does not allow, and no state reaches `approved` except through `verified`, because "somebody
checked it" and "we will publish it" are separate claims.

`priceUnit` is the vocabulary the database has always enforced, so a wrong value used to arrive as a
`500` from a SQLite `CHECK` violation rather than a validation error. It is checked in JavaScript now
and mirrors the constraint in `app/src/db/migrations/003_supply.sql`; change one and change the other.

One response field is `null` rather than `0` when nothing was computed, because a zero is a claim
that a market is empty and a client cannot tell that from a real count:

- `businessCount` on a category from `GET /api/v1/categories`, unless `?includeCounts=true` was sent.
  With it, every node carries a number rolled up the tree from its own active, approved records.

The daily supply series is the exception, and deliberately: `supply_metric_daily` rows only exist
because a measurement was taken, so a `0` in one of those columns is the measurement.

### Rate limits

Fixed windows, in process memory, keyed by account when signed in and by address when not.

| Scope | Limit |
| --- | --- |
| Sign-in and password reset | 10 per 15 minutes |
| `POST /requests`, withdraw, offers, accept | 5 per minute |
| `POST /claims`, withdraw | 5 per minute (the same budget as a marketplace request: anything the public can post in bulk gets posted in bulk) |
| `GET /search` | 30 per minute |
| `GET /ask` | 30 per minute (the search budget: every question is a demand signal) |
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

# Post a request without an account, and keep both what it returns: the
# reference is what a provider is told on the phone, and the token is what the
# requester keeps to prove the request is theirs.
REQUEST=$(curl -s -X POST $BASE/api/v1/requests \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Borehole pump needed for a school\",\"categoryId\":\"$CATEGORY\",\"locationId\":\"$LOCATION\"}")
REFERENCE=$(echo "$REQUEST" | jq -r .data.reference)
ACCESS=$(echo "$REQUEST" | jq -r .data.accessToken)

# The other half of the marketplace: a signed-in operator offers on the request
# as a business it manages. The business has to be published (active and
# approved) - an offer from a listing the public cannot see is never shown.
BUSINESS=<a published business id>
OFFER=$(curl -s -X POST $BASE/api/v1/requests/$REFERENCE/offers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS\",\"price\":150000,\"message\":\"Can install this week.\"}")
OFFER_ID=$(echo "$OFFER" | jq -r .data.id)

# A provider can see its own pipeline, and the open work it could still answer.
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/v1/admin/businesses/$BUSINESS/offers"
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/v1/admin/businesses/$BUSINESS/matching-requests"

# The requester, not the platform, decides which offer wins. Accepting declines
# the rest and moves the request to in_progress, all in one write.
curl -s -X POST $BASE/api/v1/requests/$REFERENCE/offers/$OFFER_ID/accept \
  -H 'content-type: application/json' -d "{\"accessToken\":\"$ACCESS\"}"

# Provider self-service. An owner claims a listing without an account, keeps the
# token to follow it, and an operator decides. Only a grant creates the account.
CLAIM=$(curl -s -X POST $BASE/api/v1/claims \
  -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BUSINESS\",\"claimedAs\":\"Aisha Nakato\",\"relation\":\"owner\",\"contactEmail\":\"aisha@example.com\"}")
CLAIM_REF=$(echo "$CLAIM" | jq -r .data.reference)   # CLM-2026-00001
CLAIM_TOKEN=$(echo "$CLAIM" | jq -r .data.accessToken)

# Follow it publicly, or privately with the token.
curl -s $BASE/api/v1/claims/$CLAIM_REF
curl -s -H "x-claim-token: $CLAIM_TOKEN" $BASE/api/v1/claims/$CLAIM_REF

# An operator grants it, which creates the provider account and returns the
# one-time reset token to hand to the owner (nothing sends mail).
curl -s -X POST $BASE/api/v1/admin/claims/<claim-id>/decide \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"grant","reason":"Matched the listed phone number on a call."}'

# The owner signs in with the reset token, then maintains only their own listing.
curl -s -X POST $BASE/api/v1/auth/password-reset/confirm \
  -H 'content-type: application/json' -d '{"token":"<reset-token>","newPassword":"Your-New-Password-2026"}'
curl -s -H "authorization: Bearer $OWNER_TOKEN" $BASE/api/v1/provider/businesses
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

// Claim a listing as its owner. No account yet: the token is the only proof
// until an operator decides, and it is returned exactly once.
const { data: claim } = await api('/api/v1/claims', {
  method: 'POST',
  body: { businessId: BUSINESS_ID, claimedAs: 'Aisha Nakato', relation: 'owner', contactEmail: 'aisha@example.com' },
})
console.log(claim.reference, claim.accessToken)
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

# Provider self-service: an owner claims a listing, then follows it with the
# token. Only a grant (an operator decision) creates the account.
claim = session.post(f"{BASE}/api/v1/claims", json={
    "businessId": BUSINESS_ID,
    "claimedAs": "Aisha Nakato",
    "relation": "owner",
    "contactEmail": "aisha@example.com",
}).json()["data"]

followed = session.get(
    f"{BASE}/api/v1/claims/{claim['reference']}",
    headers={"x-claim-token": claim["accessToken"]},
).json()["data"]
print(followed["status"], followed.get("contactEmail"))
```

## Deploying it

The platform is one Node process and one SQLite file, so "deploying" is mostly deciding where that
file lives and what is in front of it. Three ways, in increasing order of what they ask of you.

### A container

```bash
cp app/.env.example app/.env    # then edit it
docker compose up -d
docker compose logs -f
```

The image is a two-stage build: dependencies including the native `better-sqlite3` are compiled in a
builder, and the runtime stage carries the app, `tini` and nothing else. It runs as the unprivileged
`node` user, binds `0.0.0.0` because that is the only address reachable from outside the container,
and healthchecks `/api/v1/meta` — the endpoint that returns the configuration in force, so the check
fails when the database is unreachable rather than merely when the process exists.

One named volume, `kampala-data`, holds the database, the session secret, the live-process lock and
the backups. Everything else in the image is rebuilt from this repository, so `docker compose down`
loses nothing. **`docker compose down -v` deletes the database.**

The Compose file publishes no host port by default. The app has an operator sign-in and is built to
sit behind a proxy that terminates TLS, so exposing 4310 puts that sign-in on whatever firewall
happens to be in front of it. Uncomment the `127.0.0.1:4310:4310` mapping once a proxy on the same
host is actually there.

### A systemd service

```bash
sudo useradd --system --home /srv/kampala-intel --shell /usr/sbin/nologin kampala
sudo mkdir -p /srv/kampala-intel /var/lib/kampala-intel
sudo chown -R kampala:kampala /var/lib/kampala-intel
sudo -u kampala git clone <repo> /srv/kampala-intel/app
cd /srv/kampala-intel/app && sudo -u kampala npm ci

sudo cp deploy/kampala-intel.service /etc/systemd/system/
sudo cp deploy/kampala-intel-maintenance.{service,timer} /etc/systemd/system/
sudo cp deploy/kampala-intel-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kampala-intel.service
sudo systemctl enable --now kampala-intel-maintenance.timer kampala-intel-backup.timer
```

Five units, because there are two different kinds of work here and conflating them is how one gets
missed:

| Unit | When | What |
| --- | --- | --- |
| `kampala-intel.service` | always | The HTTP server. |
| `kampala-intel-maintenance.timer` | 03:17 nightly | Roll up demand, measure gaps, enforce retention. |
| `kampala-intel-backup.timer` | 03:47 nightly | Copy the database and verify the copy. |

The ordering matters: maintenance before backup, so a nightly copy contains the morning's rolled-up
day rather than yesterday's. Both timers carry `Persistent=true`, so a machine that was off at 03:17
runs the job at the next boot — without that, one unattended reboot silently ends the schedule and
nothing reports it.

The service runs as a dedicated unprivileged user with `ProtectSystem=strict` and a single
`ReadWritePaths` entry for the data directory. The code directory is read-only to it, so a
compromised request handler cannot rewrite the server it is running in. Backups land inside the data
directory for the same reason: a backup written outside the writable path is one the unit cannot write
at all.

Set the session secret in a root-owned file if you want a rebuild not to sign every operator out:

```bash
sudo install -m 600 -o root -g kampala /dev/null /etc/kampala-intel.env
sudo editor /etc/kampala-intel.env     # KIP_SESSION_SECRET=...
# then uncomment EnvironmentFile= in the unit
```

### Behind a proxy

`deploy/nginx-kampala-intel.conf` is a working nginx site: TLS, a redirect from port 80, HSTS, and
per-endpoint rate limits that match the ones in the app — tightest on sign-in, so a script walking
passwords sees a 429 rather than a login form.

Set `KIP_TRUST_PROXY=true` once nginx is actually in front. The rate limiter counts per address, and
without `X-Forwarded-For` nginx sends its own address, which makes every visitor on the internet
count as one client. The reverse is also true: enabling it with no proxy in front is the same as
having no rate limit at all.

### What a deployment does not include

There is no TLS termination, no firewall, no reverse proxy and no automated deploy in this
repository. Those depend on the host and belong to whoever operates it, and a checked-in default for
any of them is a guess that looks like a decision. What is here is the application, the units that
run it, and the nginx site that makes the two settings which are dangerous in isolation
(`KIP_HOST`, `KIP_TRUST_PROXY`) correct in the deployment they describe.

### Continuous integration

`.github/workflows/ci.yml` runs the suite on Node 20.11, 22 and 24; checks that `.env.example` and
`src/config.js` still agree; and builds the container, waits for its own healthcheck, asserts on
`/api/v1/meta`, stops it and checks the WAL was checkpointed rather than left for recovery. It runs
on push, on pull requests, and nightly — a platform with a daily rollup and a nightly engine has
code paths that only execute once a day in production, so a suite that only runs on push misses a
class of breakage entirely.

## Layout

```
.
├── app/                      the app, self-contained
│   ├── package.json
│   ├── .env.example          every setting, annotated, commented out where secret
│   ├── Dockerfile            two stages: native build, then runtime with tini
│   ├── src/
│   │   ├── config.js         every value resolvable from the environment
│   │   ├── core/             domain rules: auth, demand, privacy, identifiers, errors
│   │   ├── db/               driver, migrations, repositories, backup.js
│   │   ├── seed/             idempotent reference import
│   │   ├── import/           csv reader, row resolution, the importer itself
│   │   ├── api/              plugins, routes, response envelope
│   │   └── server.js         the process
│   ├── scripts/              migrate, seed, bootstrap, maintenance, analyse, create-admin,
│   │                         import, backup, restore, and the one-off repairs
│   │                         — backfill-provenance, add-sources
│   ├── test/                 201 tests, no network, temporary folders only
│   └── web/                  the website pages, and the stylesheet they share
│       ├── index.html            the front door: what this is and how a listing gets in
│       ├── directory.html        search, filters and the results list
│       ├── business.html         one listing, with its contacts, services and provenance
│       ├── insights.html         the ranked gaps, and what the engine withheld
│       ├── requests.html         the marketplace of requests
│       ├── provider.html         the marketplace provider desk
│       ├── ask.html              Ask Kampala, with the reading of the question
│       ├── second-life.html      the Second Life Electronics vertical
│       ├── claim.html            claim a listing, and follow a claim by reference
│       ├── my-business.html      the signed-in desk for a business owner
│       ├── operator.html         the review queue
│       ├── theme.css             every shared token and component, light and dark
│       ├── theme.js              the appearance toggle, and nothing else
│       ├── sheet.js              the one confirmation box, reused by every page that asks
│       ├── fonts.css             self-hosted Figtree and IBM Plex Mono, no CDN
│       ├── fonts/                the woff2 subsets and their OFL notices
│       └── img/                  the hero photograph, and CREDITS.md for its licence
├── deploy/                   systemd units, the nginx site
├── .github/workflows/ci.yml
├── docker-compose.yml        container, one named volume, no published port by default
├── install.js                Pinokio: dependencies, migrations, reference data, tests
├── start.js                  Pinokio: maintenance, then the server
├── create-admin.js           Pinokio: the only way an account is created
├── update.js                 Pinokio: dependencies, migrations, maintenance, tests
├── reset.js                  Pinokio: removes node_modules and the database
├── pinokio.js                the menu
└── pinokio.json              metadata
```

`app/data/` holds the SQLite database, the generated session secret, the live-process lock while the
server is up, and `backups/`. The database and the listings are disposable: delete the folder and run
`npm run bootstrap` to get the same platform back with no listings. The backups are not — they are
the only copy of anything you have not re-imported.

## Tests

```bash
cd app
npm test
```

201 tests, no network access, each against its own temporary database. The API tests mount the real
Fastify app with `inject()`, so routes are exercised through the real router, schema validation,
session plugin and error mapping without binding a port. They cover the behaviours that are
decisions rather than plumbing: the catalogue ingestion pipeline, provenance recording, the rule
that only approved records reach public search, the response envelope, the k-anonymity floor, private contact
points, the capability table, the rate limiter, that every documented filter actually filters and an
undocumented one is refused, that every signed-in route refuses an anonymous caller, that a bug in
our own code is answered as a 500 rather than as the caller's mistake, that every location level the
data holds is filterable, and the rule that a bad sign-in cannot be used to find out which addresses
exist. The Second Life vertical is pinned at both levels — the pure rules (the one-way stage order,
the activity/category mapping, the data-wipe rule) against `core/secondLife.js`, and a full device
lifecycle against the api — and Ask Kampala is pinned the same way: the parser's reading against
`core/ask.js`, and a count and a find question end to end through `/api/v1/ask`. Provider
self-service is pinned at both levels too: the one-way claim lifecycle and the contact normalisation
against `core/claims.js`, and the whole flow — submit, follow with and without the token, withdraw,
one-open-claim-per-listing, reject needs a reason, grant creates the provider account and sets the
capability level, and the desk refuses a listing the caller does not own — against the api.

The backup tests are written around the failure they exist to prevent, which is that a copy of a WAL
database looks complete and is missing every write since the last checkpoint. So the assertions are
that a backup taken from a connection that never stopped contains a row written *after* it was taken,
that the result is a single file with no `-wal` sibling to lose, that a byte-flipped file is refused
by the checksum rather than restored over a good database, that a restore refuses while a live pid
holds the data directory but not after a crashed one left its lock behind, and that the displaced
database is kept. The CLI tests run `create-admin`, `import`, `backup` and `restore` as real child
processes, since the interesting
ways for them to fail — a launcher step that pipes nothing, a piped email with no password, an import
whose sheet has one bad row in it — are all about how they read stdin and what they do with a file
somebody else wrote.

The operator page has no build step and therefore no unit tests, so it is driven the only way that
says anything: a real Chromium against a real server on a throwaway database, signing in, working a
batch, and reading the rows back. That pass is what caught `preHandler` being written inside a
`schema` object, where Fastify ignored it and four routes answered anonymous callers.

The colour is checked the same way, and the check is over computed values rather than over the hex in
the stylesheet: every element carrying text on all five pages, in both themes, with the background it
actually paints against resolved through the ancestors rather than read off its own rule. The states
the signed-in pages render are injected with the attributes the real page gives them, which measures the
same computed values without needing an account — the styling is attribute-driven, so that is not a
weaker claim than signing in. 400 text nodes, none under 4.5:1. Asserting against a literal
`rgb(230, 243, 236)` instead would look like an assertion about meaning and would be an assertion about
one particular palette; it fails the next time a wash is retuned, which is exactly what happened when
these were strengthened.

### The marketplace pages, driven through a real Chromium

The marketplace, ask and second-life pages have no build step and therefore no unit tests either, so
the flows that are decisions — an anonymous requester posting a request and reading it back with the
token, a provider answering, the accept-one-declines-the-other rule, withdrawing an offer, withdrawing
a request, asking a question and reading back how it was understood, browsing the vertical's six
activities — are driven the only way that says anything: Playwright against a real server on a
throwaway database.

```bash
cd app
npm run test:e2e
```

The runner (`app/scripts/run-e2e.mjs`) starts the real server on a free port for each pass, waits for it
to listen, deletes the temporary database afterwards, and exits non-zero if any pass does. The
requests pass runs against an empty database (which is what makes its `empty state` and
`list now shows one request` assertions mean anything); the ask and provider passes seed the
demonstration — 36 businesses and the one admin account. The ask pass asks a count question and a find
question and checks the reading the page prints back, then checks the vertical's six activities;
the provider pass exercises two businesses answering the same request, a requester choosing between
offers, and both kinds of withdrawal.

Prereqs: a Python 3 interpreter with the `playwright` package and its Chromium, at the same pinned
version the `e2e` job in CI installs:

```bash
pip install playwright==1.63.0 && python -m playwright install chromium
```

Override the interpreter and the demo admin credentials with `KIP_E2E_PYTHON`,
`KIP_DEMO_ADMIN_EMAIL` and `KIP_DEMO_ADMIN_PASSWORD` if your environment needs them.


## Reviews and ratings
- Public submit creates a pending review; only published reviews are visible. Administrators and operators can moderate (publish/reject/delete). Providers can view all reviews for their listings. Ratings are computed from published reviews and shown on profiles and directory cards.

