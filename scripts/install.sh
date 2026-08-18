#!/bin/sh
set -eu

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
DEFAULT_INSTALL_DIR="$HOME/Library/Application Support/Codexless/app"
INSTALL_DIR=$DEFAULT_INSTALL_DIR
JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || { echo "--install-dir requires a path" >&2; exit 2; }
      INSTALL_DIR=$2
      shift 2
      ;;
    --json)
      JSON=1
      shift
      ;;
    -h|--help)
      printf '%s\n' "Usage: sh scripts/install.sh [--install-dir <path>] [--json]"
      exit 0
      ;;
    *)
      echo "Unknown installer argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
PARENT_DIR=$(dirname "$INSTALL_DIR")
CACHE_DIR="$HOME/Library/Caches/Codexless/npm"
STAGE_DIR=""
BACKUP_DIR=""
INSTALLED=0

json_field() {
  field=$1
  node_bin=$2
  "$node_bin" -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(text)[process.argv[1]];
      if (value === undefined || value === null) process.exit(3);
      process.stdout.write(String(value));
    });
  ' "$field"
}

emit_failure() {
  message=$1
  if [ "$JSON" -eq 1 ]; then
    MESSAGE=$message node -e 'process.stdout.write(JSON.stringify({ok:false,action:"install-failed",error:process.env.MESSAGE}) + "\n")'
  else
    echo "Codexless install failed: $message" >&2
  fi
}

rollback() {
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  if [ "$INSTALLED" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR"; INSTALLED=0; fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && [ ! -e "$INSTALL_DIR" ]; then mv "$BACKUP_DIR" "$INSTALL_DIR"; BACKUP_DIR=""; fi
}

fail() {
  message=$1
  rollback
  emit_failure "$message"
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Mac Technical Preview installer requires macOS."
[ "$(uname -m)" = "arm64" ] || fail "Mac Technical Preview installer currently requires Apple Silicon arm64."

NODE=$(command -v node 2>/dev/null || true)
NPM=$(command -v npm 2>/dev/null || true)
[ -n "$NODE" ] || fail "Node.js was not found on PATH."
[ -n "$NPM" ] || fail "npm was not found on PATH."
NODE_VERSION=$($NODE -p 'process.versions.node' 2>/dev/null || true)
[ -n "$NODE_VERSION" ] || fail "Unable to read Node.js version."
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f2)
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null || { [ "$NODE_MAJOR" -eq 22 ] 2>/dev/null && [ "$NODE_MINOR" -lt 13 ] 2>/dev/null; }; then
  fail "Codexless V5 requires Node.js 22.13+. Current: v$NODE_VERSION"
fi

CODEX_JSON=$($NODE "$SOURCE_ROOT/scripts/resolve-codex.mjs" 2>/dev/null || true)
[ -n "$CODEX_JSON" ] || fail "Codex prerequisite check returned no result."
CODEX_OK=$(printf '%s' "$CODEX_JSON" | json_field ok "$NODE" 2>/dev/null || true)
if [ "$CODEX_OK" != "true" ]; then
  CODEX_ERROR=$(printf '%s' "$CODEX_JSON" | json_field error "$NODE" 2>/dev/null || true)
  fail "Codex prerequisite check failed: ${CODEX_ERROR:-unknown error}"
fi
CODEX_BIN_RESOLVED=$(printf '%s' "$CODEX_JSON" | json_field path "$NODE" 2>/dev/null || true)
CODEX_VERSION=$(printf '%s' "$CODEX_JSON" | json_field version "$NODE" 2>/dev/null || true)
CODEX_SOURCE=$(printf '%s' "$CODEX_JSON" | json_field source "$NODE" 2>/dev/null || true)
[ -n "$CODEX_BIN_RESOLVED" ] || fail "Codex prerequisite check did not return an executable path."

mkdir -p "$PARENT_DIR" "$CACHE_DIR"
STAGE_DIR=$(mktemp -d "$PARENT_DIR/.Codexless-stage.XXXXXX") || fail "Unable to create staging directory beside install target."

for entry in src config scripts bin docs package.json README.md README.zh-CN.md SECURITY.md EXPORT_SYNC.md THIRD_PARTY_NOTICES.md LICENSE; do
  [ -e "$SOURCE_ROOT/$entry" ] || fail "Release source is missing required entry: $entry"
  cp -R "$SOURCE_ROOT/$entry" "$STAGE_DIR/$entry" || fail "Failed to stage release entry: $entry"
done
if [ -f "$SOURCE_ROOT/npm-shrinkwrap.json" ]; then
  cp "$SOURCE_ROOT/npm-shrinkwrap.json" "$STAGE_DIR/npm-shrinkwrap.json" || fail "Failed to stage npm-shrinkwrap.json."
elif [ -f "$SOURCE_ROOT/package-lock.json" ]; then
  cp "$SOURCE_ROOT/package-lock.json" "$STAGE_DIR/package-lock.json" || fail "Failed to stage package-lock.json."
else
  fail "Release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json"
fi
chmod +x \
  "$STAGE_DIR/scripts/install.sh" \
  "$STAGE_DIR/scripts/uninstall.sh" \
  "$STAGE_DIR/bin/codexless.sh" \
  "$STAGE_DIR/bin/codexless.mjs" \
  "$STAGE_DIR/bin/codexless-install.sh" \
  "$STAGE_DIR/bin/codexless-doctor.sh" \
  "$STAGE_DIR/bin/codexless-http.sh" \
  "$STAGE_DIR/bin/codexless-stdio.sh" \
  "$STAGE_DIR/bin/codexless-uninstall.sh" \
  || fail "Failed to mark Mac lifecycle launchers executable in staging."

if ! (cd "$STAGE_DIR" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$CACHE_DIR" 1>&2); then
  fail "npm production dependency install failed in staging."
fi

if ! STAGE_DOCTOR=$(cd "$STAGE_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json); then fail "Staging doctor failed."; fi
STAGE_STATUS=$(printf '%s' "$STAGE_DOCTOR" | json_field status "$NODE" 2>/dev/null || true)
[ "$STAGE_STATUS" != "error" ] || fail "Staging doctor returned error."

if [ -e "$INSTALL_DIR" ]; then
  [ -f "$INSTALL_DIR/package.json" ] || fail "Refusing to replace a directory without Codexless package.json: $INSTALL_DIR"
  EXISTING_NAME=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.name || ""));' "$INSTALL_DIR/package.json" 2>/dev/null || true)
  [ "$EXISTING_NAME" = "codexless" ] || fail "Refusing to replace directory whose package name is not codexless: $INSTALL_DIR"
  BACKUP_DIR="$PARENT_DIR/.Codexless-backup.$$.${NODE_MAJOR}"
  [ ! -e "$BACKUP_DIR" ] || fail "Backup path already exists: $BACKUP_DIR"
  mv "$INSTALL_DIR" "$BACKUP_DIR" || fail "Unable to move current install to backup."
fi

if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then fail "Unable to activate staged install."; fi
STAGE_DIR=""
INSTALLED=1

if ! INSTALLED_DOCTOR=$(cd "$INSTALL_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json); then
  fail "Installed doctor failed; previous install was restored when available."
fi
INSTALLED_STATUS=$(printf '%s' "$INSTALLED_DOCTOR" | json_field status "$NODE" 2>/dev/null || true)
[ "$INSTALLED_STATUS" != "error" ] || fail "Installed doctor returned error; previous install was restored when available."

if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; BACKUP_DIR=""; fi
INSTALLED=0

PACKAGE_VERSION=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version || ""));' "$INSTALL_DIR/package.json")
CLI_CMD="$INSTALL_DIR/bin/codexless.sh"
DOCTOR_CMD="$INSTALL_DIR/bin/codexless-doctor.sh"
HTTP_CMD="$INSTALL_DIR/bin/codexless-http.sh"
STDIO_CMD="$INSTALL_DIR/bin/codexless-stdio.sh"
UNINSTALL_CMD="$INSTALL_DIR/bin/codexless-uninstall.sh"

