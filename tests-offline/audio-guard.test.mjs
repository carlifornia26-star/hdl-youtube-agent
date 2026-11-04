import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSaneSamples } from "../scripts/voice.js";

test("healthy speech samples pass", () => {
  const s = new Float32Array(24000);
  for (let i = 0; i < s.length; i++) s[i] = 0.6 * Math.sin(i / 20);
  assert.doesNotThrow(() => assertSaneSamples(s, "unit"));
});

test("full-scale edge samples pass (no false positive at normal peaks)", () => {
  const s = new Float32Array([0, 0.99, -1.0, 0.5, -0.5, 1.5, -1.5]);
  assert.doesNotThrow(() => assertSaneSamples(s, "unit"));
});

test("blown-up samples are rejected (captured failure mode: peak ~1.8e11)", () => {
  const s = new Float32Array(1000);
  s[500] = 1.79e11;
  assert.throws(() => assertSaneSamples(s, "unit"), /degenerate audio rejected/);
});

test("non-finite samples are rejected", () => {
  assert.throws(() => assertSaneSamples(new Float32Array([0.1, NaN, 0.2]), "unit"), /degenerate audio rejected/);
  assert.throws(() => assertSaneSamples(new Float32Array([0.1, Infinity]), "unit"), /degenerate audio rejected/);
});

test("empty audio passes to the existing duration handling", () => {
  assert.doesNotThrow(() => assertSaneSamples(new Float32Array(0), "unit"));
});
