"""Isolated paid Qwen 0.6B benchmark; key from stdin, never persisted.

Uploads only the frozen reviewed WAVs, without transcripts or prompts.
Three serial passes, maximum 54 attempts, no automatic retries.
"""
import argparse
import hashlib
import io
import json
import platform
import random
import struct
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / 'training:meeting/verified-excerpts-v1-76136748b154'
MODEL = 'Qwen/Qwen3-ASR-0.6B'
URL = 'https://api.deepinfra.com/v1/inference/' + MODEL


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify():
    manifest = json.loads((BUNDLE / 'manifest.json').read_bytes())
    assert manifest['referenceHash'] == sha((BUNDLE / 'reference.json').read_bytes())
    for file in manifest['files']:
        assert sha((BUNDLE / file['path']).read_bytes()) == file['sha256'], file['path']
    assert len(manifest['clips']) == 18
    for clip in manifest['clips']:
        pcm = (BUNDLE / clip['pcm']).read_bytes()
        wav = (BUNDLE / clip['audio']).read_bytes()
        assert sha(pcm) == clip['inputHash']
        assert wav[:4] == b'RIFF' and wav[8:12] == b'WAVE'
        # Existing review WAVs are IEEE float32 wrappers around exact PCM bytes.
        assert struct.unpack_from('<H', wav, 20)[0] == 3
        assert struct.unpack_from('<I', wav, 24)[0] == 16000
        assert wav[44:] == pcm
    return manifest


def save(path, value, key=''):
    data = json.dumps(value, ensure_ascii=False, indent=2)
    if key and key in data:
        raise RuntimeError('Credential persistence blocked')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(data)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--passes', type=int, choices=[1, 2, 3], default=3)
    args = parser.parse_args()
    manifest = verify()
    print('Frozen corpus verified: 18 exact float32 WAVs; no reference text sent.', flush=True)
    if args.dry_run:
        print(json.dumps(dict(model=MODEL, attempts=18 * args.passes,
                             uploadedAudioSeconds=144 * args.passes,
                             estimatedListCostUsd=144 * args.passes / 60 * .00020)))
        return
    destination = ROOT / 'artifacts/deepinfra-qwen' / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    destination.mkdir(parents=True, exist_ok=False)
    print('Waiting for API key on stdin (no echo).', flush=True)
    key = sys.stdin.readline().strip()
    if not key or len(key) < 16:
        raise RuntimeError('Missing API key')
    report = dict(kind='deepinfra-qwen-frozen-benchmark', model=MODEL, endpoint=URL,
                  createdAt=time.time(), complete=False, maxAttempts=18 * args.passes,
                  automaticRetries=0, passCount=args.passes, referenceHash=manifest['referenceHash'],
                  manifestHash=sha((BUNDLE / 'manifest.json').read_bytes()),
                  scriptHash=sha(Path(__file__).read_bytes()),
                  machine=dict(platform=platform.platform(), python=platform.python_version()),
                  recipe=dict(audio='unchanged IEEE float32 WAV, 16kHz mono',
                              parameters='provider defaults; audio only; no language hint/prompt',
                              connection='one requests.Session, serial; no automatic retry',
                              timeout='10s connect, 45s read', orderSeed=6025),
                  timingDefinition='Complete prepared WAV through complete parsed JSON on this machine; excludes audio collection, LLM, UI and a deployed service relay. headersMs includes upload/server wait, not isolated inference.',
                  scope='18 representations of six periods from one meeting; no Mandarin validation',
                  results=[], responseArtifacts=[])
    output = destination / 'run.json'
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + key
    fatal = False
    for pass_number in range(1, args.passes + 1):
        clips = list(manifest['clips'])
        if pass_number > 1:
            random.Random(6025 + pass_number).shuffle(clips)
        for clip in clips:
            assert len(report['results']) < report['maxAttempts']
            row = dict(id=clip['id'], role=clip['role'], startSeconds=clip['startSeconds'],
                       endSeconds=clip['endSeconds'], inputStats={'sha256': clip['inputHash']},
                       wavHash=sha((BUNDLE / clip['audio']).read_bytes()),
                       passNumber=pass_number, attemptNumber=len(report['results']) + 1,
                       startedAt=time.time())
            started = time.perf_counter()
            try:
                with (BUNDLE / clip['audio']).open('rb') as audio:
                    response = session.post(URL, files={'audio': ('excerpt.wav', audio, 'audio/wav')},
                                            timeout=(10, 45), stream=True, allow_redirects=False)
                row['headersMs'] = (time.perf_counter() - started) * 1000
                row['httpStatus'] = response.status_code
                content = response.content
                row['bodyCompleteMs'] = (time.perf_counter() - started) * 1000
                row['responseBytes'] = len(content)
                if response.status_code != 200:
                    row['error'] = 'HTTP ' + str(response.status_code)
                    # Never print or persist an arbitrary provider error body.
                    fatal = response.status_code in [400, 401, 402, 403, 404, 422]
                else:
                    payload = json.loads(content)
                    if not isinstance(payload, dict) or not isinstance(payload.get('text'), str):
                        row['error'] = 'Response schema missing text string'
                        fatal = True
                    else:
                        elapsed = (time.perf_counter() - started) * 1000
                        row['result'] = dict(type='RESULT', text=payload['text'],
                                             language=payload.get('language', 'unreported'), inferenceMs=elapsed)
                        status = payload.get('inference_status') or {}
                        row['providerRuntimeMs'] = status.get('runtime_ms')
                        row['providerCostUsd'] = status.get('cost')
                        row['providerInputLengthMs'] = payload.get('input_length_ms')
                        row['providerRequestId'] = payload.get('request_id')
                        name = f"response-{row['attemptNumber']:02d}.json"
                        save(destination / name, payload, key)
                        report['responseArtifacts'].append(dict(path=name, sha256=sha((destination / name).read_bytes())))
                response.close()
            except requests.RequestException as error:
                row['error'] = type(error).__name__
            except (ValueError, TypeError):
                row['error'] = 'Malformed provider JSON'
                fatal = True
            row['wallMs'] = (time.perf_counter() - started) * 1000
            report['results'].append(row)
            save(output, report, key)
            print(f"pass {pass_number} {clip['id']} {row.get('httpStatus', 'network')} {row['wallMs']:.0f}ms {'error' if row.get('error') else 'ok'}", flush=True)
            costs = [r.get('providerCostUsd') for r in report['results']]
            known = sum(c for c in costs if isinstance(c, (float, int)))
            if fatal or known >= .10:
                fatal = True
                break
        if fatal:
            break
        if pass_number < args.passes:
            time.sleep(3)
    session.close()
    report['finishedAt'] = time.time()
    report['complete'] = len(report['results']) == report['maxAttempts'] and not any(r.get('error') for r in report['results'])
    report['frozenCorpusVerifiedAfter'] = verify()['referenceHash'] == manifest['referenceHash']
    save(output, report, key)
    print('Saved local run: ' + str(output), flush=True)


if __name__ == '__main__':
    main()
