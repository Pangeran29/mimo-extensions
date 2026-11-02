"""Offline checks for the paid benchmark's request and safety boundaries."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).with_name('asr-deepinfra-benchmark.py'))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class Response:
    status_code = 200
    content = json.dumps(dict(text='sample', language='en', input_length_ms=8000,
                              inference_status=dict(runtime_ms=100, cost=.00002664))).encode()

    def close(self):
        pass


class Session:
    def __init__(self, response):
        self.headers = {}
        self.calls = []
        self.response = response

    def post(self, url, **kwargs):
        assert url == benchmark.URL
        assert set(kwargs) == {'files', 'timeout', 'stream', 'allow_redirects'}
        assert set(kwargs['files']) == {'audio'}
        audio = kwargs['files']['audio'][1].read()
        assert audio.startswith(b'RIFF')
        self.calls.append(len(audio))
        return self.response

    def close(self):
        pass


class BenchmarkTest(unittest.TestCase):
    def exercise(self, response):
        session = Session(response)
        credential = 'dummy-offline-credential-12345'
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(benchmark, 'ROOT', Path(folder)), \
                 patch.object(benchmark.requests, 'Session', return_value=session), \
                 patch.object(benchmark.sys, 'stdin', io.StringIO(credential + '\n')), \
                 patch.object(benchmark.sys, 'argv', ['benchmark']), \
                 patch.object(benchmark.time, 'sleep'), \
                 contextlib.redirect_stdout(io.StringIO()):
                benchmark.main()
            reports = list(Path(folder).rglob('run.json'))
            self.assertEqual(len(reports), 1)
            for path in Path(folder).rglob('*.json'):
                self.assertNotIn(credential, path.read_text())
            return json.loads(reports[0].read_text()), session

    def test_cap_exact_audio_only_and_no_credential_persistence(self):
        report, session = self.exercise(Response())
        self.assertTrue(report['complete'])
        self.assertEqual(len(session.calls), 54)
        self.assertEqual(report['automaticRetries'], 0)
        self.assertTrue(report['frozenCorpusVerifiedAfter'])
        self.assertEqual(len({r['id'] for r in report['results']}), 18)

    def test_auth_error_stops_without_saving_arbitrary_body(self):
        response = Response()
        response.status_code = 401
        response.content = b'untrusted arbitrary error body'
        report, session = self.exercise(response)
        self.assertFalse(report['complete'])
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(report['responseArtifacts'], [])

    def test_bad_schema_stops(self):
        response = Response()
        response.content = b'{"unexpected": true}'
        report, session = self.exercise(response)
        self.assertEqual(len(session.calls), 1)
        self.assertIn('schema', report['results'][0]['error'])


if __name__ == '__main__':
    unittest.main()
