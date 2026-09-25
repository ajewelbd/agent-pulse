# shellcheck shell=bash
# shellcheck disable=SC2034  # globals here are read by the sourcing script or indirectly via ${!ref}
#
# User-level service units for native mode: systemd --user on Linux and WSL2,
# launchd LaunchAgents on macOS. Units live in the user's own directories and
# run as the user, so nothing here needs root.
#
# native.sh describes each service by setting, before calling svc_render:
#   AP_SVC_ARGV     the command, one argument per line
#   AP_SVC_FORCE    KEY=VALUE per line, applied AFTER .env so they always win
#   AP_SVC_ENVFILE  true when the service reads .env
#   AP_SVC_AFTER    a service it should start after (postgres), or empty
# Unit files never contain a secret: .env is referenced, not inlined.

AP_INSTANCE=${AGENTPULSE_INSTANCE:-agentpulse}
AP_SVC_ARGV=""
AP_SVC_FORCE=""
AP_SVC_ENVFILE=false
AP_SVC_AFTER=""

svc_unit_name() { printf '%s-%s.service' "$AP_INSTANCE" "$1"; }
svc_label() { printf 'com.%s.%s' "$AP_INSTANCE" "$1"; }
svc_log_dir() { printf '%s/Library/Logs/%s' "$HOME" "$AP_INSTANCE"; }
systemd_dir() { printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

svc_file() {
  if [[ $AP_OS == darwin ]]; then
    printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(svc_label "$1")"
  else
    printf '%s/%s' "$(systemd_dir)" "$(svc_unit_name "$1")"
  fi
}

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------

# One ExecStart argument: double-quoted, with systemd's own specifier (%) and
# variable ($) expansion escaped, so a path is taken literally.
systemd_arg() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//%/%%}
  s=${s//\$/\$\$}
  printf '"%s"' "$s"
}

# Forced variables go through /usr/bin/env on the command line rather than
# Environment=, because EnvironmentFile= overrides Environment= — a TZ in .env
# would otherwise beat the TZ=UTC every service is meant to run under.
render_systemd() { # <service>
  local arg exec="/usr/bin/env" pg_unit
  while IFS= read -r arg; do [[ -n $arg ]] && exec="$exec $(systemd_arg "$arg")"; done <<< "$AP_SVC_FORCE"
  while IFS= read -r arg; do [[ -n $arg ]] && exec="$exec $(systemd_arg "$arg")"; done <<< "$AP_SVC_ARGV"
  printf '# Written by install.sh — re-run it rather than editing this file.\n'
  printf '[Unit]\nDescription=AgentPulse %s\n' "$1"
  if [[ -n $AP_SVC_AFTER ]]; then
    pg_unit=$(svc_unit_name "$AP_SVC_AFTER")
    printf 'After=%s\nWants=%s\n' "$pg_unit" "$pg_unit"
  fi
  printf '\n[Service]\nType=simple\n'
  printf 'WorkingDirectory=%s\n' "${AP_ROOT//%/%%}"
  [[ $AP_SVC_ENVFILE == true ]] && printf 'EnvironmentFile=%s\n' "${AP_ENV_PATH//%/%%}"
  printf 'ExecStart=%s\n' "$exec"
  printf 'Restart=on-failure\nRestartSec=5\n'
  # The command starts with /usr/bin/env, which journald would otherwise use as
  # the tag on every line.
  printf 'SyslogIdentifier=%s-%s\n' "$AP_INSTANCE" "$1"
  if [[ $1 == postgres ]]; then
    # SIGINT is postgres's "fast" shutdown; the default SIGTERM waits for every
    # client to disconnect.
    printf 'KillSignal=SIGINT\nTimeoutStopSec=60\n'
  fi
  printf '\n[Install]\nWantedBy=default.target\n'
}

# ---------------------------------------------------------------------------
# launchd
# ---------------------------------------------------------------------------
xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  s=${s//\"/&quot;}
  printf '%s' "$s"
}

# launchd has no EnvironmentFile, so services that read .env start through
# service-run.sh, which loads it with the installer's own dotenv reader (the
# same one that wrote it) and then applies the forced variables.
render_launchd() { # <service>
  local arg log
  log="$(svc_log_dir)/$1.log"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<!-- Written by install.sh — re-run it rather than editing this file. -->\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$(svc_label "$1")")"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  if [[ $AP_SVC_ENVFILE == true ]]; then
    printf '    <string>/bin/bash</string>\n'
    printf '    <string>%s</string>\n' "$(xml_escape "$AP_SCRIPT_DIR/scripts/installer/service-run.sh")"
    printf '    <string>%s</string>\n' "$(xml_escape "$AP_ENV_PATH")"
    while IFS= read -r arg; do [[ -n $arg ]] && printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done <<< "$AP_SVC_FORCE"
    printf '    <string>--</string>\n'
  elif [[ -n $AP_SVC_FORCE ]]; then
    printf '    <string>/usr/bin/env</string>\n'
    while IFS= read -r arg; do [[ -n $arg ]] && printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done <<< "$AP_SVC_FORCE"
  fi
  while IFS= read -r arg; do [[ -n $arg ]] && printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done <<< "$AP_SVC_ARGV"
  printf '  </array>\n'
  printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$AP_ROOT")"
  printf '  <key>RunAtLoad</key><true/>\n'
  # Restart on a crash, not after a clean exit.
  printf '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
  printf '  <key>ThrottleInterval</key><integer>10</integer>\n'
  printf '  <key>ExitTimeOut</key><integer>60</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$log")"
  printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$log")"
  printf '</dict>\n</plist>\n'
}

svc_render() { # <service>
  if [[ $AP_OS == darwin ]]; then render_launchd "$1"; else render_systemd "$1"; fi
}

# ---------------------------------------------------------------------------
# Operations. svc_write returns 0 when the unit file changed.
# ---------------------------------------------------------------------------
launchd_target() { printf 'gui/%s/%s' "$(id -u)" "$(svc_label "$1")"; }

svc_loaded() {
  if [[ $AP_OS == darwin ]]; then
    launchctl print "$(launchd_target "$1")" >/dev/null 2>&1
  else
    systemctl --user is-enabled --quiet "$(svc_unit_name "$1")" 2>/dev/null
  fi
}

svc_running() {
  if [[ $AP_OS == darwin ]]; then
    launchctl print "$(launchd_target "$1")" 2>/dev/null | grep -q 'state = running'
  else
    systemctl --user is-active --quiet "$(svc_unit_name "$1")" 2>/dev/null
  fi
}

svc_write() { # <service>; content on stdin
  local file content
  file=$(svc_file "$1")
  content=$(cat)
  if [[ -f $file && "$(cat "$file")" == "$content" ]]; then return 1; fi
  mkdir -p "$(dirname "$file")"
  [[ $AP_OS == darwin ]] && mkdir -p "$(svc_log_dir)"
  printf '%s\n' "$content" | write_atomic "$file" 644
  ap_log "unit written: $file"
  return 0
}

# Load if not loaded; reload if the file changed; restart if asked to.
svc_apply() { # <service> <file changed true|false> <restart true|false>
  local svc=$1 changed=$2 restart=$3 unit target i
  if [[ $AP_OS == darwin ]]; then
    target=$(launchd_target "$svc")
    if svc_loaded "$svc" && [[ $changed == true ]]; then
      launchctl bootout "$target" 2>/dev/null || true
      # bootout returns before the job is gone; bootstrapping too early fails.
      for i in 1 2 3 4 5 6 7 8 9 10; do svc_loaded "$svc" || break; sleep 1; done
    fi
    if ! svc_loaded "$svc"; then
      launchctl bootstrap "gui/$(id -u)" "$(svc_file "$svc")"
    elif [[ $restart == true ]]; then
      launchctl kickstart -k "$target"
    fi
  else
    unit=$(svc_unit_name "$svc")
    [[ $changed == true ]] && systemctl --user daemon-reload
    systemctl --user enable --now "$unit" >/dev/null 2>&1 || systemctl --user enable --now "$unit"
    if [[ $restart == true || $changed == true ]]; then systemctl --user restart "$unit"; fi
  fi
  ap_log "service applied: $svc (changed $changed, restart $restart)"
}

svc_remove() { # <service>
  local file i
  file=$(svc_file "$1")
  if [[ $AP_OS == darwin ]]; then
    if svc_loaded "$1"; then
      launchctl bootout "$(launchd_target "$1")" 2>/dev/null || true
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do svc_loaded "$1" || break; sleep 1; done
    fi
  else
    systemctl --user disable --now "$(svc_unit_name "$1")" >/dev/null 2>&1 || true
  fi
  if [[ -f $file ]]; then
    rm -f "$file"
    ap_log "unit removed: $file"
  fi
  [[ $AP_OS == darwin ]] || systemctl --user daemon-reload 2>/dev/null || true
}

svc_logs() { # <service>
  info ""
  info "Last 50 log lines of $1:"
  if [[ $AP_OS == darwin ]]; then
    tail -n 50 "$(svc_log_dir)/$1.log" 2>/dev/null | sed 's/^/  │ /'
  else
    journalctl --user -u "$(svc_unit_name "$1")" -n 50 --no-pager 2>/dev/null | sed 's/^/  │ /'
  fi
}
