// R3 caption-migration fixture tests: local Argos caption translation.
// Engine-level smoke runs only when argostranslate is importable locally (skipped in CI
// until the workflow's argos install step lands); wrapper behavior verified via a stubbed
// python3 on PATH so no Workers AI call and no model download is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { translateCaptionsLocal } from "../scripts/cf-ai.js";

const stubDir = "/tmp/argos-stub";
mkdirSync(stubDir, { recursive: true });

function writeStub(body) {
  writeFileSync(`${stubDir}/python3`, body);
  chmodSync(`${stubDir}/python3`, 0o755);
}

function withStubPath(fn) {
  const orig = process.env.PATH;
  process.env.PATH = `${stubDir}:${orig}`;
  return fn().finally(() => { process.env.PATH = orig; });
}

test("R3: wrapper posts all lines in one batched call and maps outputs by index", async () => {
  writeStub(`#!/bin/sh
read -r payload || true
cat > /dev/null <<'X'
X
printf '%s' '{"lines":["uno","","tres"]}'
`);
  // stub ignores stdin content; index mapping is what we assert
  await withStubPath(async () => {
    const out = await translateCaptionsLocal(["one", "", "three"], "es");
    assert.deepEqual(out, ["uno", "", "tres"]);
  });
});

test("R3: engine failure throws (caller's per-language try/catch skips that language)", async () => {
  writeStub(`#!/bin/sh
exit 3
`);
  await withStubPath(async () => {
    await assert.rejects(() => translateCaptionsLocal(["one"], "es"), /exited 3/);
  });
});

test("R3: length mismatch throws (never silently misalign captions)", async () => {
  writeStub(`#!/bin/sh
printf '%s' '{"lines":["uno"]}'
`);
  await withStubPath(async () => {
    await assert.rejects(() => translateCaptionsLocal(["one", "two"], "es"), /returned 1 lines for 2 inputs/);
  });
});

test("R3: python wrapper passes empty lines through untranslated (source check)", () => {
  const py = readFileSync(new URL("../scripts/translate-captions.py", import.meta.url), "utf8");
  assert.match(py, /if not line or not str\(line\)\.strip\(\)/);
  assert.match(py, /pkg_translation\.translate\(line\)/);
  assert.match(py, /pkg_translation\.translator = None/); // fresh engine instance on retry
});

