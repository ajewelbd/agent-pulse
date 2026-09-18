#!/usr/bin/env bash
#
# Install agent hook configs on the HOST, pointing at the collector.
#
# The agents run on the host, not in a container, so this necessarily edits
# host config. Therefore it is:
#   - idempotent          — re-running changes nothing
#   - backup-taking       — any existing config is copied aside first
#   - self-uninstalling   — prints the exact uninstall command
#   - non-invasive        — it NEVER edits your shell rc. Base-URL exports are
#                           printed for you to paste if you want Layer 3.
#
# Usage:
#   scripts/install-hooks.sh [--uninstall] [--port 4317]

set -euo pipefail

PORT=4317
UNINSTALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
SETTINGS="$CLAUDE_HOME/settings.json"
HOOK_DIR="$CLAUDE_HOME/aiuo"
HOOK_SCRIPT="$HOOK_DIR/post-event.sh"
ENDPOINT="http://127.0.0.1:${PORT}/v1/hooks"

if [[ ! -f "${ENV_FILE:=$(dirname "$0")/../.env}" ]]; then
  echo "error: .env not found at $ENV_FILE — copy .env.example and set COLLECTOR_SHARED_SECRET first." >&2
  exit 1
fi
SECRET="$(grep -E '^COLLECTOR_SHARED_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [[ -z "$SECRET" ]]; then
  echo "error: COLLECTOR_SHARED_SECRET is empty in $ENV_FILE" >&2
  exit 1
fi

# --------------------------------------------------------------------------
python_edit() {
  # Merge (or remove) our hook entries without disturbing anything else in
  # settings.json — the file holds the user's own permissions and model
  # settings, and clobbering those would be unacceptable.
  python3 - "$SETTINGS" "$HOOK_SCRIPT" "$1" <<'PY'
import json, os, sys

path, hook_script, mode = sys.argv[1], sys.argv[2], sys.argv[3]
settings = {}
if os.path.exists(path):
    with open(path) as fh:
        text = fh.read().strip()
    if text:
        settings = json.loads(text)

hooks = settings.get("hooks", {})

# Events worth capturing. PostToolUse is the important one: it is the only
# source of real shell exit codes, which Layer 1 transcripts never record.
EVENTS = {
    "PostToolUse":      "",
    "PostToolUseFailure": "",
    "UserPromptSubmit": "",
    "SessionStart":     "",
    "SessionEnd":       "",
    "Stop":             "",
    "PreCompact":       "",
    "PostCompact":      "",
    "PostModelSwitch":  "",
}

def ours(entry):
    # Substring, not endswith: the command carries the event name as an
    # argument ("…/aiuo/post-event.sh PostToolUse"), so an endswith check never
    # matches and every re-run appends a duplicate hook entry.
    return any(
        isinstance(h, dict) and "aiuo/post-event.sh" in h.get("command", "")
        for h in entry.get("hooks", [])
    )

for event in EVENTS:
    existing = [e for e in hooks.get(event, []) if not ours(e)]
    if mode == "install":
        existing.append({
            "hooks": [{"type": "command", "command": f"{hook_script} {event}"}]
        })
    if existing:
        hooks[event] = existing
    else:
        hooks.pop(event, None)

if hooks:
    settings["hooks"] = hooks
else:
    settings.pop("hooks", None)

with open(path, "w") as fh:
    json.dump(settings, fh, indent=2)
    fh.write("\n")
print(f"{mode}ed {len(EVENTS)} hook events in {path}")
PY
}

mkdir -p "$CLAUDE_HOME"

if [[ -f "$SETTINGS" ]]; then
  BACKUP="$SETTINGS.aiuo-backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$SETTINGS" "$BACKUP"
  echo "backed up existing settings → $BACKUP"
fi

if [[ "$UNINSTALL" == true ]]; then
  [[ -f "$SETTINGS" ]] && python_edit uninstall
  rm -rf "$HOOK_DIR"
  echo "uninstalled. Removed $HOOK_DIR and our hook entries."
  exit 0
fi

mkdir -p "$HOOK_DIR"
cat > "$HOOK_SCRIPT" <<EOF
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh — edits here will be overwritten.
#
# Forwards the hook payload to the collector verbatim. It deliberately does NOT
# parse or reshape the payload: the collector stores it in raw_events as-is, so
# this keeps working across agent versions that change the payload shape.
#
# Never blocks the agent: a short timeout, errors swallowed, always exit 0.
# A collector that is down must not break your coding session.
set -u
EVENT="\${1:-unknown}"
PAYLOAD="\$(cat)"
curl --silent --show-error --max-time 2 \\
     -X POST "${ENDPOINT}?event=\${EVENT}&agent=claude_code" \\
     -H 'content-type: application/json' \\
     -H 'X-Aiuo-Secret: ${SECRET}' \\
     --data-binary "\$PAYLOAD" >/dev/null 2>&1 || true
exit 0
EOF
chmod +x "$HOOK_SCRIPT"
echo "wrote $HOOK_SCRIPT"

python_edit install

cat <<EOF

Done. Hooks post to ${ENDPOINT}

  Uninstall with:
    $(cd "$(dirname "$0")" && pwd)/install-hooks.sh --uninstall

  NOTE: Claude Code reads settings.json at SESSION START, so hooks take effect
  in your NEXT session, not the current one. (Verified on this machine.)

  Optional — Layer 3 proxy. These are printed, not written to your shell rc;
  paste them into the shell you launch the agent from:

    export ANTHROPIC_BASE_URL=http://127.0.0.1:4318
    # Codex CLI / Qwen Code / others that speak OpenAI-compatible APIs:
    export OPENAI_BASE_URL=http://127.0.0.1:4318/v1

EOF
