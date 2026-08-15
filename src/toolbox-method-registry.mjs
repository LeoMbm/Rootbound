import { readFileSync } from "node:fs";

const registryUrl = new URL("../config/toolbox-method-registry.json", import.meta.url);
let registry;
try {
  registry = JSON.parse(readFileSync(registryUrl, "utf8"));
} catch (error) {
  throw new Error(`failed to load Codexless method registry: ${error instanceof Error ? error.message : String(error)}`);
}

if (registry?.defaultAction !== "deny") {
  throw new Error("Codexless method registry must be fail-closed with defaultAction=deny");
}

export function getToolboxMethodRegistry() {
  return structuredClone(registry);
}

export function assertRemoteModelFreeMethod(method) {
  const entry = registry?.remoteAllowlist?.[method];
  if (!entry || entry.classification !== "model-free") {
    throw new Error(`Codex App Server method is not on the verified model-free remote allowlist: ${method}`);
  }
  return entry;
}