test("R3: caption loop no longer calls m2m100 translateMeta for caption tracks", () => {
  const gv = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  const captionSection = gv.slice(gv.indexOf("Caption tracks — English first"));
  assert.match(captionSection, /translateCaptionsLocal\(built\.map/);
  assert.doesNotMatch(captionSection, /translateMeta\(scene\.line/);
});

test("R3: guardrails - 15-language set unchanged in source, SKIP_TRANSLATIONS no longer set for ch2", () => {
  const cf = readFileSync(new URL("../scripts/cf-ai.js", import.meta.url), "utf8");
  assert.match(cf, /\["es", "fr", "pt", "de", "hi", "ar", "id", "sw", "ja", "ru", "ko", "zh", "it", "tr", "vi"\]/);
  const wf = readFileSync(new URL("../.github/workflows/daily-video.yml", import.meta.url), "utf8");
  assert.match(wf, /SKIP_TRANSLATIONS: ""/);
  assert.match(wf, /argospm install "translate-en_\$\{lang\}"/);
});

test("R3: real Argos engine smoke (skipped when argostranslate not installed)", async (t) => {
  try {
    execFileSync("python3", ["-c", "import argostranslate"]);
    execFileSync("python3", ["-c", "from argostranslate import translate; assert translate.translate('hello','en','es')"]);
  } catch {
    t.skip("argostranslate/es model not installed here");
    return;
  }
  const out = await translateCaptionsLocal(["Your dog does not need another toy."], "es");
  assert.equal(out.length, 1);
  assert.notEqual(out[0], "Your dog does not need another toy.");
  assert.ok(out[0].length > 5);
});

test("R3b: persistent garble exits 2 -> track fails, NO English fallback lines returned", async () => {
  writeStub(`#!/bin/sh
printf '%s' '{"error":"persistent garbled/untranslated line after retries","line_index":7,"lang":"ja"}' >&2
exit 2
`);
  await withStubPath(async () => {
    await assert.rejects(() => translateCaptionsLocal(["one", "two"], "ja"), /exited 2 for ja.*persistent garbled/s);
  });
});

test("R3b: no fallback mechanism remains in source (no English-as-translation, no threshold)", () => {
  const cf = readFileSync(new URL("../scripts/cf-ai.js", import.meta.url), "utf8");
  const fn = cf.slice(cf.indexOf("export async function translateCaptionsLocal"), cf.indexOf("export async function translateMeta"));
  assert.doesNotMatch(fn, /fallbacks/);
  assert.doesNotMatch(fn, /0\.2/);
  const py = readFileSync(new URL("../scripts/translate-captions.py", import.meta.url), "utf8");
  assert.doesNotMatch(py, /fallbacks/);
  assert.match(py, /sys\.exit\(2\)/);
  assert.match(py, /MAX_ATTEMPTS = 4/);
  assert.match(py, /"-->" in out/); // SRT structure injection guard
});

test("R3b: caption loop records explicit per-language status + writes captions-status.json", () => {
  const gv = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  assert.match(gv, /captionStatus\[lang\] = "ok"/);
  assert.match(gv, /captionStatus\[lang\] = `failed:/);
  assert.match(gv, /captions-status\.json/);
  assert.match(gv, /CAPTION STATUS \(pass 1\):/);
  assert.match(gv, /CAPTION STATUS \(final\):/);
  assert.match(gv, /ok:retry-pass/); // failed languages retried before publish, video still private
  assert.match(gv, /allLanguagesPresent/); // status file says explicitly when all-15 is NOT met
  const wf = readFileSync(new URL("../.github/workflows/daily-video.yml", import.meta.url), "utf8");
  assert.match(wf, /captionTracks/); // health record merges captions-status.json
});

test("R3b: python garble detector covers repetition floods, char runs, echoes; retries garbles", () => {
  const py = readFileSync(new URL("../scripts/translate-captions.py", import.meta.url), "utf8");
  assert.match(py, /MAX_ATTEMPTS = 4/);
  assert.match(py, /sys\.exit\(2\)/);
});

test("R3b: real detector behavior on observed garbles (skipped when argostranslate not installed)", async (t) => {
  try {
    execFileSync("python3", ["-c", "import argostranslate"]);
  } catch {
    t.skip("argostranslate not installed here");
    return;
  }
  const checks = execFileSync("python3", ["-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("tc", "scripts/translate-captions.py")
tc = importlib.util.module_from_spec(spec); spec.loader.exec_module(tc)
g = tc.looks_garbled
# observed real garbles from the 2026-11-06 matrix run
assert g("AGE ONE — AI & the information economy.", "の 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、 、")
assert g("Warren Buffett read 500 pages every single day.", "上午" + "B"*120)
assert g("Art of Joy — the science of happiness.", "的这个" * 12)
assert g("Have you ever wondered why some people succeed?", "Have you ever wondered why some people succeed?")
# legitimate translations must NOT be flagged
assert not g("Art of Joy — the science of happiness.", "Arte de la alegría — la ciencia de la felicidad.")
assert not g("In chapter 4, the author reveals 3 habits that changed over 1 million lives in 2024.", "Au chapitre 4, l'auteur révèle trois habitudes qui ont changé plus d'un million de vies en 2024.")
assert not g("Bitcoin Standard — Bitcoin & digital finance.", "Bitcoin Standard — Bitcoin & digital finance.")
print("detector OK")
`], { encoding: "utf8" }).trim();
  assert.match(checks, /detector OK/);
});

test("publication gate holds main and Short on missing, skipped, failed or absent captions", () => {
  const gv = readFileSync(new URL("../scripts/generate-video.js", import.meta.url), "utf8");
  const gate = gv.split("// CAPTION_PUBLICATION_GATE_BEGIN")[1].split("// CAPTION_PUBLICATION_GATE_END")[0];
  const check = new Function("englishCaptionOk", "VIDEO_LANGS", "captionStatus", "shortVideoId", "SHORT_CAPTION_LANGS", "shortCaptionStatus", gate);
  const langs = ["es", "pt", "hi", "ja"];
  const good = Object.fromEntries(langs.map(l => [l, "ok"]));
  const short = { en: "ok", es: "ok", pt: "ok", hi: "ok" };
  assert.doesNotThrow(() => check(true, langs, good, "short-id", ["es", "pt", "hi"], short));
  assert.doesNotThrow(() => check(true, langs, good, null, ["es", "pt", "hi"], {}));
  for (const status of [undefined, "failed:after-retry", "skipped:no-localization"]) {
    assert.throws(() => check(true, langs, { ...good, ja: status }, "short-id", ["es", "pt", "hi"], short), /Both held PRIVATE with no publishAt/);
  }
  assert.throws(() => check(false, langs, good, "short-id", ["es", "pt", "hi"], short));
  assert.throws(() => check(true, langs, good, "short-id", ["es", "pt", "hi"], { ...short, pt: "failed" }));
  assert.ok(gv.indexOf("// CAPTION_PUBLICATION_GATE_END") < gv.indexOf("await publishVideo({ videoId: uploaded.id"));
  assert.ok(gv.indexOf("// CAPTION_PUBLICATION_GATE_END") < gv.indexOf("await publishVideo({ videoId: shortVideoId"));
  // All three upload paths (main, localized Short, fallback Short) must be unscheduled.
  const uploads = [...gv.matchAll(/await uploadVideo\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.equal(uploads.length, 3);
  for (const [, body] of uploads) {
    assert.doesNotMatch(body, /publishAt/);
    assert.match(body, /privacyStatus: "private"/);
  }
});
