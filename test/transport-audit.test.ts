import assert from "node:assert/strict";
import test from "node:test";
import { RequestAudit } from "../src/audit.ts";
import { supportsIncrementalTools } from "../src/capabilities.ts";

const mid = { supportsMidConvoSystemMessages: true };
test("native transport requires declared system and API-specific tool capabilities", () => {
	assert.equal(supportsIncrementalTools(undefined), false);
	for (const [api, flag] of [
		["openai-responses", "supportsAdditionalTools"], ["openai-codex-responses", "supportsToolSearch"],
		["azure-openai-responses", "supportsAdditionalTools"], ["anthropic-messages", "supportsMidConvoToolChanges"],
		["openai-completions", "supportsMidConvoToolAdditions"],
	]) {
		assert.equal(supportsIncrementalTools({ api }), false);
		assert.equal(supportsIncrementalTools({ api, compat: { [flag]: true } }), false);
		assert.equal(supportsIncrementalTools({ api, compat: mid }), false);
		assert.equal(supportsIncrementalTools({ api, compat: { ...mid, [flag]: true } }), true);
		assert.equal(supportsIncrementalTools({ api, compat: { ...mid, [flag]: "true" } }), false);
	}
	assert.equal(supportsIncrementalTools({ api: "anthropic-messages", compat: { ...mid, supportsToolReferences: true } }), false);
	assert.equal(supportsIncrementalTools({ api: "google-generative-ai", compat: { ...mid, supportsAdditionalTools: true } }), false);
});

const tools = [{ name: "read", parameters: {} }];
const head = { role: "developer", content: "initial private system text" };
const user = { role: "user", content: "private user text" };
const patch = { role: "developer", content: "<rules>new private rules</rules>" };
const inline = { type: "additional_tools", role: "developer", tools: [{ name: "alpha" }] };

test("Responses permits tail patches and additions, but detects old prefix edits and moves", () => {
	const audit = new RequestAudit();
	const payload = { tools, input: [head, user] };
	assert.match(audit.observe(payload), /baseline/);
	const loaded = { ...payload, input: [...payload.input, inline, patch] };
	assert.match(audit.observe(loaded), /stable/);
	assert.match(audit.observe({ ...loaded, input: [...loaded.input, user, patch] }), /stable/);
	assert.match(audit.observe({ ...loaded, input: [head, user, patch, inline] }), /historical (inline definitions|system patches) changed/);
	assert.match(audit.observe(payload), /historical inline definitions changed/);
	assert.match(audit.observe({ ...payload, input: [{ ...head, content: "changed" }, user] }), /initial system prefix changed/);
	assert.doesNotMatch(audit.status(), /private|rules|changed"/);
});

test("Codex checks inline system patches even with unchanged instructions", () => {
	const audit = new RequestAudit();
	const payload = { instructions: "initial", tools, input: [user, patch] };
	assert.match(audit.observe(payload, "openai-codex-responses"), /baseline/);
	assert.match(audit.observe({ ...payload, input: [...payload.input, user, inline] }), /stable/);
	assert.match(audit.observe({ ...payload, input: [user, { ...patch, content: "historical mutation" }, user, inline] }), /historical system patches changed/);
});

test("synthetic tool-search output history is checked without reporting legal appends", () => {
	const audit = new RequestAudit();
	const output = { type: "tool_search_output", call_id: "one", tools: [{ name: "alpha" }] };
	const payload = { instructions: "initial", tools, input: [user, output] };
	audit.observe(payload);
	assert.match(audit.observe({ ...payload, input: [...payload.input, { ...output, call_id: "two" }] }), /stable/);
	assert.match(audit.observe({ ...payload, input: [user, { ...output, tools: [{ name: "changed" }] }] }), /historical inline definitions changed/);
});

test("Anthropic distinguishes deferred declarations appended after a stable tool prefix", () => {
	const audit = new RequestAudit();
	const payload = { system: [{ type: "text", text: "initial" }], tools: [...tools, { name: "placeholder", defer_loading: true }], messages: [user] };
	audit.observe(payload, "anthropic-messages");
	const loaded = { ...payload, tools: [...payload.tools, { name: "alpha", defer_loading: true }], messages: [user, { role: "system", content: [{ type: "tool_addition", tool: { name: "alpha" } }] }] };
	assert.match(audit.observe(loaded, "anthropic-messages"), /stable.*deferred tool declarations appended/);
	assert.match(audit.observe({ ...loaded, messages: [user] }, "anthropic-messages"), /historical system patches changed/);
	assert.match(audit.observe({ ...loaded, tools: [{ name: "different" }] }, "anthropic-messages"), /top-level tools changed/);
});

test("portable tools changes and Chat Completions tool-bearing patches are independent", () => {
	const audit = new RequestAudit();
	const payload = { tools: [{ type: "function", function: { name: "read" } }], messages: [head, user] };
	audit.observe(payload, "openai-completions");
	assert.match(audit.observe({ ...payload, tools: [] }, "openai-completions"), /top-level tools changed/);
	audit.reset();
	audit.observe(payload, "openai-completions");
	const next = { ...payload, messages: [...payload.messages, { role: "system", tools: [{ type: "function", function: { name: "alpha" } }] }] };
	assert.match(audit.observe(next, "openai-completions"), /stable/);
	assert.match(audit.observe(payload, "openai-completions"), /historical system patches changed/);
});

test("unsupported payload resets the comparison and never leaves stale success status", () => {
	const audit = new RequestAudit();
	audit.observe({ tools, input: [user] });
	for (const payload of [null, 1, {}, { input: {} }, { messages: "bad" }]) {
		assert.equal(audit.observe(payload), "unsupported payload");
		assert.equal(audit.status(), "unsupported payload");
	}
	assert.match(audit.observe({ input: [null, 1, user] }), /baseline/);
	assert.equal(audit.observe({ input: [] }, "google-generative-ai"), "unsupported payload");
	audit.reset();
	assert.equal(audit.status(), "no requests observed");
	assert.match(audit.observe({ input: [] }), /request 1: baseline/);
});
