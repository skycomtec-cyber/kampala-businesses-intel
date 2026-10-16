# Deploying Kampala Businesses Intel on a server

This is the concrete production runbook: a fresh Ubuntu/Debian host, a systemd
service, and nginx terminating TLS in front of it. It assumes a domain whose DNS
already points at the host. Everything it uses ships in this repository.

For a fast-and-disposable public link instead, see the Cloudflare-tunnel sharing
in `ENVIRONMENT`; for the annotated list of every setting, see `app/.env.example`
and `app/.env.production.example`. `README.md` covers backups, restore and the
nightly work in more depth.

If you would rather not run a host at all, "PaaS deployment (Render)" near the
end installs the same app as a managed service with a persistent disk, driven by
`render.yaml` and the `app/Dockerfile` that are already in the repository.

`deploy/bootstrap-server.sh` performs steps 1-6 below in one run. This document
is the same steps, spelled out, and is worth reading before trusting a script you
run as root.

Throughout, replace `kbi.example.com` with your own hostname.

## Prerequisites

- A fresh Ubuntu 22.04/24.04 (or Debian 12) host with a sudo user and SSH access.
- A domain whose `A`/`AAAA` record already resolves to the host. `certbot` proves
  control over port 80, so the record must be live before you get to the cert.
- Node.js 20.11 or newer. Step 1 installs it.

The app is one Node process and one SQLite file. The only directory that holds
state is the data directory; the code directory is replaceable from git.

## 1. Base packages, Node, firewall

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install nginx git curl ca-certificates certbot build-essential python3 ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
node -v            # must be >= 20.11

sudo ufw allow OpenSSH        # first, or enabling ufw drops your SSH session
sudo ufw allow 'Nginx Full'   # 80 and 443 only; the app port stays closed
sudo ufw --force enable
```

## 2. Service user and code

The shipped systemd units expect the app at `/srv/kampala-intel/app`, so clone
the **repository root** into `/srv/kampala-intel`. That places `app/` where the
units look for it and leaves `deploy/` beside it.

```bash
sudo useradd --system --home /srv/kampala-intel --shell /usr/sbin/nologin kampala
sudo mkdir -p /srv/kampala-intel /var/lib/kampala-intel
sudo chown -R kampala:kampala /srv/kampala-intel /var/lib/kampala-intel
sudo -u kampala git clone <repo-url> /srv/kampala-intel

cd /srv/kampala-intel/app
sudo -u kampala npm ci --omit=dev
sudo -u kampala npm rebuild better-sqlite3   # the native module must match this host
sudo -u kampala node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('ok')"
```

There is no separate migrate/seed step: `src/server.js` applies migrations and
seeds the reference data on boot.

## 3. The production configuration

The config lives in a root-owned `EnvironmentFile` rather than a checked-out
`.env`, so it is what the service actually reads and a rebuild cannot change it.
`app/.env.production.example` is this exact set, annotated.

```bash
sudo install -m 640 -o root -g kampala /dev/null /etc/kampala-intel.env
openssl rand -base64 48      # paste into KIP_SESSION_SECRET below

sudo tee /etc/kampala-intel.env >/dev/null <<'EOF'
NODE_ENV=production
KIP_HOST=127.0.0.1
KIP_PORT=4310
KIP_TRUST_PROXY=true
KIP_DATA_DIR=/var/lib/kampala-intel
KIP_SESSION_SECRET=PASTE_THE_48_BYTE_VALUE
KIP_SESSION_TTL_HOURS=12
KIP_MIN_PASSWORD_LENGTH=12
KIP_K_THRESHOLD=5
KIP_ROTATION_DAYS=1
KIP_RAW_SEARCH_RETENTION_DAYS=7
KIP_EVENT_RETENTION_DAYS=90
KIP_LOG_LEVEL=warn
KIP_SEED_REFERENCE=true
KIP_SEED_CATALOGUE_DEMO=false
EOF
sudo chmod 640 /etc/kampala-intel.env
```

`NODE_ENV=production` matters: outside production the password-reset route returns
the reset token in its response body, because nothing sends mail yet.

## 4. systemd: server, maintenance, backup

```bash
sudo cp /srv/kampala-intel/deploy/kampala-intel.service \
        /srv/kampala-intel/deploy/kampala-intel-maintenance.{service,timer} \
        /srv/kampala-intel/deploy/kampala-intel-backup.{service,timer} \
        /etc/systemd/system/

