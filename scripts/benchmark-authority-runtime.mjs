import { performance } from "node:perf_hooks";
import process from "node:process";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable, probeCodexExecutable } from "../src/codex-bin.mjs";
import { readManyAuthorized } from "../src/construction-tools.mjs";
import { searchPageAuthorized } from "../src/repo-tools.mjs";
import { resolveGitExecutable } from "../src/git-executable.mjs";
import {
  ROOTBOUND_PERMISSION_PROFILE,
  withRootboundPermissionOverrides,
} from "../src/rootbound-permission-profile.mjs";

const options = parseArgs(process.argv.slice(2));
const cwd = path.resolve(options.cwd ?? process.cwd());
const iterations = options.iterations;
const warmups = options.warmups;
const originalCodexHome = process.env.CODEX_HOME;
let isolatedCodexHome = null;
const execFileAsync = promisify(execFile);

if (options.synthetic) {
  const legacy = await runSyntheticSuite({
    cwd,
    iterations,
    warmups,
    authorityClientMaxUses: 1,
    exposeNativeLease: false,
    startupDelayMs: options.syntheticStartupMs,
    requestDelayMs: options.syntheticRequestMs,
  });
  const warm = await runSyntheticSuite({
    cwd,
    iterations,
    warmups,
    authorityClientMaxUses: 100,
    exposeNativeLease: true,
    startupDelayMs: options.syntheticStartupMs,
    requestDelayMs: options.syntheticRequestMs,
  });
  const output = {
    schemaVersion: 1,
    benchmark: "rootbound-authority-runtime-synthetic",
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd,
    iterations,
    warmups,
    syntheticStartupMs: options.syntheticStartupMs,
    syntheticRequestMs: options.syntheticRequestMs,
    legacy,
    warm,
    medianSpeedup: compareSuites(legacy.results, warm.results),
  };
  process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 2)}\n`);
  process.exit(0);
}

const resolution = await resolveCodexExecutable({ acceptedVersions: null });
const probe = await probeCodexExecutable(resolution.path, { cwd });
const version = String(probe.versionText ?? "").match(/codex-cli\s+([^\s]+)/i)?.[1] ?? null;
if (!probe.ok || !version) {
  throw new Error(`Unable to benchmark Codex runtime: ${probe.versionText ?? probe.error ?? "unknown Codex version"}`);
}

if (options.isolatedCodexHome) {
  isolatedCodexHome = await mkdtemp(path.join(path.resolve(import.meta.dirname, ".."), ".benchmark-codex-home-"));
  await writeFile(
    path.join(isolatedCodexHome, "config.toml"),
    `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`,
    { mode: 0o600 }
  );
  process.env.CODEX_HOME = isolatedCodexHome;
}

const configOverrides = withRootboundPermissionOverrides([], {
  profileOverride: ROOTBOUND_PERMISSION_PROFILE,
});
const executor = new CodexAuthorityExecutor({
  codexBin: resolution.path,
  defaultCwd: cwd,
  profileOverride: ROOTBOUND_PERMISSION_PROFILE,
  configOverrides,
  acceptedCodexVersions: [version],
  maxTimeoutMs: 120_000,
  watchdogGraceMs: 5_000,
  outputBytesCap: 1_048_576,
});

try {
  const validateMs = await measureOne(() => executor.validate());
  const gitBin = await resolveGitExecutable();
  const repoSearchProbe = await searchPageAuthorized({
    authorityExecutor: executor,
    query: "CodexAuthorityExecutor",
    cwd,
    glob: "src/*.mjs",
    maxResults: 20,
    includeSensitive: false,
  });
  const scenarios = [
  {
    name: "resolve_authority",
    run: () => executor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 }),
  },
  {
    name: "exec_noop",
    run: () => executor.exec({
      command: [process.execPath, "-e", "process.stdout.write('ok')"],
      cwd,
      access: "readOnly",
      timeoutMs: 10_000,
    }),
  },
  {
    name: "repo_search",
    run: () => searchPageAuthorized({
      authorityExecutor: executor,
      query: "CodexAuthorityExecutor",
      cwd,
      glob: "src/*.mjs",
      maxResults: 20,
      includeSensitive: false,
    }),
  },
  {
    name: "read_many_3",
    run: () => readManyAuthorized({
      authorityExecutor: executor,
      cwd,
      paths: ["package.json", "src/public-runtime.mjs", "src/codex-authority-executor.mjs"],
      maxCharsPerFile: 30_000,
      maxTotalChars: 80_000,
      allowSensitive: false,
    }),
  },
  {
    name: "git_status",
    run: () => executor.exec({
      command: [gitBin, "status", "--short", "--branch"],
      cwd,
      access: "readOnly",
      timeoutMs: 10_000,
    }),
  },
  {
    name: "git_diff",
    run: () => executor.exec({
      command: [gitBin, "diff", "--no-ext-diff"],
      cwd,
      access: "readOnly",
      timeoutMs: 10_000,
    }),
  },
  ];

  const results = {};
  for (const scenario of scenarios) {
    for (let i = 0; i < warmups; i += 1) await scenario.run();
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      samples.push(await measureOne(scenario.run));
    }
    results[scenario.name] = summarize(samples);
  }

  const output = {
    schemaVersion: 1,
    benchmark: "rootbound-authority-runtime",
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    codexVersion: version,
    cwd,
    isolatedCodexHome: Boolean(isolatedCodexHome),
    iterations,
    warmups,
    validateMs: round(validateMs),
    diagnostics: {
      repoSearchCandidateEngine: repoSearchProbe.candidateEngine ?? null,
      gitExecutable: gitBin,
    },
    results,
  };

  process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 2)}\n`);
} finally {
  await executor.close().catch(() => {});
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (isolatedCodexHome) await rm(isolatedCodexHome, { recursive: true, force: true });
}

