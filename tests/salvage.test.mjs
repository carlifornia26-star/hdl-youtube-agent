// Offline fixtures for truncation salvage (2026-11-04, prefix-only semantics). No network, no AI calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  salvageScenesFromText,
  parseScenesText,
  topupScenesForRound,
  topupMaxTokens,
} from "../scripts/cf-ai.js";

const scene = (i) => `{"line": "Scene ${i} line text here.", "visual": "person at desk ${i}"}`;
const doc = (n) => `{"scenes": [${Array.from({ length: n }, (_, i) => scene(i + 1)).join(",")}]}`;

test("clean wrapped JSON parses via the strict path (salvage not engaged)", () => {
  const out = parseScenesText(doc(5), { minItems: 5, maxItems: 5 });
  assert.equal(out.salvaged, false);
  assert.equal(out.scenes.length, 5);
  assert.equal(out.scenes[0].line, "Scene 1 line text here.");
});

test("clean bare top-level array parses via the strict path", () => {
  const out = parseScenesText(`[${scene(1)},${scene(2)}]`, { minItems: 1 });
  assert.equal(out.salvaged, false);
  assert.equal(out.scenes.length, 2);
});

test("```json fenced clean JSON parses", () => {
  const out = parseScenesText("```json\n" + doc(3) + "\n```", { minItems: 3 });
  assert.equal(out.scenes.length, 3);
  assert.equal(out.salvaged, false);
});

test("truncated mid-string: complete prefix kept, incomplete tail never accepted", () => {
  const full = doc(30);
  const cutAt = full.indexOf('"line": "Scene 27') + 12;
  const truncated = full.slice(0, cutAt) + "this line never closes";
  const out = parseScenesText(truncated, { minItems: 25, maxItems: 30 });
  assert.equal(out.salvaged, true);
  assert.equal(out.complete, false);
  assert.equal(out.stopReason, "truncated");
  assert.equal(out.scenes.length, 26);
  assert.equal(out.scenes[25].line, "Scene 26 line text here.");
});

test("truncation below minItems still throws the original parse error", () => {
  const full = doc(30);
  const cutAt = full.indexOf('"line": "Scene 27') + 12;
  const truncated = full.slice(0, cutAt) + "unclosed";
  assert.throws(() => parseScenesText(truncated, { minItems: 30, maxItems: 30 }), /Unexpected token|JSON/);
});

test("trailing garbage after a fully closed document: all scenes salvaged, complete=true", () => {
  const out = parseScenesText(doc(30) + "  <<<garbage", { minItems: 30, maxItems: 30 });
  assert.equal(out.salvaged, true);
  assert.equal(out.complete, true);
  assert.equal(out.stopReason, "closed");
  assert.equal(out.scenes.length, 30);
});

test("malformed escape stops the prefix: later valid objects are NOT cherry-picked", () => {
  const bad = '{"line": "bad \\x escape", "visual": "x"}';
  const raw = `{"scenes": [${scene(1)},${bad},${scene(3)}]}`;
  const out = parseScenesText(raw, { minItems: 1 });
  assert.equal(out.salvaged, true);
  assert.equal(out.stopReason, "malformed-element");
  assert.deepEqual(out.scenes.map((s) => s.line), ["Scene 1 line text here."]); // scene 3 never rescued
  assert.throws(() => parseScenesText(raw, { minItems: 2 }), /Unexpected token|JSON/);
});

test("nested braces/brackets inside line strings do not confuse the scanner", () => {
  const tricky = JSON.stringify({ line: 'He said "use {curly} and [square] and \\ backslash" now.', visual: "whiteboard" });
  const raw = `{"scenes": [${tricky},${scene(2)}]} TAIL-GARBAGE`; // garbage forces the salvage path
  const out = parseScenesText(raw, { minItems: 2 });
  assert.equal(out.scenes.length, 2);
  assert.equal(out.scenes[0].line, 'He said "use {curly} and [square] and \\ backslash" now.');
});

test("decoy 'scenes' string nested inside another object is not treated as the key", () => {
  const raw = `{"meta": {"note": "scenes"}, "scenes": [${scene(1)}]} GARBAGE`;
  const out = parseScenesText(raw, { minItems: 1 });
  assert.equal(out.scenes.length, 1);
});

test("'scenes' key with a non-array value does not match; broken doc is refused", () => {
  const raw = `{"scenes": "not an array", "other": [${scene(1)}]} GARBAGE`;
  assert.throws(() => parseScenesText(raw, { minItems: 1 }), /Unexpected token|JSON/);
});

test("escaped/unicode key variant does not match (fail-closed)", () => {
  const raw = `{"scen\\u0065s": [${scene(1)}]} GARBAGE`;
  assert.throws(() => parseScenesText(raw, { minItems: 1 }), /Unexpected token|JSON/);
});

