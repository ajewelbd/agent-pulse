#!/usr/bin/env bash
#
# AgentPulse installer. Full reference: docs/install.md.
#
#   ./install.sh                 interactive: asks Docker vs native, then only what is missing
#   ./install.sh --docker        skip the mode question (or --native)
#   ./install.sh --yes           never prompt; exit 2 listing anything unresolved
#   ./install.sh --dry-run       resolve and print the plan; change nothing
#   ./install.sh --upgrade       back up, pull/rebuild, migrate, restart
#   ./install.sh --uninstall     stop and remove services; data kept unless --purge
#
# Docker mode runs the stack through compose.yaml; native mode runs it as
# user-level systemd units (Linux, WSL2) or LaunchAgents (macOS).
#
# Runs on macOS's bash 3.2; see scripts/installer/lib.sh.

set -Eeuo pipefail

AP_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# AGENTPULSE_ROOT points the installer at another checkout; the tests use it.
AP_ROOT=${AGENTPULSE_ROOT:-$AP_SCRIPT_DIR}

# shellcheck source=scripts/installer/lib.sh
. "$AP_SCRIPT_DIR/scripts/installer/lib.sh"
# shellcheck source=scripts/installer/env.sh
. "$AP_SCRIPT_DIR/scripts/installer/env.sh"
# shellcheck source=scripts/installer/docker.sh
. "$AP_SCRIPT_DIR/scripts/installer/docker.sh"
# shellcheck source=scripts/installer/services.sh
. "$AP_SCRIPT_DIR/scripts/installer/services.sh"
# shellcheck source=scripts/installer/native.sh
. "$AP_SCRIPT_DIR/scripts/installer/native.sh"

AP_ENV_PATH=$AP_ROOT/.env
AP_STATE_DIR=$AP_ROOT/.install
AP_STATE_FILE=$AP_STATE_DIR/state
AP_MODE_FLAG=""
AP_ENV_FILE_ARG=""
AP_HOOKS=""
AP_ACTION=install # install | upgrade | uninstall
AP_PURGE=false

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --docker | --native        install mode (default: Docker when Docker + Compose v2 work)
  --yes, --non-interactive   never prompt; exit 2 listing every unresolved variable
  --env-file PATH            extra values, below the process env and .env in precedence
  --dry-run                  resolve and print the plan and a masked table; change nothing
  --reconfigure              ask again for values already in .env (secrets are kept)
  --upgrade                  back up the database, pull and rebuild, migrate, restart
  --uninstall                stop and remove the services; the database is kept
  --purge                    with --uninstall: also delete the database (typed confirmation,
                             backup first; refused with --yes)
  --with-hooks | --no-hooks  install (or with --uninstall, remove) the Claude Code hooks, or
                             skip them; otherwise asked
  -h, --help

Exit codes: 0 ok, 1 preflight failed, 2 unresolved or invalid configuration,
3 health check failed.
EOF
}

set_action() {
  [[ $AP_ACTION == install || $AP_ACTION == "$1" ]] || die "$AP_EXIT_PREFLIGHT" "--upgrade and --uninstall are mutually exclusive"
  AP_ACTION=$1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --docker | --native)
        [[ -z $AP_MODE_FLAG || $AP_MODE_FLAG == "${1#--}" ]] || die "$AP_EXIT_PREFLIGHT" "--docker and --native are mutually exclusive"
        AP_MODE_FLAG=${1#--}
        ;;
      --yes | --non-interactive) AP_YES=true ;;
      --env-file)
        [[ $# -ge 2 ]] || die "$AP_EXIT_PREFLIGHT" "--env-file needs a path"
        AP_ENV_FILE_ARG=$2
        shift
        ;;
      --env-file=*) AP_ENV_FILE_ARG=${1#--env-file=} ;;
      --dry-run) AP_DRY_RUN=true ;;
      --reconfigure) AP_RECONFIGURE=true ;;
      --with-hooks) AP_HOOKS=yes ;;
      --no-hooks) AP_HOOKS=no ;;
      --upgrade) set_action upgrade ;;
      --uninstall) set_action uninstall ;;
      --purge) AP_PURGE=true ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "$AP_EXIT_PREFLIGHT" "unknown option: $1" ;;
    esac
    shift
  done
  if [[ $AP_PURGE == true && $AP_ACTION != uninstall ]]; then
    die "$AP_EXIT_PREFLIGHT" "--purge only goes with --uninstall"
  fi
}

