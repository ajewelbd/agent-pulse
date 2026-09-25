# shellcheck shell=bash
# shellcheck disable=SC2034  # globals here are read by the sourcing script or indirectly via ${!ref}
# shellcheck disable=SC2153  # AP_OS and AP_ROOT come from lib.sh / install.sh
#
# Environment resolution for install.sh.
#
# .env.example is the single source of truth for which variables exist and how
# each is classified: its @tags (legend at the top of that file). This file
# keeps no list of its own. What it does key by name is how to detect, derive
# and validate a value; an unknown name gets only the generic checks, and a
# @derived name with no derivation here is fatal, so a new one cannot land as
# silently unset.
#
# Per-variable globals, NAME being the variable:
#   EX_TAGS_NAME     " @required @secret "  (space padded for matching)
#   EX_DEFAULT_NAME  the value on an active `NAME=…` line
#   EX_ACTIVE_NAME   1 for `NAME=…`, 0 for `# NAME=…`
#   EX_HELP_NAME     the comment block above it
#   ENVF_NAME        value in the existing .env
#   XF_NAME          value in --env-file
#   VAL_NAME SRC_NAME NOTE_NAME   the resolution
#
# Precedence, per variable: process env › existing .env › --env-file ›
# detected › generated › prompt › .env.example default. @derived variables are
# computed after everything else, from the resolved values.

AP_KNOWN_TAGS=" @required @optional @secret @generated @derived @detect @prompt @docker @native "

AP_MODE=""              # docker | native
AP_FIRST_INSTALL=true   # no .env yet
AP_RECONFIGURE=false
AP_VARS=""              # names in .env.example order
AP_ENVF_KEYS=""         # names in the existing .env, file order
AP_XF_KEYS=""           # names in --env-file
AP_ROOT_IDX=""          # code-root indexes in use, ascending
AP_TAKEN_PORTS=""
AP_ERRORS=""            # one "NAME: reason" per line
AP_AGENT_REPORT=""      # one line per agent, for the summary
AP_OLLAMA_FOUND=false

# ---------------------------------------------------------------------------
# Per-variable storage
# ---------------------------------------------------------------------------
getv() { local ref="$1_$2"; printf '%s' "${!ref-}"; }
isset() { local ref="$1_$2"; [[ -n "${!ref+x}" ]]; }
setv() { printf -v "$1_$2" '%s' "$3"; }

is_code_root() { local re='^CODE_ROOT_[1-9][0-9]*$'; [[ $1 =~ $re ]]; }

# CODE_ROOT_3… are not listed in .env.example; they share CODE_ROOT_2's tags.
# No subshell: this runs hundreds of times per install.
has_tag() { # <name> <tag>
  local ref="EX_TAGS_$1"
  if [[ -z ${!ref+x} ]] && is_code_root "$1"; then ref=EX_TAGS_CODE_ROOT_2; fi
  [[ "${!ref-}" == *" $2 "* ]]
}

in_scope() {
  if [[ $AP_MODE == docker ]] && has_tag "$1" @native; then return 1; fi
  if [[ $AP_MODE == native ]] && has_tag "$1" @docker; then return 1; fi
  return 0
}

add_error() { AP_ERRORS="$AP_ERRORS$1: $2"$'\n'; }

record() { # <name> <value> <source> [note]
  setv VAL "$1" "$2"
  setv SRC "$1" "$3"
  setv NOTE "$1" "${4:-}"
}

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