test("invalid scene stops the prefix: missing line, non-string line, wrong visual type", () => {
  for (const bad of ['{"visual": "no line"}', '{"line": 42}', '{"line": "ok", "visual": 7}']) {
    const raw = `{"scenes": [${scene(1)},${bad},${scene(2)}]} GARBAGE`;
    const out = parseScenesText(raw, { minItems: 1 });
    assert.equal(out.stopReason, "invalid-element");
    assert.deepEqual(out.scenes.map((s) => s.line), ["Scene 1 line text here."]);
  }
});

test("bare scalar element and missing comma are malformed separators: prefix stops, no skipping", () => {
  const scalar = `{"scenes": [${scene(1)},42,${scene(2)}]} GARBAGE`;
  const out1 = parseScenesText(scalar, { minItems: 1 });
  assert.equal(out1.stopReason, "malformed-separator");
  assert.equal(out1.scenes.length, 1);
  const noComma = `{"scenes": [${scene(1)} ${scene(2)}]} GARBAGE`;
  const out2 = parseScenesText(noComma, { minItems: 1 });
  assert.equal(out2.stopReason, "malformed-separator");
  assert.equal(out2.scenes.length, 1);
  assert.throws(() => parseScenesText(noComma, { minItems: 2 }), /Unexpected token|JSON/);
});

test("duplicate scenes are preserved (parity with strict path; repetition scoring stays downstream)", () => {
  const dup = scene(1);
  const raw = `{"scenes": [${dup},${dup},${scene(2)}]}`;
  const out = parseScenesText(raw, { minItems: 2 });
  assert.equal(out.scenes.length, 3);
  assert.equal(out.scenes[0].line, out.scenes[1].line);
});

test("duplicate root 'scenes' keys on a broken doc are AMBIGUOUS: refuse, never first-wins", () => {
  const raw = `{"scenes": [${scene(1)},${scene(2)}], "scenes": [${scene(9)}] GARBAGE`;
  assert.throws(() => parseScenesText(raw, { minItems: 1 }), /ambiguous/);
  const s = salvageScenesFromText(raw);
  assert.equal(s.stopReason, "ambiguous-duplicate-keys");
  assert.equal(s.scenes.length, 0);
});

test("duplicate bare top-level arrays are ambiguous: refuse", () => {
  const raw = `[${scene(1)}], [${scene(2)}]`;
  assert.throws(() => parseScenesText(raw, { minItems: 1 }), /ambiguous/);
});

test("clean close with non-array tail content is still accepted (not mistaken for a duplicate)", () => {
  const raw = `{"scenes": [${scene(1)}], "note": "scenes", "meta": {"x": 1}} GARBAGE`;
  const out = parseScenesText(raw, { minItems: 1 });
  assert.equal(out.complete, true);
  assert.equal(out.scenes.length, 1);
});

test("maxItems caps collection but still reports the array's true close state", () => {
  const out = parseScenesText(doc(10) + " junk", { minItems: 3, maxItems: 4 });
  assert.equal(out.scenes.length, 4);
  assert.equal(out.capped, true);
  assert.equal(out.complete, true); // scan continued to the real closing bracket
  const truncated = doc(10).slice(0, -5);
  const out2 = parseScenesText(truncated, { minItems: 3, maxItems: 4 });
  assert.equal(out2.capped, true);
  assert.equal(out2.complete, false);
});

test("input over the character bound is refused before scanning", () => {
  const huge = `{"scenes": [${scene(1)},` + " ".repeat(1_100_000);
  assert.throws(() => parseScenesText(huge, { minItems: 1 }), /Unexpected token|JSON/);
  assert.equal(salvageScenesFromText(huge), null);
});

test("entirely non-JSON text yields no salvage and throws", () => {
  assert.throws(() => parseScenesText("the model rambled with no json at all", { minItems: 1 }));
  assert.equal(salvageScenesFromText("no array here"), null);
});

test("extra keys in a salvaged scene are dropped, missing visual defaults to empty string", () => {
  const raw = `{"scenes": [{"line": "keep me", "extra": {"nested": [1,2,{"deep": true}]}, "visual": "v"}]}`;
  const out = parseScenesText(raw, { minItems: 1 });
  assert.deepEqual(out.scenes[0], { line: "keep me", visual: "v" });
  const out2 = parseScenesText(`{"scenes": [{"line": "no visual"}]}`, { minItems: 1 });
  assert.deepEqual(out2.scenes[0], { line: "no visual", visual: "" });
});

test("empty scenes array keeps the existing 'no scenes' failure", () => {
  assert.throws(() => parseScenesText('{"scenes": []}', { minItems: 1 }), /no scenes/);
});

test("bare truncated top-level array salvages complete elements", () => {
  const full = `[${scene(1)},${scene(2)},${scene(3)}]`;
  const truncated = full.slice(0, full.indexOf('"Scene 3'));
  const out = parseScenesText(truncated, { minItems: 2 });
  assert.equal(out.salvaged, true);
  assert.equal(out.scenes.length, 2);
  assert.equal(out.complete, false);
});

