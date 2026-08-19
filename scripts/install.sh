#!/bin/sh
set -eu

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
DEFAULT_INSTALL_DIR="$HOME/Library/Application Support/Rootbound/app"
INSTALL_DIR=$DEFAULT_INSTALL_DIR
JSON=0
USER_BIN_DIR="${ROOTBOUND_USER_BIN_DIR:-$HOME/.local/bin}"
CLI_LINK="$USER_BIN_DIR/rootbound"
SHELL_PROFILE="${ROOTBOUND_SHELL_PROFILE:-}"
CLI_LINK_CREATED=0
PROFILE_CHANGED=0
PROFILE_EXISTED=0
PROFILE_BACKUP=""
PROFILE_TEMP=""

if [ -z "$SHELL_PROFILE" ]; then
  case "${SHELL:-}" in
    */bash) SHELL_PROFILE="$HOME/.bash_profile" ;;
    *) SHELL_PROFILE="$HOME/.zprofile" ;;
  esac
fi

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
CACHE_DIR="$HOME/Library/Caches/Rootbound/npm"
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
    echo "Rootbound install failed: $message" >&2
  fi
}

rollback() {
  if [ "$PROFILE_CHANGED" -eq 1 ]; then
    if [ "$PROFILE_EXISTED" -eq 1 ] && [ -n "$PROFILE_BACKUP" ] && [ -f "$PROFILE_BACKUP" ]; then
      cp "$PROFILE_BACKUP" "$SHELL_PROFILE" 2>/dev/null || true
    else
      rm -f "$SHELL_PROFILE" 2>/dev/null || true
    fi
  fi
  if [ -n "$PROFILE_TEMP" ]; then rm -f "$PROFILE_TEMP" 2>/dev/null || true; fi
  if [ "$CLI_LINK_CREATED" -eq 1 ]; then rm -f "$CLI_LINK" 2>/dev/null || true; fi
  if [ -n "$PROFILE_BACKUP" ]; then rm -f "$PROFILE_BACKUP" 2>/dev/null || true; fi
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

configure_cli() {
  mkdir -p "$USER_BIN_DIR" || fail "Unable to create user CLI directory: $USER_BIN_DIR"
  if [ -e "$CLI_LINK" ] || [ -L "$CLI_LINK" ]; then
    if [ ! -L "$CLI_LINK" ] || [ "$(readlink "$CLI_LINK" 2>/dev/null || true)" != "$INSTALL_DIR/bin/rootbound.sh" ]; then
      fail "Refusing to replace an existing non-Rootbound CLI path: $CLI_LINK"
    fi
  else
    ln -s "$INSTALL_DIR/bin/rootbound.sh" "$CLI_LINK" || fail "Unable to create Rootbound CLI link: $CLI_LINK"
    CLI_LINK_CREATED=1
  fi

  case ":${PATH:-}:" in
    *":$USER_BIN_DIR:"*) return 0 ;;
  esac
  if [ -f "$SHELL_PROFILE" ] && grep -F '# >>> Rootbound CLI >>>' "$SHELL_PROFILE" >/dev/null 2>&1; then return 0; fi

  if [ -e "$SHELL_PROFILE" ]; then
    PROFILE_EXISTED=1
    PROFILE_BACKUP="$SHELL_PROFILE.rootbound-backup.$$"
    cp "$SHELL_PROFILE" "$PROFILE_BACKUP" || fail "Unable to back up shell profile before PATH update: $SHELL_PROFILE"
  fi
  PROFILE_TEMP="$SHELL_PROFILE.rootbound-tmp.$$"
  if [ -f "$SHELL_PROFILE" ]; then cat "$SHELL_PROFILE" > "$PROFILE_TEMP"; else : > "$PROFILE_TEMP"; fi
  printf '\n# >>> Rootbound CLI >>>\nexport PATH="%s:$PATH"\n# <<< Rootbound CLI <<<\n' "$USER_BIN_DIR" >> "$PROFILE_TEMP"
  mv "$PROFILE_TEMP" "$SHELL_PROFILE" || fail "Unable to add Rootbound CLI directory to shell PATH: $SHELL_PROFILE"
  PROFILE_TEMP=""
  PROFILE_CHANGED=1
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
  fail "Rootbound V5 requires Node.js 22.13+. Current: v$NODE_VERSION"
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
STAGE_DIR=$(mktemp -d "$PARENT_DIR/.Rootbound-stage.XXXXXX") || fail "Unable to create staging directory beside install target."

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
  "$STAGE_DIR/bin/rootbound.sh" \
  "$STAGE_DIR/bin/rootbound.mjs" \
  "$STAGE_DIR/bin/rootbound-install.sh" \
  "$STAGE_DIR/bin/rootbound-doctor.sh" \
  "$STAGE_DIR/bin/rootbound-http.sh" \
  "$STAGE_DIR/bin/rootbound-stdio.sh" \
  "$STAGE_DIR/bin/rootbound-uninstall.sh" \
  || fail "Failed to mark Mac lifecycle launchers executable in staging."

if ! (cd "$STAGE_DIR" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$CACHE_DIR" 1>&2); then
  fail "npm production dependency install failed in staging."
fi

if ! STAGE_DOCTOR=$(cd "$STAGE_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json); then fail "Staging doctor failed."; fi
STAGE_STATUS=$(printf '%s' "$STAGE_DOCTOR" | json_field status "$NODE" 2>/dev/null || true)
[ "$STAGE_STATUS" != "error" ] || fail "Staging doctor returned error."

if [ -e "$INSTALL_DIR" ]; then
  [ ! -e "$INSTALL_DIR/.git" ] || fail "Refusing to replace a Git checkout: $INSTALL_DIR"
  [ -f "$INSTALL_DIR/package.json" ] || fail "Refusing to replace a directory without Rootbound package.json: $INSTALL_DIR"
  EXISTING_NAME=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.name || ""));' "$INSTALL_DIR/package.json" 2>/dev/null || true)
  [ "$EXISTING_NAME" = "rootbound" ] || fail "Refusing to replace directory whose package name is not rootbound: $INSTALL_DIR"
  BACKUP_DIR="$PARENT_DIR/.Rootbound-backup.$$.${NODE_MAJOR}"
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

configure_cli

if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; BACKUP_DIR=""; fi
if [ -n "$PROFILE_BACKUP" ]; then rm -f "$PROFILE_BACKUP" || true; PROFILE_BACKUP=""; fi
INSTALLED=0

PACKAGE_VERSION=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version || ""));' "$INSTALL_DIR/package.json")
CLI_CMD="$INSTALL_DIR/bin/rootbound.sh"
DOCTOR_CMD="$INSTALL_DIR/bin/rootbound-doctor.sh"
HTTP_CMD="$INSTALL_DIR/bin/rootbound-http.sh"
STDIO_CMD="$INSTALL_DIR/bin/rootbound-stdio.sh"
UNINSTALL_CMD="$INSTALL_DIR/bin/rootbound-uninstall.sh"

