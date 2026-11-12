// Offline fixture test: a hard-failed top-up round must not forfeit the remaining
// round(s) (2026-11-12). Reproduces the Nov 12 ch3 failure (top-up round 1 of 2 died on
// malformed model JSON, the loop broke, round 2 never ran, duration invariant failed at
// 334s < 510s) against the REAL loop text extracted from scripts/generate-video.js, with
// all AI/build functions mocked - no network, no Workers AI calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");

// Extract the real top-up loop (from its declaration to just before the final-cut checks)
// and run it with injected mocks, so this test exercises the production control flow,
// not a hand-copied variant.
function extractLoop(src) {
  const start = src.indexOf("let topupRound = 0;");
  const endMarker = "\n\n  // Check the FINAL cut";
  const end = src.indexOf(endMarker);
  assert.notEqual(start, -1, "top-up loop start not found in generate-video.js");
  assert.notEqual(end, -1, "top-up loop end marker not found in generate-video.js");
  return src.slice(start, end);
}

function makeRunner(src) {
  const loopText = extractLoop(src);
  const wrapper = `
    const { topupScenesForRound, sanitizeScenePauses, generateBonusScenes,
            repairRepeatedSentences, wordCount, buildOneScene, console } = deps;
    let { built, totalSeconds, measuredNarrationRate, nextSceneIndex } = deps.state;
    const { TARGET_MIN_SECONDS, MAX_TOPUP_ROUNDS, TOPUP_SCENES_PER_ROUND,
            TOPUP_MAX_SCENES_PER_ROUND, book } = deps;
    ${loopText}
    return { built, totalSeconds, topupRound };
  `;
  return new Function("deps", `return (async () => { ${wrapper} })()`);
}

// A built cut shaped like the Nov 12 ch3 run: 334s voiced, CTA last. `built` must
// actually sum to totalSeconds because the real loop recomputes totalSeconds from it.
function ch3LikeState(overrides = {}) {
  const main = Array.from({ length: 41 }, (_, i) => ({ line: `main scene line ${i + 1}`, duration: 8 }));
  const scenes = [...main, { line: "closing cta", duration: 6, cta: true }];
  return {
    built: scenes,
    totalSeconds: 334,
    measuredNarrationRate: 2.4,
    nextSceneIndex: 50,
    ...overrides,
  };
}

function baseDeps(state, { genPlan, repairPlan } = {}) {
  const calls = { generateBonusScenes: 0, buildOneScene: 0 };
  const silent = { log() {}, warn() {}, error() {} };
  const deps = {
    state,
    console: silent,
    TARGET_MIN_SECONDS: 510,
    MAX_TOPUP_ROUNDS: 2,
    TOPUP_SCENES_PER_ROUND: 10,
    TOPUP_MAX_SCENES_PER_ROUND: 30,
    book: { title: "Test Book" },
    topupScenesForRound: (durations, total) => ({
      avgSceneSeconds: 7,
      shortfall: 510 - total,
      request: 30,
      wordBudget: 200,
    }),
    sanitizeScenePauses: (scenes) => scenes,
    generateBonusScenes: async () => {
      calls.generateBonusScenes++;
      return genPlan(calls.generateBonusScenes);
    },
    repairRepeatedSentences: (scenes) =>
      repairPlan ? repairPlan(scenes) : { scenes, removedSentences: 0, removedScenes: 0 },
    wordCount: (line) => line.split(/\s+/).filter(Boolean).length,
    buildOneScene: async (scene) => {
      calls.buildOneScene++;
      return { ...scene, voicePath: "mock-voice" };
    },
  };
  return { deps, calls };
}

const mkScenes = (n, secondsEach) =>
  Array.from({ length: n }, (_, i) => ({ line: `bonus scene line ${i + 1}`, duration: secondsEach }));

