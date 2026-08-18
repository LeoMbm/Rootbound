#!/bin/sh
set -eu

DEFAULT_INSTALL_DIR="$HOME/Library/Application Support/Codexless/app"
DEFAULT_STATE_DIR="$HOME/Library/Application Support/Codexless"
INSTALL_DIR=$DEFAULT_INSTALL_DIR
STATE_DIR=$DEFAULT_STATE_DIR
PURGE_STATE=0
JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || { echo "--install-dir requires a path" >&2; exit 2; }
      INSTALL_DIR=$2
      shift 2
      ;;
    --state-dir)
      [ "$#" -ge 2 ] || { echo "--state-dir requires a path" >&2; exit 2; }
      STATE_DIR=$2
      shift 2
      ;;
    --purge-state)
      PURGE_STATE=1
      shift
      ;;
    --json)
      JSON=1
      shift
      ;;
    -h|--help)
      printf '%s\n' "Usage: sh scripts/uninstall.sh [--install-dir <path>] [--state-dir <path>] [--purge-state] [--json]"
      exit 0
      ;;
    *)
      echo "Unknown uninstaller argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
case "$STATE_DIR" in /*) ;; *) STATE_DIR="$PWD/$STATE_DIR" ;; esac
NODE=$(command -v node 2>/dev/null || true)

emit_json() {
  action=$1
  version=$2
  state_purged=$3
  [ -n "$NODE" ] || return 1
  ACTION_ENV=$action VERSION_ENV=$version INSTALL_DIR_ENV=$INSTALL_DIR STATE_DIR_ENV=$STATE_DIR STATE_PURGED_ENV=$state_purged \
    "$NODE" -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({
        ok: true,
        action: e.ACTION_ENV,
        ...(e.VERSION_ENV ? {version: e.VERSION_ENV} : {}),
        installDir: e.INSTALL_DIR_ENV,
        stateRoot: e.STATE_DIR_ENV,
        statePurged: e.STATE_PURGED_ENV === "true",
        notes: [
          "Codex, Node.js, projects, Browser configuration, Tunnel configuration, Codex trust, and shell PATH were not changed.",
          e.STATE_PURGED_ENV === "true" ? "Codexless-owned state/runtime/log/backups were purged." : "Codexless-owned state was preserved."
        ]
      }) + "\n");
    '
}

fail() {
  message=$1
  if [ "$JSON" -eq 1 ] && [ -n "$NODE" ]; then
    MESSAGE_ENV=$message "$NODE" -e 'process.stdout.write(JSON.stringify({ok:false,action:"uninstall-failed",error:process.env.MESSAGE_ENV}) + "\n")'
  else
    echo "Codexless uninstall failed: $message" >&2
  fi
  exit 1
}

if [ ! -e "$INSTALL_DIR" ]; then
  if [ "$PURGE_STATE" -eq 1 ] && [ -e "$STATE_DIR" ]; then rm -rf "$STATE_DIR"; fi
  if [ "$JSON" -eq 1 ]; then emit_json "already-absent" "" "$([ "$PURGE_STATE" -eq 1 ] && printf true || printf false)" || fail "Node.js is required for --json output."; else printf 'Codexless is already absent: %s\n' "$INSTALL_DIR"; fi
  exit 0
fi

[ -f "$INSTALL_DIR/package.json" ] || fail "Refusing to remove a directory without Codexless package.json: $INSTALL_DIR"
[ -n "$NODE" ] || fail "Node.js was not found on PATH; cannot validate Codexless package ownership."
PACKAGE_NAME=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.name || ""));' "$INSTALL_DIR/package.json" 2>/dev/null || true)
[ "$PACKAGE_NAME" = "codexless" ] || fail "Refusing to remove directory whose package name is not codexless: $INSTALL_DIR"
PACKAGE_VERSION=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version || ""));' "$INSTALL_DIR/package.json" 2>/dev/null || true)

cd /private/tmp
rm -rf "$INSTALL_DIR"

STATE_PURGED=false
if [ "$PURGE_STATE" -eq 1 ] && [ -e "$STATE_DIR" ]; then
  rm -rf "$STATE_DIR"
  STATE_PURGED=true
fi

if [ "$JSON" -eq 1 ]; then
  emit_json "uninstalled" "$PACKAGE_VERSION" "$STATE_PURGED"
else
  printf 'Codexless uninstalled: %s\n' "$INSTALL_DIR"
  if [ "$STATE_PURGED" = true ]; then printf 'Codexless state purged: %s\n' "$STATE_DIR"; else printf 'Codexless state preserved: %s\n' "$STATE_DIR"; fi
fi
