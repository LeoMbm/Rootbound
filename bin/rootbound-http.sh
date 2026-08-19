#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
exec node "$SCRIPT_DIR/../scripts/launch.mjs" http "$@"
