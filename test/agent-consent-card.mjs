import assert from "node:assert/strict";
import { createAgentPreviewState, registerAgentPreviewTools } from "../src/agent-tools.mjs";

const tools = new Map();
const server = {
  registerTool(name, definition, handler) { tools.set(name, { definition, handler }); },
  registerResource() {},
};

let starts = 0;
const agentExecutor = {
  async listModels() { return { models: [], nextCursor: null }; },
  async start({ clientRequestId }) {
    starts += 1;
    return {
      agentRef: "agent_fake",
      threadId: "thread_fake",
      turnId: "turn_fake",
      status: "idle",
      latestTurnStatus: "completed",
      canSend: true,
      pendingApproval: null,
      finalResult: `FAKE_OK:${clientRequestId}`,
      resourceReceipt: null,
      latestError: null,
      createdAt: 1,
      updatedAt: 2,
      timing: { startedAt: 1, endedAt: 2, durationMs: 1 },
      execution: { requestedModel: null, resolvedModel: "fake-model", modelProvider: "fake", serviceTier: null, reasoningEffort: null },
      events: [],
      nextSeq: 0,
    };
  },
  async show() { throw new Error("show should not be needed for this terminal fake start"); },
  async send() { throw new Error("send not used"); },
  async resolveApproval() { throw new Error("approval not used"); },
  async rejectApproval() { throw new Error("reject not used"); },
  async cancel() { throw new Error("cancel not used"); },
};

const authorityExecutor = {
  async resolveAuthority({ cwd = null } = {}) {
    return {
      effectiveCwd: cwd ?? "C:\\workspace",
      permissionProfile: ":read-only",
    };
  },
};

const state = createAgentPreviewState({
  meteredConsentMode: "always",
  meteredQuotaProvider: async () => ({ status: "ok", observedAt: new Date().toISOString(), usage: { status: "ok" }, rateLimits: { status: "ok", limits: [] } }),
});
registerAgentPreviewTools(server, {
  agentExecutor,
  authorityExecutor,
  meteredConsentMode: "always",
  meteredQuotaProvider: null,
  agentPreviewState: state,
});

const start = tools.get("codex.agent_start").handler;
const render = tools.get("codex.agent_card_render").handler;
const decline = tools.get("codex.agent_decline").handler;
const commit = tools.get("codex.agent_commit").handler;

const prepared = await start({ prompt: "fake approval card start", requestId: "fake-request-1" });
assert.equal(prepared.isError, false);
assert.equal(prepared.structuredContent.status, "consent_required");
assert.equal(starts, 0);
const consentRef = prepared.structuredContent.meteredConsent.consentRef;

const card = await render({ consentRef });
assert.equal(card.isError, false);
const commitToken = card._meta?.codexlessCommitToken;
assert.match(commitToken ?? "", /^commit_/);
assert.equal(JSON.stringify(card.structuredContent).includes(commitToken), false);
assert.equal(card.content[0].text.includes(commitToken), false);

const missing = await commit({ consentRef, commitToken: "commit_wrong" });
assert.equal(missing.isError, true);
assert.equal(starts, 0);

const accepted = await commit({ consentRef, commitToken });
assert.equal(accepted.isError, false);
assert.equal(starts, 1);
assert.equal(accepted.structuredContent.finalResult, "FAKE_OK:fake-request-1");
assert.equal(accepted.structuredContent.terminal, true);

const duplicate = await commit({ consentRef, commitToken });
assert.equal(duplicate.isError, false);
assert.equal(duplicate.structuredContent.duplicate, true);
assert.equal(starts, 1, "repeated exact card commit must not start a second logical Codex turn");

const declinePrepared = await start({ prompt: "fake decline card start", requestId: "fake-request-decline-1" });
assert.equal(declinePrepared.isError, false);
assert.equal(declinePrepared.structuredContent.status, "consent_required");
const declineConsentRef = declinePrepared.structuredContent.meteredConsent.consentRef;
const declineCard = await render({ consentRef: declineConsentRef });
const declineCommitToken = declineCard._meta?.codexlessCommitToken;
assert.match(declineCommitToken ?? "", /^commit_/);

const declined = await decline({ consentRef: declineConsentRef });
assert.equal(declined.isError, false);
assert.equal(declined.structuredContent.status, "rejected");
assert.equal(declined.structuredContent.terminal, true);
assert.equal(declined.structuredContent.agentRef, null);
assert.equal(declined.structuredContent.turnId, null);
assert.equal(starts, 1, "declining a prepared card must not start Codex");

const declinedAgain = await decline({ consentRef: declineConsentRef });
assert.equal(declinedAgain.isError, false);
assert.equal(declinedAgain.structuredContent.status, "rejected");
assert.equal(starts, 1, "duplicate decline must remain terminal without starting Codex");

const cachedCommitAfterNo = await commit({ consentRef: declineConsentRef, commitToken: declineCommitToken });
assert.equal(cachedCommitAfterNo.isError, false);
assert.equal(cachedCommitAfterNo.structuredContent.status, "rejected");
assert.equal(cachedCommitAfterNo.structuredContent.terminal, true);
assert.equal(cachedCommitAfterNo.structuredContent.duplicate, true);
assert.equal(starts, 1, "a cached Yes/commit after No must not revive or start the rejected task");

const replayAfterNo = await start({ prompt: "fake decline card start", requestId: "fake-request-decline-1" });
assert.equal(replayAfterNo.isError, false);
assert.equal(replayAfterNo.structuredContent.status, "rejected");
assert.equal(replayAfterNo.structuredContent.terminal, true);
assert.equal(starts, 1, "same requestId replay after No must stay rejected and start nothing");

console.log("agent Task Card capability + decline hardening PASS");
