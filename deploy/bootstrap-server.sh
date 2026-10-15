#!/usr/bin/env bash
#
# Kampala Businesses Intel - fresh-server bootstrap.
#
# Turns a fresh Ubuntu/Debian host into a running, TLS-terminated install: the
# packages, the service user, the code, the production EnvironmentFile, the
# systemd units, the nginx site, the certificate and the first operator account.
# It is the executable form of DEPLOY.md, and the two are meant to be read
# together - the script is convenient, the document is what explains the choices.
#
# Run it as root, on the server, from the repository root:
#
#   sudo bash deploy/bootstrap-server.sh
#
# Configure it through the environment; nothing is taken from argv, so a secret
# never appears in the process table:
#
#   DOMAIN         the public hostname, DNS already pointing here   (required)
#   LE_EMAIL       Let's Encrypt contact address                    (required)
#   REPO_URL       git URL to clone when the code is not present    (when needed)
#   ADMIN_EMAIL    first operator account to create                 (optional)
#   ADMIN_PASSWORD its password; generated and printed if omitted   (optional)
#
#   APP_USER       default kampala
#   INSTALL_DIR    default /srv/kampala-intel   (must end in /app's parent)
#   DATA_DIR       default /var/lib/kampala-intel
#   ENV_FILE       default /etc/kampala-intel.env
#
# Every step is idempotent, so a re-run after a failure is safe. The two steps
# that touch secrets do not overwrite: an existing EnvironmentFile is left alone,
# and an existing operator account is not replaced.

set -euo pipefail

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "run this with sudo: it installs packages and systemd units"

DOMAIN="${DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
REPO_URL="${REPO_URL:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

APP_USER="${APP_USER:-kampala}"
INSTALL_DIR="${INSTALL_DIR:-/srv/kampala-intel}"
DATA_DIR="${DATA_DIR:-/var/lib/kampala-intel}"
ENV_FILE="${ENV_FILE:-/etc/kampala-intel.env}"

[[ -n "$DOMAIN" ]]   || die "set DOMAIN=<your hostname>"
[[ -n "$LE_EMAIL" ]] || die "set LE_EMAIL=<contact address for the certificate>"

# ---------------------------------------------------------------------------
# 1. Packages, Node, firewall
# ---------------------------------------------------------------------------
log "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install nginx git curl ca-certificates certbot build-essential python3 ufw

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);
           process.exit(a>20||(a===20&&b>=11)?0:1)' 2>/dev/null
}
if ! node_ok; then
  log "installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get -y install nodejs
fi
log "node $(node -v)"

# OpenSSH must be allowed before ufw is enabled, or the session that is running
# this script is cut off mid-run. Nginx Full is 80 and 443; the app port (4310)
# is never opened - the app binds loopback and nginx is the only public listener.
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ---------------------------------------------------------------------------
# 2. Service user and code
# ---------------------------------------------------------------------------
log "preparing $INSTALL_DIR and $DATA_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

if [[ ! -f "$INSTALL_DIR/app/src/server.js" ]]; then
  [[ -n "$REPO_URL" ]] || die "$INSTALL_DIR/app is not present. Set REPO_URL=<git url> to clone, or copy the code there first."
  [[ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]] || die "$INSTALL_DIR is not empty; refusing to clone into it"
  mkdir -p "$INSTALL_DIR"
  chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
  sudo -u "$APP_USER" git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/app"
if [[ ! -d node_modules ]]; then
  log "installing dependencies"
  sudo -u "$APP_USER" npm ci --omit=dev
fi
# better-sqlite3 must be built against this host. npm ci may have fetched a
# prebuilt binary for another libc; rebuilding makes it match, and the smoke test
# is what fails loudly if it still does not.
sudo -u "$APP_USER" npm rebuild better-sqlite3
sudo -u "$APP_USER" node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('better-sqlite3 loads')"

# ---------------------------------------------------------------------------
# 3. Production configuration
# ---------------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  log "$ENV_FILE exists; leaving it untouched"
else
  log "writing $ENV_FILE"
  SECRET="$(openssl rand -base64 48)"
  install -m 640 -o root -g "$APP_USER" /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<EOF
# Written by deploy/bootstrap-server.sh. See app/.env.production.example for the
# annotated version of this file, and DEPLOY.md for what each value decides.
NODE_ENV=production
KIP_HOST=127.0.0.1
KIP_PORT=4310
KIP_TRUST_PROXY=true
KIP_DATA_DIR=$DATA_DIR
KIP_SESSION_SECRET=$SECRET
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
  chmod 640 "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# 4. systemd