# One layer of matching quotes is removed; in an unquoted value " #" starts a
# comment. That is how compose reads .env, for every value this installer
# writes or accepts.
dotenv_unquote() {
  local v=$1
  if [[ ${#v} -ge 2 ]]; then
    case "$v" in
      \"*\" | \'*\')
        printf '%s' "${v:1:${#v}-2}"
        return
        ;;
    esac
  fi
  v="${v%% \#*}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# Fill <prefix>_NAME from a dotenv file and append each name to the list held
# in the variable <keys var>. Later duplicates win, as in compose.
load_dotenv() { # <file> <prefix> <keys var>
  # Locals are __-prefixed: <keys var> is assigned by name, and a local of the
  # same name would swallow the assignment.
  local __file=$1 __prefix=$2 __keysvar=$3 __line __key __value __keys=""
  local re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
  while IFS= read -r __line || [[ -n "$__line" ]]; do
    __line=${__line%$'\r'}
    [[ $__line =~ $re ]] || continue
    __key=${BASH_REMATCH[2]}
    __value=$(dotenv_unquote "${BASH_REMATCH[3]}")
    setv "$__prefix" "$__key" "$__value"
    [[ " $__keys " == *" $__key "* ]] || __keys="$__keys $__key"
  done < "$__file"
  printf -v "$__keysvar" '%s' "${__keys# }"
}

# The grammar is in the header of .env.example: a line is a variable only when
# a tag line sits directly above it. Anything that breaks it stops the install
# rather than being guessed at.
parse_example() { # <file>
  local file=$1 line n=0 tags="" help="" name raw active tag
  local re_var='^([A-Z_][A-Z0-9_]*)=(.*)$'
  local re_cvar='^# ?([A-Z_][A-Z0-9_]*)=(.*)$'
  local re_banner='^# ?-{3,}$'
  AP_VARS=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    if [[ -n "$tags" ]]; then
      if [[ $line =~ $re_var ]]; then
        active=1
      elif [[ $line =~ $re_cvar ]]; then
        active=0
      else
        die "$AP_EXIT_PREFLIGHT" "$file:$n: a tag line must be followed by a variable line"
      fi
      name=${BASH_REMATCH[1]}
      raw=${BASH_REMATCH[2]}
      if isset EX_TAGS "$name"; then die "$AP_EXIT_PREFLIGHT" "$file:$n: $name is declared twice"; fi
      setv EX_TAGS "$name" "$tags"
      setv EX_ACTIVE "$name" "$active"
      setv EX_HELP "$name" "$help"
      if [[ $active == 1 ]]; then setv EX_DEFAULT "$name" "$(dotenv_unquote "$raw")"; fi
      AP_VARS="$AP_VARS $name"
      tags=""
      help=""
      continue
    fi
    case "$line" in
      "# @"*)
        tags=" "
        for tag in ${line#\# }; do
          [[ "$AP_KNOWN_TAGS" == *" $tag "* ]] || die "$AP_EXIT_PREFLIGHT" "$file:$n: unknown tag $tag"
          tags="$tags$tag "
        done
        ;;
      "") help="" ;;
      "#"*)
        if [[ $line =~ $re_banner ]]; then
          help=""
        else
          line=${line#\#}
          help="$help${line# }"$'\n'
        fi
        ;;
      *)
        if [[ $line =~ $re_var ]]; then
          die "$AP_EXIT_PREFLIGHT" "$file:$n: ${BASH_REMATCH[1]} has no tag line above it"
        fi
        ;;
    esac
  done < "$file"
  AP_VARS=${AP_VARS# }
  [[ -z "$tags" ]] || die "$AP_EXIT_PREFLIGHT" "$file: ends with a tag line and no variable"
}

# ---------------------------------------------------------------------------
# Validation. Each validator sets AP_ERR and returns 1 on a bad value.
# ---------------------------------------------------------------------------
AP_ERR=""

# Values are written unquoted, and compose reads .env the way a shell would
# read an assignment: it expands $, treats " #" as a comment, and strips quotes.
# Values that would read back differently are refused.
validate_safe() {
  local v=$1
  case "$v" in
    *$'\n'* | *$'\r'* | *$'\t'*) AP_ERR="contains a control character"; return 1 ;;
    *'$'*) AP_ERR="contains '\$', which compose would expand"; return 1 ;;
    *' #'*) AP_ERR="contains ' #', which starts a comment in .env"; return 1 ;;
    [\"\']*) AP_ERR="starts with a quote"; return 1 ;;
    [[:space:]]* | *[[:space:]]) AP_ERR="has leading or trailing whitespace"; return 1 ;;
  esac
  return 0
}

validate_int() { # <value> <min> <max>
  local re='^[0-9]+$'
  if ! [[ $1 =~ $re ]] || [[ $1 -lt $2 || $1 -gt $3 ]]; then
    AP_ERR="must be an integer from $2 to $3"
    return 1
  fi
}

validate_dir() {
  case "$1" in
    /*) ;;
    *) AP_ERR="must be an absolute path"; return 1 ;;
  esac
  case "$1" in
    *,*) AP_ERR="contains ',', the PATH_MAP separator"; return 1 ;;
  esac
  [[ -d "$1" ]] || { AP_ERR="is not a directory on this machine"; return 1; }
}

validate_url() {
  local re='^https?://[^[:space:]]+$'
  [[ $1 =~ $re ]] || { AP_ERR="must be an http:// or https:// URL"; return 1; }
}

validate_value() { # <name> <value>
  local name=$1 v=$2 re
  AP_ERR=""
  validate_safe "$v" || return 1
  case "$name" in
    *_HOST_PORT | COLLECTOR_PORT | PROXY_PORT) validate_int "$v" 1 65535 ;;
    HOST_UID | HOST_GID) validate_int "$v" 0 4294967295 ;;
    POSTGRES_USER | POSTGRES_DB)
      re='^[a-z_][a-z0-9_]{0,62}$'
      [[ $v =~ $re ]] || { AP_ERR="must be a lowercase identifier ([a-z_][a-z0-9_]*)"; return 1; }
      ;;
    COLLECTOR_SHARED_SECRET)
      # Also pasted into a single-quoted curl header by install-hooks.sh.
      re='^[A-Za-z0-9._~+/=-]{16,}$'
      [[ $v =~ $re ]] || { AP_ERR="must be at least 16 characters of [A-Za-z0-9._~+/=-]"; return 1; }
      ;;
    REDACTION_DISABLED | AGENT_*_ENABLED)
      [[ $v == true || $v == false ]] || { AP_ERR="must be true or false"; return 1; }
      ;;
    COLLECTOR_MAX_*_BYTES | WATCH_POLL_INTERVAL_MS) validate_int "$v" 0 2147483647 ;;
    PROXY_MAX_*_BYTES) validate_int "$v" 1 2147483647 ;;
    WATCH_MODE)
      [[ $v == auto || $v == poll || $v == inotify ]] || { AP_ERR="must be auto, poll or inotify"; return 1; }
      ;;
    PROXY_DEFAULT_UPSTREAM | OLLAMA_BASE_URL | COLLECTOR_URL) validate_url "$v" ;;
    PROXY_UPSTREAMS)
      re='^[A-Za-z0-9_-]+=https?://[^,[:space:]]+(,[A-Za-z0-9_-]+=https?://[^,[:space:]]+)*$'
      [[ $v =~ $re ]] || { AP_ERR="must be name=url[,name=url…]"; return 1; }
      ;;
    CLAUDE_HOME | GEMINI_HOME | CODE_ROOT_* | AGENT_*_HOME) validate_dir "$v" ;;
    PATH_MAP) validate_path_map "$v" ;;
    DATABASE_URL | DATABASE_URL_HOST)
      re='^postgres(ql)?://'
      [[ $v =~ $re ]] || { AP_ERR="must be a postgres:// URL"; return 1; }
      ;;
    COLLECTOR_BIND_HOST | PROXY_BIND_HOST)
      re='^[A-Za-z0-9.:-]+$'
      [[ $v =~ $re ]] || { AP_ERR="must be an address such as 127.0.0.1"; return 1; }
      ;;
    ANTHROPIC_API_KEY)
      re='^[A-Za-z0-9_-]{20,}$'
      [[ $v =~ $re ]] || { AP_ERR="does not look like an API key"; return 1; }
      ;;
  esac
}

# ---------------------------------------------------------------------------
# PATH_MAP. Two checks: the collector's own parser when a build of it can be
# imported, and a bash port of it that always runs. The port follows
# apps/collector/src/paths.ts line for line, down to the error messages, and
# tests/run.sh asserts the two agree.
# ---------------------------------------------------------------------------
pm_normalize() { # paths.ts:28-31
  local p=$1
  while [[ $p == */ ]]; do p=${p%/}; done
  printf '%s' "${p:-/}"
}

