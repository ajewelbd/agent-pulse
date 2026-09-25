#!/usr/bin/env bash
#
# Native-mode integration test: real Node 20, real PostgreSQL 16, real
# LaunchAgents (macOS) or systemd --user units (Linux). Opt-in; run.sh does not
# call it. Needs Node 20 and PostgreSQL 16 binaries already installed.
#
#   scripts/installer/tests/native-integration.sh
#
# It never touches an existing install: the repo is copied to a temp dir, the
# instance is apnt<pid> (its own unit names, data dir and log dir), every port
# is in the 56xxx range, and the agent home and code roots are temp dirs. On
# exit, pass or fail, it removes the units, the data dir, the log dir and the
# copy.
#
# Pass 1, dedicated cluster: install → re-run restarts nothing → upgrade (backup
# first) → uninstall keeps the cluster → purge deletes it.
# Pass 2, reuse: a throwaway cluster plays "an existing PostgreSQL 16 server";
# install creates a role and database on it; purge drops them.

# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034  # AP_* are read by the sourced libraries
set -Eeuo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/ap-native-it.XXXXXX")
INSTANCE=apnt$$
FAILS=0
OS=$(uname -s)
EXISTING_PID=""

# The checkout a user would have: tracked and untracked-but-not-ignored files.
# Outside a git checkout (a copied tree), the same minus the obvious build and
# secret paths.
copy_repo() { # <dest>
  if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    (cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$1"
  else
    tar -C "$REPO" --exclude=./node_modules --exclude='*/node_modules' --exclude='*/dist' --exclude='*/.next' \
      --exclude=./.env --exclude='./.env.bak.*' --exclude=./.install --exclude=./backups --exclude=./compose.override.yaml \
      -cf - . | tar -xf - -C "$1"
  fi
}

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok    %s\n' "$*"; }
bad() { printf '   FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# shellcheck source=../lib.sh
. "$REPO/scripts/installer/lib.sh"
# shellcheck source=../env.sh
. "$REPO/scripts/installer/env.sh"
# shellcheck source=../services.sh
. "$REPO/scripts/installer/services.sh"
# shellcheck source=../native.sh
. "$REPO/scripts/installer/native.sh"
detect_os
AP_ROOT=$REPO
find_pg || { echo "PostgreSQL 16 binaries not found — install them first (e.g. brew install postgresql@16)"; exit 77; }
PGBIN=$AP_PG_BIN

data_home() {
  if [[ $OS == Darwin ]]; then printf '%s/Library/Application Support/%s' "$HOME" "$1"
  else printf '%s/%s' "${XDG_DATA_HOME:-$HOME/.local/share}" "$1"; fi
}

cleanup() {
  say "cleanup"
  local svc
  for svc in web proxy collector postgres; do AP_INSTANCE=$INSTANCE svc_remove "$svc" 2>/dev/null || true; done
  AP_INSTANCE=$INSTANCE
  rm -rf "$(data_home "$INSTANCE")" "$HOME/Library/Logs/$INSTANCE"
  [[ -z $EXISTING_PID ]] || "$PGBIN/pg_ctl" -D "$T/existing" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$T"
  echo "   removed instance $INSTANCE and $T"
}
trap cleanup EXIT

say "copying the repo to $T/repo"
mkdir -p "$T/repo" "$T/claude/projects/demo" "$T/code root one"
copy_repo "$T/repo"
: > "$T/claude/projects/demo/session.jsonl"

run() {
  env AGENTPULSE_INSTANCE=$INSTANCE AGENTPULSE_HEALTH_TIMEOUT=120 \
    POSTGRES_HOST_PORT="${PGPORT_OVERRIDE:-56433}" COLLECTOR_HOST_PORT=56317 PROXY_HOST_PORT=56318 WEB_HOST_PORT=56300 \
    CLAUDE_HOME="$T/claude" AGENT_GEMINI_CLI_ENABLED=false CODE_ROOT_1="$T/code root one" \
    bash "$T/repo/install.sh" "$@"
}

main_pid() { # <service>
  if [[ $OS == Darwin ]]; then
    { launchctl print "gui/$(id -u)/com.$INSTANCE.$1" 2>/dev/null || true; } | awk '/^\tpid = / { print $3 }'
  else
    systemctl --user show -p MainPID --value "$INSTANCE-$1.service" 2>/dev/null || true
  fi
}

# At least one listener, and every one of them on loopback.
listens_loopback_only() { # <port>
  local addrs
  if command -v ss >/dev/null 2>&1; then
    addrs=$(ss -ltnH "sport = :$1" | awk '{ print $4 }')
  else
    addrs=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' || true)
  fi
  [[ -n $addrs ]] && ! grep -qvE '^(127\.0\.0\.1|\[::1\]):' <<< "$addrs"
}

# ---------------------------------------------------------------------------
say "pass 1: install (dedicated cluster; builds, takes a few minutes)"
rc=0
run --yes --native --no-hooks > "$T/install.out" 2>&1 || rc=$?
tail -30 "$T/install.out"
expect "exit 0" "[[ $rc -eq 0 ]]"
expect "dashboard answers" "curl -fsS --max-time 5 http://127.0.0.1:56300/healthz >/dev/null"
expect "collector answers" "curl -fsS --max-time 5 http://127.0.0.1:56317/healthz >/dev/null"
expect "proxy answers" "curl -fsS --max-time 5 http://127.0.0.1:56318/healthz >/dev/null"
for p in 56433 56317 56318 56300; do expect "port $p listens on loopback only" "listens_loopback_only $p"; done
expect "cluster created" "[[ -f '$(data_home "$INSTANCE")/pgdata/PG_VERSION' ]]"
expect "no unix socket in /tmp" "! ls /tmp/.s.PGSQL.56433 >/dev/null 2>&1"
expect "migrations applied" "PGPASSWORD=\$(sed -n 's/^POSTGRES_PASSWORD=//p' '$T/repo/.env') '$PGBIN/psql' -X -At -h 127.0.0.1 -p 56433 -U aiuo -d aiuo -c 'select count(*) from schema_migrations' | grep -qE '^[1-9]'"
expect "dashboard home page renders from the database" "curl -fsS --max-time 20 http://127.0.0.1:56300/ >/dev/null"
expect ".env is mode 600" "[[ -n \$(find '$T/repo/.env' -prune -perm 600) ]]"
before=$(main_pid collector)

say "re-run"
run --yes --native --no-hooks > "$T/rerun.out" 2>&1 || true
expect "reports no change" "grep -q 'No changes to .env.' '$T/rerun.out'"
expect "build skipped" "grep -q 'build       present' '$T/rerun.out'"
expect "collector not restarted (pid $before)" "[[ -n '$before' && '$(main_pid collector)' == '$before' ]]"
expect "healthy" "grep -q 'AgentPulse is running' '$T/rerun.out'"

say "upgrade"
run --upgrade --yes --no-hooks > "$T/upgrade.out" 2>&1 || true
tail -8 "$T/upgrade.out"
expect "healthy after upgrade" "grep -q 'AgentPulse is running' '$T/upgrade.out'"
dump=$(find "$T/repo/backups" -name "$INSTANCE-*.dump" | head -1)
expect "backup written" "[[ -n '$dump' ]]"
expect "backup restores (pg_restore --list)" "'$PGBIN/pg_restore' --list '$dump' | grep -q schema_migrations"
expect "collector restarted by the upgrade" "[[ '$(main_pid collector)' != '$before' ]]"

say "uninstall"
run --uninstall --yes --no-hooks > "$T/uninstall.out" 2>&1 || true
expect "collector unit gone" "[[ ! -e '$(AP_INSTANCE=$INSTANCE svc_file collector)' ]]"
expect "nothing on 56317" "! curl -fsS --max-time 2 http://127.0.0.1:56317/healthz >/dev/null 2>&1"
expect "cluster kept" "[[ -f '$(data_home "$INSTANCE")/pgdata/PG_VERSION' ]]"

say "purge"
printf 'delete %s\n' "$INSTANCE" | run --uninstall --purge --no-hooks > "$T/purge.out" 2>&1 || true
tail -4 "$T/purge.out"
expect "backup taken before purge" "[[ \$(find '$T/repo/backups' -name '$INSTANCE-*.dump' | wc -l) -ge 2 ]]"
expect "cluster deleted" "[[ ! -e '$(data_home "$INSTANCE")' ]]"
expect "postgres unit gone" "[[ ! -e '$(AP_INSTANCE=$INSTANCE svc_file postgres)' ]]"

# ---------------------------------------------------------------------------
say "pass 2: reuse an existing PostgreSQL 16 server"
rm -rf "$T/repo/.env" "$T/repo/.install"
"$PGBIN/initdb" -D "$T/existing" -U admin --auth=trust -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$T/existing" -o "-p 56432 -k '' -c listen_addresses=127.0.0.1" -l "$T/existing.log" -w start >/dev/null
EXISTING_PID=started
rc=0
AGENTPULSE_PG_ADMIN_URL=postgres://admin@127.0.0.1:56432/postgres PGPORT_OVERRIDE=56432 \
  run --yes --native --no-hooks > "$T/reuse.out" 2>&1 || rc=$?
tail -12 "$T/reuse.out"
expect "exit 0" "[[ $rc -eq 0 ]]"
expect "port fixed to the existing server" "grep -q '^POSTGRES_HOST_PORT=56432$' '$T/repo/.env'"
expect "no dedicated cluster" "[[ ! -e '$(data_home "$INSTANCE")/pgdata' ]]"
expect "role is not a superuser" "'$PGBIN/psql' -X -At -h 127.0.0.1 -p 56432 -U admin -d postgres -c \"select rolsuper from pg_roles where rolname='aiuo'\" | grep -qx f"
expect "collector answers" "curl -fsS --max-time 5 http://127.0.0.1:56317/healthz >/dev/null"
expect "state records reuse" "grep -q '^pg_mode=reuse$' '$T/repo/.install/state'"
printf 'delete %s\n' "$INSTANCE" | AGENTPULSE_PG_ADMIN_URL=postgres://admin@127.0.0.1:56432/postgres PGPORT_OVERRIDE=56432 \
  run --uninstall --purge --no-hooks > "$T/reuse-purge.out" 2>&1 || true
tail -3 "$T/reuse-purge.out"
expect "database dropped" "[[ -z \$('$PGBIN/psql' -X -At -h 127.0.0.1 -p 56432 -U admin -d postgres -c \"select 1 from pg_database where datname='aiuo'\") ]]"
expect "role dropped" "[[ -z \$('$PGBIN/psql' -X -At -h 127.0.0.1 -p 56432 -U admin -d postgres -c \"select 1 from pg_roles where rolname='aiuo'\") ]]"
expect "existing server still running" "'$PGBIN/pg_isready' -q -h 127.0.0.1 -p 56432"

say "result"
if [[ $FAILS -eq 0 ]]; then echo "   all checks passed"; else echo "   $FAILS check(s) failed"; exit 1; fi