choose_mode() {
  local default previous answer
  if [[ -n $AP_MODE_FLAG ]]; then AP_MODE=$AP_MODE_FLAG; return; fi
  previous=$(state_get "$AP_STATE_FILE" mode)
  if [[ -n $previous ]]; then AP_MODE=$previous; return; fi
  if [[ $AP_ACTION != install ]]; then AP_MODE=docker; return; fi
  if docker_usable; then default=docker; else default=native; fi
  if [[ $AP_YES == true ]]; then AP_MODE=$default; return; fi
  while :; do
    read_answer answer "Install with Docker or natively? [docker/native] ($default) "
    case "${answer:-$default}" in
      docker | d) AP_MODE=docker; return ;;
      native | n) AP_MODE=native; return ;;
    esac
    printf 'Please answer docker or native.\n' >&2
  done
}

open_log() {
  [[ $AP_DRY_RUN == true ]] && return 0
  (umask 077 && mkdir -p "$AP_STATE_DIR" && touch "$AP_STATE_DIR/install.log")
  AP_LOG_FILE=$AP_STATE_DIR/install.log
  ap_log "---- install.sh $* (action: $AP_ACTION, yes: $AP_YES)"
}

load_inputs() {
  parse_example "$AP_ROOT/.env.example"
  if [[ -f $AP_ENV_PATH ]]; then
    AP_FIRST_INSTALL=false
    load_dotenv "$AP_ENV_PATH" ENVF AP_ENVF_KEYS
  fi
  if [[ -n $AP_ENV_FILE_ARG ]]; then
    [[ -f $AP_ENV_FILE_ARG ]] || die "$AP_EXIT_PREFLIGHT" "--env-file $AP_ENV_FILE_ARG does not exist"
    load_dotenv "$AP_ENV_FILE_ARG" XF AP_XF_KEYS
  fi
}

env_is_current() {
  [[ -f $AP_ENV_PATH ]] && [[ "$(render_env)" == "$(cat "$AP_ENV_PATH")" ]]
}

env_mode_ok() {
  [[ -n $(find "$AP_ENV_PATH" -prune -perm 600 2>/dev/null) ]]
}

count_changes() {
  local name n=0
  for name in $(output_names); do
    [[ -n $(change_mark "$name") ]] && n=$((n + 1))
  done
  for name in $AP_ENVF_KEYS; do
    if isset EX_TAGS "$name" && ! isset VAL "$name" && [[ -n $(getv ENVF "$name") ]]; then n=$((n + 1)); fi
  done
  printf '%s' "$n"
}

AP_STEP=1
step() { info "  $AP_STEP. $*"; AP_STEP=$((AP_STEP + 1)); }

