# shellcheck shell=bash
# shellcheck disable=SC2034  # globals here are read by the sourcing script or indirectly via ${!ref}
#
# Native mode: prerequisites, database, build, migrate, services, health.
#
# What mirrors Docker, and where:
#   postgres    a dedicated PostgreSQL 16 cluster owned by this user, with
#               POSTGRES_USER as its superuser and database owner — what the
#               postgres:16 image does with the same variables. Or, with
#               consent, a role and database on an existing 16 server.
#   read-only   nothing to create: the dashboard enforces it per connection
#               (apps/web/src/lib/db.ts:35), not through a role (§3).
#   build       the order the Dockerfiles use: schema, then each app with its
#               workspace dependencies (`--filter "<app>..."`), then web.
#   migrate     the migrate service's own command, migrate.js up.
#   services    one user-level unit each, bound to 127.0.0.1 (D4, F2).

AP_NODE_BIN=""
AP_PNPM=""
AP_PG_BIN=""
AP_PG_MODE=own          # own | reuse
AP_PG_ADMIN_URL=${AGENTPULSE_PG_ADMIN_URL:-}
AP_PKG=""
AP_MISSING=""
AP_BUILT=false
AP_ENV_CHANGED=false

# Pins read from the repo, not remembered: every service image is built FROM
# node:<major> (apps/*/Dockerfile), and package.json names the package manager.
node_major_pinned() {
  sed -n 's/^FROM node:\([0-9][0-9]*\).*/\1/p' "$AP_ROOT/apps/collector/Dockerfile" | head -1
}

pnpm_version_pinned() {
  sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$AP_ROOT/package.json" | head -1
}

native_home() {
  if [[ $AP_OS == darwin ]]; then
    printf '%s/Library/Application Support/%s' "$HOME" "$AP_INSTANCE"
  else
    printf '%s/%s' "${XDG_DATA_HOME:-$HOME/.local/share}" "$AP_INSTANCE"
  fi
}
native_pgdata() { printf '%s/pgdata' "$(native_home)"; }
native_cluster_exists() { [[ -f "$(native_pgdata)/PG_VERSION" ]]; }

native_supported() {
  case "$AP_OS" in
    darwin) command -v launchctl >/dev/null 2>&1 ;;
    linux | wsl)
      command -v systemctl >/dev/null 2>&1 || return 1
      # Arriving through su, sudo -iu or an exec leaves no XDG_RUNTIME_DIR, and
      # without it systemctl --user cannot find a user manager that is running.
      if [[ -z ${XDG_RUNTIME_DIR:-} && -d /run/user/$(id -u) ]]; then
        XDG_RUNTIME_DIR=/run/user/$(id -u)
        export XDG_RUNTIME_DIR
      fi
      systemctl --user show-environment >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
node_major_of() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true; }

brew_prefix_of() {
  command -v brew >/dev/null 2>&1 && brew --prefix "$1" 2>/dev/null || true
}

# The newest nvm-installed <major>.x, if any.
nvm_node() {
  local n last=""
  for n in "$HOME"/.nvm/versions/node/v"$1".*/bin/node; do [[ -x $n ]] && last=$n; done
  printf '%s' "$last"
}

find_node() {
  local want c candidates
  want=$(node_major_pinned)
  candidates="$(command -v node 2>/dev/null || true)
$(brew_prefix_of "node@$want")/bin/node
/opt/homebrew/opt/node@$want/bin/node
/usr/local/opt/node@$want/bin/node
$(nvm_node "$want")"
  while IFS= read -r c; do
    [[ -n $c && -x $c ]] || continue
    if [[ $(node_major_of "$c") == "$want" ]]; then AP_NODE_BIN=$c; return 0; fi
  done <<< "$candidates"
  return 1
}

# pnpm itself when it is the pinned version; otherwise corepack, which ships
# with Node and honours package.json's packageManager without a global install.
find_pnpm() {
  local want corepack
  want=$(pnpm_version_pinned)
  if command -v pnpm >/dev/null 2>&1 && [[ $(pnpm -v 2>/dev/null) == "$want" ]]; then
    AP_PNPM=$(command -v pnpm)
    return 0
  fi
  corepack=$(dirname "$AP_NODE_BIN")/corepack
  if [[ -x $corepack ]]; then AP_PNPM="$corepack pnpm"; return 0; fi
  return 1
}

