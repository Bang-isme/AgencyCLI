from __future__ import annotations

import sys
import unittest
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parents[1]
GATE_SCRIPTS = SKILLS_ROOT / "codex-execution-quality-gate" / "scripts"
sys.path.insert(0, str(GATE_SCRIPTS))

import output_guard  # noqa: E402


class OutputGuardPufferyTest(unittest.TestCase):
    """The output gate must treat self-congratulatory marketing puffery as
    generic filler — it is an 'amateur tell' with no evidence behind it."""

    def test_detects_marketing_puffery_phrases(self) -> None:
        text = (
            "This enterprise-grade, world-class platform is blazing fast and "
            "battle-tested — a truly best-in-class, cutting-edge solution."
        )
        hits = output_guard.find_generic_phrases(text)
        for phrase in ("enterprise-grade", "world-class", "blazing fast", "battle-tested", "best-in-class", "cutting-edge"):
            self.assertIn(phrase, hits, f"expected puffery phrase '{phrase}' to be flagged")

    def test_hyphen_and_space_variants_both_match(self) -> None:
        self.assertIn("blazing-fast", output_guard.find_generic_phrases("a blazing-fast index"))
        self.assertIn("lightning fast", output_guard.find_generic_phrases("lightning fast queries"))

    def test_puffery_fails_the_gate(self) -> None:
        # Two-plus generic hits force a fail regardless of other signal.
        report = output_guard.analyze_text_heuristic(
            "We built a world-class, enterprise-grade dashboard."
        )
        self.assertEqual(report["status"], "fail")
        self.assertGreaterEqual(report["counts"]["generic_phrases"], 2)

    def test_no_false_positive_on_grounded_technical_prose(self) -> None:
        # A concrete, evidence-bearing deliverable must not trip the puffery list.
        text = (
            "Decision: cache the catalog in `src/cache.ts`. Evidence: `pnpm test` "
            "passes 42 cases; p95 latency dropped from 180ms to 90ms. "
            "Next step: add an eviction cap in `src/cache.ts`."
        )
        hits = output_guard.find_generic_phrases(text)
        self.assertEqual(hits, [], f"unexpected filler flagged: {hits}")

    def test_enforces_anti_patterns_documented_in_reasoning_rigor(self) -> None:
        # Coupling: every anti-pattern phrase the codex-reasoning-rigor reference
        # teaches (references/anti-generic-patterns.md) must actually be detected
        # by the gate — the skill should enforce what it preaches.
        documented = [
            "follow best practices",
            "ensure scalability",
            "improve performance",
            "enhance maintainability",
            "robust solution",
            "seamless workflow",
            "optimize the process",
            "industry standard",
            "proper implementation",
            "best-in-class",
        ]
        for phrase in documented:
            self.assertTrue(
                output_guard.find_generic_phrases(f"We will {phrase} here."),
                f"documented anti-pattern '{phrase}' is not enforced by the gate",
            )

    def test_premium_design_vocabulary_is_not_flagged(self) -> None:
        # "premium" is legitimate design vocabulary (codex-design-system) and is
        # deliberately excluded from the puffery list.
        self.assertNotIn("premium", output_guard.find_generic_phrases("a premium dark palette"))


if __name__ == "__main__":
    unittest.main()
