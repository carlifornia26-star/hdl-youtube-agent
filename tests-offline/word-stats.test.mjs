// T1 (H1): word-count + pre-synthesis duration projection, offline unit tests.
// Feeds fixture scripts matching the OBSERVED 2026-11-05 production distributions
// (46 scenes @ ~6.0s audio/scene; Kokoro measured at 1.81 words/sec on an existing
// local sample -> ~11 words/scene implied) and asserts the projection flags the
// shortfall BEFORE any rendering. No network, no AI calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordCount, sceneWordStats, projectNarrationSeconds } from "../scripts/cf-ai.js";

const TARGET_MIN_SECONDS = 510;
const MEASURED_WPS = 1.81; // single-sample Kokoro measurement (28 words / 15.45s); production rotates 11 voices

function fixtureScenes(count, wordsPerScene) {
  const word = "steady";
  return Array.from({ length: count }, (_, i) => ({ line: `${word}${i} ` + Array(wordsPerScene).fill("calm").join(" ") }));
}

test("wordCount handles blanks and spacing", () => {
  assert.equal(wordCount("one two   three"), 3);
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount(null), 0);
  assert.equal(wordCount("  padded  words  "), 2);
});

test("sceneWordStats over the observed short distribution (46 x 11 words)", () => {
  const s = sceneWordStats(fixtureScenes(46, 11));
  assert.equal(s.scenes, 46);
  assert.equal(s.totalWords, 46 * 12); // each fixture line = index word + 11 filler words
  assert.equal(s.min, 12);
  assert.equal(s.max, 12);
  assert.ok(Math.abs(s.mean - 12) < 1e-9);
  assert.equal(s.median, 12);
});

test("projection flags the Nov-5-shaped shortfall before rendering", () => {
  // 46 scenes at the observed ~12 words/scene, measured 1.81 wps -> ~305s: far under 510s.
  const projected = projectNarrationSeconds(fixtureScenes(46, 11), MEASURED_WPS);
  assert.ok(projected < TARGET_MIN_SECONDS, `expected shortfall, got ${projected.toFixed(0)}s`);
  assert.ok(projected > 200 && projected < 400, `projection in the observed 220-449s failure band, got ${projected.toFixed(0)}s`);
});

test("projection clears when scenes carry the instructed 40-55 words", () => {
  // What the prompt asks for: 46 scenes x ~46 words at the same measured rate.
  const projected = projectNarrationSeconds(fixtureScenes(46, 45), MEASURED_WPS);
  assert.ok(projected >= TARGET_MIN_SECONDS, `instructed word counts should clear the floor, got ${projected.toFixed(0)}s`);
});

test("projection refuses an unknown/invalid rate instead of guessing", () => {
  assert.equal(projectNarrationSeconds(fixtureScenes(10, 10), 0), null);
  assert.equal(projectNarrationSeconds(fixtureScenes(10, 10), -2), null);
  assert.equal(projectNarrationSeconds(fixtureScenes(10, 10), NaN), null);
});

test("empty script stats are zeros, not NaN", () => {
  const s = sceneWordStats([]);
  assert.deepEqual(s, { scenes: 0, totalWords: 0, mean: 0, median: 0, min: 0, max: 0 });
});
