// Offline full-video-path validation harness (fixture run, network-disabled).
// Mode "short": tiny scenes -> the 510s duration invariant must throw BEFORE any upload.
// Mode "long":  ~12s scenes -> full path runs to a mocked publish with a real final.mp4.
// Proves artifact/gate/editorial ordering under fixtures; says nothing about live model behavior.
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const MODE = ["long", "voiceless"].includes(process.env.FIXTURE_MODE) ? process.env.FIXTURE_MODE : "short";
const REPO = process.env.FIXTURE_REPO || "/tmp/hdl-youtube-agent";
const ASSETS = process.env.FIXTURE_ASSETS || "/tmp/fullpath/assets";
const RUN_DIR = process.cwd();
const BUILD_DIR = path.join(RUN_DIR, "build");

process.env.CHANNEL_ID = "2";
process.env.PUBLISH_HOUR_UTC = "16";
process.env.PUBLISH_MINUTE_UTC = "0";
process.env.PEXELS_API_KEY = "fixture-pexels-key";
process.env.CF_ACCOUNT_ID = "fixture-account";
process.env.CF_API_TOKEN = "fixture-token";
process.env.UNSPLASH_ACCESS_KEY = "fixture-unsplash-key";
process.env.HDL_CHANNEL_2_URL = "";

const clipBuf = fs.readFileSync(path.join(ASSETS, "clip.mp4"));
const photoBuf = fs.readFileSync(path.join(ASSETS, "photo.jpg"));
const musicBuf = fs.readFileSync(path.join(ASSETS, "sincerely.mp3"));

const logs = { error: [], warn: [] };
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { logs[level].push(a.map(String).join(" ")); orig(...a); };
}

const blockedHosts = [];
const cfCalls = [];
const ytCalls = [];