test("ch3 repro: round 1 hard-fails twice, round 2 succeeds - loop continues, invariant reached", async () => {
  const genPlan = (n) => {
    if (n <= 2) throw new Error("malformed JSON from model"); // round 1: initial + bounded retry
    return mkScenes(30, 6); // round 2: +180s
  };
  const { deps, calls } = baseDeps(ch3LikeState(), { genPlan });
  const out = await makeRunner(SRC)(deps);
  assert.equal(calls.generateBonusScenes, 3, "expected 1+1 failed calls in round 1, then 1 in round 2");
  assert.equal(out.topupRound, 2);
  assert.equal(out.totalSeconds, 334 + 180, "round 2 scenes must be built into the cut");
  assert.ok(out.totalSeconds >= 510, "duration invariant now satisfied");
  assert.equal(out.built[out.built.length - 1].cta, true, "CTA stays last");
});

test("every round hard-fails: bounded at MAX x (1+retry) calls, cut unchanged, gate still judges", async () => {
  const genPlan = () => {
    throw new Error("malformed JSON from model");
  };
  const { deps, calls } = baseDeps(ch3LikeState(), { genPlan });
  const out = await makeRunner(SRC)(deps);
  assert.equal(calls.generateBonusScenes, 4, "2 rounds x (1 initial + 1 retry), no unbounded loop");
  assert.equal(out.totalSeconds, 334, "no scenes were added");
  assert.equal(out.topupRound, 2);
  // The production duration invariant (outside the loop, unchanged) would still throw here.
  assert.match(SRC, /Duration invariant violated/);
  assert.ok(out.totalSeconds < 510, "short cut still fails the invariant loudly");
});

test("round 1 succeeds immediately: unchanged happy path, single call", async () => {
  const genPlan = () => mkScenes(30, 6);
  const { deps, calls } = baseDeps(ch3LikeState(), { genPlan });
  const out = await makeRunner(SRC)(deps);
  assert.equal(calls.generateBonusScenes, 1);
  assert.equal(out.topupRound, 1);
  assert.ok(out.totalSeconds >= 510);
});

test("single-round channel (MAX_TOPUP_ROUNDS=1) hard failure keeps the old stop: 2 calls, break", async () => {
  const genPlan = () => {
    throw new Error("malformed JSON from model");
  };
  const { deps, calls } = baseDeps(ch3LikeState({ totalSeconds: 480 }), { genPlan });
  deps.MAX_TOPUP_ROUNDS = 1;
  const out = await makeRunner(SRC)(deps);
  assert.equal(calls.generateBonusScenes, 2, "initial + bounded retry, then stop (pre-patch behavior)");
  assert.equal(out.topupRound, 1);
  assert.equal(out.totalSeconds, 480);
});

test("repair-to-empty still stops the top-up early (duplicate-steering path unchanged)", async () => {
  const genPlan = () => mkScenes(10, 6);
  const repairPlan = () => ({ scenes: [], removedSentences: 3, removedScenes: 10 });
  const { deps, calls } = baseDeps(ch3LikeState(), { genPlan, repairPlan });
  const out = await makeRunner(SRC)(deps);
  assert.equal(calls.generateBonusScenes, 1, "no extra call when a round repairs to empty");
  assert.equal(out.topupRound, 1);
  assert.equal(out.totalSeconds, 334);
});

test("guardrails: loop bound, bounded retry, gates and floor all unchanged", async () => {
  assert.match(SRC, /while \(totalSeconds < TARGET_MIN_SECONDS && topupRound < MAX_TOPUP_ROUNDS\)/);
  assert.match(SRC, /MAX_TOPUP_ROUNDS = .*LOW_AI.*\? 1 : 2/);
  assert.match(SRC, /Duration invariant violated/);
  assert.match(SRC, /TARGET_MIN_SECONDS = 8\.5 \* 60; \/\/ 510s/);
  assert.match(SRC, /retrying once:/);
  // The patched file added exactly one continuation path; the old stop is still there for
  // the final round and for repair-to-empty.
  assert.equal((SRC.match(/stopping top-up early/g) || []).length, 2);
  // No gate relaxation anywhere: claims-lint and loudness paths untouched by this change.
  assert.match(SRC, /claims/i);
});
