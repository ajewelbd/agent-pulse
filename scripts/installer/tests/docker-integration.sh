#!/usr/bin/env bash
#
# Docker-mode integration test against a REAL Docker daemon. Opt-in, because
# it builds four images (a few minutes) — run.sh does not call it.
#
#   scripts/installer/tests/docker-integration.sh
#
# It never touches an existing stack: the repo is copied to a temp dir, the
# compose project is named apit<pid> (`-p` overrides `name: aiuo`), every host
# port is in the 55xxx range, and the agent home and code roots are temp dirs.
# Everything it creates — containers, volume, network, images — is removed on
# exit, pass or fail.
#
# Lifecycle covered: install → re-run is a no-op (no container recreated) →
# upgrade (backup first) → uninstall keeps the volume → purge deletes it.

set -Eeuo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/ap-docker-it.XXXXXX")
PROJECT=apit$$
FAILS=0

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

cleanup() {
  say "cleanup"
  local id image
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  docker volume rm "${PROJECT}_pgdata" >/dev/null 2>&1 || true
  docker network rm "${PROJECT}_default" >/dev/null 2>&1 || true
  for image in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$PROJECT-" || true); do docker rmi -f "$image" >/dev/null 2>&1 || true; done
  rm -rf "$T"
  echo "   removed project $PROJECT and $T"
}
trap cleanup EXIT

# Tracked and untracked-but-not-ignored files: the checkout a user would have,
# without node_modules, dist, .env or backups.
say "copying the repo to $T/repo"
mkdir -p "$T/repo" "$T/claude/projects/demo" "$T/code root one" "$T/code root two"
copy_repo "$T/repo"
: > "$T/claude/projects/demo/session.jsonl"

run() {
  env AGENTPULSE_COMPOSE_PROJECT=$PROJECT AGENTPULSE_HEALTH_TIMEOUT=240 \
    POSTGRES_HOST_PORT=55433 COLLECTOR_HOST_PORT=55317 PROXY_HOST_PORT=55318 WEB_HOST_PORT=55300 \
    CLAUDE_HOME="$T/claude" AGENT_GEMINI_CLI_ENABLED=false \
    CODE_ROOT_1="$T/code root one" CODE_ROOT_2="$T/code root two" \
    bash "$T/repo/install.sh" "$@"
}

started_at() { docker inspect -f '{{.State.StartedAt}}' "${PROJECT}-$1-1" 2>/dev/null; }

say "install"
rc=0
run --yes --docker --no-hooks > "$T/install.out" 2>&1 || rc=$?
tail -25 "$T/install.out"
expect "exit 0" "[[ $rc -eq 0 ]]"
expect "dashboard answers" "curl -fsS --max-time 5 http://127.0.0.1:55300/healthz >/dev/null"
expect "collector answers" "curl -fsS --max-time 5 http://127.0.0.1:55317/healthz >/dev/null"
expect "proxy answers" "curl -fsS --max-time 5 http://127.0.0.1:55318/healthz >/dev/null"
expect "root two mounted from the override" "docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' ${PROJECT}-collector-1 | grep -q /host/code/root2"
expect "no 0.0.0.0 publish" "! docker ps --filter label=com.docker.compose.project=$PROJECT --format '{{.Ports}}' | grep -q '0.0.0.0'"
expect ".env is mode 600" "[[ -n \$(find '$T/repo/.env' -prune -perm 600) ]]"
before=$(started_at collector)

say "re-run"
run --yes --docker --no-hooks > "$T/rerun.out" 2>&1 || true
expect "reports no change" "grep -q 'No changes to .env.' '$T/rerun.out'"
expect "collector not restarted" "[[ '$(started_at collector)' == '$before' ]]"
expect "healthy" "grep -q 'AgentPulse is running' '$T/rerun.out'"

say "upgrade"
run --upgrade --yes --no-hooks > "$T/upgrade.out" 2>&1 || true
tail -12 "$T/upgrade.out"
expect "healthy after upgrade" "grep -q 'AgentPulse is running' '$T/upgrade.out'"
dump=$(find "$T/repo/backups" -name "$PROJECT-*.dump" | head -1)
expect "backup written" "[[ -n '$dump' ]]"
expect "backup is a pg_dump custom archive" "[[ \$(head -c 5 '$dump') == PGDMP ]]"
expect "backup restores (pg_restore --list)" "docker exec -i ${PROJECT}-postgres-1 pg_restore --list < '$dump' | grep -q schema_migrations"

say "uninstall"
run --uninstall --yes --no-hooks > "$T/uninstall.out" 2>&1 || true
expect "containers gone" "[[ -z \$(docker ps -aq --filter label=com.docker.compose.project=$PROJECT) ]]"
expect "volume kept" "docker volume inspect ${PROJECT}_pgdata >/dev/null 2>&1"

say "purge"
printf 'delete %s\n' "$PROJECT" | run --uninstall --purge --no-hooks > "$T/purge.out" 2>&1 || true
tail -6 "$T/purge.out"
expect "backup taken before purge" "[[ \$(find '$T/repo/backups' -name '$PROJECT-*.dump' | wc -l) -ge 2 ]]"
expect "volume deleted" "! docker volume inspect ${PROJECT}_pgdata >/dev/null 2>&1"

say "result"
if [[ $FAILS -eq 0 ]]; then echo "   all checks passed"; else echo "   $FAILS check(s) failed"; exit 1; fi
