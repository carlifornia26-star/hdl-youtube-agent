// R1+R2 offline fixture tests: narration-budget-aware top-ups + strengthened main-script
// word floor. No network: pure functions and source-level checks only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topupScenesForRound, buildBonusScenesPrompt } from "../scripts/cf-ai.js";

const book = { title: "Test Book", angle: "testing" };

test("R1: wordBudget = ceil(shortfall x measured rate x 1.15)", () => {
  // ch3 2026-11-06 recorded shape: 440s built, 510s target, measured 2.37 w/s
  const r = topupScenesForRound([8.7, 8.7], 440, { targetSeconds: 510, narrationRate: 2.37 });
  assert.equal(r.shortfall, 70);
  assert.equal(r.wordBudget, Math.ceil(70 * 2.37 * 1.15)); // 191
  assert.equal(r.wordBudget, 191);
});

test("R1: fallback rate 2.4 w/s (mid of measured 2.26-2.61 range) when rate missing", () => {
  const r = topupScenesForRound([], 387, { targetSeconds: 510 });
  assert.equal(r.wordBudget, Math.ceil(123 * 2.4 * 1.15)); // 340
  const r0 = topupScenesForRound([], 387, { targetSeconds: 510, narrationRate: 0 });
  assert.equal(r0.wordBudget, r.wordBudget);
});

test("R1: scene-request sizing math unchanged (backward-compatible fields)", () => {
  const base = topupScenesForRound([7, 9, 8], 400, { targetSeconds: 510, roundFloor: 10, roundCap: 30 });
  const withRate = topupScenesForRound([7, 9, 8], 400, { targetSeconds: 510, roundFloor: 10, roundCap: 30, narrationRate: 2.5 });
  assert.equal(withRate.request, base.request);
  assert.equal(withRate.avgSceneSeconds, base.avgSceneSeconds);
  assert.equal(withRate.shortfall, base.shortfall);
});

test("R1: bonus prompt carries explicit countable budget when provided", () => {
  const p = buildBonusScenesPrompt(book, 12, [], { wordBudget: 340 });
  assert.match(p, /MUST total AT LEAST 340 words/);
  assert.match(p, /at least 45 words/);
  assert.match(p, /count your words/i);
});

test("R1: bonus prompt unchanged in shape when no budget (no budget language leaked)", () => {
  const p = buildBonusScenesPrompt(book, 12, []);
  assert.doesNotMatch(p, /WORD BUDGET RULE/);
  assert.match(p, /roughly 40-55 words/); // original rule preserved on the compat path
});

test("R1: covered-openings block still passed through", () => {
  const p = buildBonusScenesPrompt(book, 5, ["Some earlier opening line about testing."], { wordBudget: 100 });
  assert.match(p, /ALREADY COVERED/);
});

test("R2: main-script prompt carries hard per-scene floor and total-word floor", () => {
  const src = readFileSync(new URL("../scripts/cf-ai.js", import.meta.url), "utf8");
  assert.match(src, /4-6 full sentences and MUST be at least 45 words/);
  assert.match(src, /MUST reach at least 1800 words/);
});

test("guardrails: duration floor and gate wording unchanged", () => {
  const gv = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  assert.match(gv, /Duration invariant violated/);
  const cf = readFileSync(new URL("../scripts/cf-ai.js", import.meta.url), "utf8");
  assert.match(cf, /targetSeconds = 510/);
});

test("guardrails: no new AI call sites added by R1+R2 (counts = pre-R1R2 baseline)", () => {
  const cf = readFileSync(new URL("../scripts/cf-ai.js", import.meta.url), "utf8");
  const gv = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  // Counts verified identical to origin/main (pre-R1R2) at authoring: 6 / 4 / 0.
  assert.equal((cf.match(/await run\(/g) || []).length, 6);
  assert.equal((cf.match(/requestSceneScript\(/g) || []).length, 4);
  assert.equal((gv.match(/await run\(/g) || []).length, 0);
});