if [ "$JSON" -eq 1 ]; then
  INSTALL_DIR_ENV=$INSTALL_DIR PACKAGE_VERSION_ENV=$PACKAGE_VERSION NODE_VERSION_ENV=$NODE_VERSION CODEX_VERSION_ENV=$CODEX_VERSION CODEX_SOURCE_ENV=$CODEX_SOURCE DOCTOR_STATUS_ENV=$INSTALLED_STATUS CLI_CMD_ENV=$CLI_CMD CLI_LINK_ENV=$CLI_LINK SHELL_PROFILE_ENV=$SHELL_PROFILE PROFILE_CHANGED_ENV=$PROFILE_CHANGED DOCTOR_CMD_ENV=$DOCTOR_CMD HTTP_CMD_ENV=$HTTP_CMD STDIO_CMD_ENV=$STDIO_CMD UNINSTALL_CMD_ENV=$UNINSTALL_CMD \
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
        commands: { rootbound: e.CLI_LINK_ENV, direct: e.CLI_CMD_ENV, doctor: e.DOCTOR_CMD_ENV, http: e.HTTP_CMD_ENV, stdio: e.STDIO_CMD_ENV, uninstall: e.UNINSTALL_CMD_ENV },
        shell: { profile: e.SHELL_PROFILE_ENV, pathUpdated: e.PROFILE_CHANGED_ENV === "1" },
        notes: [
          "Rootbound installs a user-local CLI link under ~/.local/bin and adds that directory to the shell profile only when it is not already on PATH.",
          "No LaunchAgent, Browser configuration, Tunnel configuration, or Codex trust was changed.",
          "Re-running a newer Mac Technical Preview installer against the same install directory performs a staged upgrade."
        ]
      }) + "\n");
    '
else
  printf 'Rootbound Mac Technical Preview installed: %s\n' "$PACKAGE_VERSION"
  printf 'Location: %s\n' "$INSTALL_DIR"
  printf 'CLI:      %s\n' "$CLI_LINK"
  printf 'Doctor:   %s\n' "$DOCTOR_CMD"
  printf 'HTTP:     %s\n' "$HTTP_CMD"
  if [ "$PROFILE_CHANGED" -eq 1 ]; then printf 'PATH:     added %s to %s (open a new shell to pick it up)\n' "$USER_BIN_DIR" "$SHELL_PROFILE"; fi
  printf '%s\n' "No LaunchAgent, Browser, Tunnel, or Codex trust settings were changed."
fi
