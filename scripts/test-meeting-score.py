"""Run with the optional JiWER environment; uses only synthetic references."""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('meeting_score', Path(__file__).with_name('meeting-reference-score.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReferenceScoringTests(unittest.TestCase):
    def setUp(self):
        self.pilot = json.dumps({'results': [
            {'startSeconds': 8, 'role': 'combined', 'inputStats': {'sha256': 'samples'},
             'result': {'type': 'RESULT', 'text': 'paling nanya masyarakat', 'inferenceMs': 100, 'language': 'id'}}
        ]}).encode()
        self.ref = dict(pilotHash=hashlib.sha256(self.pilot).hexdigest(), annotations=[
            dict(id='8:combined', inputHash='samples', status='speech', text='paling nanya mas anam')])

    def call(self):
        return module.score(self.pilot, json.dumps(self.ref).encode())

    def test_reference_controls_scoring_without_rewriting_names(self):
        result = self.call()
        self.assertEqual(result['groups']['combined']['referenceWords'], 4)
        self.assertEqual(result['groups']['combined']['errors'], 2)
        self.assertEqual(result['speech'][0]['reference'], 'paling nanya mas anam')

    def test_wrong_pilot_or_audio_rejected(self):
        self.ref['pilotHash'] = 'different'
        with self.assertRaises(ValueError): self.call()
        self.ref['pilotHash'] = hashlib.sha256(self.pilot).hexdigest()
        self.ref['annotations'][0]['inputHash'] = 'different'
        with self.assertRaises(ValueError): self.call()

    def test_pending_and_uncertain_not_scored(self):
        for status in ['pending', 'uncertain']:
            self.ref['annotations'][0]['status'] = status
            result = self.call()
            self.assertEqual(result['groups']['combined']['speechClips'], 0)
            self.assertEqual(result['pending'], ['8:combined'])

    def test_no_speech_not_hidden_in_word_denominator(self):
        self.ref['annotations'][0].update(status='no-speech', text='')
        result = self.call()
        self.assertEqual(len(result['noSpeech']), 1)
        self.assertEqual(result['groups']['combined']['referenceWords'], 0)
        self.assertTrue(result['noSpeech'][0]['rawNonempty'])

    def test_extra_or_duplicate_ids_rejected(self):
        self.ref['annotations'].append(dict(self.ref['annotations'][0]))
        with self.assertRaises(ValueError): self.call()
        self.ref['annotations'][1]['id'] = 'unrelated'
        with self.assertRaises(ValueError): self.call()


if __name__ == '__main__': unittest.main()
