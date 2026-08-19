import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { ensureRootboundStateDirs } from "./state-paths.mjs";

export const ROOTBOUND_PERMISSION_PROFILE = "rootbound";
export const ROOTBOUND_PERMISSION_CONTRACT_VERSION = 1;

export const ROOTBOUND_PERMISSION_CONFIG_OVERRIDES = Object.freeze([
  'default_permissions=":workspace"',
  `permissions.${ROOTBOUND_PERMISSION_PROFILE}.description="Rootbound local project access"`,
  `permissions.${ROOTBOUND_PERMISSION_PROFILE}.extends=":workspace"`,
  `permissions.${ROOTBOUND_PERMISSION_PROFILE}.filesystem={":workspace_roots"={".git"="write"}}`,
  `permissions.${ROOTBOUND_PERMISSION_PROFILE}.network.enabled=true`,
  `permissions.${ROOTBOUND_PERMISSION_PROFILE}.network.allow_local_binding=false`,
]);

export const ROOTBOUND_PERMISSION_CONTRACT_HASH = createHash("sha256")
  .update(JSON.stringify({
    version: ROOTBOUND_PERMISSION_CONTRACT_VERSION,
    profile: ROOTBOUND_PERMISSION_PROFILE,
    overrides: ROOTBOUND_PERMISSION_CONFIG_OVERRIDES,
  }))
  .digest("hex");

const RESERVED_OVERRIDE = /^(?:default_permissions|permissions\.rootbound(?:\.|=))/;

export function withRootboundPermissionOverrides(configOverrides = [], { profileOverride = ROOTBOUND_PERMISSION_PROFILE } = {}) {
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("configOverrides must be an array of non-empty Codex -c key=value strings");
  }
  if (profileOverride !== ROOTBOUND_PERMISSION_PROFILE) return [...configOverrides];
  const conflicting = configOverrides.find((value) => RESERVED_OVERRIDE.test(value.trim()));
  if (conflicting) {
    const error = new Error(`ROOTBOUND_CONFIG_OVERRIDES_FILE may not override the managed Rootbound permission contract: ${conflicting.split("=", 1)[0]}`);
    error.code = "ROOTBOUND_PERMISSION_OVERRIDE_CONFLICT";
    throw error;
  }
  return [...configOverrides, ...ROOTBOUND_PERMISSION_CONFIG_OVERRIDES];
}

export async function hasRootboundPermissionConsent({ paths } = {}) {
  if (!paths?.permissionConsentPath) throw new Error("hasRootboundPermissionConsent requires Rootbound state paths");
  try {
    const payload = JSON.parse(await readFile(paths.permissionConsentPath, "utf8"));
    return payload?.schemaVersion === 1
      && payload?.profile === ROOTBOUND_PERMISSION_PROFILE
      && payload?.contractVersion === ROOTBOUND_PERMISSION_CONTRACT_VERSION
      && payload?.contractHash === ROOTBOUND_PERMISSION_CONTRACT_HASH;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function recordRootboundPermissionConsent({ paths, now = Date.now() } = {}) {
  if (!paths?.permissionConsentPath) throw new Error("recordRootboundPermissionConsent requires Rootbound state paths");
  await ensureRootboundStateDirs(paths);
  const payload = {
    schemaVersion: 1,
    profile: ROOTBOUND_PERMISSION_PROFILE,
    contractVersion: ROOTBOUND_PERMISSION_CONTRACT_VERSION,
    contractHash: ROOTBOUND_PERMISSION_CONTRACT_HASH,
    approvedAt: now,
  };
  const temp = `${paths.permissionConsentPath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.permissionConsentPath);
  return payload;
}