pm_has_prefix() { # <path> <prefix>  — paths.ts:40-43, segment boundaries only
  if [[ $2 == / ]]; then [[ $1 == /* ]]; return; fi
  [[ $1 == "$2" || $1 == "$2"/* ]]
}

# The bash port. Sets AP_ERR to the message PathMapper.parse would throw.
pm_check_bash() {
  local raw=$1 pair host container hosts="" containers="" count=0 i j hi hj ci cj
  local ws_re='^[[:space:]]*(.*[^[:space:]])[[:space:]]*$'
  while IFS= read -r pair || [[ -n "$pair" ]]; do
    if [[ $pair =~ $ws_re ]]; then pair=${BASH_REMATCH[1]}; else pair=""; fi
    [[ -n $pair ]] || continue
    # paths.ts:75 splits on the LAST colon.
    if [[ $pair != *:* || $pair == :* || $pair == *: ]]; then
      AP_ERR="PATH_MAP entry \"$pair\" is not host_prefix:container_prefix"
      return 1
    fi
    host=${pair%:*}
    container=${pair##*:}
    if [[ $host != /* || $container != /* ]]; then
      AP_ERR="PATH_MAP entry \"$pair\" must use absolute paths on both sides"
      return 1
    fi
    hosts="$hosts$(pm_normalize "$host")"$'\n'
    containers="$containers$(pm_normalize "$container")"$'\n'
    count=$((count + 1))
  done <<< "$(printf '%s' "$raw" | tr ',' '\n')"
  if [[ $count -eq 0 ]]; then
    AP_ERR="PATH_MAP is empty — the collector cannot translate any path"
    return 1
  fi
  # paths.ts:102-121: an earlier entry must not swallow a later one.
  for ((i = 1; i <= count; i++)); do
    hi=$(sed -n "${i}p" <<< "$hosts")
    ci=$(sed -n "${i}p" <<< "$containers")
    for ((j = i + 1; j <= count; j++)); do
      hj=$(sed -n "${j}p" <<< "$hosts")
      cj=$(sed -n "${j}p" <<< "$containers")
      if pm_has_prefix "$hj" "$hi"; then
        AP_ERR="PATH_MAP entry $j (\"$hj\") is shadowed by entry $i (\"$hi\") and would never match. List the more specific prefix first."
        return 1
      fi
      if pm_has_prefix "$cj" "$ci"; then
        AP_ERR="PATH_MAP container prefix $j (\"$cj\") is shadowed by entry $i (\"$ci\"). List the more specific prefix first."
        return 1
      fi
    done
  done
  return 0
}

# The collector's own parser. Returns 2 when no build is importable. The value
# travels in the environment, not argv.
pm_check_node() {
  local dist="$AP_ROOT/apps/collector/dist/paths.js" out
  [[ -f $dist ]] && command -v node >/dev/null 2>&1 || return 2
  # shellcheck disable=SC2016  # JavaScript, not shell
  if out=$(AP_PM_VALUE=$1 AP_PM_DIST=$dist node --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const { PathMapper } = await import(pathToFileURL(process.env.AP_PM_DIST).href);
    try { PathMapper.parse(process.env.AP_PM_VALUE); }
    catch (e) { process.stdout.write(e.message); process.exit(1); }' 2>&1); then
    return 0
  fi
  AP_ERR=$out
  return 1
}

# Entries normalised and sorted, for comparing two maps regardless of order.
pm_entry_set() {
  local pair
  printf '%s' "$1" | tr ',' '\n' | while IFS= read -r pair || [[ -n $pair ]]; do
    [[ -n $pair ]] || continue
    printf '%s:%s\n' "$(pm_normalize "${pair%:*}")" "$(pm_normalize "${pair##*:}")"
  done | LC_ALL=C sort
}

validate_path_map() {
  pm_check_bash "$1" || return 1
  local rc=0
  pm_check_node "$1" || rc=$?
  [[ $rc -ne 1 ]]
}

# Entries for every enabled agent home and code root, most specific host
# prefix first, so a root that contains an agent home (CODE_ROOT_1=$HOME) cannot
# shadow it. Docker maps onto the compose mount targets; native has no mount
# layer, so each entry maps a path onto itself.
build_path_map() {
  local tab=$'\t' lines="" i home out=""
  if [[ $(getv VAL AGENT_CLAUDE_CODE_ENABLED) == true ]]; then
    home=$(effective_home CLAUDE_HOME)
    if [[ $AP_MODE == docker ]]; then lines="$lines$home$tab/host/agents/claude"$'\n'; else lines="$lines$home$tab$home"$'\n'; fi
  fi
  if [[ $(getv VAL AGENT_GEMINI_CLI_ENABLED) == true ]]; then
    home=$(effective_home GEMINI_HOME)
    if [[ $AP_MODE == docker ]]; then lines="$lines$home$tab/host/agents/gemini"$'\n'; else lines="$lines$home$tab$home"$'\n'; fi
  fi
  for i in $AP_ROOT_IDX; do
    home=$(getv VAL "CODE_ROOT_$i")
    if [[ $AP_MODE == docker ]]; then lines="$lines$home$tab/host/code/root$i"$'\n'; else lines="$lines$home$tab$home"$'\n'; fi
  done
  [[ -n $lines ]] || return 1
  while IFS="$tab" read -r _ home i; do
    out="$out,$home:$i"
  done <<< "$(printf '%s' "$lines" | while IFS="$tab" read -r home i; do
    printf '%d\t%s\t%s\n' "${#home}" "$home" "$i"
  done | sort -t "$tab" -k1,1nr -s)"
  printf '%s' "${out#,}"
}

# Compose falls back to ~/.claude and ~/.gemini when these are unset.
effective_home() {
  local v
  v=$(getv VAL "$1")
  if [[ -n $v ]]; then printf '%s' "$v"; return; fi
  case "$1" in
    CLAUDE_HOME) printf '%s' "$HOME/.claude" ;;
    GEMINI_HOME) printf '%s' "$HOME/.gemini" ;;
  esac
}

# ---------------------------------------------------------------------------
# Detection. Sets AP_DV (and AP_DNOTE) and returns 0 when there is something.
# ---------------------------------------------------------------------------
AP_DV=""
AP_DNOTE=""

# Mirrors each adapter's discover(): claude-code.ts:489-530 scans
# <home>/projects/<slug>/*.jsonl, gemini-cli.ts:280-305 scans
# <home>/tmp/<hash>/chats/session-*.
has_transcripts() { # <agent key> <home>
  local f
  case "$1" in
    claude_code) for f in "$2"/projects/*/*.jsonl; do [[ -f $f ]] && return 0; done ;;
    gemini_cli) for f in "$2"/tmp/*/chats/session-*; do [[ -f $f ]] && return 0; done ;;
  esac
  return 1
}

detect_value() { # <name>
  local name=$1 home
  AP_DV=""
  AP_DNOTE=""
  case "$name" in
    CLAUDE_HOME) [[ -d $HOME/.claude ]] && AP_DV=$HOME/.claude ;;
    GEMINI_HOME) [[ -d $HOME/.gemini ]] && AP_DV=$HOME/.gemini ;;
    AGENT_CLAUDE_CODE_ENABLED | AGENT_GEMINI_CLI_ENABLED)
      if [[ $name == AGENT_CLAUDE_CODE_ENABLED ]]; then home=$(effective_home CLAUDE_HOME); else home=$(effective_home GEMINI_HOME); fi
      if has_transcripts "$(agent_key "$name")" "$home"; then
        AP_DV=true
        AP_DNOTE="transcripts found in $home"
      else
        AP_DV=false
        AP_DNOTE="no transcripts in $home"
      fi
      ;;
    HOST_UID) AP_DV=$(id -u) ;;
    HOST_GID) AP_DV=$(id -g) ;;
    WATCH_MODE)
      # Bind mounts on Docker Desktop for macOS do not deliver inotify events
      # reliably (compose.dev.yaml:18-21 forces poll for the same reason), and
      # neither do WSL's /mnt/* drives.
      if [[ $AP_MODE == docker && $AP_OS == darwin ]]; then
        AP_DV=poll
        AP_DNOTE="Docker Desktop bind mounts drop inotify events"
      elif [[ $AP_OS == wsl ]] && roots_under_mnt; then
        AP_DV=poll
        AP_DNOTE="a code root is on a WSL /mnt drive"
      fi
      ;;
    OLLAMA_BASE_URL)
      # Nothing to write: the dashboard's default already reaches a local
      # daemon, natively and from compose. Only reported in the summary.
      if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        AP_OLLAMA_FOUND=true
      fi
      ;;
  esac
  [[ -n $AP_DV ]]
}

agent_key() { # AGENT_CLAUDE_CODE_ENABLED → claude_code
  local k=${1#AGENT_}
  k=${k%_ENABLED}
  printf '%s' "$k" | tr '[:upper:]' '[:lower:]'
}

roots_under_mnt() {
  local i
  for i in $AP_ROOT_IDX; do
    [[ $(getv VAL "CODE_ROOT_$i") == /mnt/* ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
AP_LV=""
AP_LS=""
AP_LNOTE=""

# A @generated variable still holding its .env.example value is a copied
# placeholder, and counts as unset — except where regenerating it would lock
# the user out of data that already exists.
is_placeholder() { # <name> <value>
  has_tag "$1" @generated && [[ $(getv EX_ACTIVE "$1") == 1 && $2 == "$(getv EX_DEFAULT "$1")" ]]
}

# Postgres reads POSTGRES_PASSWORD only when it initialises an empty data
# directory. Once pgdata exists, a new value here would simply fail to log in.
placeholder_locked() {
  [[ $1 == POSTGRES_PASSWORD ]] || return 1
  if [[ $AP_MODE == docker ]]; then docker_pgdata_exists; else native_cluster_exists; fi
}

lookup_sources() { # <name>
  local name=$1 v
  AP_LV=""
  AP_LS=""
  AP_LNOTE=""
  # A value the mode has already fixed, such as the port of a reused server.
  v=$(getv FORCE "$name")
  if [[ -n $v ]]; then AP_LV=$v; AP_LS=detected; AP_LNOTE="fixed by the database choice"; return 0; fi
  v=${!name-}
  if [[ -n $v ]] && ! is_placeholder "$name" "$v"; then AP_LV=$v; AP_LS="env"; return 0; fi
  v=$(getv ENVF "$name")
  if [[ -n $v ]]; then
    if ! is_placeholder "$name" "$v"; then AP_LV=$v; AP_LS=.env; return 0; fi
    if placeholder_locked "$name"; then
      AP_LV=$v
      AP_LS=.env
      AP_LNOTE="still the .env.example placeholder, but the database was initialised with it — rotate by hand"
      return 0
    fi
  fi
  v=$(getv XF "$name")
  if [[ -n $v ]] && ! is_placeholder "$name" "$v"; then AP_LV=$v; AP_LS=env-file; return 0; fi
  return 1
}

# ---------------------------------------------------------------------------
# Prompting
# ---------------------------------------------------------------------------
show_help() {
  local help
  help=$(getv EX_HELP "$1")
  [[ -n $help ]] || return 0
  printf '\n' >&2
  printf '%s' "$help" | sed 's/^/  │ /' >&2
}

# Asks until the answer validates. Blank takes <default>; blank with no default
# leaves an optional variable unset, and generates a @generated one.
prompt_value() { # <name> <default>
  local name=$1 default=$2 answer shown
  show_help "$name"
  while :; do
    if has_tag "$name" @secret; then
      shown=""
      [[ -n $default ]] && shown=" [keep $(mask_url_or_secret "$default")]"
      has_tag "$name" @generated && [[ -z $default ]] && shown=" [blank = generate]"
      read_answer answer "$name$shown: " secret
    else
      shown=""
      [[ -n $default ]] && shown=" [$default]"
      read_answer answer "$name$shown: "
    fi
    if [[ -z $answer ]]; then
      if [[ -n $default ]]; then answer=$default
      elif has_tag "$name" @generated; then record "$name" "$(random_hex)" generated; return 0
      elif has_tag "$name" @required; then printf '%s is required.\n' "$name" >&2; continue
      else return 0
      fi
    fi
    if validate_value "$name" "$answer"; then
      record "$name" "$answer" prompt
      return 0
    fi
    printf '%s %s\n' "$name" "$AP_ERR" >&2
  done
}

# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------
resolve_var() { # <name>
  local name=$1 v src note
  if ! in_scope "$name"; then
    # Kept as found. A value for the other mode is not this run's to judge.
    v=$(getv ENVF "$name")
    if [[ -n $v ]]; then record "$name" "$v" .env "unused in $AP_MODE mode"; fi
    return 0
  fi
  has_tag "$name" @derived && return 0

  if lookup_sources "$name"; then
    v=$AP_LV
    src=$AP_LS
    note=$AP_LNOTE
    # An API key that happens to be exported is not an instruction to store it
    # in a file on disk.
    if [[ $src == env ]] && has_tag "$name" @secret && has_tag "$name" @optional; then
      if ! ask_yes_no "$name is set in your shell. Save it into .env?" n; then
        info "  $name: not saved (it stays in your shell only)"
        return 0
      fi
    fi
    if ! validate_value "$name" "$v"; then
      if [[ $AP_YES == true ]]; then
        add_error "$name" "value from $src $AP_ERR"
        return 0
      fi
      warn "$name from $src $AP_ERR"
      prompt_value "$name" ""
      post_resolve "$name"
      return 0
    fi
    if [[ $AP_RECONFIGURE == true && $src == .env ]] && ! has_tag "$name" @secret &&
      { has_tag "$name" @prompt || has_tag "$name" @detect; }; then
      prompt_value "$name" "$v"
    else
      record "$name" "$v" "$src" "$note"
    fi
    post_resolve "$name"
    return 0
  fi

  if detect_value "$name"; then
    record "$name" "$AP_DV" detected "$AP_DNOTE"
    confirm_detected "$name"
    post_resolve "$name"
    return 0
  fi

  if has_tag "$name" @generated; then
    record "$name" "$(random_hex)" generated
    return 0
  fi

  if [[ $AP_YES != true ]] && { has_tag "$name" @required ||
    { has_tag "$name" @prompt && [[ $AP_FIRST_INSTALL == true || $AP_RECONFIGURE == true ]]; }; }; then
    prompt_value "$name" "$(getv EX_DEFAULT "$name")"
    post_resolve "$name"
    return 0
  fi

  if [[ -n $(getv EX_DEFAULT "$name") ]]; then
    record "$name" "$(getv EX_DEFAULT "$name")" default
    post_resolve "$name"
    return 0
  fi

  if has_tag "$name" @required; then
    add_error "$name" "not set in the environment, .env or --env-file, and nothing to detect"
  fi
}

confirm_detected() {
  local name=$1 v
  v=$(getv VAL "$name")
  case "$name" in
    AGENT_*_ENABLED)
      local def=n
      [[ $v == true ]] && def=y
      if ask_yes_no "Collect $(agent_key "$name") ($(getv NOTE "$name"))?" "$def"; then v=true; else v=false; fi
      if [[ $v != "$(getv VAL "$name")" ]]; then record "$name" "$v" prompt "$(getv NOTE "$name")"; fi
      ;;
  esac
}

post_resolve() {
  case "$1" in
    *_HOST_PORT) settle_port "$1" ;;
  esac
}

# A port stays put when it is free or when this stack already holds it (a
# re-run of an installed system). A default is moved to the next free port; a
# value someone chose is only moved with their say-so.
settle_port() {
  local name=$1 port src proposed
  port=$(getv VAL "$name")
  [[ -n $port ]] || return 0
  src=$(getv SRC "$name")
  if [[ " $AP_TAKEN_PORTS " == *" $port "* ]]; then
    :
  elif ! port_in_use "$port" || port_is_ours "$name" "$port"; then
    AP_TAKEN_PORTS="$AP_TAKEN_PORTS $port"
    return 0
  fi
  if ! proposed=$(next_free_port "$port" "$AP_TAKEN_PORTS"); then
    add_error "$name" "port $port is in use and no free port was found above it"
    return 0
  fi
  if [[ $src == default || $src == detected ]]; then
    if [[ $AP_YES == true ]] || ask_yes_no "$name: port $port is in use. Use $proposed instead?" y; then
      record "$name" "$proposed" detected "$port in use"
    else
      prompt_value "$name" ""
    fi
  elif [[ $AP_MODE == native ]] && docker_port_is_ours "$name" "$port"; then
    add_error "$name" "port $port is held by this project's Docker stack — run \`docker compose down\` before switching to native (data is kept)"
    return 0
  elif [[ $AP_YES == true ]]; then
    add_error "$name" "port $port (from $src) is in use by another process"
    return 0
  elif ask_yes_no "$name: port $port (from $src) is in use. Use $proposed instead?" y; then
    record "$name" "$proposed" prompt "$port in use"
  else
    add_error "$name" "port $port is in use by another process"
    return 0
  fi
  AP_TAKEN_PORTS="$AP_TAKEN_PORTS $(getv VAL "$name")"
}

port_is_ours() { # <name> <port>
  if [[ $AP_MODE == docker ]]; then docker_port_is_ours "$1" "$2"; else native_port_is_ours "$1" "$2"; fi
}

root_indexes_known() {
  local k
  {
    printf '1\n2\n'
    compgen -v CODE_ROOT_ | sed -n 's/^CODE_ROOT_\([1-9][0-9]*\)$/\1/p'
    for k in $AP_ENVF_KEYS $AP_XF_KEYS; do
      is_code_root "$k" && printf '%s\n' "${k#CODE_ROOT_}"
    done
  } | sort -n -u
}

root_duplicate() { # <path> → 0 if another resolved root already has it
  local i
  for i in $AP_ROOT_IDX; do
    [[ $(getv VAL "CODE_ROOT_$i") == "$1" ]] && return 0
  done
  return 1
}

# CODE_ROOT_1 is required; more can be added, and each becomes
# /host/code/rootN in Docker (compose.yaml for 1, compose.override.yaml after).
resolve_code_roots() {
  local i name v next suggestion suggestions="" c
  for i in $(root_indexes_known); do
    name=CODE_ROOT_$i
    if lookup_sources "$name"; then
      if validate_value "$name" "$AP_LV" && ! root_duplicate "$AP_LV"; then
        record "$name" "$AP_LV" "$AP_LS"
        AP_ROOT_IDX="$AP_ROOT_IDX $i"
      elif [[ $AP_YES == true ]]; then
        [[ -n $AP_ERR ]] || AP_ERR="duplicates another code root"
        add_error "$name" "value from $AP_LS $AP_ERR"
      else
        warn "$name from $AP_LS ${AP_ERR:-duplicates another code root} — ignored"
      fi
    fi
  done

  if [[ " $AP_ROOT_IDX " != *" 1 "* ]]; then
    if [[ $AP_YES == true ]]; then
      add_error CODE_ROOT_1 "not set in the environment, .env or --env-file (the installer does not guess which tree to mount)"
      return 0
    fi
    for c in "$HOME/code" "$HOME/projects" "$(dirname "$AP_ROOT")"; do
      [[ -d $c && " $suggestions " != *" $c "* ]] && suggestions="$suggestions$c"$'\n'
    done
    suggestion=$(printf '%s' "$suggestions" | head -1)
    show_help CLAUDE_HOME
    if [[ -n $suggestions ]]; then
      printf '\nDirectories that exist and look like code roots:\n' >&2
      printf '%s' "$suggestions" | sed 's/^/    /' >&2
    fi
    prompt_value CODE_ROOT_1 "$suggestion"
    AP_ROOT_IDX="1$AP_ROOT_IDX"
  fi

  if [[ $AP_YES != true && ($AP_FIRST_INSTALL == true || $AP_RECONFIGURE == true) ]]; then
    while :; do
      next=1
      for i in $AP_ROOT_IDX; do [[ $i -ge $next ]] && next=$((i + 1)); done
      read_answer v "Another code root to collect from (blank to finish): "
      [[ -n $v ]] || break
      if ! validate_value "CODE_ROOT_$next" "$v"; then
        printf '%s %s\n' "$v" "$AP_ERR" >&2
      elif root_duplicate "$v"; then
        printf '%s is already a code root\n' "$v" >&2
      else
        record "CODE_ROOT_$next" "$v" prompt
        AP_ROOT_IDX="$AP_ROOT_IDX $next"
      fi
    done
  fi
  # shellcheck disable=SC2086  # split on purpose: a space-separated list
  AP_ROOT_IDX=$(printf '%s\n' $AP_ROOT_IDX | sort -n -u | tr '\n' ' ')
  AP_ROOT_IDX=${AP_ROOT_IDX% }
}

# Sets AP_DV, or returns 2 when the variable is deliberately left unset.
derive_value() { # <name>
  local u p db pg
  AP_DV=""
  case "$1" in
    DATABASE_URL | DATABASE_URL_HOST)
      u=$(url_encode "$(getv VAL POSTGRES_USER)")
      p=$(url_encode "$(getv VAL POSTGRES_PASSWORD)")
      db=$(getv VAL POSTGRES_DB)
      pg=$(getv VAL POSTGRES_HOST_PORT)
      # In compose the services build their own URL on the compose network
      # (compose.yaml:53,71,126,150); the one derived here is for the host.
      AP_DV="postgres://$u:$p@127.0.0.1:$pg/$db"
      ;;
    PATH_MAP) AP_DV=$(build_path_map) || return 1 ;;
    AGENT_CLAUDE_CODE_HOME)
      [[ $(getv VAL AGENT_CLAUDE_CODE_ENABLED) == true ]] || return 2
      AP_DV=$(effective_home CLAUDE_HOME)
      ;;
    AGENT_GEMINI_CLI_HOME)
      [[ $(getv VAL AGENT_GEMINI_CLI_ENABLED) == true ]] || return 2
      AP_DV=$(effective_home GEMINI_HOME)
      ;;
    AGENT_CODEX_CLI_HOME | AGENT_QWEN_CODE_HOME | AGENT_CURSOR_CLI_HOME | AGENT_COPILOT_CLI_HOME)
      return 2 # no adapter (apps/collector/src/main.ts:216-224)
      ;;
    COLLECTOR_PORT) AP_DV=$(getv VAL COLLECTOR_HOST_PORT) ;;
    PROXY_PORT) AP_DV=$(getv VAL PROXY_HOST_PORT) ;;
    COLLECTOR_BIND_HOST | PROXY_BIND_HOST) AP_DV=127.0.0.1 ;;
    COLLECTOR_URL) AP_DV="http://127.0.0.1:$(getv VAL COLLECTOR_HOST_PORT)" ;;
    *) die "$AP_EXIT_PREFLIGHT" "$1 is tagged @derived in .env.example but scripts/installer/env.sh has no derivation for it" ;;
  esac
}

resolve_derived() { # <name>
  local name=$1 v existing rc=0
  in_scope "$name" || return 0
  v=${!name-}
  if [[ -n $v ]]; then
    if validate_value "$name" "$v"; then
      record "$name" "$v" env "overrides the derived value"
    else
      add_error "$name" "value from env $AP_ERR"
    fi
    return 0
  fi
  derive_value "$name" || rc=$?
  existing=$(getv ENVF "$name")
  if [[ $rc -eq 2 ]]; then
    return 0
  elif [[ $rc -ne 0 ]]; then
    has_tag "$name" @required && add_error "$name" "cannot be derived: $(derive_needs "$name")"
    return 0
  fi
  if ! validate_value "$name" "$AP_DV"; then
    add_error "$name" "derived value $AP_ERR"
    return 0
  fi
  # A PATH_MAP with the same entries in another valid order is the same map:
  # rewriting it would turn every re-run into a change.
  if [[ $name == PATH_MAP && -n $existing && $existing != "$AP_DV" ]] &&
    [[ $(pm_entry_set "$existing") == "$(pm_entry_set "$AP_DV")" ]] && validate_value PATH_MAP "$existing"; then
    record "$name" "$existing" .env
    return 0
  fi
  if [[ -n $existing && $existing != "$AP_DV" ]]; then
    if [[ $AP_YES != true ]] && ! has_tag "$name" @secret; then
      printf '\n%s in .env differs from what the installer derives:\n  .env:    %s\n  derived: %s\n' "$name" "$existing" "$AP_DV" >&2
      if ask_yes_no "Keep the .env value?" n && validate_value "$name" "$existing"; then
        record "$name" "$existing" .env "differs from the derived value"
        return 0
      fi
    fi
    record "$name" "$AP_DV" derived "replaces the .env value"
    return 0
  fi
  record "$name" "$AP_DV" derived
}

derive_needs() {
  case "$1" in
    PATH_MAP) printf 'needs CODE_ROOT_1 or an enabled agent' ;;
    *) printf 'inputs missing' ;;
  esac
}

# Checks that span variables, mirroring the collector's startup assertions
# (apps/collector/src/main.ts:31-80, 240).
validate_config() {
  local name enabled=0 p seen="" home
  for name in AGENT_CLAUDE_CODE_ENABLED AGENT_GEMINI_CLI_ENABLED; do
    [[ $(getv VAL "$name") == true ]] || continue
    enabled=$((enabled + 1))
    if [[ $name == AGENT_CLAUDE_CODE_ENABLED ]]; then home=$(effective_home CLAUDE_HOME); else home=$(effective_home GEMINI_HOME); fi
    [[ -d $home ]] || add_error "$name" "is true but $home does not exist"
  done
  [[ $enabled -gt 0 ]] ||
    add_error AGENT_CLAUDE_CODE_ENABLED "no agent with an adapter is enabled, and the collector refuses to start with none (main.ts:240)"
  for name in POSTGRES_HOST_PORT COLLECTOR_HOST_PORT PROXY_HOST_PORT WEB_HOST_PORT; do
    p=$(getv VAL "$name")
    [[ -n $p ]] || continue
    if [[ " $seen " == *" $p "* ]]; then add_error "$name" "port $p is also used by another service"; fi
    seen="$seen $p"
  done
}

agent_report() {
  local name key v note
  AP_AGENT_REPORT=""
  for name in $AP_VARS; do
    case "$name" in AGENT_*_ENABLED) ;; *) continue ;; esac
    key=$(agent_key "$name")
    v=$(getv VAL "$name")
    note=$(getv NOTE "$name")
    case "$key" in
      claude_code | gemini_cli) ;;
      *) note="no adapter yet" ;;
    esac
    [[ -n $note ]] || note="from $(getv SRC "$name")"
    if [[ $v == true ]]; then
      AP_AGENT_REPORT="$AP_AGENT_REPORT  enabled   $key — $note"$'\n'
    else
      AP_AGENT_REPORT="$AP_AGENT_REPORT  skipped   $key — $note"$'\n'
    fi
  done
}

resolve_all() {
  local name
  for name in $AP_VARS; do
    case "$name" in
      CODE_ROOT_1) resolve_code_roots ;;
      CODE_ROOT_*) ;;
      *) resolve_var "$name" ;;
    esac
  done
  for name in $AP_VARS; do
    has_tag "$name" @derived && resolve_derived "$name"
  done
  validate_config
  agent_report
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

# .env.example order, with code roots in CODE_ROOT_1's place, then anything the
# old .env had that .env.example does not know about.
output_names() {
  local name i
  for name in $AP_VARS; do
    case "$name" in
      CODE_ROOT_1) for i in $AP_ROOT_IDX; do printf 'CODE_ROOT_%s\n' "$i"; done ;;
      CODE_ROOT_*) ;;
      *) isset VAL "$name" && printf '%s\n' "$name" ;;
    esac
  done
  for name in $AP_ENVF_KEYS; do
    isset EX_TAGS "$name" && continue
    is_code_root "$name" && continue
    printf '%s\n' "$name"
  done
}

value_for_output() { # <name>
  if isset VAL "$1"; then getv VAL "$1"; else getv ENVF "$1"; fi
}

render_env() {
  local name
  printf '# AgentPulse environment, written by ./install.sh.\n'
  printf '# Every variable is documented in .env.example. Re-run ./install.sh to\n'
  printf '# change values; it keeps what is here and validates it.\n'
  for name in $(output_names); do
    printf '%s=%s\n' "$name" "$(value_for_output "$name")"
  done
}

display_value() { # <name>
  local v
  v=$(value_for_output "$1")
  if has_tag "$1" @secret || [[ $1 == *PASSWORD* || $1 == *SECRET* || $1 == *_KEY || $1 == DATABASE_URL* ]]; then
    mask_url_or_secret "$v"
  else
    printf '%s' "$v"
  fi
}

change_mark() { # <name>
  local now old
  [[ $AP_FIRST_INSTALL == true ]] && return 0
  now=$(value_for_output "$1")
  if ! isset ENVF "$1"; then printf 'new'; return; fi
  old=$(getv ENVF "$1")
  [[ $now == "$old" ]] || printf 'changed'
}

print_table() {
  local name src note mark line
  printf '\n%-30s %-10s %-8s %s\n' VAR SOURCE CHANGE VALUE
  printf '%-30s %-10s %-8s %s\n' "---" "------" "------" "-----"
  for name in $(output_names); do
    if isset SRC "$name"; then src=$(getv SRC "$name"); else src=.env; fi
    note=$(getv NOTE "$name")
    isset EX_TAGS "$name" || is_code_root "$name" || note="not in .env.example — kept"
    mark=$(change_mark "$name")
    line=$(printf '%-30s %-10s %-8s %s' "$name" "$src" "$mark" "$(display_value "$name")")
    [[ -n $note ]] && line="$line   ($note)"
    printf '%s\n' "$line"
    ap_log "table: $line"
  done
  for name in $AP_ENVF_KEYS; do
    if isset EX_TAGS "$name" && ! isset VAL "$name" && [[ -n $(getv ENVF "$name") ]]; then
      printf '%-30s %-10s %-8s %s\n' "$name" "-" removed "(no longer set — the service default applies)"
    fi
  done
}
