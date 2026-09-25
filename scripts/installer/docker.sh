# shellcheck shell=bash
# shellcheck disable=SC2034  # globals here are read by the sourcing script or indirectly via ${!ref}
#
# Docker mode: preflight, then start / upgrade / uninstall through the
# existing compose.yaml. Nothing here restates compose logic; every call goes
# through dc().

# compose.yaml:13 names the project, so containers and the data volume carry
# this prefix whatever directory the repo is cloned into. The override exists
# for the integration test, which must never touch a real stack; `-p` beats
# `name:` (checked with a scratch project, docs/install.md §12).
AP_COMPOSE_PROJECT=${AGENTPULSE_COMPOSE_PROJECT:-aiuo}
AP_COMPOSE_VERSION=""
AP_HEALTH_TIMEOUT=${AGENTPULSE_HEALTH_TIMEOUT:-180}

# service:container_port:host_port_var, from the `ports:` entries in compose.yaml.
AP_PUBLISHED="postgres:5432:POSTGRES_HOST_PORT collector:4317:COLLECTOR_HOST_PORT proxy:4318:PROXY_HOST_PORT web:3000:WEB_HOST_PORT"

# Sets AP_COMPOSE_VERSION and AP_COMPOSE_MAJOR. Not called in a subshell, so
# the version survives for the state file.
AP_COMPOSE_MAJOR=0
docker_compose_probe() {
  local v
  v=$(docker compose version --short 2>/dev/null) || return 1
  v=${v#v}
  AP_COMPOSE_VERSION=$v
  AP_COMPOSE_MAJOR=${v%%.*}
  local re='^[0-9]+$'
  [[ $AP_COMPOSE_MAJOR =~ $re ]] || AP_COMPOSE_MAJOR=0
}

# Enough to offer Docker as the default mode. Preflight explains failures.
docker_usable() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  docker_compose_probe || return 1
  [[ $AP_COMPOSE_MAJOR -ge 2 ]]
}

docker_preflight() {
  local out root free_kb ok=true
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker is not installed. Install Docker Desktop (macOS) or Docker Engine + the compose plugin (Linux), or use --native."
    return 1
  fi
  if ! out=$(docker info 2>&1); then
    case "$out" in
      *"permission denied"*)
        fail "this user cannot reach the Docker daemon. Either run: sudo usermod -aG docker \"\$USER\" and log in again, or use --native. The installer will not run docker through sudo."
        ;;
      *)
        fail "the Docker daemon is not reachable. Start Docker Desktop, or: sudo systemctl start docker"
        ;;
    esac
    return 1
  fi
  # `version --short` exists from compose v2 on; v1 (docker-compose) has no
  # `docker compose` subcommand at all. Newer majors (v5 on this machine) keep
  # the v2 file format and CLI.
  if ! docker_compose_probe; then
    fail "Docker Compose v2 or later is required (\`docker compose version\` failed). Install the compose plugin."
    return 1
  fi
  if [[ $AP_COMPOSE_MAJOR -lt 2 ]]; then
    fail "Docker Compose $AP_COMPOSE_VERSION is too old; v2 or later is required."
    return 1
  fi
  info "  docker      ok (compose $AP_COMPOSE_VERSION)"

  # On Linux pgdata lives under the daemon's root dir on this disk. Docker
  # Desktop keeps it inside its own VM disk image, which df cannot see into.
  if [[ $AP_OS == linux ]]; then
    root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
    if [[ -n $root && -d $root ]]; then
      free_kb=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
      if [[ $free_kb -lt 1048576 ]]; then
        fail "less than 1 GB free under $root; pgdata and the images need more"
        ok=false
      elif [[ $free_kb -lt 5242880 ]]; then
        warn "less than 5 GB free under $root; history grows with use"
      fi
    fi
  else
    info "  disk        not checked (Docker Desktop stores data in its own disk image)"
  fi
  [[ $ok == true ]]
}

docker_pgdata_exists() {
  command -v docker >/dev/null 2>&1 &&
    docker volume inspect "${AP_COMPOSE_PROJECT}_pgdata" >/dev/null 2>&1
}

# True when this project's own container already publishes the port, which is
# what a re-run of an installed system looks like. Uses container labels, not
# `docker compose port`, because that parses compose.yaml and fails until .env
# is complete.
docker_port_is_ours() { # <var name> <port>
  local service
  case "$1" in
    POSTGRES_HOST_PORT) service=postgres ;;
    COLLECTOR_HOST_PORT) service=collector ;;
    PROXY_HOST_PORT) service=proxy ;;
    WEB_HOST_PORT) service=web ;;
    *) return 1 ;;
  esac
  command -v docker >/dev/null 2>&1 || return 1
  docker ps \
    --filter "label=com.docker.compose.project=$AP_COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.Ports}}' 2>/dev/null | grep -q "127.0.0.1:$2->"
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