const A = ["Morning light","A quiet room","Slow breathing","Gentle focus","Steady practice","Small habits","Calm attention","Simple rituals","Patient effort","Daily rhythm","Soft footsteps","Clear intention"];
const B = ["changes","softens","steadies","reshapes","brightens","settles","carries","opens"];
const C = ["the way the whole afternoon unfolds","the mood of the entire day","how the next hour feels","the rhythm of ordinary moments","the tone of everything that follows","the shape of a busy week"];
const D = ["each small moment builds on the last","the pattern repeats and then slowly shifts","the pause gives the next step more room","the ordinary detail starts to matter more","the quiet parts carry the meaning forward","the simple choice keeps echoing ahead","a gentle start protects the rest","attention settles where it is placed","little rituals hold the day together","the slowest part often matters most","steady repetition quietly becomes ease","one calm breath invites the next"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function sceneLine(i) {
  const head = `${A[i % 12]} ${B[i % 8]} ${C[i % 6]}.`;
  if (MODE === "short") return head;
  return `${head} ${cap(D[i % 12])}, and ${D[(i * 5 + 3) % 12]}, while ${D[(i * 7 + 5) % 12]} again.`;
}
const VISUALS = ["person writing notes at a desk","hands pouring tea in a kitchen","someone walking through a quiet park","a person reading near a window","hands arranging flowers in a vase","someone stretching in morning light","a person journaling at a table","someone watering plants at home"];

const TRENDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>slow mornings</title><ht:approx_traffic>20,000+</ht:approx_traffic>
<ht:news_item><ht:news_item_title>Slow mornings are having a moment</ht:news_item_title><ht:news_item_url>https://fixture.local/news1</ht:news_item_url><ht:news_item_source>Fixture News</ht:news_item_source></ht:news_item></item>
</channel></rss>`;

const NEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title>Slow mornings are having a moment - Fixture News</title><link>https://fixture.local/n1</link><source>Fixture News</source><pubDate>Tue, 04 Nov 2026 05:00:00 GMT</pubDate></item>
<item><title>Why slow mornings appeal to tired workers - Daily Fixture</title><link>https://fixture.local/n2</link><source>Daily Fixture</source><pubDate>Tue, 04 Nov 2026 04:00:00 GMT</pubDate></item>
<item><title>The slow mornings trend grows on social platforms - Fixture Times</title><link>https://fixture.local/n3</link><source>Fixture Times</source><pubDate>Mon, 03 Nov 2026 22:00:00 GMT</pubDate></item>
<item><title>Slow mornings reshape weekend routines - Weekly Fixture</title><link>https://fixture.local/n4</link><source>Weekly Fixture</source><pubDate>Mon, 03 Nov 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

function jsonRes(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

let pexelsCall = 0;
const ytMock = {
  uploadVideo: async (args) => { ytCalls.push({ fn: "uploadVideo", title: args?.title, privacy: args?.privacyStatus, publishAt: args?.publishAt ?? null }); return { id: `fixturevid${String(ytCalls.filter((c) => c.fn === "uploadVideo").length).padStart(3, "0")}` }; },
  uploadThumbnail: async () => { ytCalls.push({ fn: "uploadThumbnail" }); return {}; },
  addVideoToPlaylist: async () => { ytCalls.push({ fn: "addVideoToPlaylist" }); return {}; },
  publishVideo: async (a) => { ytCalls.push({ fn: "publishVideo", id: a?.videoId ?? a?.id ?? null }); return {}; },
  uploadCaptionTrack: async (a) => { ytCalls.push({ fn: "uploadCaptionTrack", lang: a?.language }); return {}; },
  checkVideoTrainability: async () => { ytCalls.push({ fn: "checkVideoTrainability" }); return ["all"]; },
  isQuotaLatched: async () => false,
};

const mockFetch = async (url, opts = {}) => {
  const u = String(url);
  const host = new URL(u).host;
  if (host === "api.cloudflare.com") {
    const body = JSON.parse(opts.body);
    const model = decodeURIComponent(u.split("/").pop());
    const props = body.response_format?.json_schema?.properties;
    const kind = props?.scenes ? "scenes" : props?.choice ? "choice" : model.includes("m2m100") ? "translate" : "text";
    cfCalls.push({ model, kind });
    let result;
    if (kind === "translate") {
      result = { translated_text: "Texto fijo de accesorio para pruebas sin red" };
    } else if (kind === "scenes") {
      const n = props.scenes.minItems; // smallest schema-legal count keeps the fixture minimal
      result = { response: { scenes: Array.from({ length: n }, (_, i) => ({ line: sceneLine(i), visual: VISUALS[i % VISUALS.length] })) } };
    } else if (kind === "choice") {
      result = { response: { choice: 1, fit: 9, tie_in: "The term mirrors the topic as a gentle everyday analogy." } };
    } else {
      result = { response: "A Quiet Fixture Title For Calm Mornings" };
    }
    return jsonRes({ success: true, result });
  }
  if (u.startsWith("https://api.pexels.com/videos/search")) {
    pexelsCall++;
    const base = pexelsCall * 1000;
    return jsonRes({ videos: Array.from({ length: 8 }, (_, j) => ({
      id: 900000 + base + j,
      video_files: [
        { link: "https://fixture.local/clip_hd.mp4", width: 1920, height: 1080, file_type: "video/mp4" },
        { link: "https://fixture.local/clip_sd.mp4", width: 1280, height: 720, file_type: "video/mp4" },
        { link: "https://fixture.local/clip_low.mp4", width: 640, height: 360, file_type: "video/mp4" },
      ],
    })) });
  }
  if (host === "fixture.local") {
    if (u.includes("clip_")) return new Response(clipBuf, { status: 200, headers: { "content-type": "video/mp4" } });
    if (u.includes("photo")) return new Response(photoBuf, { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response("{}", { status: 200 });
  }
  if (host === "trends.google.com") return new Response(TRENDS_XML, { status: 200 });
  if (host === "news.google.com") return new Response(NEWS_XML, { status: 200 });
  if (host === "incompetech.com") {
    if (u.endsWith("pieces.json")) return jsonRes([{ title: "Sincerely", filename: "sincerely.mp3" }, { title: "Wholesome", filename: "wholesome.mp3" }]);
    return new Response(musicBuf, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }
  if (u.startsWith("https://api.unsplash.com/search/photos")) {
    return jsonRes({ results: [1, 2].map((n) => ({
      id: `fx${n}`,
      urls: { regular: `https://fixture.local/photo${n}.jpg` },
      links: { download_location: `https://fixture.local/dl${n}` },
      user: { name: "Fixture Photographer", links: { html: "https://fixture.local/u/fx" } },
    })) });
  }
  blockedHosts.push(u);
  throw new Error(`network disabled in fixture run: ${u}`);
};