async function measureOne(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples.map(round),
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

function percentile(sorted, percentileValue) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function parseArgs(argv) {
  const result = {
    cwd: null,
    iterations: 5,
    warmups: 1,
    json: false,
    isolatedCodexHome: false,
    synthetic: false,
    syntheticStartupMs: 100,
    syntheticRequestMs: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      result.cwd = requireValue(argv, ++index, "--cwd");
      continue;
    }
    if (arg === "--iterations") {
      result.iterations = parsePositiveInt(requireValue(argv, ++index, "--iterations"), "--iterations");
      continue;
    }
    if (arg === "--warmups") {
      result.warmups = parseNonNegativeInt(requireValue(argv, ++index, "--warmups"), "--warmups");
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--isolated-codex-home") {
      result.isolatedCodexHome = true;
      continue;
    }
    if (arg === "--synthetic") {
      result.synthetic = true;
      continue;
    }
    if (arg === "--synthetic-startup-ms") {
      result.syntheticStartupMs = parseNonNegativeInt(requireValue(argv, ++index, "--synthetic-startup-ms"), "--synthetic-startup-ms");
      continue;
    }
    if (arg === "--synthetic-request-ms") {
      result.syntheticRequestMs = parseNonNegativeInt(requireValue(argv, ++index, "--synthetic-request-ms"), "--synthetic-request-ms");
      continue;
    }
    throw new Error(`Unknown benchmark argument: ${arg}`);
  }
  return result;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || !value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

async function runSyntheticSuite({
  cwd,
  iterations,
  warmups,
  authorityClientMaxUses,
  exposeNativeLease,
  startupDelayMs,
  requestDelayMs,
}) {
  const metrics = { created: 0, started: 0, closed: 0, requests: 0, execs: 0 };
  const executor = new CodexAuthorityExecutor({
    codexBin: "/synthetic/codex",
    defaultCwd: cwd,
    profileOverride: ROOTBOUND_PERMISSION_PROFILE,
    configOverrides: [],
    acceptedCodexVersions: ["synthetic"],
    prevalidatedCodexVersion: "synthetic",
    authorityClientMaxAgeMs: 60 * 60_000,
    authorityClientMaxUses,
    outputBytesCap: 1_048_576,
    clientFactory: () => createSyntheticAuthorityClient({
      cwd,
      metrics,
      startupDelayMs,
      requestDelayMs,
    }),
  });
  const benchmarkExecutor = exposeNativeLease
    ? executor
    : {
        resolveAuthority: (input) => executor.resolveAuthority(input),
        exec: (input) => executor.exec(input),
      };
  try {
    const validateMs = await measureOne(() => executor.validate());
    const scenarios = [
      {
        name: "resolve_authority",
        run: () => executor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 }),
      },
      {
        name: "exec_noop",
        run: () => executor.exec({
          command: [process.execPath, "-e", "process.stdout.write('ok')"],
          cwd,
          access: "readOnly",
          timeoutMs: 10_000,
        }),
      },
      {
        name: "repo_search",
        run: () => searchPageAuthorized({
          authorityExecutor: benchmarkExecutor,
          query: "CodexAuthorityExecutor",
          cwd,
          glob: "src/*.mjs",
          maxResults: 20,
          includeSensitive: false,
        }),
      },
      {
        name: "read_many_3",
        run: () => readManyAuthorized({
          authorityExecutor: benchmarkExecutor,
          cwd,
          paths: ["package.json", "src/public-runtime.mjs", "src/codex-authority-executor.mjs"],
          maxCharsPerFile: 30_000,
          maxTotalChars: 80_000,
          allowSensitive: false,
        }),
      },
    ];
    const results = {};
    for (const scenario of scenarios) {
      for (let index = 0; index < warmups; index += 1) await scenario.run();
      const samples = [];
      for (let index = 0; index < iterations; index += 1) samples.push(await measureOne(scenario.run));
      results[scenario.name] = summarize(samples);
    }
    return {
      authorityClientMaxUses,
      exposeNativeLease,
      validateMs: round(validateMs),
      lifecycle: { ...metrics },
      results,
    };
  } finally {
    await executor.close();
  }
}

