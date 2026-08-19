#!/bin/sh
set -eu

SOURCE=$0
while [ -L "$SOURCE" ]; do
  DIR=$(CDPATH= cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
  LINK=$(readlink "$SOURCE")
  case "$LINK" in
    /*) SOURCE=$LINK ;;
    *) SOURCE="$DIR/$LINK" ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
exec node "$SCRIPT_DIR/rootbound-entry.mjs" "$@"