print_plan() {
  local status
  if [[ $AP_FIRST_INSTALL == true ]]; then status="new file"
  elif env_is_current; then status="unchanged"
  else status="$(count_changes) value(s) change; rewritten in .env.example order"
  fi
  info ""
  info "Plan"
  info "  mode        $AP_MODE ($AP_OS $AP_ARCH)"
  info "  .env        $AP_ENV_PATH — $status"
  if [[ $status != unchanged ]]; then
    [[ $AP_FIRST_INSTALL == true ]] || step "back up .env → .env.bak.<UTC timestamp>"
    step "write .env (mode 600, atomic)"
  elif ! env_mode_ok; then
    step "chmod 600 .env"
  fi
  if [[ $AP_MODE == docker ]]; then
    step "regenerate compose.override.yaml (code roots 2…N)"
    if [[ $AP_ACTION == upgrade ]]; then
      step "back up the database → backups/$AP_COMPOSE_PROJECT-<UTC>.dump (pg_dump -Fc)"
      step "docker compose pull postgres; docker compose build --pull"
    fi
    step "docker compose up -d (project $AP_COMPOSE_PROJECT; builds missing images, restarts only what changed)"
    step "wait for postgres healthy, migrate exit 0, collector/proxy/web /healthz"
    step "check every published port is bound to 127.0.0.1"
    step "Claude Code hooks: $(hooks_plan)"
  else
    if [[ $AP_PG_MODE == own ]]; then
      if native_cluster_exists; then step "use the cluster in $(native_pgdata)"
      else step "initdb a PostgreSQL 16 cluster in $(native_pgdata) (localhost only, no unix socket)"
      fi
      step "user service $(svc_file postgres | sed "s|^$HOME|~|") on 127.0.0.1:$(env_or_file POSTGRES_HOST_PORT)"
    else
      step "on the existing server (127.0.0.1:$(env_or_file POSTGRES_HOST_PORT)): create role $(env_or_file POSTGRES_USER) and database $(env_or_file POSTGRES_DB) if missing"
    fi
    if [[ $AP_ACTION == upgrade ]]; then
      step "back up the database → backups/$AP_INSTANCE-<UTC>.dump (pg_dump -Fc)"
      step "pnpm install --frozen-lockfile and rebuild schema, collector, proxy, web"
    elif native_artifacts_present; then
      step "build: already present (skipped)"
    else
      step "pnpm install --frozen-lockfile and build schema, collector, proxy, web"
    fi
    step "migrate (packages/schema/dist/migrate.js up)"
    step "user services for collector, proxy, web ($(dirname "$(svc_file collector)" | sed "s|^$HOME|~|"))"
    step "wait for collector/proxy/web /healthz, check every port listens on 127.0.0.1 only"
    step "Claude Code hooks: $(hooks_plan)"
  fi
}

print_uninstall_plan() {
  info ""
  info "Plan"
  if [[ $AP_MODE == native ]]; then
    info "  mode        native, instance $AP_INSTANCE, database: $AP_PG_MODE"
    [[ $AP_PURGE != true ]] || { step "typed confirmation"; step "back up the database → backups/$AP_INSTANCE-<UTC>.dump"; }
    step "stop and remove the user services (web, proxy, collector$([[ $AP_PG_MODE == own ]] && echo ', postgres'))"
    if [[ $AP_PURGE == true && $AP_PG_MODE == own ]]; then step "delete $(native_home)"
    elif [[ $AP_PURGE == true ]]; then step "drop database $(env_or_file POSTGRES_DB) and role $(env_or_file POSTGRES_USER)"
    else step "keep the database"
    fi
    info "  kept        .env, backups/, the build in this checkout"
    return 0
  fi
  info "  mode        $AP_MODE, project $AP_COMPOSE_PROJECT"
  if [[ $AP_PURGE == true ]]; then
    step "typed confirmation"
    step "back up the database → backups/$AP_COMPOSE_PROJECT-<UTC>.dump"
    step "docker compose down -v — deletes ${AP_COMPOSE_PROJECT}_pgdata"
  else
    step "docker compose down — ${AP_COMPOSE_PROJECT}_pgdata is kept"
  fi
  case "$AP_HOOKS" in
    yes) step "remove the Claude Code hooks" ;;
    no) ;;
    *) step "ask whether to remove the Claude Code hooks" ;;
  esac
  info "  kept        .env, backups/, the built images"
}

print_agents() {
  info ""
  info "Agents"
  printf '%s' "$AP_AGENT_REPORT"
  ap_log "agents: $(printf '%s' "$AP_AGENT_REPORT" | tr '\n' ';')"
  if [[ $AP_OLLAMA_FOUND == true ]]; then
    info ""
    info "Ollama is running on 127.0.0.1:11434; the compact panel can use it with no setting."
  fi
}

