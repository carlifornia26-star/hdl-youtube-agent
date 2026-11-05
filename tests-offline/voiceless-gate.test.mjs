import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsVoicelessThreshold } from "../scripts/voiceless-gate.js";

test("exactly 20% voiceless is ALLOWED (strictly-greater semantics preserved)", () => {
  assert.equal(exceedsVoicelessThreshold(1, 5), false);   // 0.20 exactly
  assert.equal(exceedsVoicelessThreshold(10, 50), false); // 0.20 exactly
  assert.equal(exceedsVoicelessThreshold(20, 100), false);
});

test("above 20% voiceless is BLOCKED", () => {
  assert.equal(exceedsVoicelessThreshold(2, 5), true);    // 0.40
  assert.equal(exceedsVoicelessThreshold(21, 100), true); // just over
  assert.equal(exceedsVoicelessThreshold(30, 49), true);  // the v5 fixture case (61%)
});

test("below 20% and zero voiceless are allowed; zero scenes never blocks here", () => {
  assert.equal(exceedsVoicelessThreshold(0, 49), false);
  assert.equal(exceedsVoicelessThreshold(9, 50), false);  // 0.18
  assert.equal(exceedsVoicelessThreshold(0, 0), false);   // duration invariant handles emptiness first
});

test("invalid accounting throws rather than silently passing", () => {
  assert.throws(() => exceedsVoicelessThreshold(NaN, 10));
  assert.throws(() => exceedsVoicelessThreshold(1, -3));
});
