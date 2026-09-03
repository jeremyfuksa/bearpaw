#!/usr/bin/env python3
"""Hold the end-user guide to a reading level and a jargon budget.

Two measurements, because one alone is misleading.

**Reading level** (Flesch-Kincaid) catches sentences that are too long or too
tangled. Plain-language standards target grade 8-9 for a general audience; most
software documentation lands at 12-14.

**Jargon linking** catches what Flesch-Kincaid structurally cannot see.
"Squelch" is two syllables and scores as easy prose; to a scanner user who is
not a ham operator it is opaque. A readability score can be excellent while the
page is unreadable to its actual audience, so the second check asks a different
question: when the guide uses a term the glossary defines, does it send the
reader there?

Only OPAQUE terms are required to link. "Hold", "delay" and "draft" are also
glossary entries, but they are ordinary English first and demanding a link on
every use would produce noise nobody reads -- and a check nobody trusts gets
deleted.

Usage:
    python3 scripts/docs_readability.py            # report
    python3 scripts/docs_readability.py --check    # non-zero exit on a failure
"""

from __future__ import annotations

import argparse
import glob
import re
import sys
from pathlib import Path

# Grade ceiling for the guide. Measured at 7.7 weighted mean when this was
# written, so the ceiling is a ratchet against regression, not a stretch goal.
MAX_GRADE = 8.5

# Terms a reader cannot reasonably infer. Every one of these must link to its
# glossary entry the first time a page uses it.
#
# Deliberately NOT here: bank, delay, draft, hit, hold, priority, sync, upload.
# Those are ordinary words in context, and requiring a link on each would bury
# the real findings.
OPAQUE = {
    "alpha tag": "alpha-tag",
    "close call": "close-call",
    "ctcss": "ctcss--tone--dcs",
    "dcs": "ctcss--tone--dcs",
    "modulation": "modulation",
    "rssi": "rssi",
    "squelch": "squelch",
    "memory sync": "memory-sync",
    "lockout": "lockout",
}

GUIDE = "site/docs/*.html"
GLOSSARY = "glossary.html"
VOWELS = "aeiouy"


def count_syllables(word: str) -> int:
    """Approximate syllable count. Good enough for relative comparison."""
    w = word.lower().strip(".,;:!?()\"'")
    if not w:
        return 0
    total, prev_vowel = 0, False
    for ch in w:
        is_vowel = ch in VOWELS
        if is_vowel and not prev_vowel:
            total += 1
        prev_vowel = is_vowel
    if w.endswith("e") and total > 1:
        total -= 1
    return max(total, 1)


def extract_prose(html: str) -> str:
    """The prose a reader actually reads.

    Navigation, code samples and figure captions are stripped: they are not
    sentences, and leaving them in makes a page look harder or easier than it
    reads.
    """
    html = re.sub(
        r"<(script|style|nav|aside|figure|code|pre|table)[^>]*>.*?</\1>",
        " ",
        html,
        flags=re.S | re.I,
    )
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    main = re.search(r"<main[^>]*>(.*?)</main>", html, flags=re.S | re.I)
    if main:
        html = main.group(1)
    html = re.sub(r"<[^>]+>", " ", html)
    for entity, plain in (
        ("&amp;", "&"),
        ("&nbsp;", " "),
        ("&mdash;", "-"),
        ("&rarr;", ""),
        ("&larr;", ""),
        ("&#8217;", "'"),
    ):
        html = html.replace(entity, plain)
    return re.sub(r"\s+", " ", html).strip()


def flesch_kincaid_grade(text: str) -> tuple[float, int, int] | None:
    """Grade level, word count, sentence count. None when there is no prose."""
    sentences = [s for s in re.split(r"[.!?]+(?:\s|$)", text) if len(s.split()) > 2]
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    if not sentences or not words:
        return None
    syllables = sum(count_syllables(w) for w in words)
    words_per_sentence = len(words) / len(sentences)
    syllables_per_word = syllables / len(words)
    grade = 0.39 * words_per_sentence + 11.8 * syllables_per_word - 15.59
    return grade, len(words), len(sentences)


def body_of(html: str) -> str:
    main = re.search(r"<main[^>]*>(.*?)</main>", html, flags=re.S | re.I)
    return main.group(1) if main else html


def unlinked_terms(html: str) -> list[str]:
    """Opaque terms used in PROSE without a link to the glossary.

    Navigation, pagination, figure captions, headings and existing link text
    are all excluded. The first version of this searched the whole `<main>`
    body and reported "Close Call" as unlinked on pages where it appears only
    in the sidebar nav and the Next/Previous footer -- three false positives
    out of four findings.

    That matters more than the wasted effort: a check that cries wolf is a
    check people learn to ignore, and then it is worse than no check. Any term
    already inside an anchor is satisfied too -- a reader who can click through
    to a fuller explanation has been served, even if the target is another
    guide page rather than the glossary.
    """
    body = body_of(html)
    linked = set(re.findall(r"glossary\.html#([\w-]+)", body))

    prose = re.sub(
        r"<(nav|aside|figure|figcaption|h1|h2|h3|a)[^>]*>.*?</\1>",
        " ",
        body,
        flags=re.S | re.I,
    )
    prose = re.sub(r"<[^>]+>", " ", prose).lower()

    missing = []
    for term, slug in sorted(OPAQUE.items()):
        pattern = r"\b" + re.escape(term).replace(r"\ ", r"\s+") + r"\b"
        if re.search(pattern, prose) and slug not in linked:
            missing.append(term)
    return missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero when a page exceeds the grade ceiling or leaves an opaque term unlinked",
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    pages = sorted(glob.glob(str(args.root / GUIDE)))
    if not pages:
        print(f"no guide pages found at {args.root / GUIDE}", file=sys.stderr)
        return 1

    failures: list[str] = []
    rows = []
    total_words = 0
    weighted_grade = 0.0

    for path in pages:
        name = Path(path).name
        html = Path(path).read_text(encoding="utf-8")
        measured = flesch_kincaid_grade(extract_prose(html))
        if measured is None:
            continue
        grade, words, sentences = measured
        # The glossary defines the terms; it does not need to link to itself.
        missing = [] if name == GLOSSARY else unlinked_terms(html)

        total_words += words
        weighted_grade += grade * words
        rows.append((name, words, sentences, grade, missing))

        if grade > MAX_GRADE:
            failures.append(f"{name}: grade {grade:.1f} exceeds the {MAX_GRADE} ceiling")
        if missing:
            failures.append(f"{name}: unlinked glossary terms: {', '.join(missing)}")

    print(f"{'page':<26}{'words':>7}{'grade':>7}  unlinked")
    print("-" * 62)
    for name, words, _sentences, grade, missing in sorted(rows, key=lambda r: -r[3]):
        flag = "!" if grade > MAX_GRADE else " "
        print(f"{name:<26}{words:>7}{grade:>7.1f}{flag} {', '.join(missing)}")
    print("-" * 62)
    print(f"{'WEIGHTED MEAN':<26}{total_words:>7}{weighted_grade / total_words:>7.1f}")
    print(f"\nceiling: grade {MAX_GRADE}; opaque terms tracked: {len(set(OPAQUE.values()))}")

    if not args.check:
        return 0
    if failures:
        print("\nFAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("\ndocs readability check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
