#!/usr/bin/env bash
#
# Installer tests. Plain bash, no framework, so they need nothing the
# installer itself does not (see docs/install.md, F12).
#
#   scripts/installer/tests/run.sh            all tests
#   scripts/installer/tests/run.sh precedence only tests whose name contains it
#
# Unit tests source the libraries in a subshell. End-to-end tests run
# install.sh against a throwaway checkout (AGENTPULSE_ROOT) with a throwaway
# HOME and stub docker/lsof/ss on PATH, so they never touch this machine's
# .env, Docker or ports.

# shellcheck source-path=SCRIPTDIR
# Fixtures assign VAL_/ENVF_ globals the code reads indirectly, and test doubles
# are called by the libraries, never here.
# shellcheck disable=SC2034,SC2329

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
FILTER=${1:-}
PASS=0
FAIL=0
SKIP=0
FAILED=""
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ap-installer-tests.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
check() { # <description> <command…>
  local what=$1
  shift
  if "$@"; then return 0; fi
  printf '    FAILED: %s\n' "$what"
  return 1
}
eq() { [[ $1 == "$2" ]] || { printf '    expected: %q\n    actual:   %q\n' "$1" "$2"; return 1; }; }
has() { [[ $1 == *"$2"* ]] || { printf '    missing %q in:\n%s\n' "$2" "$1" | head -40; return 1; }; }
hasnt() { [[ $1 != *"$2"* ]] || { printf '    unexpected %q\n' "$2"; return 1; }; }

run_test() {
  local name=$1 out rc
  [[ -z $FILTER || $name == *"$FILTER"* ]] || return 0
  out=$( (set -e; "$name") 2>&1)
  rc=$?
  if [[ $rc -eq 77 ]]; then
    SKIP=$((SKIP + 1))
    printf 'skip  %s — %s\n' "$name" "$(printf '%s' "$out" | tail -1)"
  elif [[ $rc -eq 0 ]]; then
    PASS=$((PASS + 1))
    printf 'ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $name"
    printf 'FAIL  %s\n%s\n' "$name" "$(printf '%s' "$out" | tail -40 | sed 's/^/      /')"
  fi
}

# Load the libraries with test doubles for everything that touches the system.
load_libs() {
  AP_ROOT=$WORK/unit
  mkdir -p "$AP_ROOT"
  # shellcheck source=../lib.sh
  . "$HERE/../lib.sh"
  # shellcheck source=../env.sh
  . "$HERE/../env.sh"
  # shellcheck source=../docker.sh
  . "$HERE/../docker.sh"
  # shellcheck source=../services.sh
  . "$HERE/../services.sh"
  # shellcheck source=../native.sh
  . "$HERE/../native.sh"
  AP_SCRIPT_DIR=$REPO
  AP_ENV_PATH=$AP_ROOT/.env
  AP_MODE=docker
  AP_OS=linux
  AP_YES=true
  BUSY_PORTS=""
  OURS_PORTS=""
  PGDATA=false
  port_in_use() { [[ " $BUSY_PORTS " == *" $1 "* ]]; }
  docker_port_is_ours() { [[ " $OURS_PORTS " == *" $2 "* ]]; }
  docker_pgdata_exists() { [[ $PGDATA == true ]]; }
}

write() { # <file> <content>
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" > "$1"
}

# ---------------------------------------------------------------------------
# .env.example parsing
# ---------------------------------------------------------------------------
test_example_grammar() {
  load_libs
  # shellcheck disable=SC2016
  write "$WORK/ex" '# Header prose
# NOT_A_VAR=untagged, so prose
#
# ----------
# Help line one
# Help line two
# @required @secret @generated
PASSWORD=placeholder-value
# @optional
QUOTED="a b=c"
# @optional
EMPTY=
# @optional
# COMMENTED=example=with=equals
# @optional @docker
SINGLE='"'"'x #y'"'"'
'
  parse_example "$WORK/ex"
  check "names in order" eq "PASSWORD QUOTED EMPTY COMMENTED SINGLE" "$AP_VARS"
  check "double quotes stripped, = kept" eq "a b=c" "$EX_DEFAULT_QUOTED"
  check "single quotes keep ' #'" eq "x #y" "$EX_DEFAULT_SINGLE"
  check "empty value is active and empty" eq "1:" "$EX_ACTIVE_EMPTY:$EX_DEFAULT_EMPTY"
  check "commented var is inactive" eq 0 "$EX_ACTIVE_COMMENTED"
  check "commented var has no default" eq unset "${EX_DEFAULT_COMMENTED-unset}"
  check "help is the block after the banner" eq $'Help line one\nHelp line two\n' "$EX_HELP_PASSWORD"
  check "tags" has_tag PASSWORD @secret
  check "untagged prose is not a var" eq unset "${EX_TAGS_NOT_A_VAR-unset}"
}