# Files, project and env file are named explicitly so the installer acts on
# this checkout from any cwd. Naming -f turns off compose's auto-merge of
# compose.override.yaml, so it is named too. The phase5 profile brings in web,
# as `make web` does (Makefile:25-26).
dc() {
  if [[ -f $AP_ROOT/compose.override.yaml ]]; then
    docker compose -p "$AP_COMPOSE_PROJECT" --project-directory "$AP_ROOT" --env-file "$AP_ENV_PATH" \
      -f "$AP_ROOT/compose.yaml" -f "$AP_ROOT/compose.override.yaml" --profile phase5 "$@"
  else
    docker compose -p "$AP_COMPOSE_PROJECT" --project-directory "$AP_ROOT" --env-file "$AP_ENV_PATH" \
      -f "$AP_ROOT/compose.yaml" --profile phase5 "$@"
  fi
}

# The resolved value, else what .env holds (uninstall resolves nothing).
env_or_file() {
  if isset VAL "$1"; then getv VAL "$1"; elif [[ -n $(getv ENVF "$1") ]]; then getv ENVF "$1"; else getv EX_DEFAULT "$1"; fi
}

container_of() { dc ps -a -q "$1" 2>/dev/null | head -1; }

container_state() { # <service> → "running 0", "exited 1", or empty
  local id
  id=$(container_of "$1")
  [[ -n $id ]] || return 0
  docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || true
}

container_health() {
  local id
  id=$(container_of "$1")
  [[ -n $id ]] || return 0
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true
}

http_ok() { curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$1/healthz" 2>/dev/null; }

show_logs() {
  info ""
  info "Last 50 log lines of $1:"
  dc logs --no-color --tail 50 "$1" 2>&1 | sed 's/^/  │ /'
}

# postgres healthy, migrate exited 0, then collector, proxy and web answering
# /healthz on their published 127.0.0.1 ports. The HTTP check is from the host,
# so it also proves the publish rule works, which a container healthcheck
# cannot.
docker_wait_healthy() {
  local deadline=$(($(date +%s) + AP_HEALTH_TIMEOUT)) pending="postgres migrate collector proxy web" still svc state
  info ""
  info "Waiting for services (up to ${AP_HEALTH_TIMEOUT}s)"
  while :; do
    still=""
    for svc in $pending; do
      case "$svc" in
        postgres)
          if [[ $(container_health postgres) == healthy ]]; then info "  postgres    healthy"; else still="$still $svc"; fi
          ;;
        migrate)
          state=$(container_state migrate)
          case "$state" in
            "exited 0") info "  migrate     exited 0" ;;
            exited*)
              fail "migrate exited ${state#exited } — no service that depends on it was started"
              show_logs migrate
              return 1
              ;;
            *) still="$still $svc" ;;
          esac
          ;;
        *)
          if http_ok "$(env_or_file "$(published_var "$svc")")"; then
            info "  $(printf '%-11s' "$svc") http://127.0.0.1:$(env_or_file "$(published_var "$svc")")/healthz ok"
          else
            still="$still $svc"
          fi
          ;;
      esac
    done
    pending=${still# }
    [[ -n $pending ]] || return 0
    if [[ $(date +%s) -ge $deadline ]]; then
      fail "not healthy after ${AP_HEALTH_TIMEOUT}s: $pending"
      for svc in $pending; do show_logs "$svc"; done
      return 1
    fi
    sleep 2
  done
}

published_var() {
  local entry
  for entry in $AP_PUBLISHED; do
    [[ ${entry%%:*} == "$1" ]] && { printf '%s' "${entry##*:}"; return; }
  done
}

