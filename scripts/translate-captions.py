#!/usr/bin/env python3
"""Local caption translation via Argos Translate (open-source, runs on the runner CPU).
Replaces the per-line Workers AI m2m100 calls for caption tracks, so translated
captions cost zero neurons. Reads {"lines": [...], "lang": "es"} on stdin, writes
{"lines": [...]} on stdout (same order, empty lines pass through untranslated -
same skip rule as the m2m100 path's Sep 23 empty-line fix).

NO ENGLISH-AS-TRANSLATION: a line that stays garbled or untranslated after
MAX_ATTEMPTS attempts fails the WHOLE language track (exit 2, JSON error on stderr:
{"error", "line_index", "lang"}). The caller records that language as an explicit
recoverable failure instead of uploading a track containing English or corrupt text.

Quality guards (evidence: 2026-11-06 offline matrix + stability runs over all 15
pairs): Argos/CTranslate2 occasionally emits DEGENERATE output - runaway repetition
("的这个的这个...", "BBBB...", "の 、 、"), or the source echoed back untranslated
(production m2m100 does this systematically: 60% of ja lines in the community-post
draft corpus). These garbles are nondeterministic near-tie beam flips, so each
flagged line is retried (fresh decode each attempt) before the track is failed.
Semantic hallucinations at normal length cannot be string-detected - stated
residual risk, same model class as m2m100.
"""
import sys, json, re
from collections import Counter

MAX_ATTEMPTS = 4  # first try + 3 retries; garbles observed to be nondeterministic

def _repeated_substring_flood(text):
    # Catches CJK garbles like "的这个的这个..." where tokens are not space-separated.
    # A real flood DOMINATES the output (the repeated unit covers most of the text);
    # short natural substrings ("e " in Romance languages) repeat legitimately, so
    # presence alone is not enough - require coverage of at least half the output.
    for n in (2, 3, 4):
        for i in range(0, max(0, len(text) - n * 4)):
            sub = text[i:i + n]
            if sub.strip() and text.count(sub) >= 4 and text.count(sub) * n * 2 >= len(text):
                return True
    return False

def looks_garbled(source, out):
    """True when a translation shows a degenerate pattern. Conservative: only flags
    patterns that are never a legitimate translation of a caption line."""
    if not out:
        return True
    src = (source or "").strip()
    # Length blowup (same rule as the m2m100 path's runaway guard).
    if len(out) > max(200, len(src) * 3):
        return True
    # Any single character repeated 10+ times in a row ("BBBB...").
    if re.search(r"(.)\1{9,}", out, re.S):
        return True
    # Space-separated token flooding ("の 、 、 、 ...").
    toks = out.split()
    if len(toks) >= 6:
        word, count = Counter(toks).most_common(1)[0]
        if count >= max(5, len(toks) // 2):
            return True
    # Short-substring flooding for unsegmented scripts (short caption lines only).
    if len(out) >= 30 and _repeated_substring_flood(out):
        return True
    # SRT structure injection would corrupt the caption file's timing blocks.
    if "-->" in out:
        return True
    # Echoed back untranslated: identical non-trivial English line. Lines dominated by
    # proper nouns/brand terms are allowed to round-trip (a real translation can leave
    # "Bitcoin Standard" unchanged), so count only lowercase content words.
    if src and out == src and len(re.findall(r"\b[a-z]{4,}", src)) >= 3:
        return True
    return False

def main():
    req = json.load(sys.stdin)
    lines = req["lines"]
    lang = req["lang"]
    from argostranslate import translate as argos_translate
    installed = {l.code: l for l in argos_translate.get_installed_languages()}
    pkg_translation = installed["en"].get_translation(installed[lang])
    out = []
    for idx, line in enumerate(lines):
        if not line or not str(line).strip():
            out.append(line or "")
            continue
        result = None
        for attempt in range(MAX_ATTEMPTS):
            if attempt > 0:
                # Retries run on a FRESH engine instance: garbles correlate within a
                # process (near-tie beam state), so same-process retry alone is weak.
                pkg_translation.translator = None
            candidate = pkg_translation.translate(line).strip()
            # A translated caption must be one line of display text; normalize any
            # embedded newlines so the SRT block structure cannot be broken.
            candidate = " ".join(candidate.split())
            if not looks_garbled(line, candidate):
                result = candidate
                break
            result = None  # retry: garbles observed to be nondeterministic
        if result is None:
            json.dump({"error": "persistent garbled/untranslated line after retries",
                       "line_index": idx, "lang": lang}, sys.stderr)
            sys.stderr.write("\n")
            sys.exit(2)
        out.append(result)
    json.dump({"lines": out}, sys.stdout, ensure_ascii=False)

if __name__ == "__main__":
    main()