# turn on the EnvironmentFile the unit ships commented out
sudo sed -i 's|^# EnvironmentFile=/etc/kampala-intel.env|EnvironmentFile=/etc/kampala-intel.env|' \
        /etc/systemd/system/kampala-intel.service

# The maintenance job is what enforces the retention windows, and it does NOT
# read the EnvironmentFile on its own. Without this line your
# KIP_RAW_SEARCH_RETENTION_DAYS=7 is ignored and the default 30 is used.
sudo sed -i '/^Environment=KIP_DATA_DIR/a EnvironmentFile=/etc/kampala-intel.env' \
        /etc/systemd/system/kampala-intel-maintenance.service

sudo systemctl daemon-reload
sudo systemctl enable --now kampala-intel.service
sudo systemctl enable --now kampala-intel-maintenance.timer kampala-intel-backup.timer
sudo systemctl status kampala-intel --no-pager
```

| Unit | When | What |
| --- | --- | --- |
| `kampala-intel.service` | always | The HTTP server. |
| `kampala-intel-maintenance.timer` | 03:17 nightly | Roll up demand, measure gaps, enforce retention. |
| `kampala-intel-backup.timer` | 03:47 nightly | Copy the database and verify the copy. |

`deploy/kampala-intel-harvest.{service,timer}` is a fourth, **opt-in** pair that re-reads the harvest
plans declaring a cadence, at 04:17. It is not installed above because it makes requests to third-party
sites: enable it only once the plans you want re-read say so with a `cadenceDays`, and read
[Keeping a source fresh](README.md#keeping-a-source-fresh) first.

## 5. nginx for the domain

```bash
sudo cp /srv/kampala-intel/deploy/nginx-kampala-intel.conf /etc/nginx/sites-available/kampala-intel
sudo sed -i 's/intel\.example\.ug/kbi.example.com/g; s#/etc/letsencrypt/live/[^/]*/#/etc/letsencrypt/live/kbi.example.com/#g' \
        /etc/nginx/sites-available/kampala-intel

# Get the certificate BEFORE the TLS server block can load: that block references
# a cert path that does not exist yet, so nginx would refuse the config. Standalone
# mode stops nginx for a moment; the hooks make renewals do the same.
sudo systemctl stop nginx || true
sudo certbot certonly --standalone -d kbi.example.com \
  --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" \
  --non-interactive --agree-tos -m you@example.com

sudo ln -sfn /etc/nginx/sites-available/kampala-intel /etc/nginx/sites-enabled/kampala-intel
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

The site already carries HSTS, a port-80 redirect, and per-endpoint rate limits
that match the app's own (tightest on sign-in).

## 6. The first operator account

There is no public sign-up and no mail transport, so every account is created
here. The password is passed through the environment, never as an argument.

```bash
cd /srv/kampala-intel/app
sudo -u kampala env KIP_DATA_DIR=/var/lib/kampala-intel \
  KIP_ADMIN_EMAIL=you@example.com \
  KIP_ADMIN_PASSWORD='a-long-unguessable-one' \
  KIP_ADMIN_PASSWORD_CONFIRM='a-long-unguessable-one' \
  node scripts/create-admin.js
```

Sign in at `https://kbi.example.com/operator.html`; the laboratory is at
`/lab.html`.

## 7. Verify