before(async () => {
  // Real network is allowed ONLY here: one-time Kokoro model download + synth warm-up,
  // so the fixture run itself can prove zero external calls.
  // "voiceless" mode mocks voice.js entirely (deterministic forced failures), so no real
  // TTS/model download is needed at all.
  if (MODE === "voiceless") return;
  const voice = await import(path.join(REPO, "scripts", "voice.js"));
  await voice.synthesizeVoice("Warming up the local speech model for an offline fixture run.", path.join(ASSETS, "warm.mp3"));
}, { timeout: 600000 });

test(`offline full video path, ${MODE} fixtures`, async (t) => {
  mock.module("node-fetch", { defaultExport: mockFetch });
  mock.module(path.join(REPO, "scripts", "youtube.js"), { namedExports: ytMock });
  if (MODE === "voiceless") {
    // Deterministic forced voice failures: 3 of every 5 scenes (60%, well above the 20%
    // threshold) throw; healthy scenes get a pregenerated 13s wav so probeDuration and the
    // scene mix behave exactly as with real TTS. No Kokoro/Fish involved.
    let voiceCall = 0;
    const healthyWav = path.join(ASSETS, "healthy_13s.wav");
    mock.module(path.join(REPO, "scripts", "voice.js"), {
      namedExports: {
        pickTodaysVoice: () => "af_heart",
        synthesizeVoice: async (_text, outPath) => {
          voiceCall++;
          const slot = voiceCall % 5;
          if (slot === 1 || slot === 2 || slot === 3) {
            throw new Error("fixture: forced voice failure for pre-publish gate test");
          }
          fs.copyFileSync(healthyWav, outPath);
          return outPath;
        },
      },
    });
  }
  globalThis.fetch = mockFetch;

  await import(path.join(REPO, "scripts", "generate-video.js"));

  const deadline = Date.now() + 28 * 60 * 1000;
  const manifestFiles = () => fs.readdirSync(RUN_DIR).filter((f) => /^videos-manifest.*\.json$/.test(f));
  const manifestHasFixture = () => manifestFiles().some((f) => fs.readFileSync(path.join(RUN_DIR, f), "utf8").includes("fixturevid"));
  while (Date.now() < deadline) {
    const errs = logs.error.join("\n");
    if (MODE === "short" && errs.includes("Duration invariant violated")) break;
    if (MODE === "long" && (manifestHasFixture() || /Error/.test(errs))) break;
    if (MODE === "voiceless" && (errs.includes("holding the video and Short PRIVATE") || manifestHasFixture())) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const scriptExitCode = process.exitCode ?? 0;
  process.exitCode = 0; // the script's own exit code is evidence, not the harness's verdict

  const errText = logs.error.join("\n");
  const evidence = { mode: MODE, scriptExitCode, cfCalls, ytCalls, blockedHosts, errors: logs.error.slice(0, 30), warns: logs.warn.slice(0, 60) };
  fs.writeFileSync(path.join(RUN_DIR, "fixture-evidence.json"), JSON.stringify(evidence, null, 2));

  assert.deepEqual(blockedHosts.filter((h) => /huggingface|cdn-lfs|fish\.audio|api\.cloudflare/.test(h)), [], "no model/TTS/cloud network access during fixture run");

  if (MODE === "short") {
    assert.match(errText, /Duration invariant violated/, "duration gate must throw");
    assert.equal(scriptExitCode, 1, "script exits nonzero");
    assert.equal(ytCalls.length, 0, `zero YouTube calls on the fail-closed path, got ${JSON.stringify(ytCalls)}`);
    assert.equal(manifestFiles().length, 0, "no manifest entry written before the gate");
    const scenes = fs.readdirSync(BUILD_DIR).filter((f) => /^scene_\d+\.mp4$/.test(f));
    assert.ok(scenes.length >= 30, `rendered scenes exist before the gate (got ${scenes.length})`);
    assert.ok(cfCalls.some((c) => c.kind === "scenes" && c.model.includes("70b")), "main script call observed (mocked 70B)");
  } else if (MODE === "voiceless") {
    // The pre-publish voiceless gate must fail the run BEFORE any publishVideo call, while
    // leaving the private uploads/captions/thumbnails in place (ordering preserved).
    assert.equal(scriptExitCode, 1, "gate fails the run nonzero");
    assert.match(errText, /holding the video and Short PRIVATE/, "pre-publish gate threw");
    const seq = ytCalls.map((c) => c.fn);
    assert.equal(seq.filter((f) => f === "publishVideo").length, 0, `ZERO publish calls expected, got ${JSON.stringify(seq)}`);
    const uploads = ytCalls.filter((c) => c.fn === "uploadVideo");
    assert.equal(uploads.length, 2, `exactly 2 uploads (main + Short), got ${uploads.length}`);
    assert.ok(uploads.every((u) => u.privacy === "private"), `ALL uploads must be PRIVATE, got ${JSON.stringify(uploads.map((u) => u.privacy))}`);
    const captionTracks = seq.filter((f) => f === "uploadCaptionTrack").length;
    assert.equal(captionTracks, 20, `exactly 20 caption tracks (16 main + 4 Short) attached before the gate, got ${captionTracks}`);
    assert.ok(seq.indexOf("uploadVideo") > -1 && seq.indexOf("publishVideo") === -1, "ordering preserved and nothing published");
    assert.ok(!manifestHasFixture(), "no manifest entry for an unpublished video");
    assert.match(logs.warn.join("\n"), /have no narration/, "voiceless count still logged");
  } else {
    assert.equal(scriptExitCode, 0, `happy path exits zero; errors: ${errText.slice(0, 800)}`);
    assert.ok(manifestHasFixture(), "manifest records the fixture upload");
    const seq = ytCalls.map((c) => c.fn);
    assert.ok(seq.indexOf("uploadVideo") > -1 && seq.indexOf("publishVideo") > seq.indexOf("uploadVideo"), "upload precedes publish");
    assert.ok(seq.filter((f) => f === "uploadCaptionTrack").length >= 16, `16 caption tracks uploaded (en + 15), got ${seq.filter((f) => f === "uploadCaptionTrack").length}`);
    assert.ok(seq.filter((f) => f === "uploadVideo").length >= 2, "main video plus Short uploaded");
    const finalPath = path.join(BUILD_DIR, "final.mp4");
    assert.ok(fs.existsSync(finalPath), "final.mp4 rendered");
    const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${finalPath}"`).toString().trim());
    assert.ok(dur >= 510, `final.mp4 clears the 510s floor (got ${dur.toFixed(1)}s)`);
    assert.ok(fs.readdirSync(path.join(BUILD_DIR, "qc")).length >= 1, "QC stills extracted");
    assert.ok(cfCalls.some((c) => c.kind === "translate"), "m2m100 translations exercised (mocked)");
  }
  console.log(`EVIDENCE_SUMMARY ${JSON.stringify({ mode: MODE, scriptExitCode, cfCalls: cfCalls.length, ytCalls: ytCalls.length, blocked: blockedHosts.length })}`);
}, { timeout: 30 * 60 * 1000 });
