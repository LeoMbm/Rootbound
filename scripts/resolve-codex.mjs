import { ACCEPTED_CODEX_VERSIONS } from "../src/codex-authority-executor.mjs";
import { probeCodexExecutable, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { parseCodexVersion } from "../src/codex-compatibility.mjs";

try {
  const resolution = await resolveCodexExecutable({ acceptedVersions: null });
  const probe = await probeCodexExecutable(resolution.path);
  const parsedVersion = parseCodexVersion(probe.versionText);
  const knownAcceptedVersion = Boolean(parsedVersion && ACCEPTED_CODEX_VERSIONS.includes(parsedVersion));
  process.stdout.write(`${JSON.stringify({
    ok: probe.ok && Boolean(parsedVersion),
    path: resolution.path,
    source: resolution.source,
    version: probe.versionText,
    parsedVersion,
    knownAcceptedVersion,
    compatibility: knownAcceptedVersion ? "built-in-version-policy" : "deferred-to-project-capability-probe",
    error: probe.error,
  })}\n`);
  process.exitCode = probe.ok && parsedVersion ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