```bash
sudo journalctl -u kampala-intel -n 40 --no-pager
curl -sI http://kbi.example.com | head -1                 # expect 301 -> https
curl -fsS https://kbi.example.com/api/v1/meta             # the config in force
systemctl list-timers | grep kampala                      # 03:17 and 03:47
sudo ls -l /var/lib/kampala-intel/backups
```

`/api/v1/meta` reports the retention windows in force. If it shows
`rawSearchRetentionDays: 7`, the environment file is genuinely being read; if it
shows `30`, it is not.

## Operating it

**Update**
```bash
cd /srv/kampala-intel && sudo -u kampala git pull
cd app && sudo -u kampala npm ci --omit=dev
sudo systemctl restart kampala-intel
```

**Restore** (stop the server first)
```bash
cd /srv/kampala-intel/app
sudo -u kampala env KIP_DATA_DIR=/var/lib/kampala-intel node scripts/restore.js --list
sudo -u kampala env KIP_DATA_DIR=/var/lib/kampala-intel node scripts/restore.js --file <name>
```

**Forgotten password**
```bash
cd /srv/kampala-intel/app
sudo -u kampala env KIP_DATA_DIR=/var/lib/kampala-intel \
  KIP_ADMIN_EMAIL=you@example.com KIP_ADMIN_PASSWORD='new-long-one' \
  node scripts/set-password.js
```

Backups live in `/var/lib/kampala-intel/backups`; that directory is on the same
disk as the database, so copy it off the host, or point `--dir` in the backup
unit at a mounted volume.

## PaaS deployment (Render)

The steps above assume a host you own: a sudo user, a package manager, systemd,
nginx. A platform-as-a-service gives you the same single Node process and the
same SQLite file without any of that. Use it when there is no VPS, or when you
would rather not patch one.

There are two shapes, and the difference is money:

- **Free** (`plan: free`, what `render.yaml` ships). No card, no monthly fee, and
  a custom domain. The catch is that free web services cannot attach a
  persistent disk, so SQLite lives on the container's own filesystem and every
  redeploy, restart or idle spin-down starts from an empty database. That is the
  right shape for a demonstration or a test.
- **Paid** (`plan: starter`, about $7/month). Adds a persistent disk, a shell and
  no idle spin-down, so the database survives redeploys and the runbook's
  `create-admin` step works. That is the shape for anything that must keep its
  data.

Everything below - the image, the entrypoint, the environment, the domain, the
in-process schedulers - is the same in both; only the plan line and the presence
of the disk differ, and the two places that change are called out.

The platform does the jobs that `certbot`, `nginx` and the reverse proxy did up
there: it terminates TLS, gives the service a hostname, and forwards public
traffic to a port inside the container. What it does **not** provide is a systemd
timer, which is the one thing below that has no direct equivalent.

### The three files that do it

| File | Role |
| --- | --- |
| `render.yaml` | The blueprint. Describes the service, its plan and its environment so the whole thing is reproduced from the repository rather than clicked together. |
| `app/Dockerfile` | The image. Already sets `NODE_ENV=production`, `KIP_HOST=0.0.0.0`, `KIP_PORT=4310` and `KIP_DATA_DIR=/data`. |
| `app/docker-entrypoint.sh` | Chowns the data directory and drops to `node`, the one non-obvious part, below. |

### Why there is an entrypoint

On a host, `/var/lib/kampala-intel` is created by an operator and owned by the
service user. A paid PaaS instead bind-mounts the persistent disk over `/data`,
and that mount arrives **root-owned**, whatever the image did at build time. The
image used to run as the unprivileged `node` user, so `better-sqlite3` could not
create `kampala.db` and the process died at boot with `SQLITE_CANTOPEN` — a
failure that looks like a code bug and is entirely a permissions one.

