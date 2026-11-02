"""Run with the same optional JiWER environment as whisper-fallback-score.py."""
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location("score", Path(__file__).with_name("whisper-fallback-score.py"))
score = module_from_spec(spec)
spec.loader.exec_module(score)


class ScoringTests(unittest.TestCase):
    def test_deletion_counts(self):
        result = score.counts("cat sat on mat", "cat sat mat")
        self.assertEqual((result["errors"], result["deletions"], result["wer"]), (1, 1, .25))

    def test_substitution_and_insertion(self):
        result = score.counts("cat sat", "cat ran away")
        self.assertEqual((result["substitutions"], result["insertions"], result["wer"]), (1, 1, 1))

    def test_explicit_literal_normalization(self):
        self.assertEqual(score.normalize('Tim-tim, “Virtual”'), "tim tim virtual")
        self.assertNotEqual(score.normalize("25"), score.normalize("twenty five"))

    def test_empty_hypothesis_keeps_missing_words(self):
        result = score.counts("dua peserta", "")
        self.assertEqual((result["errors"], result["deletions"], result["wer"]), (2, 2, 1))


if __name__ == "__main__":
    unittest.main()
