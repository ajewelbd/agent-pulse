# shellcheck shell=bash
# shellcheck disable=SC2034  # globals here are read by the sourcing script or indirectly via ${!ref}
#
# Shared helpers for install.sh: output and logging, prompts, masking, OS and
# port detection, atomic writes, installer state.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile, no
# ${v,,} — and no arrays at all, because an empty array under `set -u` is an
# unbound-variable error before bash 4.4. Per-variable state lives in prefixed
# globals (VAL_<NAME>, SRC_<NAME>, …) written with printf -v, read with ${!ref}.

AP_EXIT_PREFLIGHT=1
AP_EXIT_UNRESOLVED=2
AP_EXIT_HEALTH=3 # used from Phase 3 on

AP_YES=false
AP_DRY_RUN=false
AP_LOG_FILE=""
AP_TMP_FILE=""

# ---------------------------------------------------------------------------
# Output. Nothing passed to these may contain a secret: callers pass masked
# values only (mask_value), because every line is also appended to the log.
# ---------------------------------------------------------------------------
ap_log() {
  [[ -n "$AP_LOG_FILE" ]] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$AP_LOG_FILE"
}

info() { printf '%s\n' "$*"; ap_log "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; ap_log "warning: $*"; }
fail() { printf 'error: %s\n' "$*" >&2; ap_log "error: $*"; }
die() {
  local code=$1
  shift
  fail "$*"
  exit "$code"
}

# ---------------------------------------------------------------------------
# Prompts. All read stdin; bash shows the prompt text only when stdin is a
# terminal, which keeps piped test input clean.
# ---------------------------------------------------------------------------

# EOF is fatal rather than an empty answer: a prompt that silently read "" would
# accept a default nobody saw.
read_answer() { # <var> <prompt> [secret]
  local __answer=""
  if [[ "${3:-}" == secret ]]; then
    IFS= read -r -s -p "$2" __answer || [[ -n "$__answer" ]] ||
      die "$AP_EXIT_PREFLIGHT" "input ended while asking: $2(use --yes to run unattended)"
    printf '\n' >&2
  else
    IFS= read -r -p "$2" __answer || [[ -n "$__answer" ]] ||
      die "$AP_EXIT_PREFLIGHT" "input ended while asking: $2(use --yes to run unattended)"
  fi
  printf -v "$1" '%s' "$__answer"
}

ask_yes_no() { # <question> <default y|n>
  local answer hint="[y/N]"
  [[ "$2" == y ]] && hint="[Y/n]"
  if [[ "$AP_YES" == true ]]; then
    [[ "$2" == y ]]
    return
  fi
  while :; do
    read_answer answer "$1 $hint "
    case "$answer" in
      "") [[ "$2" == y ]]; return ;;
      y | Y | yes | YES) return 0 ;;
      n | N | no | NO) return 1 ;;
    esac
    printf 'Please answer y or n.\n' >&2
  done
}

# ---------------------------------------------------------------------------
# Masking: `abcd…(64)`. Short values show nothing but their length.
# ---------------------------------------------------------------------------
mask_secret() {
  local v=$1
  if [[ ${#v} -le 8 ]]; then
    printf '****(%d)' "${#v}"
  else
    printf '%s…(%d)' "${v:0:4}" "${#v}"
  fi
}

# URLs keep their shape so host, port and database can still be checked by eye.
mask_url_or_secret() {
  local v=$1 re='^([a-z][a-z0-9+.-]*://[^:/@]*):([^@]*)@(.*)$'
  if [[ $v =~ $re ]]; then
    printf '%s:%s@%s' "${BASH_REMATCH[1]}" "$(mask_secret "${BASH_REMATCH[2]}")" "${BASH_REMATCH[3]}"
  else
    mask_secret "$v"
  fi
}

# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------

# 32 random bytes as 64 hex characters. Hex needs no quoting in .env, no
# escaping in a URL, and survives install-hooks.sh's `cut -d= -f2-`.
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

# Percent-encode for the userinfo part of a postgres:// URL.
url_encode() {
  local s=$1 out="" c i
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      [A-Za-z0-9._~-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------
AP_OS=""
AP_ARCH=""

detect_os() {
  AP_ARCH=$(uname -m)
  case "$(uname -s)" in
    Darwin) AP_OS=darwin ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then AP_OS=wsl; else AP_OS=linux; fi
      ;;
    *) AP_OS=unsupported ;;
  esac
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------
port_in_use() {
  local port=$1
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  # lsof run without root on macOS lists only this user's sockets, so a
  # listener owned by another user (a Homebrew postgres service) is invisible
  # to it. A loopback connect sees every listener.
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

# First port above <start> that is neither listening nor in <taken>.
next_free_port() { # <start> <taken, space separated>
  local p=$(($1 + 1)) limit=$(($1 + 200))
  while [[ $p -le $limit && $p -le 65535 ]]; do
    if [[ " $2 " != *" $p "* ]] && ! port_in_use "$p"; then
      printf '%s' "$p"
      return 0
    fi
    p=$((p + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

# Content on stdin, never as an argument: argv is readable by any local user
# through ps, and this writes secrets. The temp file sits beside the target so
# the mv is a same-filesystem rename, which is atomic.
write_atomic() { # <target> <mode>
  local target=$1 mode=$2
  AP_TMP_FILE=$(umask 077 && mktemp "$target.tmp.XXXXXX")
  cat > "$AP_TMP_FILE"
  chmod "$mode" "$AP_TMP_FILE"
  mv -f "$AP_TMP_FILE" "$target"
  AP_TMP_FILE=""
}

cleanup_tmp() {
  if [[ -n "$AP_TMP_FILE" ]]; then rm -f "$AP_TMP_FILE"; fi
}

# ---------------------------------------------------------------------------
# State: ./.install/state holds mode, versions and a timestamp. Never secrets.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Database backups, for both modes: <producer> writes a pg_dump -Fc stream to
# stdout. It lands under a temporary name and counts only once it starts with
# the custom-format magic, so a failed dump can never pass for a backup. Mode
# 600 in a 700 directory: it holds every prompt ever recorded.
# ---------------------------------------------------------------------------
AP_LAST_BACKUP=""
AP_BACKUP_PREFIX=agentpulse

backup_write() { # <producer function>
  local dir=$AP_ROOT/backups name tmp magic
  (umask 077 && mkdir -p "$dir")
  name=$dir/$AP_BACKUP_PREFIX-$(utc_stamp).dump
  tmp=$dir/.$(basename "$name").partial
  info "backing up the database → $name"
  ap_log "backup → $name"
  if ! (umask 077 && "$1" > "$tmp"); then
    rm -f "$tmp"
    fail "pg_dump failed"
    return 1
  fi
  magic=$(head -c 5 "$tmp" 2>/dev/null || true)
  if [[ $magic != PGDMP ]]; then
    rm -f "$tmp"
    fail "pg_dump produced no custom-format dump"
    return 1
  fi
  mv -f "$tmp" "$name"
  chmod 600 "$name"
  AP_LAST_BACKUP=$name
  info "  $(du -h "$name" | cut -f1 | tr -d ' ') written"
}

state_get() { # <state file> <key>
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}