print_errors() {
  fail "the configuration is incomplete or invalid:"
  printf '%s' "$AP_ERRORS" | sed 's/^/  - /' >&2
  ap_log "unresolved: $(printf '%s' "$AP_ERRORS" | tr '\n' ';')"
  if [[ $AP_YES == true ]]; then
    printf '\nSet these in your shell, in .env, or in a file passed with --env-file, then re-run.\n' >&2
  fi
}

write_env() {
  local backup
  if [[ -f $AP_ENV_PATH ]]; then
    backup=$AP_ENV_PATH.bak.$(utc_stamp)
    [[ -e $backup ]] && backup=$backup.$$
    (umask 077 && cp "$AP_ENV_PATH" "$backup")
    chmod 600 "$backup"
    info "backed up .env → $backup"
  fi
  render_env | write_atomic "$AP_ENV_PATH" 600
  info "wrote $AP_ENV_PATH (mode 600)"
}

write_state() { # <status>
  {
    printf 'mode=%s\n' "$AP_MODE"
    printf 'status=%s\n' "$1"
    printf 'installer_phase=3\n'
    if [[ $AP_MODE == docker ]]; then
      printf 'compose_project=%s\n' "$AP_COMPOSE_PROJECT"
    else
      printf 'instance=%s\n' "$AP_INSTANCE"
      printf 'pg_mode=%s\n' "$AP_PG_MODE"
      printf 'pg_port=%s\n' "$(env_or_file POSTGRES_HOST_PORT)"
      local created=${AP_PG_ROLE_CREATED:-$(state_get "$AP_STATE_FILE" pg_role_created)}
      [[ -z $created ]] || printf 'pg_role_created=%s\n' "$created"
      [[ -z $AP_PG_BIN ]] || printf 'pg_bin=%s\n' "$AP_PG_BIN"
      [[ -z $AP_NODE_BIN ]] || printf 'node_bin=%s\n' "$AP_NODE_BIN"
    fi
    printf 'os=%s\n' "$AP_OS"
    printf 'arch=%s\n' "$AP_ARCH"
    [[ -n $AP_COMPOSE_VERSION ]] && printf 'compose_version=%s\n' "$AP_COMPOSE_VERSION"
    command -v node >/dev/null 2>&1 && printf 'node_version=%s\n' "$(node -v)"
    [[ -n $AP_LAST_BACKUP ]] && printf 'last_backup=%s\n' "$AP_LAST_BACKUP"
    printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } | write_atomic "$AP_STATE_FILE" 600
}

# ---------------------------------------------------------------------------
# Claude Code hooks, through scripts/install-hooks.sh (idempotent, backs up
# settings.json, never edits a shell rc).
# ---------------------------------------------------------------------------
hook_script_path() { printf '%s/aiuo/post-event.sh' "$(effective_home CLAUDE_HOME)"; }

# Current = the forwarder posts to this collector port with this secret. The
# comparison happens inside bash: the secret never becomes a grep argument.
hooks_state() { # → current | stale | absent
  local f content
  f=$(hook_script_path)
  [[ -f $f ]] || { printf absent; return; }
  content=$(cat "$f")
  if [[ $content == *"127.0.0.1:$(env_or_file COLLECTOR_HOST_PORT)/v1/hooks"* &&
    $content == *"X-Aiuo-Secret: $(env_or_file COLLECTOR_SHARED_SECRET)'"* ]]; then
    printf current
  else
    printf stale
  fi
}

hooks_plan() {
  if [[ $(env_or_file AGENT_CLAUDE_CODE_ENABLED) != true ]]; then printf 'skipped (claude_code not enabled)'; return; fi
  case "$(hooks_state):$AP_HOOKS" in
    current:*) printf 'already installed and current' ;;
    *:no) printf 'skipped (--no-hooks)' ;;
    *:yes) printf 'install via scripts/install-hooks.sh' ;;
    stale:*) printf 'installed but stale (other port or secret) — %s' "$([[ $AP_YES == true ]] && echo 'left as is; pass --with-hooks' || echo 'will ask')" ;;
    absent:*) printf '%s' "$([[ $AP_YES == true ]] && echo 'not installed; pass --with-hooks' || echo 'will ask')" ;;
  esac
}