if [ "$JSON" -eq 1 ]; then
  INSTALL_DIR_ENV=$INSTALL_DIR PACKAGE_VERSION_ENV=$PACKAGE_VERSION NODE_VERSION_ENV=$NODE_VERSION CODEX_VERSION_ENV=$CODEX_VERSION CODEX_SOURCE_ENV=$CODEX_SOURCE DOCTOR_STATUS_ENV=$INSTALLED_STATUS CLI_CMD_ENV=$CLI_CMD DOCTOR_CMD_ENV=$DOCTOR_CMD HTTP_CMD_ENV=$HTTP_CMD STDIO_CMD_ENV=$STDIO_CMD UNINSTALL_CMD_ENV=$UNINSTALL_CMD \
    "$NODE" -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({
        ok: true,
        action: "installed-or-upgraded",
        version: e.PACKAGE_VERSION_ENV,
        installDir: e.INSTALL_DIR_ENV,
        node: `v${e.NODE_VERSION_ENV}`,
        codex: e.CODEX_VERSION_ENV,
        codexResolutionSource: e.CODEX_SOURCE_ENV,
        doctorStatus: e.DOCTOR_STATUS_ENV,
        commands: { codexless: e.CLI_CMD_ENV, doctor: e.DOCTOR_CMD_ENV, http: e.HTTP_CMD_ENV, stdio: e.STDIO_CMD_ENV, uninstall: e.UNINSTALL_CMD_ENV },
        notes: [
          "No PATH entry, LaunchAgent, Browser configuration, Tunnel configuration, or Codex trust was changed.",
          "Re-running a newer Mac Technical Preview installer against the same install directory performs a staged upgrade."
        ]
      }) + "\n");
    '
else
  printf 'Codexless Mac Technical Preview installed: %s\n' "$PACKAGE_VERSION"
  printf 'Location: %s\n' "$INSTALL_DIR"
  printf 'CLI:      %s\n' "$CLI_CMD"
  printf 'Doctor:   %s\n' "$DOCTOR_CMD"
  printf 'HTTP:     %s\n' "$HTTP_CMD"
  printf '%s\n' "No PATH, LaunchAgent, Browser, Tunnel, or Codex trust settings were changed."
fi
