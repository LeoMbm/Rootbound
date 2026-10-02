import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-authority-runtime-"));
const projectRoot = path.join(temp, "project");
await mkdir(projectRoot);
const cwd = await realpath(projectRoot);

class FakeClient {
  #cwd;
  #metrics;
  #running = false;

  constructor({ cwd, metrics }) {
    this.#cwd = cwd;
    this.#metrics = metrics;
    metrics.created += 1;
    if (Array.isArray(metrics.clients)) metrics.clients.push(this);
  }

  get running() { return this.#running; }
  get notificationMethods() { return []; }
  get serverRequestMethods() { return []; }

  crash() {
    this.#running = false;
    this.#metrics.crashed = (this.#metrics.crashed ?? 0) + 1;
  }

  async start() {
    this.#metrics.started += 1;
    if (this.#metrics.startDelayMs) await new Promise((resolve) => setTimeout(resolve, this.#metrics.startDelayMs));
    if (this.#metrics.failNextStart) {
      this.#metrics.failNextStart = false;
      throw new Error("synthetic start failure");
    }
    this.#running = true;
  }

  async close() {
    if (!this.#running) return;
    this.#running = false;
    this.#metrics.closed += 1;
  }

  async exec(params) {
    this.#metrics.requests.push(["command/exec", params]);
    await this.#delay();
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }

  async request(method, params) {
    this.#metrics.requests.push([method, params, this.#cwd]);
    await this.#delay();
    if (method === "config/read") {
      if (this.#metrics.failNextConfigRead) {
        this.#metrics.failNextConfigRead = false;
        throw new Error("synthetic config failure");
      }
      return { config: { projects: { [this.#cwd]: { trust_level: "trusted" } } } };
    }
    if (method === "permissionProfile/list") {
      return { data: [{ id: "rootbound", allowed: true }, { id: ":read-only", allowed: true }] };
    }
    if (method === "thread/start") {
      return {
        activePermissionProfile: { id: "rootbound" },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        runtimeWorkspaceRoots: [this.#cwd],
        sandbox: { type: "workspaceWrite", networkAccess: true, writableRoots: [this.#cwd], excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    }
    throw new Error(`unexpected fake App Server method: ${method}`);
  }

  async #delay() {
    const delayMs = this.#metrics.requestDelayMs ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [] };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 3 });
  try {
    await executor.validate();
    assert.equal(metrics.created, 1);
    assert.equal(metrics.started, 1);
    assert.equal(metrics.closed, 0);

    const authority = await executor.resolveAuthority({ cwd, access: "readOnly" });
    assert.equal(authority.permissionProfile, ":read-only");
    assert.equal(metrics.created, 1, "resolveAuthority should reuse the validation App Server");

    const command = await executor.exec({
      command: [process.execPath, "-e", "process.stdout.write('ok')"],
      cwd,
      access: "readOnly",
      timeoutMs: 10_000,
    });
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout, "ok");
    assert.equal(metrics.created, 1, "exec should reuse the warm authority App Server");
    assert.equal(metrics.closed, 1, "max-use recycling should close after the configured lease count");

    await executor.resolveAuthority({ cwd, access: "readOnly" });
    assert.equal(metrics.created, 2, "the next lease should create a fresh App Server after recycling");
  } finally {
    await executor.close();
  }
  assert.equal(metrics.closed, 2);
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [], failNextConfigRead: false };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  try {
    await executor.validate();
    metrics.failNextConfigRead = true;
    await assert.rejects(
      executor.resolveAuthority({ cwd, access: "readOnly" }),
      /synthetic config failure/
    );
    assert.equal(metrics.closed, 1, "a failed authority lease must recycle the suspect App Server");

    await executor.resolveAuthority({ cwd, access: "readOnly" });
    assert.equal(metrics.created, 2, "the request after a failure must use a fresh App Server");
  } finally {
    await executor.close();
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [], requestDelayMs: 5 };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  try {
    await executor.validate();
    await Promise.all([
      executor.resolveAuthority({ cwd, access: "readOnly" }),
      executor.resolveAuthority({ cwd, access: "readOnly" }),
      executor.resolveAuthority({ cwd, access: "readOnly" }),
    ]);
    assert.equal(metrics.created, 1, "concurrent leases must share one successfully started warm client");
  } finally {
    await executor.close();
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [] };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  try {
    await executor.validate();
    await executor.withAuthority({ cwd, access: "readOnly" }, async (lease) => {
      await assert.rejects(
        lease.exec({
          command: [process.execPath, "-e", "process.stdout.write('nope')"],
          access: "inherit",
          timeoutMs: 10_000,
        }),
        /cannot be escalated/i
      );
    });
  } finally {
    await executor.close();
  }
}

{
  const secondRoot = path.join(temp, "project-two");
  await mkdir(secondRoot);
  const secondCwd = await realpath(secondRoot);
  const metrics = { created: 0, started: 0, closed: 0, requests: [] };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  try {
    await executor.validate();
    await executor.resolveAuthority({ cwd, access: "readOnly" });
    await executor.resolveAuthority({ cwd: secondCwd, access: "readOnly" });
    assert.equal(metrics.created, 2, "switching canonical cwd must create a fresh authority App Server");
    assert.equal(metrics.closed, 1, "the previous project-scoped authority App Server must be closed");
  } finally {
    await executor.close();
  }
  assert.equal(metrics.closed, 2);
}

{
  const secondRoot = path.join(temp, "project-three");
  await mkdir(secondRoot);
  const secondCwd = await realpath(secondRoot);
  const metrics = { created: 0, started: 0, closed: 0, requests: [], startDelayMs: 20 };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 1 });
  try {
    await executor.validate();
    assert.equal(metrics.closed, 1, "validation should recycle before the concurrent cross-project acquisition");
    const [first, second] = await Promise.all([
      executor.resolveAuthority({ cwd, access: "readOnly" }),
      executor.resolveAuthority({ cwd: secondCwd, access: "readOnly" }),
    ]);
    assert.equal(first.effectiveCwd, cwd);
    assert.equal(second.effectiveCwd, secondCwd);
    const crossProjectRequests = metrics.requests.filter(
      ([method, params, clientCwd]) => method === "config/read" && params.cwd !== clientCwd
    );
    assert.deepEqual(crossProjectRequests, [], "a project must never use an App Server launched for another cwd");
    assert.equal(metrics.created, 3, "validation plus two concurrent project scopes should create distinct project-scoped clients");
  } finally {
    await executor.close();
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [], failNextStart: false };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 1 });
  try {
    await executor.validate();
    metrics.failNextStart = true;
    await assert.rejects(
      executor.resolveAuthority({ cwd, access: "readOnly" }),
      /synthetic start failure/
    );
    await executor.resolveAuthority({ cwd, access: "readOnly" });
    assert.equal(metrics.created, 3, "startup failure must not poison the next warm-client acquisition");
  } finally {
    await executor.close();
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [], startDelayMs: 30 };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 1 });
  await executor.validate();
  const pending = executor.resolveAuthority({ cwd, access: "readOnly" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await executor.close();
  await assert.rejects(pending, /closed while authority App Server was starting|CodexAuthorityExecutor is closed/);
  assert.equal(metrics.closed, 2, "closing during startup must close both the recycled validation client and the pending startup client");
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [], clients: [] };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  try {
    await executor.validate();
    assert.equal(metrics.clients.length, 1);
    metrics.clients[0].crash();
    const authority = await executor.resolveAuthority({ cwd, access: "readOnly" });
    assert.equal(authority.effectiveCwd, cwd);
    assert.equal(metrics.created, 2, "a dead warm App Server must be replaced before the next authority operation");
    assert.equal(metrics.started, 2);
  } finally {
    await executor.close();
  }
}

{
  const metrics = { created: 0, started: 0, closed: 0, requests: [] };
  const executor = makeExecutor({ cwd, metrics, authorityClientMaxUses: 100 });
  await executor.validate();
  let activeResolve;
  let releaseResolve;
  const active = new Promise((resolve) => { activeResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const operation = executor.withAuthority({ cwd, access: "readOnly" }, async () => {
    activeResolve();
    await release;
    return "completed";
  });
  await active;
  const closeResult = await Promise.race([
    executor.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  assert.equal(closeResult, "closed", "executor shutdown must not hang while an authority lease is active");
  assert.equal(metrics.closed, 1, "shutdown must close the active warm App Server exactly once");
  releaseResolve();
  assert.equal(await operation, "completed");
  await executor.close();
  assert.equal(metrics.closed, 1, "releasing a lease after shutdown must not leak or double-close the client");
}

console.log("authority-runtime-reuse-v5: ok");

function makeExecutor({ cwd, metrics, authorityClientMaxUses }) {
  return new CodexAuthorityExecutor({
    codexBin: "/synthetic/codex",
    defaultCwd: cwd,
    profileOverride: "rootbound",
    configOverrides: [],
    acceptedCodexVersions: ["test"],
    prevalidatedCodexVersion: "test",
    authorityClientMaxAgeMs: 60_000,
    authorityClientMaxUses,
    clientFactory: (options) => new FakeClient({ cwd: options.cwd, metrics }),
  });
}