pg_major_of() { "$1/postgres" -V 2>/dev/null | sed -n 's/.*PostgreSQL) \([0-9][0-9]*\).*/\1/p'; }

# Refuses any major but 16 unless AGENTPULSE_PG_ANY_MAJOR=1: pg_dump output and
# the data directory are major-specific, and 16 is what compose runs.
find_pg() {
  local d candidates tool ok
  candidates="$(command -v pg_config >/dev/null 2>&1 && pg_config --bindir 2>/dev/null || true)
$(brew_prefix_of postgresql@16)/bin
/opt/homebrew/opt/postgresql@16/bin
/usr/local/opt/postgresql@16/bin
/usr/lib/postgresql/16/bin
/usr/pgsql-16/bin
/usr/bin"
  while IFS= read -r d; do
    [[ -n $d && -x $d/postgres ]] || continue
    ok=true
    for tool in initdb psql pg_dump pg_isready; do [[ -x $d/$tool ]] || ok=false; done
    [[ $ok == true ]] || continue
    if [[ $(pg_major_of "$d") == 16 || ${AGENTPULSE_PG_ANY_MAJOR:-} == 1 ]]; then
      AP_PG_BIN=$d
      return 0
    fi
  done <<< "$candidates"
  return 1
}

detect_pkg_manager() {
  if [[ $AP_OS == darwin ]]; then
    command -v brew >/dev/null 2>&1 && AP_PKG=brew
  elif command -v apt-get >/dev/null 2>&1; then AP_PKG=apt
  elif command -v dnf >/dev/null 2>&1; then AP_PKG=dnf
  elif command -v pacman >/dev/null 2>&1; then AP_PKG=pacman
  elif command -v brew >/dev/null 2>&1; then AP_PKG=brew
  fi
}

apt_has() { [[ $(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ { print $2 }') =~ ^[0-9] ]]; }
dnf_has() { dnf list --available "$1" >/dev/null 2>&1 || dnf list --installed "$1" >/dev/null 2>&1; }

# The package command for <node|postgres>, or nothing when this platform has no
# package that is known to carry the pinned major.
pkg_command() {
  local want
  want=$(node_major_pinned)
  case "$AP_PKG:$1" in
    brew:node) printf 'brew install node@%s' "$want" ;;
    brew:postgres) printf 'brew install postgresql@16' ;;
    apt:node)
      local candidate
      candidate=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2 }')
      candidate=${candidate#*:}
      [[ $candidate == "$want".* ]] && printf 'sudo apt-get install -y nodejs'
      ;;
    apt:postgres) apt_has postgresql-16 && printf 'sudo apt-get install -y postgresql-16' ;;
    dnf:node) dnf_has "nodejs$want" && printf 'sudo dnf install -y nodejs%s' "$want" ;;
    dnf:postgres) dnf_has postgresql16-server && printf 'sudo dnf install -y postgresql16-server postgresql16' ;;
    pacman:node) [[ $want == 20 ]] && printf 'sudo pacman -S --needed nodejs-lts-iron' ;;
  esac
  return 0
}

