#!/usr/bin/env bash
# The configured, revision-checked SDK and tool arguments are data, not shell code.
set -e
source "$1/emsdk_env.sh" >/dev/null 2>&1
shift
exec "$@"