function compareSuites(legacyResults, warmResults) {
  return Object.fromEntries(Object.keys(legacyResults).map((name) => {
    const before = legacyResults[name].medianMs;
    const after = warmResults[name].medianMs;
    return [name, {
      beforeMs: before,
      afterMs: after,
      improvementPercent: before > 0 ? round(((before - after) / before) * 100) : 0,
      speedupX: after > 0 ? round(before / after) : null,
    }];
  }));
}

function createSyntheticAuthorityClient({ cwd, metrics, startupDelayMs, requestDelayMs }) {
  metrics.created += 1;
  let running = false;
  return {
    get running() { return running; },
    get notificationMethods() { return []; },
    get serverRequestMethods() { return []; },
    async start() {
      await delay(startupDelayMs);
      running = true;
      metrics.started += 1;
    },
    async close() {
      if (!running) return;
      running = false;
      metrics.closed += 1;
    },
    async request(method) {
      metrics.requests += 1;
      await delay(requestDelayMs);
      if (method === "config/read") {
        return { config: { projects: { [cwd]: { trust_level: "trusted" } } } };
      }
      if (method === "permissionProfile/list") {
        return { data: [{ id: ROOTBOUND_PERMISSION_PROFILE, allowed: true }, { id: ":read-only", allowed: true }] };
      }
      if (method === "thread/start") {
        return { activePermissionProfile: { id: ROOTBOUND_PERMISSION_PROFILE } };
      }
      throw new Error(`unexpected synthetic App Server request: ${method}`);
    },
    async exec(params) {
      metrics.execs += 1;
      await delay(requestDelayMs);
      const [command, ...args] = params.command;
      try {
        const result = await execFileAsync(command, args, {
          cwd: params.cwd,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          timeout: params.timeoutMs,
        });
        return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      } catch (error) {
        return {
          exitCode: Number.isInteger(error?.code) ? error.code : 1,
          stdout: error?.stdout ?? "",
          stderr: error?.stderr ?? error?.message ?? String(error),
        };
      }
    },
  };
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
