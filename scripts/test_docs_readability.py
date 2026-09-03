import unittest

from docs_readability import (
    extract_prose,
    flesch_kincaid_grade,
    unlinked_terms,
)

PAGE = """<html><body>
<nav>Skip this navigation text entirely because it is not prose</nav>
<main>
  <p>{body}</p>
  <figure><figcaption>Also not prose, ignore this caption</figcaption></figure>
  <pre><code>CIN,1,,00000000,,,0,1,0</code></pre>
</main>
</body></html>"""


def page(body: str) -> str:
    return PAGE.format(body=body)


class ExtractProseTests(unittest.TestCase):
    def test_strips_navigation_figures_and_code(self) -> None:
        """Only <main> prose is scored.

        Navigation and code are not sentences. Leaving them in makes a page
        look harder or easier than it actually reads -- a wire-protocol code
        sample is full of one-syllable tokens and would drag the grade down.
        """
        prose = extract_prose(page("The scanner stops on a signal."))
        self.assertIn("The scanner stops on a signal.", prose)
        self.assertNotIn("navigation", prose)
        self.assertNotIn("caption", prose)
        self.assertNotIn("CIN", prose)


    def test_tables_are_not_prose(self) -> None:
        """REGRESSION GUARD: a table has no sentence punctuation, so flattening
        one produces a single enormous pseudo-sentence.

        troubleshooting.html measured grade 9.3 and looked like the hardest page
        in the guide. Four keyboard-shortcut tables were being read as run-on
        prose; excluding them puts it at 8.0. The page was never the problem --
        the measurement was, and I nearly rewrote perfectly good prose to satisfy
        a broken number.
        """
        with_table = """<html><body><main>
          <p>Press escape to close a panel.</p>
          <table><tr><td>Esc</td><td>Close any open panel or dialog</td></tr>
          <tr><td>Ctrl/S</td><td>Scan resume scanning</td></tr></table>
        </main></body></html>"""
        prose = extract_prose(with_table)
        self.assertIn("Press escape", prose)
        self.assertNotIn("Ctrl", prose)


class GradeTests(unittest.TestCase):
    def test_short_plain_sentences_score_lower_than_long_tangled_ones(self) -> None:
        """The metric has to move in the right direction, or the ceiling is noise."""
        plain = extract_prose(page("The app shows a hit. You can hold on it. It is easy."))
        tangled = extract_prose(
            page(
                "Notwithstanding the aforementioned considerations, the "
                "application subsequently demonstrates transmissions whose "
                "characteristics necessitate additional interpretation."
            )
        )
        plain_grade = flesch_kincaid_grade(plain)[0]
        tangled_grade = flesch_kincaid_grade(tangled)[0]
        self.assertLess(plain_grade, tangled_grade)

    def test_returns_none_without_prose(self) -> None:
        self.assertIsNone(flesch_kincaid_grade(""))


class JargonTests(unittest.TestCase):
    def test_an_opaque_term_without_a_link_is_reported(self) -> None:
        self.assertIn("squelch", unlinked_terms(page("Turn the squelch up.")))

    def test_an_opaque_term_with_a_link_is_not(self) -> None:
        linked = page('Turn the <a href="glossary.html#squelch">squelch</a> up.')
        self.assertNotIn("squelch", unlinked_terms(linked))

    def test_an_ordinary_word_is_not_treated_as_jargon(self) -> None:
        """`hold`, `delay` and `draft` are glossary entries AND ordinary English.

        Requiring a link on every use produces noise nobody reads, and a check
        nobody trusts gets deleted. Only genuinely opaque terms are required.
        """
        self.assertEqual(unlinked_terms(page("Hold the delay in a draft.")), [])

    def test_a_link_elsewhere_on_the_page_counts(self) -> None:
        """Define-on-FIRST-use. One link per page is the bar, not one per mention."""
        twice = page(
            'The <a href="glossary.html#squelch">squelch</a> is a gate. '
            "Raise the squelch to hear less."
        )
        self.assertNotIn("squelch", unlinked_terms(twice))

    def test_navigation_and_pagination_are_not_prose(self) -> None:
        """REGRESSION GUARD: the first version of the checker searched the whole
        `<main>` body and reported "Close Call" as unlinked on three pages where
        it appears only in the sidebar nav and the Next/Previous footer.

        Three false positives out of four findings. A check that cries wolf is
        one people learn to ignore, which is worse than no check at all.
        """
        nav_only = """<html><body><main>
          <p>Nothing opaque in this sentence at all.</p>
          <nav><a href="close-call.html">Close Call</a></nav>
        </main></body></html>"""
        self.assertEqual(unlinked_terms(nav_only), [])

    def test_a_heading_alone_does_not_demand_a_link(self) -> None:
        """A section titled "Close Call" is not an unexplained use of the term."""
        heading_only = """<html><body><main>
          <h2>Close Call</h2><p>It watches for nearby transmitters.</p>
        </main></body></html>"""
        self.assertEqual(unlinked_terms(heading_only), [])

    def test_prose_still_reports_when_nav_is_present(self) -> None:
        """The paired half: stripping nav must not strip the finding.

        Without this, a checker that returned [] unconditionally would pass
        both guards above.
        """
        both = """<html><body><main>
          <p>Turn the squelch up until the hiss stops.</p>
          <nav><a href="close-call.html">Close Call</a></nav>
        </main></body></html>"""
        self.assertIn("squelch", unlinked_terms(both))

    def test_substrings_do_not_match(self) -> None:
        """`dcs` must not fire on `dcses` or a word that merely contains it."""
        self.assertEqual(unlinked_terms(page("The abcdcsx value is unrelated.")), [])


if __name__ == "__main__":
    unittest.main()
