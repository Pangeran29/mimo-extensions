"""Local frozen-clip comparison. Human references are only used for binding/scoring.

Qwen uses unmodified antirez/qwen-asr through asr-qwen-batch.c. Fun uses
the pinned QwenAudio/Fun-ASR model.py through the installed FunASR loader.
No hotwords, previous transcripts, reference words or hosted inference.
"""
import argparse
import hashlib
import json
import os
import pathlib
import resource
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORK = ROOT / 'artifacts/asr-replacement'
BUNDLE = ROOT / 'training:meeting/verified-excerpts-v1-76136748b154'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inputs():
    manifest = json.loads((BUNDLE / 'manifest.json').read_bytes())
    if sha((BUNDLE / 'reference.json').read_bytes()) != manifest['referenceHash']:
        raise ValueError('Frozen reference changed')
    for clip in manifest['clips']:
        if sha((BUNDLE / clip['pcm']).read_bytes()) != clip['inputHash']:
            raise ValueError('Frozen audio changed: ' + clip['id'])
    return manifest


def save(path, report):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    temp.replace(path)


def run(variant):
    manifest = inputs()
    output = WORK / (variant + '.json')
    if output.exists():
        raise FileExistsError('Refusing to overwrite results: ' + str(output))
    revisions = json.loads((WORK / 'candidate-revisions.json').read_text())
    index = {'qwen-0.6b': 0, 'qwen-1.7b': 1, 'fun-mlt': 2}[variant]
    checkpoint = revisions[index]
    model_dir = WORK / 'models' / checkpoint['model'].split('/')[-1]
    assets = json.loads((WORK/'upstream-file-hashes.json').read_text())[index]['files']
    verified_weights = []
    for asset in assets:
        if not asset['path'].endswith(('.safetensors', '.pt')):
            continue
        file = model_dir/asset['path']
        expected = asset['lfs']['sha256']
        digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
        if digest != expected or file.stat().st_size != asset['size']:
            raise ValueError('Checkpoint checksum mismatch: '+str(file))
        verified_weights.append(dict(path=asset['path'], sha256=digest, bytes=file.stat().st_size))
    report = dict(kind='asr-replacement-native', variant=variant, complete=False,
                  checkpoint=checkpoint, referenceHash=manifest['referenceHash'],
                  verifiedWeights=verified_weights,
                  swapBefore=subprocess.check_output(['sysctl', 'vm.swapusage'], text=True).strip(),
                  createdAt=time.time(), results=[],
                  scope='18 source representations from six periods of one meeting. Indonesian/English only; Mandarin not tested.',
                  latencyDefinition='Complete 8-second PCM already available. Resident-model serial inference, not live capture or visible notes.',
                  resourceDefinition='Process peak RSS (macOS bytes), CPU core-seconds. No GPU-memory measurement; no system-wide peak claim.',
                  runtimeSha=subprocess.check_output(['git', '-C', str(WORK/'vendor'/('qwen-asr' if index < 2 else 'fun-asr')), 'rev-parse', 'HEAD'], text=True).strip())
    save(output, report)
    try:
        if index < 2:
            # Native model's offline greedy defaults, 2048-token safety ceiling.
            report['decoding'] = dict(language='auto', prompt=None, hotwords=[],
                                      segmentSeconds=0, tokenCeiling=2048, threads=os.cpu_count(), device='cpu-accelerate')
            args = [str(WORK/'qwen-batch'), str(model_dir)] + [str(BUNDLE/c['pcm']) for c in manifest['clips']]
            with (WORK/(variant+'.stderr.log')).open('wb') as log:
                proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=log)
                try:
                    line = proc.stdout.readline().decode().strip().split('\t')
                    if line[0] != 'LOAD': raise RuntimeError('No LOAD header: '+repr(line))
                    report['load'] = dict(ms=float(line[1]), cpuSeconds=float(line[2]), peakRssBytes=int(line[3]))
                    save(output, report)
                    for clip in manifest['clips']:
                        head = proc.stdout.readline().decode().strip().split('\t')
                        if head[0] != 'RESULT': raise RuntimeError('No RESULT header: '+repr(head))
                        if int(head[1]) != len(report['results']): raise ValueError('Result order changed')
                        text = proc.stdout.read(int(head[8])).decode('utf-8')
                        if proc.stdout.read(1) != b'\n': raise ValueError('Bad result framing')
                        row = row_for(clip, text, float(head[2]))
                        row.update(cpuSeconds=float(head[3]), peakRssBytes=int(head[4]),
                                   textTokens=int(head[5]), encodeMs=float(head[6]), decodeMs=float(head[7]))
                        report['results'].append(row)
                        save(output, report)
                        print(variant, clip['id'], round(float(head[2])), 'ms', flush=True)
                    if proc.wait() != 0: raise RuntimeError('Native runtime failed')
                finally:
                    if proc.poll() is None: proc.terminate(); proc.wait()
        else:
            # Avoid any implicit hub fetch or upload during private inference.
            os.environ['HF_HUB_OFFLINE'] = '1'
            os.environ['TRANSFORMERS_OFFLINE'] = '1'
            import torch
            from funasr import AutoModel
            import numpy as np
            import importlib.util
            sys.path.insert(0, str(WORK/'vendor/fun-asr'))
            # HF local-path loading does not import remote_code in this FunASR
            # release. Explicitly import the pinned, maintained implementation.
            source = WORK/'vendor/fun-asr/model.py'
            spec = importlib.util.spec_from_file_location('meeting_fun_model', source)
            implementation = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = implementation
            spec.loader.exec_module(implementation)
            original_hook = implementation.FunASRNano.on_pretrained_model_loaded
            def audited_load(instance, loaded_keys):
                original_hook(instance, loaded_keys)
                missing = sorted(set(instance.state_dict()) - set(loaded_keys))
                # The upstream hook removes untrained optional CTC/timestamp
                # heads. Every remaining text-transcription tensor must load.
                instance._meeting_load_audit = dict(loadedTensorCount=len(loaded_keys),
                    missingTextTensors=missing, optionalCtcEnabled=instance.ctc_decoder is not None)
                if missing:
                    raise RuntimeError('Uninitialized transcription tensors: '+repr(missing[:10]))
            implementation.FunASRNano.on_pretrained_model_loaded = audited_load
            torch.set_num_threads(os.cpu_count())
            report['decoding'] = dict(language=None, hotwords=[], itn=False, maxLength=512,
                                      device='cpu', llmDtype='fp32', threads=os.cpu_count())
            # CPU/fp32 is an integration recipe, not the author's CUDA latency.
            t, c = time.perf_counter(), time.process_time()
            model = AutoModel(model=str(model_dir), trust_remote_code=True,
                              remote_code=str(WORK/'vendor/fun-asr/model.py'), device='cpu',
                              hub='hf', disable_update=True, llm_dtype='fp32',
                              llm_conf={'init_param_path': str(model_dir/'Qwen3-0.6B'), 'llm_dtype':'fp32'},
                              tokenizer_conf={'init_param_path': str(model_dir/'Qwen3-0.6B')})
            report['implementation'] = dict(path=str(source), sha256=sha(source.read_bytes()),
                                           checkpointAudit=model.model._meeting_load_audit)
            report['load'] = dict(ms=(time.perf_counter()-t)*1000, cpuSeconds=time.process_time()-c,
                                  peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
            save(output, report)
            with torch.inference_mode():
                for clip in manifest['clips']:
                    pcm = np.frombuffer((BUNDLE/clip['pcm']).read_bytes(), dtype='<f4').copy()
                    t, c = time.perf_counter(), time.process_time()
                    result = model.generate(input=torch.from_numpy(pcm), cache={}, batch_size=1, hotwords=[],
                                            language=None, itn=False, llm_dtype='fp32', max_length=512)
                    row = row_for(clip, result[0]['text'], (time.perf_counter()-t)*1000)
                    row.update(cpuSeconds=time.process_time()-c,
                               peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
                    report['results'].append(row); save(output, report)
                    print(variant, clip['id'], round(row['result']['inferenceMs']), 'ms', flush=True)
        report['complete'] = len(report['results']) == len(manifest['clips'])
    except Exception as error:
        report['runError'] = repr(error)
        raise
    finally:
        report['swapAfter'] = subprocess.check_output(['sysctl', 'vm.swapusage'], text=True).strip()
        save(output, report)


def row_for(clip, text, ms):
    return dict(role=clip['role'], startSeconds=clip['startSeconds'], endSeconds=clip['endSeconds'],
                inputStats={'sha256':clip['inputHash']},
                result=dict(type='RESULT', text=text, language='auto-unreported', inferenceMs=ms))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('variant', choices=['qwen-0.6b', 'qwen-1.7b', 'fun-mlt'])
    run(parser.parse_args().variant)
