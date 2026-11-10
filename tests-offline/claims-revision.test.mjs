// Offline tests for the 2026-11-10 claims-lint repair, corrected after ops review:
// the revision prompt must push the model toward support-from-the-verified-library or
// removal - never toward laundering the same assertion past the lint regex with
// sourceless "it's well documented" style wording. No network: pure functions only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintUnsupportedClaims, renderRevisionRule, renderGroundingBlock } from "../scripts/cf-ai.js";

const GROUNDING = [
  { type: "study", fact: "A 2019 University of Example study tracked 412 households for six months", source: "grounding library" },
];

test("grounding fallback rule no longer suggests evidence-asserting filler phrasing", () => {
  const block = renderGroundingBlock(GROUNDING);
  // The exact suggestions removed after ops review (they evade the SOURCE_CLAIM regex
  // while still asserting documentation/popularity the model does not have):
  assert.ok(!block.includes("it's well documented that"), "must not suggest 'it's well documented that'");
  assert.ok(!block.includes("many people find"), "must not suggest 'many people find'");
  assert.ok(!block.includes("researchers have found"), "must not suggest 'researchers have found'");
  // The replacement rule must offer omission or open interpretation, and forbid
  // asserting evidence the script does not have:
  assert.match(block, /leave the point out entirely/);
  assert.match(block, /general interpretation/);
  assert.match(block, /do NOT claim or imply it is documented, researched, surveyed, measured, widely known, or popular/);
});

test("laundering note: the lint regex alone does not catch sourceless assertions", () => {
  // This sentence follows the OLD fallback advice: no number, no SOURCE_CLAIM token, so
  // the regex lint passes it - which is exactly why the prohibition lives in the prompt
  // rule (tested above), not in the lint. The lint stays unchanged by design.
  const scenes = [{ line: "It's well documented that most companies now use artificial intelligence in daily work." }];
  assert.equal(lintUnsupportedClaims(scenes, []).length, 0);
});

test("flags preserve the full rejected sentence for revision (log slice stays 140)", () => {
  const longSentence =
    "Researchers at a well known institute spent many years studying this exact topic and eventually found that more than 85 percent of all companies now use artificial intelligence somewhere in their daily operations across the world.";
  assert.ok(longSentence.length > 140, "fixture must exceed the log slice");
  const flags = lintUnsupportedClaims([{ line: longSentence }], []);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].sentence, longSentence.slice(0, 140));
  assert.equal(flags[0].fullSentence, longSentence);
});

test("revision rule names each rejected sentence in full and demands support-or-remove", () => {
  const flagged = "Over 18 million units of a certain digital currency have been mined so far.";
  const rule = renderRevisionRule([flagged]);
  assert.ok(rule.includes(`[${flagged}]`), "must quote the full rejected sentence");
  assert.match(rule, /VERIFIED GROUNDING LIBRARY/);
  assert.match(rule, /remove the claim entirely/);
  assert.match(rule, /number or attribution stripped/, "must forbid laundering the assertion with only number/attribution removed");
});

test("revision rule is empty without flags (normal first-pass prompts unchanged)", () => {
  assert.equal(renderRevisionRule([]), "");
});
