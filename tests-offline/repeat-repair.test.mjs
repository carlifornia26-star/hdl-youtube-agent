// Offline tests for the 2026-11-10 pre-build verbatim-repeat repair + the spoken
// trending-screenshots intro. No network: pure functions and source-level checks only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSpokenSentence, repairRepeatedSentences } from "../scripts/cf-ai.js";

const LONG_A = "This is a fairly long sentence about saving money every single month.";
const LONG_B = "Another completely different thought about building a small emergency fund this year."; // 12+ words, over the gate floor

test("normalizer matches the gate's rule (case, punctuation, curly quotes collapse)", () => {
  assert.equal(
    normalizeSpokenSentence("  It\u2019s the SAME thing, really!  "),
    normalizeSpokenSentence("it's the same thing really")
  );
});

test("later verbatim duplicate is stripped, first occurrence kept", () => {
  const scenes = [
    { line: `${LONG_A} ${LONG_B}`, visual: "a" },
    { line: `${LONG_B} ${LONG_A}`, visual: "b" }, // both already said above
    { line: "A short aside.", visual: "c" },       // under minWords, never stripped
  ];
  const r = repairRepeatedSentences(scenes, { protectLast: false });
  assert.equal(r.removedSentences, 2);
  assert.equal(r.removedScenes, 1); // second scene left empty -> dropped
  assert.equal(r.scenes.length, 2);
  assert.equal(r.scenes[0].line, `${LONG_A} ${LONG_B}`);
  assert.equal(r.scenes[1].line, "A short aside.");
});

test("partial duplicate keeps the scene's unique sentences", () => {
  const scenes = [
    { line: LONG_A, visual: "a" },
    { line: `${LONG_A} ${LONG_B}`, visual: "b" },
  ];
  const r = repairRepeatedSentences(scenes, { protectLast: false });
  assert.equal(r.removedSentences, 1);
  assert.equal(r.removedScenes, 0);
  assert.equal(r.scenes[1].line, LONG_B);
});

test("priorLines seed: batch lines repeating earlier video lines are stripped", () => {
  const bonus = [{ line: `${LONG_A} ${LONG_B}`, visual: "x" }];
  const r = repairRepeatedSentences(bonus, { priorLines: [`Intro. ${LONG_A}`], protectLast: false });
  assert.equal(r.removedSentences, 1);
  assert.equal(r.scenes[0].line, LONG_B);
});

test("closing CTA scene is never silently emptied", () => {
  const scenes = [
    { line: LONG_A, visual: "a" },
    { line: LONG_A, visual: "cta" }, // last scene, full duplicate
  ];
  const r = repairRepeatedSentences(scenes); // protectLast defaults true
  assert.equal(r.scenes.length, 2);
  assert.equal(r.scenes[1].line, LONG_A); // restored; the hard gate still judges it
  assert.equal(r.removedSentences, 1);
  assert.equal(r.removedScenes, 0);
});

test("clean scripts pass through untouched", () => {
  const scenes = [
    { line: LONG_A, visual: "a", isNewsSegment: true },
    { line: LONG_B, visual: "b" },
  ];
  const r = repairRepeatedSentences(scenes);
  assert.equal(r.removedSentences, 0);
  assert.equal(r.removedScenes, 0);
  assert.deepEqual(r.scenes, scenes);
});

test("source: final-cut gate still throws (repair does not weaken it)", () => {
  const src = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  assert.match(src, /Final narration repeats \$\{finalRepeats\.length\} verbatim sentence\(s\) across the cut; refusing upload/);
  assert.match(src, /repairRepeatedSentences\(scenes\)/); // pre-build repair wired in
  assert.match(src, /repairRepeatedSentences\(round, \{ priorLines: existingLines, protectLast: false \}\)/); // top-up wired
  assert.match(src, /retrying once/); // one bounded retry on hard top-up generation failure
});

test("source: trending-screenshots segment gets a clear spoken intro before the cards", () => {
  const src = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  assert.match(src, /Before we get into it, let's see what's trending today around the world, starting with \$\{trend\.term\}\./);
  // intro is part of the news segment so the chapter label and CTA-last logic see it
  assert.match(src, /newsScenes\.unshift\(\{[\s\S]*?isNewsSegment: true,[\s\S]*?\}\);\s*\n\s*scenes\.splice\(insertAt, 0, \.\.\.newsScenes\)/);
});