test("malformed-key variants (single-quoted or unquoted 'scenes') are refused, fail-closed", () => {
  assert.throws(() => parseScenesText(`{'scenes': [${scene(1)}]}`, { minItems: 1 }), /Unexpected token|JSON/);
  assert.throws(() => parseScenesText(`{scenes: [${scene(1)}]}`, { minItems: 1 }), /Unexpected token|JSON/);
});

test("production-shaped 30-scene truncation at scene 27 (Nov 2 failure class)", () => {
  const long = (i) => `{"line": "Scene ${i} ${"verbose long-form narration sentence. ".repeat(12)}", "visual": "wide shot ${i}"}`;
  const full = `{"scenes": [${Array.from({ length: 30 }, (_, i) => long(i + 1)).join(",")}]}`;
  const cutAt = full.indexOf('"line": "Scene 27') + 30;
  const truncated = full.slice(0, cutAt);
  assert.throws(() => parseScenesText(truncated, { minItems: 30, maxItems: 30 }), /Unexpected token|JSON/);
  const rescued = parseScenesText(truncated, { minItems: 10, maxItems: 30 });
  assert.equal(rescued.scenes.length, 26);
  assert.equal(rescued.salvaged, true);
});

// --- strict/salvage boundary consistency (review item 3) ---
test("strict path fails clearly when removing invalid scenes would break the minItems floor", () => {
  const four = JSON.parse(doc(4));
  four.scenes[1] = { visual: "no line" };
  four.scenes[3] = { line: 99 };
  // 2 valid remain; minItems 3 -> clear failure, not a silent partial batch
  assert.throws(() => parseScenesText(JSON.stringify(four), { minItems: 3 }), /schema-invalid/);
});

test("strict path keeps legacy pass-through for valid under-delivery (no invalid scenes)", () => {
  // 2 valid scenes, minItems 5: nothing invalid to remove, so the callsite's own
  // short-count warning flow applies - this must NOT throw here.
  const out = parseScenesText(doc(2), { minItems: 5 });
  assert.equal(out.salvaged, false);
  assert.equal(out.scenes.length, 2);
});

test("COMPATIBILITY CHANGE: strict path drops schema-invalid scenes instead of passing line:undefined", () => {
  const valid = JSON.parse(doc(3));
  valid.scenes.splice(1, 0, { visual: "no line here" });
  const out = parseScenesText(JSON.stringify(valid), { minItems: 1 });
  assert.equal(out.salvaged, false);
  assert.equal(out.dropped, 1);
  assert.equal(out.scenes.length, 3);
  assert.ok(out.scenes.every((s) => typeof s.line === "string" && s.line.trim()));
});

test("strict path parity on valid production shapes: unicode, emoji, escaped quotes, missing visual, extra keys", () => {
  const prod = {
    scenes: [
      { line: "You open the app at 6am — the number hasn’t moved. 📉", visual: "person checking phone in bed" },
      { line: "He said \"not yet\" and closed the laptop.", visual: "man closing laptop" },
      { line: "No visual on this one.", extra: "dropped", another: { deep: true } },
    ],
  };
  const out = parseScenesText(JSON.stringify(prod), { minItems: 1 });
  assert.equal(out.salvaged, false);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.scenes, [
    { line: "You open the app at 6am — the number hasn’t moved. 📉", visual: "person checking phone in bed" },
    { line: "He said \"not yet\" and closed the laptop.", visual: "man closing laptop" },
    { line: "No visual on this one.", visual: "" },
  ]);
});

// --- sizing regression (re-establishes the lost 2026-11-03 fixture evidence) ---
test("topupMaxTokens scales with count and caps at 6000", () => {
  assert.equal(topupMaxTokens(30), 4500);
  assert.equal(topupMaxTokens(10), 2300);
  assert.equal(topupMaxTokens(100), 6000);
});

test("topupScenesForRound: floor 10, cap 30, measured-average driven", () => {
  const r = topupScenesForRound([6.5, 6.5, 6.5, 6.5], 400, { targetSeconds: 510, roundFloor: 10, roundCap: 30, avgFloor: 6 });
  assert.equal(r.shortfall, 110);
  assert.equal(r.avgSceneSeconds, 6.5);
  assert.equal(r.request, Math.min(30, Math.max(10, Math.ceil((110 / 6.5) * 1.25)))); // 22
  const tiny = topupScenesForRound([7], 500, { targetSeconds: 510 });
  assert.equal(tiny.request, 10); // floor
  const huge = topupScenesForRound([6.3], 100, { targetSeconds: 510 });
  assert.equal(huge.request, 30); // cap
  const slowAvg = topupScenesForRound([2, 2], 400, { targetSeconds: 510, avgFloor: 6 });
  assert.ok(slowAvg.request >= Math.ceil((110 / 6) * 1.25)); // avgFloor clamps a too-fast measured average
});