# Every published port must be bound to 127.0.0.1. compose.yaml says so today;
# this catches an edit that drops the prefix, which would publish the full
# prompt history to the LAN past the host firewall (compose.yaml:3-7). A
# service found listening wider is stopped, not just reported.
docker_verify_ports() {
  local entry svc cport binding bad="" line
  for entry in $AP_PUBLISHED; do
    svc=${entry%%:*}
    cport=${entry#*:}
    cport=${cport%%:*}
    binding=$(dc port "$svc" "$cport" 2>/dev/null || true)
    if [[ -z $binding ]]; then
      bad="$bad $svc"
      fail "$svc: container port $cport is not published"
      continue
    fi
    while IFS= read -r line; do
      [[ -n $line ]] || continue
      if [[ $line != 127.0.0.1:* ]]; then
        bad="$bad $svc"
        fail "$svc: published on $line — must be 127.0.0.1 only"
      fi
    done <<< "$binding"
  done
  if [[ -n $bad ]]; then
    # shellcheck disable=SC2086  # a list of service names
    dc stop $bad >/dev/null 2>&1 || true
    fail "stopped:$bad. Restore the 127.0.0.1: prefix on their ports in compose.yaml."
    return 1
  fi
  info "  ports       all published on 127.0.0.1 only"
}

docker_ensure_postgres() {
  [[ $(container_health postgres) == healthy ]] && return 0
  info "starting postgres for the backup"
  dc up -d postgres
  local deadline=$(($(date +%s) + AP_HEALTH_TIMEOUT))
  until [[ $(container_health postgres) == healthy ]]; do
    if [[ $(date +%s) -ge $deadline ]]; then
      show_logs postgres
      return 1
    fi
    sleep 2
  done
}

# The same dump `make backup` takes (Makefile:46-50): pg_dump -Fc inside the
# postgres container. backup_write (lib.sh) does the file handling.
docker_dump() {
  dc exec -T postgres pg_dump -Fc -U "$(env_or_file POSTGRES_USER)" "$(env_or_file POSTGRES_DB)"
}

docker_backup() {
  AP_BACKUP_PREFIX=$AP_COMPOSE_PROJECT
  backup_write docker_dump
}

# Install and upgrade. `up -d` builds images that do not exist yet, recreates
# only containers whose config changed, and re-runs the one-shot migrate — so a
# re-run of an installed, unchanged stack restarts nothing.
docker_start() { # <upgrade true|false>
  if [[ $1 == true ]]; then
    if docker_pgdata_exists; then
      docker_ensure_postgres || die "$AP_EXIT_PREFLIGHT" "postgres did not start, so no backup could be taken — upgrade aborted, nothing changed"
      docker_backup || die "$AP_EXIT_PREFLIGHT" "backup failed — upgrade aborted, nothing changed"
    else
      info "no database yet, so nothing to back up"
    fi
    info "pulling postgres and rebuilding images"
    dc pull postgres || die "$AP_EXIT_PREFLIGHT" "docker compose pull failed — the running stack was not touched"
    dc build --pull || die "$AP_EXIT_PREFLIGHT" "docker compose build failed — the running stack was not touched"
  fi
  info ""
  info "Starting the stack (images are built on first run; that takes a few minutes)"
  ap_log "docker compose up -d (project $AP_COMPOSE_PROJECT)"
  if ! dc up -d; then
    fail "docker compose up failed"
    [[ $(container_state migrate) == exited\ 0 ]] || show_logs migrate
    exit "$AP_EXIT_HEALTH"
  fi
  docker_wait_healthy || exit "$AP_EXIT_HEALTH"
  docker_verify_ports || exit "$AP_EXIT_HEALTH"
}

# `down` keeps the pgdata volume. `down -v` deletes every byte of history
# (compose.yaml:178-181), so it needs --purge, a typed confirmation, and a
# backup that succeeded first.
docker_uninstall() { # <purge true|false>
  local volume=${AP_COMPOSE_PROJECT}_pgdata typed
  if [[ $1 == true ]]; then
    if [[ $AP_YES == true ]]; then
      die "$AP_EXIT_PREFLIGHT" "--purge deletes all recorded history and needs a typed confirmation; run it without --yes"
    fi
    info ""
    info "PURGE: this removes the containers AND the volume $volume — every recorded"
    info "turn, prompt and diff. A backup is taken first; if it fails, nothing is deleted."
    read_answer typed "Type 'delete $AP_COMPOSE_PROJECT' to confirm: "
    if [[ $typed != "delete $AP_COMPOSE_PROJECT" ]]; then
      info "Confirmation did not match. Nothing was deleted."
      exit 0
    fi
    ap_log "purge confirmed"
    if docker_pgdata_exists; then
      docker_ensure_postgres || die "$AP_EXIT_PREFLIGHT" "postgres did not start, so no backup could be taken — nothing deleted"
      docker_backup || die "$AP_EXIT_PREFLIGHT" "backup failed — nothing deleted"
    fi
    ap_log "docker compose down -v (project $AP_COMPOSE_PROJECT)"
    dc down -v
    info "Removed the containers and $volume."
  else
    if [[ $AP_YES != true ]] && ! ask_yes_no "Stop and remove the AgentPulse containers? The data in $volume is kept." y; then
      info "Nothing changed."
      exit 0
    fi
    ap_log "docker compose down (project $AP_COMPOSE_PROJECT)"
    dc down
    info "Removed the containers. Data kept in $volume."
  fi
}
