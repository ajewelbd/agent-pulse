#!/usr/bin/env bash
#
# Starts one AgentPulse service with .env loaded. launchd has no
# EnvironmentFile=, so the LaunchAgents written by install.sh run this.
#
#   service-run.sh <env file> [KEY=VALUE …] -- <command> [args…]
#
# .env is read with the same parser that wrote it (env.sh), not `source`d: its
# values are unquoted and may contain spaces, which a shell would split. The
# KEY=VALUE arguments are applied after it, so TZ=UTC and the bind address
# cannot be overridden from .env.

# shellcheck source-path=SCRIPTDIR
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
# shellcheck source=env.sh
. "$here/env.sh"

[[ $# -ge 3 ]] || { echo "usage: service-run.sh <env file> [KEY=VALUE …] -- <command> [args…]" >&2; exit 64; }
env_file=$1
shift
keys=""
load_dotenv "$env_file" SVCENV keys
for k in $keys; do
  export "$k=$(getv SVCENV "$k")"
done
while [[ $# -gt 0 && $1 != -- ]]; do
  export "${1?}"
  shift
done
shift
exec "$@"
