import { createHash, randomUUID } from "node:crypto";
import { projectQuotaSnapshot } from "./agent-resource.mjs";

const CONSENT_TTL_MS = 10 * 60_000;

function requestHash(action, subjectRef, payload) {
  return createHash("sha256")
    .update(`${action}\0${subjectRef ?? ""}\0${JSON.stringify(payload)}`, "utf8")
    .digest("hex");
}

export class MeteredConsentGate {
  #mode;
  #quotaProvider;
  #records = new Map();

  constructor({ mode = "off", quotaProvider = null } = {}) {
    if (!new Set(["off", "always"]).has(mode)) throw new Error("metered consent mode must be off or always");
    if (quotaProvider !== null && typeof quotaProvider !== "function") {
      throw new Error("metered consent quotaProvider must be a function when provided");
    }
    this.#mode = mode;
    this.#quotaProvider = quotaProvider;
  }

  get mode() {
    return this.#mode;
  }

  async authorize({ action, requestId, subjectRef = null, payload, consentRef = null }) {
    if (!new Set(["start", "send"]).has(action)) throw new Error("metered consent action must be start or send");
    if (typeof requestId !== "string" || !requestId.trim()) throw new Error("metered consent requestId must be a non-empty string");
    const hash = requestHash(action, subjectRef, payload);
    if (this.#mode === "off") return { authorized: true, mode: "off", consentRef: null, duplicate: false };

    const prior = this.#records.get(requestId);
    if (prior && !prior.authorized && prior.expiresAt <= Date.now()) {
      this.#records.delete(requestId);
      throw new Error(`consentRef is expired for this metered ${action} request; prepare the task again`);
    }
    if (prior) {
      if (prior.requestHash !== hash) throw new Error(`requestId was already used for a different metered ${action} request: ${requestId}`);
      if (consentRef !== null && consentRef !== prior.consentRef) throw new Error(`consentRef does not match the pending metered ${action} request`);
      if (prior.authorized) {
        if (consentRef !== prior.consentRef) return this.#required(prior, true);
        return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: true };
      }
      if (consentRef === prior.consentRef) {
        prior.authorized = true;
        prior.authorizedAt = Date.now();
        return { authorized: true, mode: "always", consentRef: prior.consentRef, duplicate: false };
      }
      return this.#required(prior, true);
    }

    if (consentRef !== null) throw new Error("consentRef is unknown or stale for this metered requestId");
    let quotaSnapshot;
    try {
      quotaSnapshot = this.#quotaProvider
        ? await this.#quotaProvider()
        : { status: "unavailable", observedAt: new Date().toISOString(), usage: { status: "unavailable" }, rateLimits: { status: "unavailable" } };
    } catch (error) {
      const projected = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
      quotaSnapshot = {
        status: "unavailable",
        observedAt: new Date().toISOString(),
        usage: { status: "unavailable", error: projected },
        rateLimits: { status: "unavailable", error: projected },
      };
    }
    const record = {
      action,
      subjectRef,
      requestId,
      requestHash: hash,
      consentRef: `consent_${randomUUID()}`,
      quota: projectQuotaSnapshot(quotaSnapshot),
      createdAt: Date.now(),
      expiresAt: Date.now() + CONSENT_TTL_MS,
      authorized: false,
      authorizedAt: null,
    };
    this.#records.set(requestId, record);
    return this.#required(record, false);
  }

  #required(record, duplicate) {
    return {
      authorized: false,
      mode: "always",
      duplicate,
      consent: {
        status: "required",
        consentRef: record.consentRef,
        action: record.action,
        subjectRef: record.subjectRef,
        requestId: record.requestId,
        expiresAt: record.expiresAt,
        quota: record.quota,
        message: "This action starts metered Codex model work. Ask the user to approve this exact call before retrying with the same requestId and consentRef.",
      },
    };
  }
}