The container therefore starts as root, and `docker-entrypoint.sh` `chown`s
`$KIP_DATA_DIR` (best effort, since it may already be correct) and then drops to
`node` before the app runs, using `setpriv`. The app itself never runs as root.
On the free plan there is no mounted disk, so the directory is created inside the
container and the `chown` is a no-op - the script stays the same either way, and
`docker compose` is unaffected because it sets `user: node` itself.

### Deploy

1. Push this repository to GitHub (Render deploys from a git remote).
2. Sign in at `https://dashboard.render.com` (GitHub login is fine). If GitHub
   is not connected yet: avatar -> **Account Settings** -> **GitHub** ->
   **Connect**, authorize, and grant access to `skycomtec-cyber/kampala-businesses-intel`.
3. **New +** -> **Blueprint** -> **Connect a repository** -> pick
   `skycomtec-cyber/kampala-businesses-intel`. (If it is not listed, **Configure
   account** -> add the repository.) Render reads `render.yaml` and previews the
   service: **kampala-intel**, region **Frankfurt**, plan **Free**, built from
   `app/Dockerfile` with `app/` as the build context.
4. Before applying, edit the two variables that need a decision (the rest are
   generated): set **`KIP_ADMIN_EMAIL`** to your real address in place of the
   `you@example.com` placeholder, and leave **`KIP_ADMIN_PASSWORD`** and
   **`KIP_SESSION_SECRET`** on **Generate**.
5. **Apply** / **Deploy Blueprint**. The first Docker build takes a few minutes;
   the status goes **Building -> Deploying -> Live**. If it fails, open the
   service's **Logs** tab.
6. **Live** means the health check `/api/v1/meta` answered, which is only answered
   once migrations and the reference seed have finished — so a green deploy means
   a working database.

To do it without the blueprint, create a **Web Service** by hand with Language
`Docker`, Dockerfile Path `app/Dockerfile`, **Docker Build Context Directory**
`app`, and add the variables yourself. Pick plan **Free** for a test, or
**Starter** and add a 1 GB disk at `/data` to keep the database across redeploys.

### The environment

`render.yaml` sets eight values; the image already sets the rest.

| Variable | Value | Why |
| --- | --- | --- |
| `PORT` | `4310` | The port Render forwards to. It must equal the `KIP_PORT` the image binds; Render's own default is `10000` and a mismatch means a service that builds, runs and answers nothing. |
| `KIP_TRUST_PROXY` | `true` | Render's router sets `X-Forwarded-For`/`X-Forwarded-Proto`. This is the same reason step 3 sets it: without a real proxy in front the per-IP sign-in limiter can be spoofed, and the session cookie is only marked `Secure` when `request.protocol` is `https`. |
| `KIP_SEED_CATALOGUE_DEMO` | `false` | A public install must not carry the demonstration record. |
| `KIP_OPS_SCHEDULE` | `true` | There is no systemd timer here, so the server runs its own nightly maintenance and backup. See "Scheduled work" below. |
| `KIP_HARVEST_SCHEDULE` | `true` | No timer for harvest; the server re-harvests plans that declare a cadence. Only set after reviewing plans and sources. |
| `KIP_SESSION_SECRET` | generated | Render generates and keeps it, so a redeploy does not sign every operator out. |
| `KIP_ADMIN_EMAIL` | you@example.com | The first operator account, created at boot because the free plan has no shell to run `create-admin`. Edit before deploying. |
| `KIP_ADMIN_PASSWORD` | generated | The password for that account. Render generates it; read it back from the Environment tab to sign in, then change it. |

`KIP_HOST=0.0.0.0` comes from the image. On the host the config sets
`127.0.0.1` because nginx shares the loopback; here the router reaches the
container across the network, and binding loopback would make the service
unreachable.

### The domain

In the Render dashboard, open the service -> **Settings -> Custom Domains -> Add
Custom Domain**, and enter `kbi.kampalabiz.space`. Render replies with a target
of the form `<service>.onrender.com`; copy the exact value it shows, because the
service name is its own.

