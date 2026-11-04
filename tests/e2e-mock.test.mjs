// End-to-end OFFLINE tests of the real generateBonusScenes path (review item 4):
// node-fetch is module-mocked, so requestSceneScript -> run() -> fetch all execute
// with canned Workers AI payloads. No network, no AI calls, no uploads.
// Run: node --experimental-test-module-mocks --test tests/e2e-mock.test.mjs
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const calls = [];
let payloads = [];
function fetchMock(url, opts) {
  calls.push({ url, body: JSON.parse(opts.body) });
  const payload = payloads.length > 1 ? payloads.shift() : payloads[0];
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { response: payload } }),
  });
}
mock.module("node-fetch", { defaultExport: fetchMock });

const { generateBonusScenes, topupMaxTokens } = await import("../scripts/cf-ai.js");

const book = { title: "Test Book", angle: "everyday focus" };
const prior = ["An earlier opening line from the main script.", "Another covered point already made."];
const scene = (i, line) => JSON.stringify({ line: line ?? `Bonus scene number ${i} digs into a fresh angle on focus.`, visual: `person at desk ${i}` });
const doc = (n, mutate) => {
  const arr = Array.from({ length: n }, (_, i) => scene(i + 1, mutate ? mutate(i + 1) : undefined));
  return `{"scenes": [${arr.join(",")}]}`;
};

test("E2E-1: truncated 30-scene top-up response is salvaged on the real code path (no extra call)", async () => {
  calls.length = 0;
  payloads = [doc(30).slice(0, -2)]; // unclosed wrapper: strict parse fails, salvage rescues all 30
  const scenes = await generateBonusScenes(book, 30, prior);
  assert.equal(scenes.length, 30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, topupMaxTokens(30)); // 4500, token-scaled budget on the real path
  assert.ok(calls[0].url.includes("@cf/meta/llama-3.1-8b-instruct-fast")); // top-up stays on the cheap model
  assert.ok(scenes.every((s) => typeof s.line === "string" && typeof s.visual === "string"));
});

test("E2E-2: salvaged scenes pass the SAME editorial checks - CTA leak triggers the existing retry", async () => {
  calls.length = 0;
  const leaky = doc(30, (i) =>
    i === 5 ? `Bonus scene ${i} says visit the website for more, which is banned here.` : undefined
  );
  payloads = [leaky.slice(0, -2), doc(30)]; // salvaged batch leaks -> existing CTA retry -> clean valid batch
  const scenes = await generateBonusScenes(book, 30, prior);
  assert.equal(calls.length, 2); // proof the salvaged output went through scoreIssues and the retry path
  // Either the clean retry batch was kept (30 scenes) or the zero-neuron code
  // removal dropped the leaking scene (29) - both are the existing editorial
  // machinery acting on salvaged output. The invariant: no CTA language ships.
  assert.ok(scenes.length >= 29 && scenes.length <= 30);
  assert.ok(!scenes.some((s) => /visit (the )?(website|site)/i.test(s.line)));
});

test("E2E-3: unrecoverable garbage still rejects (round aborts; generate-video breaks top-up and the 510s gate fails the run)", async () => {
  calls.length = 0;
  payloads = ["the model rambled with no json at all"];
  await assert.rejects(() => generateBonusScenes(book, 30, prior), /Unexpected token|JSON/);
});

test("E2E-4: valid JSON, 31 entries with 1 invalid, 30 valid >= minItems 30: accepts with the invalid one dropped (compat change, logged)", async () => {
  calls.length = 0;
  const mixed = JSON.parse(doc(30));
  mixed.scenes.splice(7, 0, { visual: "missing its line" });
  payloads = [JSON.stringify(mixed)];
  const scenes = await generateBonusScenes(book, 30, prior);
  assert.equal(scenes.length, 30);
  assert.equal(calls.length, 1);
  assert.ok(scenes.every((s) => typeof s.line === "string" && s.line.trim()));
});

test("E2E-6: valid JSON, 30 entries with 1 invalid, 29 valid < minItems 30: fails clearly, no silent partial batch", async () => {
  calls.length = 0;
  const mixed = JSON.parse(doc(30));
  mixed.scenes[7] = { visual: "missing its line" };
  payloads = [JSON.stringify(mixed)];
  await assert.rejects(() => generateBonusScenes(book, 30, prior), /schema-invalid/);
});

test("E2E-5: fail-closed ordering in generate-video.js - duration gate precedes any upload, top-up failure breaks instead of throwing past the gate", () => {
  const src = fs.readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  assert.ok(/catch \(e\) \{\s*console\.warn\("Bonus scene generation failed, stopping top-up early/.test(src), "top-up round failure is caught and breaks the loop");
  const gate = src.indexOf("Duration invariant violated");
  const firstUpload = src.indexOf("uploadVideo(");
  assert.ok(gate > -1 && firstUpload > -1, "gate and upload call both present");
  assert.ok(gate < firstUpload, "the fail-closed 510s gate runs before any upload call");
  const wf = fs.readFileSync(new URL("../.github/workflows/daily-video.yml", import.meta.url), "utf8");
  assert.ok(!/continue-on-error:\s*true/.test(wf), "no continue-on-error masking a failed run");
  assert.ok(!/^\s*retry/m.test(wf), "no automatic workflow retry config");
});
