"""Capped phase timing of the existing requests-based upload path.

Key is accepted through stdin only. Socket writes are client-side boundaries,
not proof that a server has received the upload. No references are transmitted.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import ssl
import sys
import time
from unittest.mock import patch
import http.client
import requests
import urllib3.connection

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('asr-deepinfra-benchmark.py'))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


def run(key, output):
    manifest = baseline.verify()
    clips = {c['id']: c for c in manifest['clips']}
    order = ['424:combined', '792:combined', '864:combined'] * 2
    report = dict(kind='deepinfra-overhead', complete=False, createdAt=time.time(),
                  maxRequests=6, automaticRetries=0, model=baseline.MODEL,
                  sourceHash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  referenceHash=manifest['referenceHash'], results=[],
                  notes='Prepared exact float32 WAV, serial shared requests.Session. Socket-write completion is not server receipt. Post-send wait includes remaining upload transit, service work/queue, inference, and response transit.')
    session = requests.Session()
    session.headers['Authorization'] = 'Bearer ' + key
    current = None
    started = None
    original_dns = socket.getaddrinfo
    original_tcp = socket.socket.connect
    original_tls = ssl.SSLContext.wrap_socket
    original_connect = urllib3.connection.HTTPSConnection.connect
    original_send = http.client.HTTPConnection.send

    def timed(name, function, *args, **kwargs):
        begin = time.perf_counter()
        try:
            return function(*args, **kwargs)
        finally:
            if current is not None:
                current['events'].append(dict(stage=name, startMs=(begin-started)*1000,
                                              endMs=(time.perf_counter()-started)*1000))

    def dns(*args, **kwargs):
        return timed('dns', original_dns, *args, **kwargs)

    def tcp(instance, *args, **kwargs):
        return timed('tcpConnect', original_tcp, instance, *args, **kwargs)

    def tls(instance, *args, **kwargs):
        return timed('tlsWrapHandshake', original_tls, instance, *args, **kwargs)

    def connect(instance, *args, **kwargs):
        return timed('connectionSetup', original_connect, instance, *args, **kwargs)

    def send(instance, data):
        stage = 'sendHeadersIncludingPossibleConnect' if isinstance(data, bytes) and data.startswith(b'POST ') else 'sendBody'
        return timed(stage, original_send, instance, data)

    with patch.object(socket, 'getaddrinfo', dns), patch.object(socket.socket, 'connect', tcp), \
         patch.object(ssl.SSLContext, 'wrap_socket', tls), \
         patch.object(urllib3.connection.HTTPSConnection, 'connect', connect), \
         patch.object(http.client.HTTPConnection, 'send', send):
        for clip_id in order:
            clip = clips[clip_id]
            row = dict(id=clip_id, attempt=len(report['results'])+1, events=[])
            current = row
            started = time.perf_counter()
            try:
                audio = (baseline.BUNDLE / clip['audio']).read_bytes()
                request = requests.Request('POST', baseline.URL, files={'audio': ('excerpt.wav', audio, 'audio/wav')})
                prepared = session.prepare_request(request)
                row['preparationMs'] = (time.perf_counter()-started)*1000
                row['requestBodyBytes'] = len(prepared.body)
                response = session.send(prepared, stream=True, timeout=(10,45), allow_redirects=False)
                row['headersReceivedMs'] = (time.perf_counter()-started)*1000
                row['httpStatus'] = response.status_code
                row['responseHeaders'] = {k:v for k,v in response.headers.items() if k.lower() in ['server','connection','via','cf-ray','content-length','server-timing']}
                content = response.content
                row['bodyReceivedMs'] = (time.perf_counter()-started)*1000
                if response.status_code == 200:
                    payload = json.loads(content)
                    if not isinstance(payload.get('text'), str):
                        raise ValueError('schema')
                    row['providerRuntimeMs'] = payload.get('inference_status', {}).get('runtime_ms')
                    row['providerCostUsd'] = payload.get('inference_status', {}).get('cost')
                    row['providerRequestId'] = payload.get('request_id')
                    baseline.save(output / f"response-{row['attempt']:02d}.json", payload, key)
                else:
                    row['error'] = 'HTTP ' + str(response.status_code)
                response.close()
            except requests.RequestException as error:
                row['error'] = type(error).__name__
            except (ValueError, TypeError):
                row['error'] = 'Malformed response'
            row['totalMs'] = (time.perf_counter()-started)*1000
            current = None
            def durations(name):
                return sum(e['endMs']-e['startMs'] for e in row['events'] if e['stage']==name)
            sends = [e for e in row['events'] if e['stage']=='sendBody']
            row['phases'] = dict(dnsMs=durations('dns'), tcpConnectMs=durations('tcpConnect'),
                tlsHandshakeMs=durations('tlsWrapHandshake'), connectionSetupMs=durations('connectionSetup'),
                bodySocketWriteMs=durations('sendBody'), connectionReused=not any(e['stage']=='connectionSetup' for e in row['events']))
            if sends and row.get('headersReceivedMs'):
                row['phases']['afterBodyWriteToHeadersMs'] = row['headersReceivedMs'] - max(e['endMs'] for e in sends)
            if row.get('headersReceivedMs') and row.get('bodyReceivedMs'):
                row['phases']['responseBodyReadMs'] = row['bodyReceivedMs'] - row['headersReceivedMs']
            report['results'].append(row)
            baseline.save(output / 'run.json', report, key)
            print(json.dumps({k:row[k] for k in ['attempt','id','totalMs','phases']}), flush=True)
            if row.get('error') or sum(r.get('providerCostUsd') or 0 for r in report['results']) >= .10:
                break
    session.close()
    report['complete'] = len(report['results'])==6 and not any(r.get('error') for r in report['results'])
    report['verifiedAfter'] = baseline.verify()['referenceHash'] == report['referenceHash']
    baseline.save(output / 'run.json', report, key)
    return report


if __name__ == '__main__':
    baseline.verify()
    print('Waiting for API key on stdin (terminal echo must be disabled).', flush=True)
    credential = sys.stdin.readline().strip()
    if not credential:
        raise SystemExit('No credential supplied; zero requests made')
    folder = ROOT / 'artifacts/deepinfra-overhead' / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    folder.mkdir(parents=True, exist_ok=False)
    run(credential, folder)
    print('Saved: ' + str(folder), flush=True)