test_example_rejects_bad_grammar() {
  load_libs
  local out
  write "$WORK/e1" $'# @optional @bogus\nX=1\n'
  out=$( (parse_example "$WORK/e1") 2>&1) && return 1
  check "unknown tag" has "$out" "unknown tag @bogus"
  write "$WORK/e2" $'# @optional\n# just prose\n'
  out=$( (parse_example "$WORK/e2") 2>&1) && return 1
  check "tag without var" has "$out" "must be followed by a variable"
  write "$WORK/e3" $'# @optional\nA=1\nB=2\n'
  out=$( (parse_example "$WORK/e3") 2>&1) && return 1
  check "untagged active var" has "$out" "B has no tag line"
  write "$WORK/e4" $'# @optional\nA=1\n# @optional\n# A=2\n'
  out=$( (parse_example "$WORK/e4") 2>&1) && return 1
  check "duplicate" has "$out" "declared twice"
}

test_real_example_is_classified() {
  load_libs
  parse_example "$REPO/.env.example"
  local name bad=""
  for name in $AP_VARS; do
    has_tag "$name" @required || has_tag "$name" @optional || has_tag "$name" @derived || bad="$bad $name"
  done
  check "every var is required, optional or derived" eq "" "$bad"
  check "the secret is generated" has_tag COLLECTOR_SHARED_SECRET @generated
}

