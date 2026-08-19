import { spawn } from "node:child_process";

export class CodexRpcError extends Error {
  constructor(method, rpcError) {
    super(`${method} failed: ${rpcError?.message || JSON.stringify(rpcError)}`);
    this.name = "CodexRpcError";
    this.method = method;
    this.rpcError = rpcError;
  }
}

export class CodexRpcTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = "CodexRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class CodexAppServerClient {
  #cwd;
  #launchFactory;
  #child = null;
  #cleanup = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #notificationMethods = new Set();
  #notificationHandlers = new Set();
  #serverRequestMethods = new Set();
  #serverRequestHandler = null;
  #pendingServerRequests = new Map();
  #initializedResult = null;
  #defaultRequestTimeoutMs;
  #initializeCapabilities;
  #closing = false;
  #stderrHandler;

  constructor({
    bin,
    cwd,
    clientInfo = {},
    launch,
    requestTimeoutMs = 30_000,
    initializeCapabilities = null,
    serverRequestHandler = null,
    stderrHandler = null,
  }) {
    if (!launch && !bin) throw new Error("CodexAppServerClient requires either a codex binary path or a launch factory");
    if (launch && typeof launch !== "function") throw new Error("CodexAppServerClient launch must be a function returning a spawn spec");
    if (serverRequestHandler !== null && typeof serverRequestHandler !== "function") throw new Error("serverRequestHandler must be a function when provided");
    if (stderrHandler !== null && typeof stderrHandler !== "function") throw new Error("stderrHandler must be a function when provided");

    this.#cwd = cwd;
    this.#defaultRequestTimeoutMs = requestTimeoutMs;
    this.#initializeCapabilities = initializeCapabilities;
    this.#serverRequestHandler = serverRequestHandler;
    this.#stderrHandler = stderrHandler ?? ((chunk) => process.stderr.write(`[codex-app-server] ${chunk}`));
    this.#launchFactory = launch ?? (() => ({
      command: bin,
      args: ["app-server", "--stdio"],
      options: { cwd: this.#cwd },
    }));
    this.clientInfo = {
      name: clientInfo.name ?? "rootbound",
      title: clientInfo.title ?? "Rootbound",
      version: clientInfo.version ?? "0.1.0",
    };
  }

  get notificationMethods() { return [...this.#notificationMethods]; }
  get serverRequestMethods() { return [...this.#serverRequestMethods]; }
  get pendingServerRequestIds() { return [...this.#pendingServerRequests.values()].map((entry) => entry.id); }
  get initializedResult() { return this.#initializedResult; }
  get running() { return Boolean(this.#child); }

  onNotification(handler) {
    if (typeof handler !== "function") throw new Error("notification handler must be a function");
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  async start() {
    if (this.#child) return this.#initializedResult;
    this.#closing = false;
    this.#buffer = "";

    const spec = await this.#launchFactory();
    if (!spec?.command) throw new Error("Codex App Server launch factory returned no command");

    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.options?.cwd ?? this.#cwd,
      env: spec.options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: spec.options?.windowsHide ?? true,
      shell: false,
    });
    this.#child = child;
    this.#cleanup = typeof spec.cleanup === "function" ? spec.cleanup : null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      try { this.#stderrHandler(chunk); }
      catch (error) { process.stderr.write(`[codex-app-server] stderr handler failure: ${error instanceof Error ? error.message : String(error)}\n`); }
    });
    child.on("error", (error) => this.#failAll(error));
    child.on("exit", (code, signal) => {
      const wasRunning = this.#child === child;
      if (wasRunning) this.#child = null;
      if (wasRunning && !this.#closing) {
        const exitError = new Error(`codex app-server exited: code=${code} signal=${signal}`);
        if (this.#pending.size) this.#failAll(exitError);
        if (this.#pendingServerRequests.size) this.#abandonServerRequests(exitError);
      }
    });

    try {
      const initializeParams = { clientInfo: this.clientInfo };
      if (this.#initializeCapabilities) initializeParams.capabilities = this.#initializeCapabilities;
      this.#initializedResult = await this.request(
        "initialize",
        initializeParams,
        { timeoutMs: Math.min(this.#defaultRequestTimeoutMs, 15_000) }
      );
      this.notify("initialized", {});
      return this.#initializedResult;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(method, params, { timeoutMs = this.#defaultRequestTimeoutMs } = {}) {
    if (!this.#child) throw new Error("codex app-server is not started");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const key = String(id);
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            const waiter = this.#pending.get(key);
            if (!waiter) return;
            this.#pending.delete(key);
            const timeoutError = new CodexRpcTimeoutError(method, timeoutMs);
            void (async () => {
              try {
                await this.close();
                waiter.reject(timeoutError);
              } catch (cleanupError) {
                waiter.reject(new AggregateError([timeoutError, cleanupError], `${timeoutError.message}; cleanup also failed`));
              }
            })();
          }, timeoutMs)
        : null;
      timer?.unref?.();
      this.#pending.set(key, { method, resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  notify(method, params) {
    if (!this.#child) throw new Error("codex app-server is not started");
    this.#send({ method, params });
  }

  exec(params, options) { return this.request("command/exec", params, options); }

  async close() {
    const child = this.#child;
    const cleanup = this.#cleanup;
    let cleanupError = null;
    this.#closing = true;

    if (child && this.#pendingServerRequests.size) this.#closePendingServerRequests();
    this.#child = null;
    this.#cleanup = null;

    if (child) {
      try { child.stdin.end(); } catch {}
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch {}
      }
    }

    if (cleanup) {
      try { await cleanup(); }
      catch (error) {
        cleanupError = error;
        process.stderr.write(`[codex-app-server] cleanup failure: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    if (this.#pending.size) this.#failAll(new Error("codex app-server closed before pending requests completed"));
    this.#closing = false;
    if (cleanupError) throw cleanupError;
  }

  #send(message) {
    if (!this.#child) throw new Error("codex app-server is not started");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try { message = JSON.parse(line); }
      catch (error) {
        this.#failAll(new Error(`Invalid Codex App Server JSON line: ${line}\n${error.message}`));
        continue;
      }

      const key = message.id === undefined ? null : String(message.id);
      if (key !== null && this.#pending.has(key)) {
        const waiter = this.#pending.get(key);
        this.#pending.delete(key);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new CodexRpcError(waiter.method, message.error));
        else waiter.resolve(message.result);
        continue;
      }

      if (key !== null && typeof message.method === "string") {
        this.#serverRequestMethods.add(message.method);
        if (!this.#serverRequestHandler) {
          this.#send({ id: message.id, error: { code: -32601, message: `Server-initiated request not supported by Rootbound: ${message.method}` } });
          continue;
        }
        if (this.#pendingServerRequests.has(key)) {
          this.#send({ id: message.id, error: { code: -32600, message: `Duplicate server request id: ${String(message.id)}` } });
          continue;
        }
        const handle = this.#createServerRequestHandle(message);
        try {
          const handlerResult = this.#serverRequestHandler(handle);
          Promise.resolve(handlerResult).catch((error) => {
            if (!handle.settled) {
              try { handle.reject({ code: -32603, message: `serverRequestHandler failed: ${error instanceof Error ? error.message : String(error)}` }); }
              catch {}
            }
          });
        } catch (error) {
          if (!handle.settled) handle.reject({ code: -32603, message: `serverRequestHandler failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        continue;
      }

      if (typeof message.method === "string") {
        this.#notificationMethods.add(message.method);
        if (message.method === "serverRequest/resolved") this.#settleServerRequestFromServer(message.params);
        for (const handler of this.#notificationHandlers) {
          try { handler(message); }
          catch (error) { process.stderr.write(`[codex-app-server] notification handler failure: ${error instanceof Error ? error.message : String(error)}\n`); }
        }
      }
    }
  }

  #createServerRequestHandle(message) {
    const key = String(message.id);
    const entry = { id: message.id, method: message.method, params: message.params, settled: false, settlement: null, handle: null };
    const handle = {
      id: entry.id,
      method: entry.method,
      params: entry.params,
      get settled() { return entry.settled; },
      get settlement() { return entry.settlement; },
      resolve: (result) => this.#settleServerRequest(key, { kind: "resolve", result }),
      reject: (error) => this.#settleServerRequest(key, { kind: "reject", error }),
    };
    entry.handle = Object.freeze(handle);
    this.#pendingServerRequests.set(key, entry);
    return entry.handle;
  }

  #settleServerRequest(key, settlement) {
    const entry = this.#pendingServerRequests.get(key);
    if (!entry) throw new Error(`server request is unknown or already settled: ${key}`);
    if (!this.#child) throw new Error(`cannot settle server request after Codex App Server closed: ${key}`);
    if (settlement.kind === "resolve") this.#send({ id: entry.id, result: settlement.result });
    else {
      const error = settlement.error && typeof settlement.error === "object"
        ? settlement.error
        : { code: -32000, message: String(settlement.error ?? "server request rejected") };
      this.#send({ id: entry.id, error });
    }
    entry.settled = true;
    entry.settlement = settlement;
    this.#pendingServerRequests.delete(key);
    return true;
  }

  #settleServerRequestFromServer(params) {
    const requestId = params?.requestId;
    if (requestId === undefined || requestId === null) return false;
    const key = String(requestId);
    const entry = this.#pendingServerRequests.get(key);
    if (!entry) return false;
    entry.settled = true;
    entry.settlement = { kind: "serverResolved", params };
    this.#pendingServerRequests.delete(key);
    return true;
  }

  #closePendingServerRequests() {
    for (const [key, entry] of this.#pendingServerRequests) {
      const error = { code: -32000, message: `Rootbound client closed before server request was resolved: ${entry.method}` };
      try { this.#send({ id: entry.id, error }); } catch {}
      entry.settled = true;
      entry.settlement = { kind: "reject", error };
      this.#pendingServerRequests.delete(key);
    }
  }

  #abandonServerRequests(error) {
    for (const [key, entry] of this.#pendingServerRequests) {
      const rpcError = { code: -32000, message: error instanceof Error ? error.message : String(error) };
      entry.settled = true;
      entry.settlement = { kind: "reject", error: rpcError };
      this.#pendingServerRequests.delete(key);
    }
  }

  #failAll(error) {
    for (const waiter of this.#pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }
}