run_install_hooks() { # [--uninstall]
  ENV_FILE=$AP_ENV_PATH CLAUDE_HOME=$(effective_home CLAUDE_HOME) "$AP_SCRIPT_DIR/scripts/install-hooks.sh" "$@"
}

hooks_step() {
  local state
  [[ $(env_or_file AGENT_CLAUDE_CODE_ENABLED) == true ]] || return 0
  state=$(hooks_state)
  info ""
  if [[ $state == current ]]; then
    info "Claude Code hooks: installed and current."
    return 0
  fi
  if [[ $AP_HOOKS == no ]]; then
    info "Claude Code hooks: skipped (--no-hooks). Later: make install-hooks"
    return 0
  fi
  if [[ $AP_HOOKS != yes ]]; then
    if [[ $AP_YES == true ]]; then
      info "Claude Code hooks: $state, left as is. Install with --with-hooks or: make install-hooks"
      return 0
    fi
    info "Claude Code hooks add measured durations, exit codes and exact tool-call joins."
    info "They edit $(effective_home CLAUDE_HOME)/settings.json (backed up first; nothing else is touched)."
    ask_yes_no "Install them now?" y || { info "Skipped. Later: make install-hooks"; return 0; }
  fi
  ap_log "install-hooks.sh --port $(env_or_file COLLECTOR_HOST_PORT)"
  run_install_hooks --port "$(env_or_file COLLECTOR_HOST_PORT)" --proxy-port "$(env_or_file PROXY_HOST_PORT)"
}

hooks_uninstall_step() {
  [[ -f $(hook_script_path) ]] || return 0
  case "$AP_HOOKS" in
    no) return 0 ;;
    yes) ;;
    *)
      if [[ $AP_YES == true ]]; then
        info "Claude Code hooks left installed (they fail silently with the collector gone). Remove: make uninstall-hooks"
        return 0
      fi
      ask_yes_no "Also remove the Claude Code hooks?" n || return 0
      ;;
  esac
  ap_log "install-hooks.sh --uninstall"
  run_install_hooks --uninstall
}

# ---------------------------------------------------------------------------
print_done() {
  local web
  web=$(env_or_file WEB_HOST_PORT)
  info ""
  info "AgentPulse is running."
  info "  dashboard   http://127.0.0.1:$web"
  info "  hooks       http://127.0.0.1:$(env_or_file COLLECTOR_HOST_PORT)/v1/hooks"
  info "  proxy       export ANTHROPIC_BASE_URL=http://127.0.0.1:$(env_or_file PROXY_HOST_PORT)   (optional, Layer 3)"
  info "  .env        $AP_ENV_PATH"
  info "  backups     $AP_ROOT/backups/ (database), $AP_ROOT/.env.bak.* (config)"
  info "  log         $AP_STATE_DIR/install.log"
  if [[ $AP_MODE == native ]]; then
    [[ $AP_PG_MODE == own ]] && info "  database    $(native_pgdata)"
    info "  units       $(dirname "$(svc_file collector)")"
    if [[ $AP_OS == darwin ]]; then info "  logs        $(svc_log_dir)/"
    else info "  logs        journalctl --user -u '$AP_INSTANCE-*'"
    fi
  fi
  info ""
  info "  upgrade     ./install.sh --upgrade"
  info "  uninstall   ./install.sh --uninstall      (keeps the database)"
  info ""
  if [[ $AP_MODE == docker ]]; then
    info "  NEVER run 'docker compose down -v' casually: it deletes all recorded history."
    info "  ./install.sh --uninstall --purge does it deliberately, after a backup."
  else
    info "  ./install.sh --uninstall --purge deletes the database, after a typed"
    info "  confirmation and a backup. Nothing else does."
  fi
}

