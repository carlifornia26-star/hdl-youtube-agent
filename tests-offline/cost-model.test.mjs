// T4 (memo section 5): neuron cost model over the OFFICIAL rate card, offline.
// Rates read 2026-11-06 from developers.cloudflare.com/workers-ai/platform/pricing/:
//   @cf/meta/llama-3.3-70b-instruct-fp8-fast: 26,668 N/M input, 204,805 N/M output
//   @cf/meta/llama-3.1-8b-instruct-fp8-fast:  4,119 N/M input,  34,868 N/M output
// The repo's 8B id is "...-instruct-fast" (no fp8 in the name); the fp8-fast row is the
// closest listed variant and is used here as a documented proxy. m2m100-1.2b is NOT on
// the pricing page; its translation calls are unpriced here (gap recorded in memo v2).
// Per-call token figures below are ASSUMPTIONS (memo v2 cost model), not measurements -
// H1 logging exists to replace them with real usage fields before any remedy ships.
import { test } from "node:test";
import assert from "node:assert/strict";

const NEURONS_PER_MTOK = {
  "70b": { input: 26668, output: 204805 },
  "8b": { input: 4119, output: 34868 }, // fp8-fast proxy for the repo's -fast id
};
const DAILY_FREE = 10000;
const FAIR_SHARE_PER_RUN = 2500; // 4 runs sharing one 10k account

const neurons = (model, inTok, outTok) =>
  (NEURONS_PER_MTOK[model].input * inTok + NEURONS_PER_MTOK[model].output * outTok) / 1e6;

// Assumed per-call token shapes (memo v2 section 2).
const CALL = {
  mainScript70B: { in: 4000, out: 3000 },
  newsExplainer70B: { in: 2000, out: 1300 },
  newsExplainer8B: { in: 2000, out: 1300 },
  titles70B: { in: 1200, out: 120 },
  claimRevision70B: { in: 4000, out: 3000 },
  topupRound8B: { in: 2500, out: 2900 }, // one 30-scene round
};

const N = {
  main: neurons("70b", CALL.mainScript70B.in, CALL.mainScript70B.out),
  news70: neurons("70b", CALL.newsExplainer70B.in, CALL.newsExplainer70B.out),
  news8: neurons("8b", CALL.newsExplainer8B.in, CALL.newsExplainer8B.out),
  titles: neurons("70b", CALL.titles70B.in, CALL.titles70B.out),
  revision: neurons("70b", CALL.claimRevision70B.in, CALL.claimRevision70B.out),
  topup: neurons("8b", CALL.topupRound8B.in, CALL.topupRound8B.out),
};

test("happy-path run (no retries, one top-up round) fits the per-run fair share", () => {
  const perRun = N.main + N.news70 + N.titles + N.topup;
  assert.ok(perRun < FAIR_SHARE_PER_RUN, `base run ${perRun.toFixed(0)}N should fit the ${FAIR_SHARE_PER_RUN}N share`);
  assert.ok(perRun > 500, `sanity: base run ${perRun.toFixed(0)}N in the memo's ~1,100-1,200N band (before translations)`);
  // translations unpriced -> assert the model honestly cannot claim a full-run total
});

test("retry-heavy run (main x3 + revision) matches the Nov 5 exhaustion shape", () => {
  const heavy = 3 * N.main + N.revision + N.news70 + N.titles + N.topup;
  // memo: heavy run ~= 3,500N; two heavy + one normal ~= 8,300N; a third heavy crosses 10k.
  const twoHeavyOneNormal = 2 * heavy + (N.main + N.news70 + N.titles + N.topup);
  const threeHeavy = 3 * heavy;
  assert.ok(twoHeavyOneNormal < DAILY_FREE, `2 heavy + 1 normal = ${twoHeavyOneNormal.toFixed(0)}N should stay under 10k`);
  assert.ok(threeHeavy > DAILY_FREE, `3 heavy = ${threeHeavy.toFixed(0)}N should cross 10k (Nov 5 pattern: quota died on run 3 of 4)`);
});

test("key asymmetry: one extra 70B retry costs far more than a full 8B top-up round", () => {
  assert.ok(N.main > 5 * N.topup, `70B retry ${N.main.toFixed(0)}N should dwarf 8B top-up ${N.topup.toFixed(0)}N`);
  assert.ok(N.topup < 0.015 * DAILY_FREE, `one top-up round ${N.topup.toFixed(0)}N should be ~1% of the daily budget`);
});

