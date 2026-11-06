// H1 telemetry helpers: the per-call usage log and its aggregation. Offline, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAiCallLog, summarizeAiCallLog, recordAiCall, logAiUsageSummary, sceneWordStats } from "../scripts/cf-ai.js";

test("summarizeAiCallLog aggregates per model and keeps unknown usage honest", () => {
  const entries = [
    { at: "t1", model: "m70b", promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    { at: "t2", model: "m70b", promptTokens: 200, completionTokens: 70, totalTokens: 270 },
    { at: "t3", model: "m8b", promptTokens: null, completionTokens: null, totalTokens: null },
  ];
  const s = summarizeAiCallLog(entries);
  assert.equal(s.calls, 3);
  assert.equal(s.byModel.m70b.calls, 2);
  assert.equal(s.byModel.m70b.totalTokens, 420);
  assert.equal(s.byModel.m8b.unknownUsage, 1);
  assert.equal(s.byModel.m8b.totalTokens, 0);
});

test("summarizeAiCallLog on an empty log reports zero calls", () => {
  const s = summarizeAiCallLog([]);
  assert.equal(s.calls, 0);
  assert.deepEqual(s.byModel, {});
});

test("getAiCallLog returns a copy, not the live buffer", () => {
  const a = getAiCallLog();
  a.push({ fake: true });
  assert.equal(getAiCallLog().length, a.length - 1);
});


// --- Main-review hardening (2026-11-06): metadata-only logging, edge shapes, failure paths ---

function capturedLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test("recordAiCall logs metadata only: model + token counts, never content", () => {
  const secret = "sk-fixture-secret-value";
  const lines = capturedLog(() =>
    recordAiCall("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      response: `generated text mentioning ${secret}`,
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    })
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^AI usage: @cf\/meta\/llama-3\.3-70b-instruct-fp8-fast prompt_tokens=12 completion_tokens=34 total_tokens=46$/);
  assert.ok(!lines[0].includes(secret), "no response content in the log line");
});

test("missing usage object (text/translation models) logs nulls, no throw", () => {
  for (const result of [
    { translated_text: "hola" },           // m2m100 shape
    { response: "plain text" },            // text model shape
    "a bare string result",                // defensive: non-object
    null, undefined, 42,                   // degenerate shapes
  ]) {
    const lines = capturedLog(() => recordAiCall("m", result));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /prompt_tokens=\? completion_tokens=\? total_tokens=\?$/);
  }
});

test("circular usage/result objects cannot break logging", () => {
  const result = { response: "x" };
  result.self = result;                    // circular
  result.usage = { prompt_tokens: 1 };
  result.usage.circular = result;          // circular inside usage
  const lines = capturedLog(() => recordAiCall("m", result));
  assert.match(lines[0], /prompt_tokens=1 completion_tokens=\? total_tokens=\?/);
});

test("non-numeric usage fields pass through as-is and never throw", () => {
  const lines = capturedLog(() => recordAiCall("m", { usage: { prompt_tokens: "unknown", completion_tokens: null, total_tokens: 0 } }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /total_tokens=0$/);
});

test("log buffer stays bounded (cap 300, oldest dropped)", () => {
  for (let i = 0; i < 320; i++) recordAiCall("m", { usage: { prompt_tokens: i, completion_tokens: 0, total_tokens: i } });
  const log = getAiCallLog();
  assert.equal(log.length, 300);
  assert.equal(log[log.length - 1].promptTokens, 319);
});

test("summarizeAiCallLog output contains no content fields", () => {
  const s = summarizeAiCallLog([
    { at: "t", model: "m", promptTokens: 5, completionTokens: 6, totalTokens: 11 },
  ]);
  const flat = JSON.stringify(s);
  assert.ok(!/response|text|prompt"|messages|secret/i.test(flat.replace(/"promptTokens"/, "")), "aggregate carries counts only");
});

test("exit summary accounting stays exact past the 300-entry raw cap", () => {
  for (let i = 0; i < 350; i++) recordAiCall("m-capped", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try { logAiUsageSummary(); } finally { console.log = orig; }
  const totalLine = lines.find((l) => l.startsWith("AI usage summary:"));
  const modelLine = lines.find((l) => l.includes("m-capped:"));
  assert.ok(totalLine && modelLine, "summary lines printed");
  const totalCalls = Number(totalLine.match(/(\d+) successful/)[1]);
  const modelCalls = Number(modelLine.match(/(\d+) call\(s\)/)[1]);
  assert.ok(totalCalls >= 350, `aggregate covers all calls, got ${totalCalls}`);
  assert.equal(modelCalls, 350, "per-model count exact beyond the cap");
  assert.match(modelLine, /total=700 tokens/);
});

test("exit summary and word stats never carry generated content", () => {
  const secret = "sk-fixture-secret-value";
  recordAiCall("m-leak-check", { response: `body ${secret}`, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try { logAiUsageSummary(); } finally { console.log = orig; }
  assert.ok(!lines.join("\n").includes(secret), "no response content in exit summary");
  for (const line of lines) {
    assert.ok(!/response|translated_text|messages/i.test(line), `metadata shape only: ${line}`);
  }
  // sceneWordStats returns numbers only
  const ws = sceneWordStats([{ line: `mentions ${secret} here` }]);
  assert.ok(Object.values(ws).every((v) => typeof v === "number"), "word stats are numbers only");
});
