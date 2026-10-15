# Deploying Kampala Businesses Intel on a server

This is the concrete production runbook: a fresh Ubuntu/Debian host, a systemd
service, and nginx terminating TLS in front of it. It assumes a domain whose DNS
already points at the host. Everything it uses ships in this repository.

For a fast-and-disposable public link instead, see the Cloudflare-tunnel sharing
in `ENVIRONMENT`; for the annotated list of every setting, see `app/.env.example`
and `app/.env.production.example`. `README.md` covers backups, restore and the
nightly work in more depth.

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