test("H3 candidate cost: a second ch2 top-up round stays ~1% of the daily budget", () => {
  // H3 raises MAX_TOPUP_ROUNDS for LOW_AI_CHANNEL 1 -> 2: worst case +1 8B call/day.
  assert.ok(N.topup < 150, `+1 round = +${N.topup.toFixed(0)}N (expect ~110N)`);
});

test("8B-for-news on all channels saves real quota per run (H4 input)", () => {
  const saving = N.news70 - N.news8;
  assert.ok(saving > 150, `70B->8B news saving ${saving.toFixed(0)}N/run (memo ~240N)`);
});

// --- Correction (2026-11-06): m2m100 IS priced, and caption translation is a top consumer ---
// Rate from the official pricing page, read 2026-11-06: @cf/meta/m2m100-1.2b =
// 31,050 neurons per M input tokens AND per M output tokens. (Memo v2 marked it unpriced -
// it is listed; gap closed.)
const M2M100_PER_MTOK = 31050;
const TOKENS_PER_WORD = 1.3;
// Per-scene-line caption translation: one call per scene line per language, title field of
// translateMeta; output assumed ~1.15x input length (translation par).
const captionTranslateNeurons = (scenes, langs, wordsPerScene) => {
  const inTok = wordsPerScene * TOKENS_PER_WORD;
  const outTok = inTok * 1.15;
  return scenes * langs * (M2M100_PER_MTOK * (inTok + outTok)) / 1e6;
};

test("caption translation dwarfs the 70B main script at the observed word distribution", () => {
  // Observed Nov 5 shape: 76 built scenes, 15 caption languages, inferred 12-19 words/scene.
  const low = captionTranslateNeurons(76, 15, 12);
  const high = captionTranslateNeurons(76, 15, 19);
  assert.ok(low > 1000 && high < 2200, `band ${low.toFixed(0)}-${high.toFixed(0)}N/run`);
  assert.ok(low > N.main, `translation floor ${low.toFixed(0)}N exceeds the 70B main script ${N.main.toFixed(0)}N`);
});

test("translation-inclusive model is consistent with Nov 5 exhaustion, but does not prove it", () => {
  // Two successful runs (base + translations) plus ch2's failed attempt:
  const successRun = N.main + N.news70 + N.titles + captionTranslateNeurons(80, 15, 15);
  const ch2Failed = N.main * 2 + N.titles + N.topup; // main + one quality retry + top-up, no captions
  const throughCh2 = 2 * successRun + ch2Failed;
  // Honest bound: this model reaches only ~7k by the end of ch2's failure - the 429 fired
  // during run 3 of 4, so run 3's own start (main script + explainer + titles ~1,100N)
  // plus retry amplification and any heavier old-code scene counts close the gap.
  assert.ok(throughCh2 > 6000, `2 successes + ch2 failure ~= ${throughCh2.toFixed(0)}N - translations roughly double the pre-correction model`);
  const plusCh3Start = throughCh2 + N.main + N.news70 + N.titles;
  assert.ok(plusCh3Start > 7500, `with run 3's start ~= ${plusCh3Start.toFixed(0)}N - exhaustion during run 3 plausible, exact crossover unproven until H1 logs real usage`);
});

test("H3 honest ceiling: second round costs ~170N itself, translations dominate its real cost", () => {
  // +1 8B call, ENFORCED bounds: prompt <= ~2,400 tokens (base prompt + <=79 covered-opening
  // lines x ~11 tokens), output hard-capped by topupMaxTokens(30) = 4,500 tokens.
  const callCeiling = neurons("8b", 2400, 4500);
  assert.ok(callCeiling < 200, `8B call ceiling ${callCeiling.toFixed(0)}N`);
  // Downstream, ENFORCED: <=30 added scenes -> <= 30 x 15 = 450 m2m100 caption calls,
  // at 12-55 words/scene.
  const addedLow = captionTranslateNeurons(30, 15, 12);
  const addedHigh = captionTranslateNeurons(30, 15, 55);
  const totalLow = callCeiling + addedLow;
  const totalHigh = callCeiling + addedHigh;
  assert.ok(totalLow > 500 && totalLow < 1200, `likely rescue-day add ${totalLow.toFixed(0)}N`);
  assert.ok(totalHigh < 2500, `worst-case rescue-day add ${totalHigh.toFixed(0)}N stays inside one run's share`);
  // The rescue-day add applies ONLY on days ch2 needs a second round - not a daily cost.
});