# Installs only with an explicit yes. --yes is not consent to change the
# system, so it never installs a package.
offer_install() { # <node|postgres> <what>
  local cmd
  # Removing AgentPulse is no reason to install anything.
  [[ ${AP_ACTION:-install} != uninstall ]] || return 1
  cmd=$(pkg_command "$1")
  if [[ -z $cmd ]]; then
    # A fresh container or cloud image often ships with no package lists at
    # all, which reads as "no such package" rather than "not updated yet".
    if [[ $AP_PKG == apt ]] && ! ls /var/lib/apt/lists/*_Packages >/dev/null 2>&1; then
      info "  $2 is missing, and apt has no package lists yet. Run: sudo apt-get update — then re-run."
    else
      info "  $2 is missing and no ${AP_PKG:-supported} package is known to provide it."
    fi
    return 1
  fi
  if [[ $AP_YES == true || $AP_DRY_RUN == true ]]; then
    info "  $2 is missing. Install it with: $cmd"
    return 1
  fi
  info "  $2 is missing. It can be installed with:"
  info "      $cmd"
  ask_yes_no "  Run that now?" n || return 1
  ap_log "package install: $cmd"
  # shellcheck disable=SC2086  # a command line built from fixed words
  $cmd
}

native_prereqs() {
  local want
  detect_pkg_manager
  AP_MISSING=""
  want=$(node_major_pinned)
  if find_node || { offer_install node "Node $want" && find_node; }; then
    info "  node        $("$AP_NODE_BIN" -v) ($AP_NODE_BIN)"
    if find_pnpm; then
      info "  pnpm        $AP_PNPM (repo pins $(pnpm_version_pinned))"
    else
      AP_MISSING="${AP_MISSING}pnpm $(pnpm_version_pinned) (or corepack beside node)"$'\n'
    fi
  else
    AP_MISSING="${AP_MISSING}Node $want (https://nodejs.org, or: nvm install $want)"$'\n'
  fi
  if find_pg || { offer_install postgres "PostgreSQL 16" && find_pg; }; then
    info "  postgres    $("$AP_PG_BIN/postgres" -V) ($AP_PG_BIN)"
  else
    AP_MISSING="${AP_MISSING}PostgreSQL 16 server binaries (initdb, postgres, psql, pg_dump, pg_isready)"$'\n'
  fi
  if command -v git >/dev/null 2>&1; then info "  git         ok"; else info "  git         missing (optional today: nothing calls it yet)"; fi
  [[ -z $AP_MISSING ]]
}

native_preflight() {
  if ! native_supported; then
    case "$AP_OS" in
      darwin) fail "launchctl not found; native mode needs launchd." ;;
      linux | wsl) fail "native mode needs a systemd user manager (systemctl --user). Log in normally (not via su), or run: sudo loginctl enable-linger \"\$USER\". On WSL2, enable systemd in /etc/wsl.conf." ;;
      *) fail "native mode supports Linux (systemd), macOS (launchd) and Windows via WSL2 only." ;;
    esac
    return 1
  fi
  if ! native_prereqs; then
    if [[ $AP_DRY_RUN == true ]]; then
      info "  missing (a real run stops here):"
      printf '%s' "$AP_MISSING" | sed 's/^/    - /'
      return 0
    fi
    fail "missing prerequisites:"
    printf '%s' "$AP_MISSING" | sed 's/^/  - /' >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
url_decode() {
  local s=${1//+/ }
  printf '%b' "${s//%/\\x}"
}

# postgres://user:pass@host:port/db → PG_URL_{USER,PASS,HOST,PORT,DB}
parse_pg_url() {
  local re='^postgres(ql)?://([^:@/]*)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]*)'
  [[ $1 =~ $re ]] || return 1
  PG_URL_USER=$(url_decode "${BASH_REMATCH[2]}")
  PG_URL_PASS=$(url_decode "${BASH_REMATCH[4]}")
  PG_URL_HOST=${BASH_REMATCH[5]}
  PG_URL_PORT=${BASH_REMATCH[7]:-5432}
  PG_URL_DB=${BASH_REMATCH[8]:-postgres}
}

# SQL goes in on stdin and the password in PGPASSWORD, never argv.
app_psql() { # <database> ; SQL on stdin
  PGPASSWORD=$(env_or_file POSTGRES_PASSWORD) PGCONNECT_TIMEOUT=5 \
    "$AP_PG_BIN/psql" -X -A -t -q -w -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$(env_or_file POSTGRES_HOST_PORT)" -U "$(env_or_file POSTGRES_USER)" -d "$1" -f -
}

# An administrator on an existing server: AGENTPULSE_PG_ADMIN_URL (process env
# only — it is never written anywhere), else this OS user on 127.0.0.1:5432
# without a password, which is how a Homebrew server is set up.
admin_psql() { # SQL on stdin
  if [[ -n $AP_PG_ADMIN_URL ]]; then
    parse_pg_url "$AP_PG_ADMIN_URL" || die "$AP_EXIT_PREFLIGHT" "AGENTPULSE_PG_ADMIN_URL is not a postgres:// URL"
    PGPASSWORD=$PG_URL_PASS PGCONNECT_TIMEOUT=5 "$AP_PG_BIN/psql" -X -A -t -q -w -v ON_ERROR_STOP=1 \
      -h "$PG_URL_HOST" -p "$PG_URL_PORT" -U "$PG_URL_USER" -d "$PG_URL_DB" -f -
  else
    PGCONNECT_TIMEOUT=5 "$AP_PG_BIN/psql" -X -A -t -q -w -v ON_ERROR_STOP=1 \
      -h 127.0.0.1 -p 5432 -U "$(id -un)" -d postgres -f -
  fi
}

admin_port() {
  if [[ -n $AP_PG_ADMIN_URL ]] && parse_pg_url "$AP_PG_ADMIN_URL"; then printf '%s' "$PG_URL_PORT"; else printf 5432; fi
}

# "160004 t" from a reachable server where we are superuser.
admin_probe() {
  # A boolean cast to text is 'true', not 't'; spell the answer out.
  printf "select current_setting('server_version_num') || ' ' || case when rolsuper then 't' else 'f' end from pg_roles where rolname = current_user;\n" |
    admin_psql 2>/dev/null
}

# Own cluster by default. Reuse needs an administrator connection and a yes;
# once chosen, the state file keeps it, so a re-run never switches.
native_choose_pg() {
  local previous probe num
  previous=$(state_get "$AP_STATE_FILE" pg_mode)
  if [[ -n $previous ]]; then
    AP_PG_MODE=$previous
  elif [[ -n $AP_PG_BIN ]] && { [[ -n $AP_PG_ADMIN_URL ]] || [[ $AP_YES != true ]]; }; then
    probe=$(admin_probe || true)
    num=${probe%% *}
    if [[ -n $probe && ${probe##* } == t ]]; then
      if [[ $((num / 10000)) != 16 && ${AGENTPULSE_PG_ANY_MAJOR:-} != 1 ]]; then
        info "  found PostgreSQL $((num / 10000)) on port $(admin_port); only 16 is reused (AGENTPULSE_PG_ANY_MAJOR=1 overrides)"
      elif [[ -n $AP_PG_ADMIN_URL ]] ||
        ask_yes_no "  A PostgreSQL 16 server is running on 127.0.0.1:$(admin_port). Create the AgentPulse role and database on it, instead of a dedicated cluster?" n; then
        AP_PG_MODE=reuse
      fi
    elif [[ -n $AP_PG_ADMIN_URL ]]; then
      die "$AP_EXIT_PREFLIGHT" "AGENTPULSE_PG_ADMIN_URL does not reach a server as a superuser"
    fi
  fi
  if [[ $AP_PG_MODE == reuse ]]; then
    setv FORCE POSTGRES_HOST_PORT "$(state_get "$AP_STATE_FILE" pg_port)"
    [[ -n $(getv FORCE POSTGRES_HOST_PORT) ]] || setv FORCE POSTGRES_HOST_PORT "$(admin_port)"
    info "  database    existing PostgreSQL server on 127.0.0.1:$(getv FORCE POSTGRES_HOST_PORT)"
  else
    info "  database    dedicated cluster in $(native_pgdata)"
  fi
}

pg_wait_ready() {
  local deadline=$(($(date +%s) + AP_HEALTH_TIMEOUT))
  until "$AP_PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$(env_or_file POSTGRES_HOST_PORT)" -d postgres; do
    [[ $(date +%s) -lt $deadline ]] || return 1
    sleep 1
  done
}

# en_US.UTF-8 is what the postgres:16 image initialises with (its LANG), so
# sorting matches a Docker install. C is the fallback where it is not installed.
pg_locale() {
  if locale -a 2>/dev/null | grep -qiE '^en_US\.utf-?8$'; then
    locale -a | grep -iE '^en_US\.utf-?8$' | head -1
  else
    printf C
  fi
}

native_init_cluster() {
  local pgdata pwfile
  pgdata=$(native_pgdata)
  info "creating a PostgreSQL 16 cluster in $pgdata"
  ap_log "initdb $pgdata"
  (umask 077 && mkdir -p "$pgdata")
  pwfile=$(umask 077 && mktemp "$(native_home)/.pw.XXXXXX")
  AP_TMP_FILE=$pwfile
  printf '%s' "$(env_or_file POSTGRES_PASSWORD)" > "$pwfile"
  "$AP_PG_BIN/initdb" -D "$pgdata" -U "$(env_or_file POSTGRES_USER)" --pwfile="$pwfile" \
    --auth-local=scram-sha-256 --auth-host=scram-sha-256 -E UTF8 --locale="$(pg_locale)" >/dev/null
  rm -f "$pwfile"
  AP_TMP_FILE=""
  # Only for a cluster this installer created. TCP on loopback and no unix
  # socket at all: every client here connects to 127.0.0.1 with a password, and
  # a socket in a shared /tmp is one more way in.
  cat >> "$pgdata/postgresql.conf" <<'EOF'

# --- AgentPulse (install.sh) -------------------------------------------------
listen_addresses = 'localhost'
unix_socket_directories = ''
timezone = 'UTC'
log_timezone = 'UTC'
EOF
}

native_db_setup() {
  local user db pass have major
  user=$(env_or_file POSTGRES_USER)
  db=$(env_or_file POSTGRES_DB)
  if [[ $AP_PG_MODE == own ]]; then
    if native_cluster_exists; then
      major=$(cat "$(native_pgdata)/PG_VERSION")
      [[ $major == 16 || ${AGENTPULSE_PG_ANY_MAJOR:-} == 1 ]] ||
        die "$AP_EXIT_PREFLIGHT" "$(native_pgdata) is a PostgreSQL $major cluster; 16 is required"
    else
      native_init_cluster
    fi
    native_service postgres
    pg_wait_ready || { svc_logs postgres; die "$AP_EXIT_HEALTH" "postgres did not become ready"; }
    info "  postgres    ready on 127.0.0.1:$(env_or_file POSTGRES_HOST_PORT)"
  fi

  # Already working: nothing to create, and no administrator needed.
  if printf 'select 1;\n' | app_psql "$db" >/dev/null 2>&1; then return 0; fi

  if [[ $AP_PG_MODE == own ]]; then
    have=$(printf "select 1 from pg_database where datname = '%s';\n" "$db" | app_psql postgres) ||
      die "$AP_EXIT_PREFLIGHT" "cannot log in to the cluster as $user — POSTGRES_PASSWORD in .env no longer matches it"
    if [[ -z $have ]]; then
      info "creating database $db"
      ap_log "create database $db"
      printf 'create database %s owner %s;\n' "$db" "$user" | app_psql postgres
    fi
    return 0
  fi

  # Reuse: a role and database on someone else's server. An existing role of
  # that name is not ours to take over.
  have=$(printf "select 1 from pg_roles where rolname = '%s';\n" "$user" | admin_psql) ||
    die "$AP_EXIT_PREFLIGHT" "cannot reach the existing server as an administrator (set AGENTPULSE_PG_ADMIN_URL)"
  if [[ -n $have && $(state_get "$AP_STATE_FILE" pg_role_created) != yes ]]; then
    die "$AP_EXIT_PREFLIGHT" "a role named $user already exists on that server and this installer did not create it. Set POSTGRES_USER to another name."
  fi
  pass=$(env_or_file POSTGRES_PASSWORD)
  if [[ -z $have ]]; then
    info "creating role $user on the existing server"
    ap_log "create role $user"
    printf "create role %s login password '%s';\n" "$user" "${pass//\'/\'\'}" | admin_psql
  fi
  AP_PG_ROLE_CREATED=yes
  have=$(printf "select 1 from pg_database where datname = '%s';\n" "$db" | admin_psql)
  if [[ -z $have ]]; then
    info "creating database $db owned by $user"
    ap_log "create database $db"
    printf 'create database %s owner %s;\n' "$db" "$user" | admin_psql
  fi
  printf 'select 1;\n' | app_psql "$db" >/dev/null ||
    die "$AP_EXIT_PREFLIGHT" "role $user cannot log in to $db on the existing server (check its pg_hba.conf allows 127.0.0.1)"
}
AP_PG_ROLE_CREATED=""

# ---------------------------------------------------------------------------
# Build and migrate
# ---------------------------------------------------------------------------
native_artifacts_present() {
  [[ -f $AP_ROOT/packages/schema/dist/migrate.js &&
    -f $AP_ROOT/apps/collector/dist/main.js &&
    -f $AP_ROOT/apps/proxy/dist/main.js &&
    -f $AP_ROOT/apps/web/.next/standalone/apps/web/server.js ]]
}

# A plain re-run builds only what is missing — the counterpart of `up -d`
# building only missing images. --upgrade always rebuilds.
native_build() { # <force true|false>
  if [[ $1 != true ]] && native_artifacts_present; then
    info "  build       present (./install.sh --upgrade rebuilds)"
    return 0
  fi
  info ""
  info "Building (pnpm install --frozen-lockfile, then schema → collector, proxy → web)"
  ap_log "build"
  # shellcheck disable=SC2086  # AP_PNPM may be "corepack pnpm"
  (
    cd "$AP_ROOT"
    PATH="$(dirname "$AP_NODE_BIN"):$PATH"
    export PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
    $AP_PNPM install --frozen-lockfile
    $AP_PNPM --filter "@agentpulse/collector..." run build
    $AP_PNPM --filter "@agentpulse/proxy..." run build
    $AP_PNPM --filter @agentpulse/web run build
  ) || die "$AP_EXIT_PREFLIGHT" "the build failed; nothing was started or restarted"
  # The standalone server serves static assets from beside itself, where the
  # web Dockerfile copies them.
  rm -rf "$AP_ROOT/apps/web/.next/standalone/apps/web/.next/static"
  cp -R "$AP_ROOT/apps/web/.next/static" "$AP_ROOT/apps/web/.next/standalone/apps/web/.next/static"
  AP_BUILT=true
}

native_migrate() {
  local out
  info ""
  info "Migrating"
  ap_log "migrate.js up"
  if ! out=$(cd "$AP_ROOT" && DATABASE_URL=$(env_or_file DATABASE_URL) TZ=UTC \
    "$AP_NODE_BIN" packages/schema/dist/migrate.js up 2>&1); then
    printf '%s\n' "$out" | tail -50 | sed 's/^/  │ /'
    fail "migrate failed — no service that depends on it was started or restarted"
    exit "$AP_EXIT_HEALTH"
  fi
  printf '%s\n' "$out" | tail -3 | sed 's/^/  │ /'
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
svc_spec() { # <service>
  local nl=$'\n'
  AP_SVC_AFTER=""
  [[ $AP_PG_MODE == own ]] && AP_SVC_AFTER=postgres
  AP_SVC_ENVFILE=true
  AP_SVC_FORCE="TZ=UTC${nl}NODE_ENV=production"
  case "$1" in
    postgres)
      AP_SVC_AFTER=""
      AP_SVC_ENVFILE=false
      # Without a locale in its environment postgres on macOS dies at start
      # with "postmaster became multithreaded during startup" — launchd passes
      # none. Seen on this machine with Homebrew 16.15; its caveat says the same.
      AP_SVC_FORCE="LC_ALL=$(pg_locale)"
      AP_SVC_ARGV="$AP_PG_BIN/postgres$nl-D$nl$(native_pgdata)$nl-p$nl$(env_or_file POSTGRES_HOST_PORT)"
      ;;
    collector) AP_SVC_ARGV="$AP_NODE_BIN$nl$AP_ROOT/apps/collector/dist/main.js" ;;
    proxy) AP_SVC_ARGV="$AP_NODE_BIN$nl$AP_ROOT/apps/proxy/dist/main.js" ;;
    web)
      # Next's own bind variables (standalone server.js:9 reads HOSTNAME).
      AP_SVC_FORCE="$AP_SVC_FORCE${nl}HOSTNAME=127.0.0.1${nl}PORT=$(env_or_file WEB_HOST_PORT)${nl}NEXT_TELEMETRY_DISABLED=1"
      AP_SVC_ARGV="$AP_NODE_BIN$nl$AP_ROOT/apps/web/.next/standalone/apps/web/server.js"
      ;;
  esac
}

# Restarts when the unit changed, the build changed, or .env changed; a re-run
# with none of those leaves a running service alone.
native_service() { # <service>
  local changed=false restart=false
  svc_spec "$1"
  if svc_render "$1" | svc_write "$1"; then changed=true; fi
  if [[ $1 != postgres && ($AP_BUILT == true || $AP_ENV_CHANGED == true) ]]; then restart=true; fi
  svc_apply "$1" "$changed" "$restart"
}

native_app_services() { printf 'collector proxy web'; }
native_all_services() {
  if [[ $AP_PG_MODE == own ]]; then printf 'postgres collector proxy web'; else native_app_services; fi
}

native_port_is_ours() { # <var name> <port>
  case "$1" in
    POSTGRES_HOST_PORT) [[ $AP_PG_MODE == reuse ]] || svc_running postgres ;;
    COLLECTOR_HOST_PORT) svc_running collector ;;
    PROXY_HOST_PORT) svc_running proxy ;;
    WEB_HOST_PORT) svc_running web ;;
    *) return 1 ;;
  esac
}

native_wait_healthy() {
  local deadline=$(($(date +%s) + AP_HEALTH_TIMEOUT)) pending="collector proxy web" still svc port
  info ""
  info "Waiting for services (up to ${AP_HEALTH_TIMEOUT}s)"
  while :; do
    still=""
    for svc in $pending; do
      port=$(env_or_file "$(published_var "$svc")")
      if http_ok "$port"; then
        info "  $(printf '%-11s' "$svc") http://127.0.0.1:$port/healthz ok"
      else
        still="$still $svc"
      fi
    done
    pending=${still# }
    [[ -n $pending ]] || return 0
    if [[ $(date +%s) -ge $deadline ]]; then
      fail "not healthy after ${AP_HEALTH_TIMEOUT}s: $pending"
      for svc in $pending; do svc_logs "$svc"; done
      return 1
    fi
    sleep 2
  done
}

# Local addresses listening on <port>, one per line.
listen_addresses_of() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$1" 2>/dev/null | awk '{ print $4 }'
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p'
  fi
}

is_loopback() {
  case "$1" in
    127.0.0.1:* | 127.*:* | "[::1]:"* | ::1:* | localhost:*) return 0 ;;
  esac
  return 1
}

# The native counterpart of docker_verify_ports: every listener on each port
# must be loopback. A service found listening wider is stopped.
native_verify_ports() {
  local svc port addr bad="" any
  for svc in $(native_all_services); do
    port=$(env_or_file "$(published_var "$svc")")
    any=false
    while IFS= read -r addr; do
      [[ -n $addr ]] || continue
      any=true
      if ! is_loopback "$addr"; then
        bad="$bad $svc"
        fail "$svc: listening on $addr — must be 127.0.0.1 only"
      fi
    done <<< "$(listen_addresses_of "$port")"
    [[ $any == true ]] || { fail "$svc: nothing is listening on port $port"; bad="$bad $svc"; }
  done
  if [[ -n $bad ]]; then
    for svc in $bad; do [[ $svc == postgres ]] || svc_remove "$svc"; done
    fail "stopped and removed:$bad"
    return 1
  fi
  info "  ports       all listening on 127.0.0.1 only"
}

native_dump() {
  PGPASSWORD=$(env_or_file POSTGRES_PASSWORD) "$AP_PG_BIN/pg_dump" -Fc \
    -h 127.0.0.1 -p "$(env_or_file POSTGRES_HOST_PORT)" -U "$(env_or_file POSTGRES_USER)" "$(env_or_file POSTGRES_DB)"
}

# systemd user units stop at logout unless lingering is on. Turning it on is a
# system setting, so it is offered, never assumed.
native_linger() {
  [[ $AP_OS == darwin ]] && return 0
  command -v loginctl >/dev/null 2>&1 || return 0
  [[ $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null) == yes ]] && return 0
  if [[ $AP_YES != true ]] && ask_yes_no "Keep the services running after you log out (loginctl enable-linger)?" y; then
    ap_log "loginctl enable-linger"
    loginctl enable-linger "$(id -un)" || warn "enable-linger failed; services stop when you log out"
  else
    info "  note: the services stop when you log out. To keep them: loginctl enable-linger $(id -un)"
  fi
}

native_start() { # <upgrade true|false>
  native_db_setup
  if [[ $1 == true ]]; then
    backup_write native_dump || die "$AP_EXIT_PREFLIGHT" "backup failed — upgrade aborted, nothing changed"
  fi
  native_build "$1"
  native_migrate
  local svc
  for svc in $(native_app_services); do native_service "$svc"; done
  native_linger
  native_wait_healthy || exit "$AP_EXIT_HEALTH"
  native_verify_ports || exit "$AP_EXIT_HEALTH"
}

native_uninstall() { # <purge true|false>
  local typed home svc
  home=$(native_home)
  if [[ $1 == true ]]; then
    [[ $AP_YES != true ]] ||
      die "$AP_EXIT_PREFLIGHT" "--purge deletes all recorded history and needs a typed confirmation; run it without --yes"
    info ""
    if [[ $AP_PG_MODE == own ]]; then
      info "PURGE: this removes the services AND $home — the database cluster with every"
    else
      info "PURGE: this removes the services AND drops database $(env_or_file POSTGRES_DB) — every"
    fi
    info "recorded turn, prompt and diff. A backup is taken first; if it fails, nothing is deleted."
    read_answer typed "Type 'delete $AP_INSTANCE' to confirm: "
    if [[ $typed != "delete $AP_INSTANCE" ]]; then
      info "Confirmation did not match. Nothing was deleted."
      exit 0
    fi
    ap_log "purge confirmed"
    [[ $AP_PG_MODE != own ]] || { native_service postgres; pg_wait_ready || die "$AP_EXIT_PREFLIGHT" "postgres did not start, so no backup could be taken — nothing deleted"; }
    backup_write native_dump || die "$AP_EXIT_PREFLIGHT" "backup failed — nothing deleted"
  elif [[ $AP_YES != true ]] && ! ask_yes_no "Stop and remove the AgentPulse services? The database is kept." y; then
    info "Nothing changed."
    exit 0
  fi

  for svc in web proxy collector; do svc_remove "$svc"; done
  if [[ $1 == true && $AP_PG_MODE == reuse ]]; then
    printf 'drop database if exists %s;\n' "$(env_or_file POSTGRES_DB)" | app_psql postgres
    if printf 'drop role if exists %s;\n' "$(env_or_file POSTGRES_USER)" | admin_psql 2>/dev/null; then
      info "Dropped database $(env_or_file POSTGRES_DB) and role $(env_or_file POSTGRES_USER)."
    else
      info "Dropped database $(env_or_file POSTGRES_DB). Dropping the role needs an administrator:"
      info "  drop role $(env_or_file POSTGRES_USER);"
    fi
  fi
  [[ $AP_PG_MODE == own ]] && svc_remove postgres
  if [[ $1 == true && $AP_PG_MODE == own ]]; then
    # Guard the rm: the path must be the instance directory this installer uses.
    [[ -n $home && $home == */"$AP_INSTANCE" && -f $home/pgdata/PG_VERSION ]] ||
      die "$AP_EXIT_PREFLIGHT" "refusing to delete $home: it does not look like this installer's data directory"
    ap_log "rm -rf $home"
    rm -rf "$home"
    info "Removed the services and $home."
  elif [[ $1 != true ]]; then
    if [[ $AP_PG_MODE == own ]]; then info "Removed the services. Database kept in $(native_pgdata)."
    else info "Removed the services. Database $(env_or_file POSTGRES_DB) kept on the existing server."
    fi
  fi
}