run_uninstall() {
  load_inputs
  if [[ ! -f $AP_ENV_PATH ]]; then
    info "No .env at $AP_ENV_PATH — nothing is installed here."
    exit 0
  fi
  print_uninstall_plan
  if [[ $AP_DRY_RUN == true ]]; then info ""; info "Dry run: nothing was changed."; exit 0; fi
  if [[ $AP_MODE == docker ]]; then docker_uninstall "$AP_PURGE"; else native_uninstall "$AP_PURGE"; fi
  hooks_uninstall_step
  write_state "$([[ $AP_PURGE == true ]] && echo purged || echo uninstalled)"
  info ""
  info "Kept: $AP_ENV_PATH (its secrets still match the hooks and, unless purged, the database)."
  [[ -z $AP_LAST_BACKUP ]] || info "Backup: $AP_LAST_BACKUP"
  info "Reinstall: ./install.sh --$AP_MODE"
}

main() {
  parse_args "$@"
  trap cleanup_tmp EXIT
  detect_os
  [[ $AP_OS != unsupported ]] ||
    die "$AP_EXIT_PREFLIGHT" "unsupported OS $(uname -s). Supported: Linux, macOS, and Windows via WSL2."
  open_log "$@"

  choose_mode
  info "AgentPulse installer — $AP_ACTION, $AP_MODE mode$([[ $AP_DRY_RUN == true ]] && echo ', dry run')"
  info ""
  info "Preflight"
  if [[ $AP_MODE == docker ]]; then
    docker_preflight || exit "$AP_EXIT_PREFLIGHT"
  elif [[ $AP_ACTION == uninstall ]]; then
    native_supported || die "$AP_EXIT_PREFLIGHT" "native mode is not supported on this system"
    find_pg || true
    AP_PG_MODE=$(state_get "$AP_STATE_FILE" pg_mode)
    AP_PG_MODE=${AP_PG_MODE:-own}
  else
    native_preflight || exit "$AP_EXIT_PREFLIGHT"
    native_choose_pg
  fi
  [[ $AP_MODE == docker ]] || AP_BACKUP_PREFIX=$AP_INSTANCE

  if [[ $AP_ACTION == uninstall ]]; then
    run_uninstall
    return
  fi

  load_inputs
  resolve_all
  if [[ -n $AP_ERRORS ]]; then
    print_errors
    exit "$AP_EXIT_UNRESOLVED"
  fi

  print_plan
  print_table
  print_agents

  if [[ $AP_DRY_RUN == true ]]; then
    info ""
    info "Dry run: nothing was written."
    exit 0
  fi

  if env_is_current; then
    info ""
    info "No changes to .env."
    if ! env_mode_ok; then
      chmod 600 "$AP_ENV_PATH"
      info "set .env to mode 600 (it was readable by other users)"
    fi
    if [[ $AP_ACTION == upgrade && $AP_YES != true ]] &&
      ! ask_yes_no $'\nBack up the database, rebuild and restart?' y; then
      info "Nothing changed."
      exit 0
    fi
  else
    local question=$'\nWrite .env with these values?'
    [[ $AP_MODE == docker ]] && question=$'\nWrite .env and start the stack?'
    [[ $AP_MODE == native ]] && question=$'\nWrite .env and carry out the steps above?'
    if [[ $AP_YES != true ]] && ! ask_yes_no "$question" n; then
      info "Nothing written."
      exit 0
    fi
    write_env
    AP_ENV_CHANGED=true
  fi

  if [[ $AP_MODE == native ]]; then
    write_state configured
    native_start "$([[ $AP_ACTION == upgrade ]] && echo true || echo false)"
    write_state healthy
    hooks_step
    print_done
    return
  fi

  ENV_FILE=$AP_ENV_PATH COMPOSE_OVERRIDE_FILE=$AP_ROOT/compose.override.yaml \
    "$AP_SCRIPT_DIR/scripts/installer/compose-override.sh" || exit "$AP_EXIT_PREFLIGHT"
  write_state configured
  docker_start "$([[ $AP_ACTION == upgrade ]] && echo true || echo false)"
  write_state healthy
  hooks_step
  print_done
}

main "$@"