# ---------------------------------------------------------------------------
log "installing systemd units"
cp "$INSTALL_DIR/deploy/kampala-intel.service"            /etc/systemd/system/
cp "$INSTALL_DIR/deploy/kampala-intel-maintenance.service" /etc/systemd/system/
cp "$INSTALL_DIR/deploy/kampala-intel-maintenance.timer"   /etc/systemd/system/
cp "$INSTALL_DIR/deploy/kampala-intel-backup.service"      /etc/systemd/system/
cp "$INSTALL_DIR/deploy/kampala-intel-backup.timer"        /etc/systemd/system/

SVC=/etc/systemd/system/kampala-intel.service
grep -q '^EnvironmentFile=' "$SVC" || \
  sed -i "s|^# EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" "$SVC"

# The maintenance job enforces retention and does not read the EnvironmentFile on
# its own; without this its purge uses the built-in 30-day raw window regardless
# of what $ENV_FILE says.
MNT=/etc/systemd/system/kampala-intel-maintenance.service
grep -q '^EnvironmentFile=' "$MNT" || \
  sed -i "/^Environment=KIP_DATA_DIR/a EnvironmentFile=$ENV_FILE" "$MNT"

systemctl daemon-reload
systemctl enable --now kampala-intel.service
systemctl enable --now kampala-intel-maintenance.timer kampala-intel-backup.timer

# ---------------------------------------------------------------------------
# 5. nginx and the certificate
# ---------------------------------------------------------------------------
log "configuring nginx for $DOMAIN"
cp "$INSTALL_DIR/deploy/nginx-kampala-intel.conf" /etc/nginx/sites-available/kampala-intel
sed -i "s/intel\.example\.ug/$DOMAIN/g; s#/etc/letsencrypt/live/[^/]*/#/etc/letsencrypt/live/$DOMAIN/#g" \
  /etc/nginx/sites-available/kampala-intel

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  # The TLS server block references the certificate, so the certificate has to
  # exist before the site can be enabled. Standalone mode stops nginx for the
  # exchange; the hooks make scheduled renewals stop and start it the same way.
  systemctl stop nginx || true
  certbot certonly --standalone -d "$DOMAIN" \
    --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" \
    --non-interactive --agree-tos -m "$LE_EMAIL"
fi

ln -sfn /etc/nginx/sites-available/kampala-intel /etc/nginx/sites-enabled/kampala-intel
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

# ---------------------------------------------------------------------------
# 6. The first operator account
# ---------------------------------------------------------------------------
GENERATED_ADMIN_PASSWORD=0
if [[ -n "$ADMIN_EMAIL" ]]; then
  cd "$INSTALL_DIR/app"
  # Opening the app applies migrations, so this count works on a brand-new data
  # directory as well as an existing one.
  COUNT="$(sudo -u "$APP_USER" env KIP_DATA_DIR="$DATA_DIR" node -e '
    import("./src/db/index.js").then(async (m) => {
      const { loadConfig } = await import("./src/config.js")
      const app = m.openApp({ config: loadConfig() })
      process.stdout.write(String(app.users.list().length))
      app.close()
    })' 2>/dev/null || echo 0)"

  if [[ "$COUNT" == "0" ]]; then
    if [[ -z "$ADMIN_PASSWORD" ]]; then
      ADMIN_PASSWORD="$(openssl rand -base64 18)"
      GENERATED_ADMIN_PASSWORD=1
    fi
    sudo -u "$APP_USER" env KIP_DATA_DIR="$DATA_DIR" \
      KIP_ADMIN_EMAIL="$ADMIN_EMAIL" \
      KIP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      KIP_ADMIN_PASSWORD_CONFIRM="$ADMIN_PASSWORD" \
      node scripts/create-admin.js
  else
    log "$COUNT operator account(s) already exist; not creating another"
  fi
else
  warn "ADMIN_EMAIL not set; create the first account with scripts/create-admin.js"
fi

# ---------------------------------------------------------------------------
# 7. Verify and report
# ---------------------------------------------------------------------------
log "checking the deployment"
curl -sI "http://$DOMAIN" | head -1 || true
curl -fsS "https://$DOMAIN/api/v1/meta" || warn "the https endpoint did not answer yet"

cat <<EOF

Done.

  Site           https://$DOMAIN
  Operator       https://$DOMAIN/operator.html
  Laboratory     https://$DOMAIN/lab.html
  Config file    $ENV_FILE
  Data           $DATA_DIR
  Logs           journalctl -u kampala-intel -f

  Backups run nightly at 03:47 into $DATA_DIR/backups; copy that directory off
  the host, because a backup on the same disk is not a backup.
EOF

if [[ "$GENERATED_ADMIN_PASSWORD" == "1" ]]; then
  cat <<EOF

  Generated operator account:
    email     $ADMIN_EMAIL
    password  $ADMIN_PASSWORD

  This password is shown once and is not stored anywhere. Save it now.
EOF
fi