At the DNS provider (`kampalabiz.space` is hosted by `dns1-4.supremedns.com`;
the DNS may also be edited wherever that zone lives) make these changes. The
work is all on the `kbi` label — leave the apex, `www` and the mail hosts alone:

| Host | Type | Value | TTL | Action |
| --- | --- | --- | --- | --- |
| `kbi` | `A` | `198.23.48.242` | (current) | **Delete** — the old, dead host |
| `kbi` | `AAAA` | *(if one exists)* | — | **Delete** — a `CNAME` cannot share the name |
| `kbi` | `CNAME` | `kampala-intel.onrender.com` | 3600 | **Add** — use the exact target Render shows |
| `kbi` | `MX` | `mx1.supremebox.com`, `mx2.supremebox.com` | (current) | **Decide** — delete unless you receive mail at `…@kbi.kampalabiz.space` |

A `CNAME` cannot coexist with any other record on the same name, so the `A` and
any `AAAA` must go with it. The apex (`kampalabiz.space`) cannot be a `CNAME`,
which is why the app lives on the `kbi` label; the apex continues to serve
whatever it served before. Once the record resolves, click **Verify** (and verify
the certificate) and Render issues TLS on its own — there is no `certbot` step.
Propagation is usually minutes; if **Verify** stalls, confirm the TTL and that no
`AAAA` is left on `kbi`.

### The first operator account

The free plan has **no shell**, so `create-admin` cannot be run there. That is
why `render.yaml` carries `KIP_ADMIN_EMAIL` and a generated `KIP_ADMIN_PASSWORD`:
the server reads them at boot and creates the account when there is not one yet
(`seedAdmin` in `src/seed/index.js`). It is gated on there being no accounts
yet, so those variables never reset or replace a real operator afterwards.

To sign in on the free plan:

1. Open the service's **Environment** tab, copy the value of `KIP_ADMIN_PASSWORD`
   (Render generated it and kept it), and edit `KIP_ADMIN_EMAIL` to the address
   you want if the placeholder is still there. Setting an env var redeploys.
2. Sign in at `https://kbi.kampalabiz.space/operator.html` and change the
   password (the account is created with a password you did not choose).

The generated password is a random value, so it satisfies the strength rule in
practice. If a boot log ever says the password was rejected, set
`KIP_ADMIN_PASSWORD` yourself to something with upper and lower case, a digit or
a symbol, and let it redeploy; the account is created on that boot instead.

A **Starter** plan includes a shell, which opens in the image's working
directory (`/srv/kampala`, the app root), so there the same command as step 6
also works if you would rather not set the variables:

```bash
KIP_ADMIN_EMAIL=you@example.com \
KIP_ADMIN_PASSWORD='a-long-unguessable-one' \
node scripts/create-admin.js
```

### Verify

```bash
curl -fsS https://kbi.kampalabiz.space/api/v1/meta   # the config in force
```

`"environment":"production"` proves `NODE_ENV` took effect, and the retention
numbers prove the environment is being read at all. The Render dashboard shows
the same request in the service's logs.

### Scheduled work, run from inside the server

The server runbook runs two timers: `kampala-intel-maintenance` at 03:17, which
rolls up demand, measures gaps and enforces the retention windows, and
`kampala-intel-backup` at 03:47. A platform has no timer and a Render **Cron Job**
cannot supply one - cron jobs cannot mount the service's disk, so they would have
no way to reach `kampala.db`. So here the server does the work itself.

`render.yaml` sets `KIP_OPS_SCHEDULE=true`, and `src/server.js` then starts a
scheduler (`src/ops/scheduler.js`) that runs the same two jobs
`scripts/maintenance.js` and `scripts/backup.js` run on the host. It is off unless
that variable is set, precisely so the host path - which already has the timers -
does not do the work twice.

Three things about it are worth knowing:

- **Due-ness is a timestamp on disk**, not process uptime. The last run is written
  to `<KIP_DATA_DIR>/.ops-state.json`, so a redeploy resumes the cadence instead
  of restarting it. A process that measured the interval from boot would roll up
  never on a service that redeploys twice a day.
- **The cadence is one day** (`KIP_OPS_INTERVAL_HOURS`, default 24), which is the
  resolution the retention windows are measured in. A due run happens within ten
  minutes of becoming due; the check ticks more often than the interval so a
  restart does not miss its window.
- **A failed run still advances the clock** and records the error in the state
  file and the logs. The jobs are local database work, and a failure here is a
  persistent condition - a full disk - that retrying every ten minutes would only
  repeat. This is deliberately the opposite of the harvest scheduler, where a
  failed run does *not* reset a source's cadence because the thing being retried
  is a third party's page and soon-retried is cheap.

Retention is therefore enforced on a platform with no timer, and `/api/v1/meta`
reports windows that a job actually honours. The one thing that is still the
operator's job is the **off-host copy**. On a paid plan Render keeps automatic
daily snapshots of the disk, which is the copy the VPS note says to make, while
the in-process backup writes to `/data/backups` on the same disk and carries the
same caveat as the end of the runbook above. **On the free plan there is no disk
and therefore no snapshot**: the data, the state file and the backup all live in
the container and all vanish on redeploy or spin-down. Treat that plan as a
demonstration and take a copy of anything you care about before it restarts.

`KIP_HARVEST_SCHEDULE=true` also runs the harvest scheduler in-process; it scans
plans for due work, archives pages under `<KIP_DATA_DIR>/harvest-archive`, and
writes batch CSVs/manifest under `<KIP_DATA_DIR>/harvest-batches`. Only plans
with `cadenceDays` and registered sources are harvested. Logs show
`self-scheduled harvesting is on` and `scheduled harvest check failed` when
appropriate.

To confirm it ran, the service log shows `scheduled maintenance finished` and
`scheduled backup finished` once a day; `<KIP_DATA_DIR>/.ops-state.json` records
the last run in a shell. The harvest scheduler has no single state file (due-ness
is per plan from the catalogue).

### Updating

The blueprint deploys automatically on a push to the default branch, so an update
is `git push`; there is no `git pull` and `systemctl restart`. A deploy briefly
restarts the single instance rather than rolling, which is fine for an install of
this size. On the free plan a deploy also **resets the database**, since the
container's filesystem is the only store; on a paid plan with the disk attached
the data survives the restart.

A stop that is force-killed — the platform's grace period expiring, an
out-of-memory kill — leaves the data directory's `.lock` behind. That does not
block the next deploy: the server treats a lock naming its own pid as stale,
because a fresh container hands it the same small pid again, so it reclaims the
directory rather than refusing to start. A lock naming a *different* live pid is
still honoured, so a genuine second server is still refused. The server also
destroys idle connections on shutdown, so a normal deploy does not overrun the
grace period and leave a lock in the first place.

### Checking the image before Render does

The same build runs locally, which is the fastest way to catch a Dockerfile
mistake before a failed deploy:

```bash
docker build -t kampala-intel ./app
docker run --rm -p 4310:4310 -v kip-data:/data kampala-intel
```

A fresh named volume is *not* that reproduction, because Docker copies the
image's ownership into it: `/data` arrives `node`-owned and the app writes to it
whether or not the entrypoint ran. To actually see the failure the entrypoint
prevents, make the mount one the container's `node` user does not own — on Linux
a bind mount to a directory created by root, or chown the volume first:

```bash
docker run --rm -v kip-data:/data alpine chown -R root:root /data
docker run --rm -p 4310:4310 -v kip-data:/data kampala-intel   # boots anyway
```

The image is not Render-specific; Railway and Fly.io run it unchanged, given a
volume at `/data` and the same four variables. Railway asks for a `TXT` record
alongside the `CNAME` when you attach the domain; Render does not.