# Every variable the code or compose reads must be declared in .env.example
# (docs/install.md §1b). NODE_ENV is set by the images and units, not by .env.
test_example_covers_code() {
  load_libs
  parse_example "$REPO/.env.example"
  local name missing=""
  for name in $(
    {
      grep -rhoE "(required|intEnv|boolEnv)\('[A-Z_0-9]+'|process\.env(\[['\"][A-Z_0-9]+['\"]\]|\.[A-Z_0-9]+)" \
        "$REPO"/apps/*/src "$REPO/packages/schema/src" | grep -oE '[A-Z][A-Z_0-9]{2,}'
      # shellcheck disable=SC2016  # a literal ${ to match in compose.yaml
      grep -oE '\$\{[A-Z_0-9]+' "$REPO/compose.yaml" | tr -d '${'
    } | sort -u
  ); do
    [[ $name == NODE_ENV ]] && continue
    [[ " $AP_VARS " == *" $name "* ]] || missing="$missing $name"
  done
  check "undeclared variables" eq "" "$missing"
}

# ---------------------------------------------------------------------------
# .env parsing
# ---------------------------------------------------------------------------
test_dotenv_parsing() {
  load_libs
  write "$WORK/dotenv" "export A=1
B=\"x=y\"
C='q r'
D=v # trailing comment
E=
F=first
F=second
  G=indented
H=crlf$(printf '\r')
# I=commented
J=/Volumes/Macintosh HD 1/Practice
"
  local keys=""
  load_dotenv "$WORK/dotenv" T keys
  check "keys, duplicates once" eq "A B C D E F G H J" "$keys"
  check "export prefix" eq 1 "$T_A"
  check "= inside quotes" eq "x=y" "$T_B"
  check "single quotes" eq "q r" "$T_C"
  check "inline comment" eq v "$T_D"
  check "empty" eq "" "$T_E"
  check "later duplicate wins" eq second "$T_F"
  check "leading space" eq indented "$T_G"
  check "CRLF" eq crlf "$T_H"
  check "commented line ignored" eq unset "${T_I-unset}"
  check "unquoted spaces kept" eq "/Volumes/Macintosh HD 1/Practice" "$T_J"
}

# ---------------------------------------------------------------------------
# Precedence
# ---------------------------------------------------------------------------
precedence_fixture() {
  load_libs
  write "$WORK/pex" '# @optional
ALPHA=default-a
# @required @secret @generated
SECRET_X=change-me-placeholder
# @required
NEEDED=
# @optional @secret @prompt
# API_KEY_X=
'
  parse_example "$WORK/pex"
}

test_precedence_env_beats_dotenv_beats_envfile() {
  precedence_fixture
  ENVF_ALPHA=from-dotenv
  XF_ALPHA=from-envfile
  ALPHA=from-env resolve_var ALPHA
  check "env first" eq "from-env env" "$VAL_ALPHA $SRC_ALPHA"
  resolve_var ALPHA
  check ".env second" eq "from-dotenv .env" "$VAL_ALPHA $SRC_ALPHA"
  unset ENVF_ALPHA
  resolve_var ALPHA
  check "--env-file third" eq "from-envfile env-file" "$VAL_ALPHA $SRC_ALPHA"
  unset XF_ALPHA
  resolve_var ALPHA
  check "default last" eq "default-a default" "$VAL_ALPHA $SRC_ALPHA"
  ENVF_ALPHA=from-dotenv
  ALPHA="" resolve_var ALPHA
  check "empty env counts as unset" eq ".env" "$SRC_ALPHA"
}

test_precedence_generated_secrets() {
  precedence_fixture
  ENVF_SECRET_X=change-me-placeholder
  resolve_var SECRET_X
  check "placeholder regenerated" eq generated "$SRC_SECRET_X"
  check "64 hex" eq 64 "${#VAL_SECRET_X}"
  PGDATA=true
  AP_MODE=docker
  # The placeholder rule for a live database is specific to POSTGRES_PASSWORD.
  resolve_var SECRET_X
  check "only POSTGRES_PASSWORD is locked" eq generated "$SRC_SECRET_X"
  ENVF_SECRET_X=a-real-secret-value-0123456789
  resolve_var SECRET_X
  check "a real value is never regenerated" eq "a-real-secret-value-0123456789 .env" "$VAL_SECRET_X $SRC_SECRET_X"
}

test_precedence_locked_postgres_password() {
  load_libs
  parse_example "$REPO/.env.example"
  ENVF_POSTGRES_PASSWORD=change-me-before-first-run
  PGDATA=false
  resolve_var POSTGRES_PASSWORD
  check "no volume: regenerate" eq generated "$SRC_POSTGRES_PASSWORD"
  PGDATA=true
  resolve_var POSTGRES_PASSWORD
  check "volume exists: keep" eq "change-me-before-first-run .env" "$VAL_POSTGRES_PASSWORD $SRC_POSTGRES_PASSWORD"
  check "and say why" has "$NOTE_POSTGRES_PASSWORD" "initialised with it"
}

test_precedence_unresolved_and_optional_secrets() {
  precedence_fixture
  resolve_var NEEDED
  check "required with nothing: error" has "$AP_ERRORS" "NEEDED: not set"
  API_KEY_X=sk-ant-0123456789abcdefghij resolve_var API_KEY_X
  check "optional secret from env is not saved under --yes" eq unset "${VAL_API_KEY_X-unset}"
}

# ---------------------------------------------------------------------------
# PATH_MAP
# ---------------------------------------------------------------------------
path_map_fixture() {
  load_libs
  VAL_AGENT_CLAUDE_CODE_ENABLED=true
  VAL_AGENT_GEMINI_CLI_ENABLED=true
  VAL_CLAUDE_HOME=/h/.claude
  VAL_GEMINI_HOME=/h/.gemini
  VAL_CODE_ROOT_1=/h
  VAL_CODE_ROOT_2="/Volumes/Macintosh HD 1/Practice"
  AP_ROOT_IDX="1 2"
}

test_path_map_build_docker() {
  path_map_fixture
  check "most specific first, compose targets" eq \
    "/Volumes/Macintosh HD 1/Practice:/host/code/root2,/h/.claude:/host/agents/claude,/h/.gemini:/host/agents/gemini,/h:/host/code/root1" \
    "$(build_path_map)"
  check "result passes the checks" pm_check_bash "$(build_path_map)"
}

test_path_map_build_native() {
  path_map_fixture
  AP_MODE=native
  VAL_AGENT_GEMINI_CLI_ENABLED=false
  check "identity entries, disabled agent left out" eq \
    "/Volumes/Macintosh HD 1/Practice:/Volumes/Macintosh HD 1/Practice,/h/.claude:/h/.claude,/h:/h" \
    "$(build_path_map)"
  check "identity map passes" pm_check_bash "$(build_path_map)"
}

test_path_map_validation() {
  load_libs
  check "valid" pm_check_bash "/a:/host/a,/b:/host/b"
  check "trailing slashes normalised" pm_check_bash "/a/:/host/a/"
  ! pm_check_bash "/h:/host/h,/h/.claude:/host/c" || return 1
  check "shadowed host prefix" has "$AP_ERR" 'entry 2 ("/h/.claude") is shadowed by entry 1 ("/h")'
  ! pm_check_bash "/a:/host/x,/b:/host/x/y" || return 1
  check "shadowed container prefix" has "$AP_ERR" 'container prefix 2 ("/host/x/y")'
  check "segment boundary: /ap does not shadow /app" pm_check_bash "/ap:/host/1,/app:/host/2"
  ! pm_check_bash "/a/host" || return 1
  check "no colon" has "$AP_ERR" "is not host_prefix:container_prefix"
  ! pm_check_bash "a:/host/a" || return 1
  check "relative" has "$AP_ERR" "absolute paths on both sides"
  ! pm_check_bash " , ," || return 1
  check "empty" has "$AP_ERR" "PATH_MAP is empty"
  check "same entries, other order" eq "$(pm_entry_set "/a:/x,/b:/y")" "$(pm_entry_set "/b/:/y,/a:/x")"
}

# The bash port must say exactly what the collector says. Needs a build.
test_path_map_matches_collector() {
  load_libs
  AP_ROOT=$REPO
  if [[ ! -f $REPO/apps/collector/dist/paths.js ]] || ! command -v node >/dev/null 2>&1; then
    echo "no collector build or node (pnpm --filter @agentpulse/collector run build)"
    return 77
  fi
  local c bash_ok bash_err node_ok node_err
  local cases=$'/a:/host/a,/b:/host/b\n/h:/host/h,/h/.claude:/host/c\n/a:/x,/b:/x/y\n/a/host\na:/host/a\n , ,\n/:/host,/a:/b\n/a/:/b/\n/Volumes/Macintosh HD 1/P:/host/code/root1\n/ap:/host/1,/app:/host/2\n/x:\n:/x'
  while IFS= read -r c; do
    bash_ok=0; node_ok=0
    AP_ERR=""; pm_check_bash "$c" || bash_ok=1; bash_err=$AP_ERR
    AP_ERR=""; pm_check_node "$c" || node_ok=$?; node_err=$AP_ERR
    check "verdict for '$c'" eq "$node_ok" "$bash_ok"
    check "message for '$c'" eq "$node_err" "$bash_err"
  done <<< "$cases"
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------
test_port_fallback() {
  load_libs
  write "$WORK/ports" '# @optional @detect
WEB_HOST_PORT=45000
# @optional @detect
PROXY_HOST_PORT=45001
# @optional @detect
COLLECTOR_HOST_PORT=45010
# @optional @detect
POSTGRES_HOST_PORT=45020
'
  parse_example "$WORK/ports"
  BUSY_PORTS="45000 45001 45010 45020"
  OURS_PORTS="45010"
  ENVF_POSTGRES_HOST_PORT=45020
  resolve_var WEB_HOST_PORT
  resolve_var PROXY_HOST_PORT
  resolve_var COLLECTOR_HOST_PORT
  resolve_var POSTGRES_HOST_PORT
  check "busy default moves past busy ports" eq "45002 detected" "$VAL_WEB_HOST_PORT $SRC_WEB_HOST_PORT"
  check "and past ports already chosen" eq 45003 "$VAL_PROXY_HOST_PORT"
  check "a port this stack holds stays" eq "45010 default" "$VAL_COLLECTOR_HOST_PORT $SRC_COLLECTOR_HOST_PORT"
  check "a chosen port is not moved under --yes" has "$AP_ERRORS" "POSTGRES_HOST_PORT: port 45020 (from .env) is in use"
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
test_masking_and_encoding() {
  load_libs
  check "secret" eq "abcd…(64)" "$(mask_secret "abcd$(printf '%060d' 0)")"
  check "short secret shows nothing" eq "****(5)" "$(mask_secret hello)"
  check "url keeps shape" eq "postgres://aiuo:abcd…(24)@127.0.0.1:5433/aiuo" \
    "$(mask_url_or_secret "postgres://aiuo:abcdefghijklmnopqrstuvwx@127.0.0.1:5433/aiuo")"
  check "url encode" eq "p%40ss%3Aw%2Fd~._-" "$(url_encode 'p@ss:w/d~._-')"
  # shellcheck disable=SC2016  # a literal $ is the point
  check "unsafe \$ refused" eq 1 "$(validate_safe 'a$b' && echo 0 || echo 1)"
  check "unsafe ' #' refused" eq 1 "$(validate_safe 'a #b' && echo 0 || echo 1)"
  check "spaces inside allowed" validate_safe "/Volumes/Macintosh HD 1"
}

# ---------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------
E2E=""

e2e_setup() {
  E2E=$WORK/e2e.$RANDOM$RANDOM
  mkdir -p "$E2E/repo" "$E2E/home" "$E2E/code" "$E2E/stub"
  # High ports, so a real listener on this machine cannot change the outcome.
  sed -e 's/^POSTGRES_HOST_PORT=5433/POSTGRES_HOST_PORT=45433/' \
    -e 's/^COLLECTOR_HOST_PORT=4317/COLLECTOR_HOST_PORT=45317/' \
    -e 's/^PROXY_HOST_PORT=4318/PROXY_HOST_PORT=45318/' \
    -e 's/^WEB_HOST_PORT=3000/WEB_HOST_PORT=45300/' \
    "$REPO/.env.example" > "$E2E/repo/.env.example"
  # The version pins native mode reads (Node from the Dockerfile, pnpm from
  # package.json).
  mkdir -p "$E2E/repo/apps/collector"
  cp "$REPO/apps/collector/Dockerfile" "$E2E/repo/apps/collector/"
  cp "$REPO/package.json" "$E2E/repo/"
  mkdir -p "$E2E/home/.claude/projects/p"
  : > "$E2E/home/.claude/projects/p/session.jsonl"
  # A docker that answers from control files in $E2E/stub and records every
  # call in $E2E/stub/calls: pgdata (volume exists), pg_health, migrate_state,
  # bind (the address `compose port` reports), up_fail, dump_fail.
  cat > "$E2E/stub/docker" <<'EOF'
#!/bin/bash
S=$(dirname "$0")
echo "$*" >> "$S/calls"
case "$1" in
  info) exit 0 ;;
  volume) [ -f "$S/pgdata" ]; exit $? ;;
  ps) exit 0 ;;
  inspect)
    case "$3" in
      *Health*) [ "$4" = id-postgres ] && { cat "$S/pg_health" 2>/dev/null || echo healthy; } ;;
      *) if [ "$4" = id-migrate ]; then cat "$S/migrate_state" 2>/dev/null || echo "exited 0"; else echo "running 0"; fi ;;
    esac
    exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in -p | --project-directory | --env-file | -f | --profile) shift 2 ;; *) break ;; esac
    done
    sub=$1
    shift
    case "$sub" in
      version) echo 2.29.1 ;;
      ps) echo "id-${!#}" ;;
      port) echo "$(cat "$S/bind" 2>/dev/null || echo 127.0.0.1):1$2" ;;
      logs) echo "stub log for ${!#}" ;;
      exec) [ -f "$S/dump_fail" ] && exit 1; printf 'PGDMP-stub-dump' ;;
      up) [ -f "$S/up_fail" ] && exit 1; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
EOF
  # shellcheck disable=SC2016  # the stub expands these, not this shell
  printf '#!/bin/sh\n[ -f "$(dirname "$0")/curl_fail" ] && exit 7\nexit 0\n' > "$E2E/stub/curl"
  printf '#!/bin/sh\nexit 1\n' > "$E2E/stub/lsof"
  printf '#!/bin/sh\nexit 0\n' > "$E2E/stub/ss"
  chmod +x "$E2E/stub/"*
}

# Clean environment: nothing from the developer's shell leaks in.
installer() { # [VAR=value …] -- args…
  local envs=""
  while [[ $# -gt 0 && $1 != -- ]]; do envs="$envs $1"; shift; done
  shift
  # shellcheck disable=SC2086  # envs is a word list by construction
  env -i HOME="$E2E/home" PATH="$E2E/stub:/usr/bin:/bin:/usr/sbin:/sbin" \
    AGENTPULSE_ROOT="$E2E/repo" AGENTPULSE_COMPOSE_PROJECT=aptest AGENTPULSE_HEALTH_TIMEOUT=3 \
    $envs bash "$REPO/install.sh" "$@"
}

env_value() { sed -n "s/^$1=//p" "$E2E/repo/.env"; }
calls() { cat "$E2E/stub/calls" 2>/dev/null; }
# Line number of the first recorded call containing <text>, 0 if none.
call_at() { calls | grep -nF -- "$1" | head -1 | cut -d: -f1 | grep . || echo 0; }
installed() { installer "CODE_ROOT_1=$E2E/code" -- --yes --docker > /dev/null 2>&1; : > "$E2E/stub/calls"; }

test_e2e_yes_lists_every_unresolved() {
  e2e_setup
  rm -rf "$E2E/home/.claude"
  local out rc=0
  out=$(installer -- --yes --docker 2>&1) || rc=$?
  check "exit 2" eq 2 "$rc"
  check "CODE_ROOT_1 listed" has "$out" "CODE_ROOT_1: not set"
  check "no agent listed" has "$out" "no agent with an adapter is enabled"
  check "PATH_MAP listed" has "$out" "PATH_MAP: cannot be derived"
  check "nothing written" eq no "$([[ -e $E2E/repo/.env ]] && echo yes || echo no)"
}

test_e2e_dry_run_changes_nothing() {
  e2e_setup
  local out
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker --dry-run 2>&1)
  check "plan printed" has "$out" "write .env (mode 600, atomic)"
  check "secret masked in table" has "$out" "COLLECTOR_SHARED_SECRET        generated"
  check "no .env" eq no "$([[ -e $E2E/repo/.env ]] && echo yes || echo no)"
  check "no .install" eq no "$([[ -e $E2E/repo/.install ]] && echo yes || echo no)"
  check "no override" eq no "$([[ -e $E2E/repo/compose.override.yaml ]] && echo yes || echo no)"
}

test_e2e_install_then_rerun_is_a_no_op() {
  e2e_setup
  local out secret pw sum
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check ".env written" has "$out" "wrote $E2E/repo/.env (mode 600)"
  check "mode 600" eq 1 "$(find "$E2E/repo/.env" -prune -perm 600 | wc -l | tr -d ' ')"
  secret=$(env_value COLLECTOR_SHARED_SECRET)
  pw=$(env_value POSTGRES_PASSWORD)
  check "secret is 64 hex" eq 64 "$(printf '%s' "$secret" | tr -cd '0-9a-f' | wc -c | tr -d ' ')"
  check "PATH_MAP" eq "$E2E/home/.claude:/host/agents/claude,$E2E/code:/host/code/root1" "$(env_value PATH_MAP)"
  check "override generated" has "$(cat "$E2E/repo/compose.override.yaml")" "services: {}"
  check "state has mode" has "$(cat "$E2E/repo/.install/state")" "mode=docker"
  check "secret not in state" hasnt "$(cat "$E2E/repo/.install/state")" "$secret"
  check "secret not in log" hasnt "$(cat "$E2E/repo/.install/install.log")" "$secret"
  check "password not in log" hasnt "$(cat "$E2E/repo/.install/install.log")" "$pw"
  check "secret not on stdout" hasnt "$out" "$secret"
  sum=$(cksum < "$E2E/repo/.env")

  # Second run: CODE_ROOT_1 now comes from .env.
  out=$(installer -- --yes --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "reported unchanged" has "$out" "No changes to .env."
  check "file untouched" eq "$sum" "$(cksum < "$E2E/repo/.env")"
  check "no backup taken" eq 0 "$(find "$E2E/repo" -maxdepth 1 -name '.env.bak.*' | wc -l | tr -d ' ')"
  check "secret kept" eq "$secret" "$(env_value COLLECTOR_SHARED_SECRET)"
}

test_e2e_change_takes_a_backup() {
  e2e_setup
  local out secret backup
  installer "CODE_ROOT_1=$E2E/code" -- --yes --docker > /dev/null 2>&1
  secret=$(env_value COLLECTOR_SHARED_SECRET)
  out=$(installer WATCH_POLL_INTERVAL_MS=5000 -- --yes --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "change shown" has "$out" "WATCH_POLL_INTERVAL_MS         env        new"
  backup=$(find "$E2E/repo" -maxdepth 1 -name '.env.bak.*' | head -1)
  check "backup exists" test -n "$backup"
  check "backup is mode 600" eq 1 "$(find "$backup" -prune -perm 600 | wc -l | tr -d ' ')"
  check "new value written" eq 5000 "$(env_value WATCH_POLL_INTERVAL_MS)"
  check "secret unchanged" eq "$secret" "$(env_value COLLECTOR_SHARED_SECRET)"
}

test_e2e_env_file() {
  e2e_setup
  printf 'CODE_ROOT_1=%s\nWATCH_MODE=poll\n' "$E2E/code" > "$E2E/extra.env"
  local out
  out=$(installer WATCH_MODE=inotify -- --yes --docker --dry-run --env-file "$E2E/extra.env" 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "value from --env-file" has "$out" "CODE_ROOT_1                    env-file"
  check "env beats --env-file" has "$out" "WATCH_MODE                     env"
}

test_e2e_interactive() {
  e2e_setup
  local out answers
  # Prompt order follows .env.example: CODE_ROOT_1 (first a bad answer, which
  # is re-asked), another code root, claude_code, gemini_cli, the optional API
  # key, the final confirmation, then (after the stack is healthy) the hooks.
  answers=$(printf '%s\n' "relative/path" "$E2E/code" "" "" "" "" "y" "n")
  out=$(printf '%s\n' "$answers" | installer -- --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "bad path re-asked" has "$out" "must be an absolute path"
  check "prompted value recorded" eq "$E2E/code" "$(env_value CODE_ROOT_1)"
  check "claude enabled by default" eq true "$(env_value AGENT_CLAUDE_CODE_ENABLED)"
  check "gemini off (no transcripts)" eq false "$(env_value AGENT_GEMINI_CLI_ENABLED)"
  check "no API key stored" eq "" "$(env_value ANTHROPIC_API_KEY)"
}

test_e2e_interactive_decline_writes_nothing() {
  e2e_setup
  local out
  out=$(printf '%s\n' "$E2E/code" "" "" "" "" "n" | installer -- --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "declined" has "$out" "Nothing written."
  check "no .env" eq no "$([[ -e $E2E/repo/.env ]] && echo yes || echo no)"
}

# ---------------------------------------------------------------------------
# Docker lifecycle (Phase 3), against the stub docker
# ---------------------------------------------------------------------------
test_docker_install_starts_and_checks() {
  e2e_setup
  local out
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "project passed to compose" has "$(calls)" "compose -p aptest"
  check "override passed explicitly" has "$(calls)" "-f $E2E/repo/compose.override.yaml"
  check "web profile" has "$(calls)" "--profile phase5 up -d"
  check "no build on a plain install (up builds missing images)" eq 0 "$(call_at ' build')"
  check "health reported" has "$out" "migrate     exited 0"
  check "ports checked" has "$out" "all published on 127.0.0.1 only"
  check "dashboard URL" has "$out" "dashboard   http://127.0.0.1:45300"
  check "down -v warning" has "$out" "NEVER run 'docker compose down -v'"
  check "state says healthy" has "$(cat "$E2E/repo/.install/state")" "status=healthy"
  check "hooks not installed under --yes" eq no "$([[ -e $E2E/home/.claude/aiuo/post-event.sh ]] && echo yes || echo no)"
}

test_docker_health_timeout_shows_logs() {
  e2e_setup
  : > "$E2E/stub/curl_fail"
  local out rc=0
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker 2>&1) || rc=$?
  check "exit 3" eq 3 "$rc"
  check "names what is pending" has "$out" "not healthy after 3s: collector proxy web"
  check "shows that service's logs" has "$out" "stub log for collector"
}

test_docker_migrate_failure() {
  e2e_setup
  echo "exited 1" > "$E2E/stub/migrate_state"
  local out rc=0
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker 2>&1) || rc=$?
  check "exit 3" eq 3 "$rc"
  check "says so" has "$out" "migrate exited 1"
  check "migrate logs" has "$out" "stub log for migrate"
}

test_docker_port_not_on_loopback_is_stopped() {
  e2e_setup
  echo 0.0.0.0 > "$E2E/stub/bind"
  local out rc=0
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker 2>&1) || rc=$?
  check "exit 3" eq 3 "$rc"
  check "loud" has "$out" "published on 0.0.0.0:14317 — must be 127.0.0.1 only"
  check "offenders stopped" has "$(calls)" "stop postgres collector proxy web"
}

test_docker_uninstall_keeps_data() {
  e2e_setup
  installed
  local out
  out=$(installer -- --uninstall --yes 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "down" has "$(calls)" "--profile phase5 down"
  check "never -v" hasnt "$(calls)" "down -v"
  check "says data kept" has "$out" "Data kept in aptest_pgdata"
  check ".env kept" test -f "$E2E/repo/.env"
  check "state" has "$(cat "$E2E/repo/.install/state")" "status=uninstalled"
}

test_docker_purge_refused_with_yes() {
  e2e_setup
  installed
  local out rc=0
  out=$(installer -- --uninstall --purge --yes 2>&1) || rc=$?
  check "exit 1" eq 1 "$rc"
  check "why" has "$out" "needs a typed confirmation"
  check "nothing removed" eq 0 "$(call_at down)"
}

test_docker_purge_wrong_confirmation() {
  e2e_setup
  installed
  : > "$E2E/stub/pgdata"
  local out
  out=$(printf 'yes\n' | installer -- --uninstall --purge 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "aborted" has "$out" "Nothing was deleted."
  check "no down at all" eq 0 "$(call_at down)"
}

test_docker_purge_backs_up_then_deletes() {
  e2e_setup
  installed
  : > "$E2E/stub/pgdata"
  local out dump
  out=$(printf 'delete aptest\n' | installer -- --uninstall --purge 2>&1) || { printf '%s\n' "$out"; return 1; }
  dump=$(find "$E2E/repo/backups" -name 'aptest-*.dump' | head -1)
  check "dump written" test -n "$dump"
  check "dump is mode 600" eq 1 "$(find "$dump" -prune -perm 600 | wc -l | tr -d ' ')"
  check "backup before delete" test "$(call_at 'exec -T postgres pg_dump -Fc -U aiuo aiuo')" -lt "$(call_at 'down -v')"
  check "state" has "$(cat "$E2E/repo/.install/state")" "status=purged"
}

test_docker_upgrade_order() {
  e2e_setup
  installed
  : > "$E2E/stub/pgdata"
  local out b p u
  out=$(installer -- --upgrade --yes 2>&1) || { printf '%s\n' "$out"; return 1; }
  b=$(call_at "pg_dump")
  p=$(call_at "pull postgres")
  u=$(call_at "up -d")
  check "backup happened" test "$b" -gt 0
  check "backup, then pull, then build, then up" test "$b" -lt "$p" -a "$p" -lt "$(call_at 'build --pull')" -a "$(call_at 'build --pull')" -lt "$u"
  check "backup recorded in state" has "$(cat "$E2E/repo/.install/state")" "last_backup=$E2E/repo/backups/aptest-"
}

test_docker_upgrade_aborts_when_backup_fails() {
  e2e_setup
  installed
  : > "$E2E/stub/pgdata"
  : > "$E2E/stub/dump_fail"
  local out rc=0
  out=$(installer -- --upgrade --yes 2>&1) || rc=$?
  check "exit 1" eq 1 "$rc"
  check "says nothing changed" has "$out" "backup failed — upgrade aborted, nothing changed"
  check "no build" eq 0 "$(call_at build)"
  check "no up" eq 0 "$(call_at 'up -d')"
  check "no partial dump left" eq 0 "$(find "$E2E/repo/backups" -type f | wc -l | tr -d ' ')"
}

test_docker_hooks_installed_once() {
  e2e_setup
  local out
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --docker --with-hooks 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "forwarder written" test -x "$E2E/home/.claude/aiuo/post-event.sh"
  check "posts to the resolved port" has "$(cat "$E2E/home/.claude/aiuo/post-event.sh")" "127.0.0.1:45317/v1/hooks"
  check "proxy export uses the resolved port" has "$out" "ANTHROPIC_BASE_URL=http://127.0.0.1:45318"
  out=$(installer -- --yes --docker --with-hooks 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "second run leaves them alone" has "$out" "Claude Code hooks: installed and current."
  check "no second settings backup" eq 0 "$(find "$E2E/home/.claude" -name 'settings.json.aiuo-backup.*' | wc -l | tr -d ' ')"
}

# ---------------------------------------------------------------------------
# Native mode (Phase 4)
# ---------------------------------------------------------------------------
native_fixture() {
  load_libs
  AP_MODE=native
  AP_ROOT="/opt/agent pulse/100%"
  AP_ENV_PATH="$AP_ROOT/.env"
  AP_SCRIPT_DIR="$AP_ROOT"
  AP_NODE_BIN="/usr/local/bin/node"
  AP_PG_BIN="/opt/pg 16/bin"
  AP_PG_MODE=own
  AP_INSTANCE=aptest
  VAL_WEB_HOST_PORT=45300
  VAL_POSTGRES_HOST_PORT=45433
}

test_native_systemd_unit() {
  native_fixture
  AP_OS=linux
  local unit
  svc_spec web
  unit=$(render_systemd web)
  check "starts after the cluster" has "$unit" "After=aptest-postgres.service"
  check "reads .env" has "$unit" "EnvironmentFile=/opt/agent pulse/100%%/.env"
  check "forced env wins over EnvironmentFile" has "$unit" 'ExecStart=/usr/bin/env "TZ=UTC" "NODE_ENV=production" "HOSTNAME=127.0.0.1" "PORT=45300"'
  check "paths quoted, % escaped" has "$unit" '"/opt/agent pulse/100%%/apps/web/.next/standalone/apps/web/server.js"'
  check "restart on failure" has "$unit" "Restart=on-failure"
  svc_spec postgres
  unit=$(render_systemd postgres)
  check "postgres takes no .env" hasnt "$unit" "EnvironmentFile"
  check "postgres command" has "$unit" '"/opt/pg 16/bin/postgres" "-D"'
  check "fast shutdown" has "$unit" "KillSignal=SIGINT"
  AP_PG_MODE=reuse
  svc_spec collector
  check "reuse: no dependency on a local cluster" hasnt "$(render_systemd collector)" "After="
}

test_native_launchd_plist() {
  native_fixture
  AP_OS=darwin
  AP_ROOT="/Users/me/a&b"
  AP_ENV_PATH="$AP_ROOT/.env"
  AP_SCRIPT_DIR="$AP_ROOT"
  local plist
  svc_spec collector
  plist=$(render_launchd collector)
  check "label" has "$plist" "<string>com.aptest.collector</string>"
  check "xml escaped" has "$plist" "<string>/Users/me/a&amp;b/scripts/installer/service-run.sh</string>"
  check "wrapper gets forced env before --" has "$plist" $'<string>NODE_ENV=production</string>\n    <string>--</string>\n    <string>/usr/local/bin/node</string>'
  check "restart only on a crash" has "$plist" "<key>SuccessfulExit</key><false/>"
  check "logs under ~/Library/Logs" has "$plist" "Library/Logs/aptest/collector.log"
  if command -v plutil >/dev/null 2>&1; then
    printf '%s\n' "$plist" > "$WORK/p.plist"
    check "plutil accepts it" plutil -lint -s "$WORK/p.plist"
  fi
}

test_native_service_run_env() {
  load_libs
  write "$WORK/svc.env" 'TZ=Asia/Dhaka
SPACED=/Volumes/Macintosh HD 1/Practice
QUOTED="x=y"
'
  local out
  out=$(/bin/bash "$REPO/scripts/installer/service-run.sh" "$WORK/svc.env" TZ=UTC EXTRA=1 -- /usr/bin/env)
  check "forced TZ beats .env" has "$out" $'\nTZ=UTC'
  check "spaces kept" has "$out" "SPACED=/Volumes/Macintosh HD 1/Practice"
  check "quotes stripped" has "$out" "QUOTED=x=y"
  check "forced extra" has "$out" "EXTRA=1"
}

test_native_pg_url_and_loopback() {
  load_libs
  parse_pg_url "postgres://ad%40min:p%3Aw%2Fd@127.0.0.1:5432/postgres"
  check "user decoded" eq "ad@min" "$PG_URL_USER"
  check "password decoded" eq "p:w/d" "$PG_URL_PASS"
  check "port" eq 5432 "$PG_URL_PORT"
  parse_pg_url "postgres://me@localhost/db"
  check "default port, no password" eq "5432::db" "$PG_URL_PORT:$PG_URL_PASS:$PG_URL_DB"
  check "127.0.0.1" is_loopback "127.0.0.1:4317"
  check "::1" is_loopback "[::1]:4317"
  ! is_loopback "*:4317" || return 1
  ! is_loopback "0.0.0.0:4317" || return 1
  ! is_loopback "192.168.1.5:4317" || return 1
}

test_native_password_locked_by_existing_cluster() {
  load_libs
  AP_MODE=native
  AP_OS=linux
  AP_INSTANCE=aptest
  HOME=$WORK/nhome
  XDG_DATA_HOME=""
  parse_example "$REPO/.env.example"
  ENVF_POSTGRES_PASSWORD=change-me-before-first-run
  resolve_var POSTGRES_PASSWORD
  check "no cluster: regenerate" eq generated "$SRC_POSTGRES_PASSWORD"
  mkdir -p "$HOME/.local/share/aptest/pgdata"
  echo 16 > "$HOME/.local/share/aptest/pgdata/PG_VERSION"
  resolve_var POSTGRES_PASSWORD
  check "cluster exists: keep" eq .env "$SRC_POSTGRES_PASSWORD"
}

test_native_forced_port_and_ownership() {
  load_libs
  AP_MODE=native
  parse_example "$REPO/.env.example"
  setv FORCE POSTGRES_HOST_PORT 5432
  BUSY_PORTS="5432"
  AP_PG_MODE=reuse
  port_in_use() { [[ " $BUSY_PORTS " == *" $1 "* ]]; }
  ENVF_POSTGRES_HOST_PORT=5433
  resolve_var POSTGRES_HOST_PORT
  check "reused server's port wins, even over .env" eq "5432 detected" "$VAL_POSTGRES_HOST_PORT $SRC_POSTGRES_HOST_PORT"
  check "and its being busy is expected" eq "" "$AP_ERRORS"
}

find_pg_quiet() { ( load_libs; detect_os; find_pg ) >/dev/null 2>&1; }

test_e2e_native_missing_prereqs() {
  e2e_setup
  printf '#!/bin/sh\nexit 0\n' > "$E2E/stub/systemctl"
  printf '#!/bin/sh\nexit 0\n' > "$E2E/stub/launchctl"
  chmod +x "$E2E/stub/systemctl" "$E2E/stub/launchctl"
  local out rc=0
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --native 2>&1) || rc=$?
  check "exit 1" eq 1 "$rc"
  check "lists node" has "$out" "Node 20"
  # PostgreSQL is looked for at fixed system paths too (/usr/lib/postgresql/16,
  # Homebrew's opt dir), so whether it is missing depends on the machine.
  if ! AP_ROOT=$REPO find_pg_quiet; then check "lists postgres" has "$out" "PostgreSQL 16 server binaries"; fi
  check "nothing written" eq no "$([[ -e $E2E/repo/.env ]] && echo yes || echo no)"
  out=$(installer "CODE_ROOT_1=$E2E/code" -- --yes --native --dry-run 2>&1) || { printf '%s\n' "$out"; return 1; }
  check "dry run still plans" has "$out" "a real run stops here"
  check "identity PATH_MAP planned" has "$out" "$E2E/code:$E2E/code"
  check "bind hosts derived" has "$out" "COLLECTOR_BIND_HOST            derived             127.0.0.1"
}

# ---------------------------------------------------------------------------
for t in $(compgen -A function test_); do run_test "$t"; done
printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[[ $FAIL -eq 0 ]] || { printf 'failed:%s\n' "$FAILED"; exit 1; }
