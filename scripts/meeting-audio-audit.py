"""Local intake and signal checks. No transcript, speech labels, or training claims.
Requires NumPy and imageio-ffmpeg; never modifies the original recordings.
"""
import hashlib
import json
import subprocess
import sys
import re
from pathlib import Path

import numpy as np
import imageio_ffmpeg

source = Path(sys.argv[1] if len(sys.argv) > 1 else 'training:meeting').resolve()
dest = Path(sys.argv[2] if len(sys.argv) > 2 else 'artifacts/meeting-baseline').resolve()
dest.mkdir(parents=True, exist_ok=True)
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
report = dict(kind='local-meeting-intake', sampleRate=16000,
              scope='Decoded exported Opus; not bit-identical live Whisper PCM. Energy is not speech detection. No verified reference transcript.',
              scriptHash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              ffmpegVersion=subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0],
              tracks={})
arrays = {}
for role in ['tab', 'microphone', 'combined']:
    files = sorted(source.glob('*-' + role + '.webm'))
    if len(files) != 1:
        raise ValueError(f'Expected exactly one {role} file; found {len(files)}')
    original = files[0]
    pcm = dest / (role + '.f32')
    probe = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(original)], capture_output=True, text=True)
    channels = re.search(r'Audio:.*?, \d+ Hz, (stereo|mono)', probe.stderr)
    if not channels:
        raise ValueError('Unsupported input channel layout; review before downmixing')
    layout = channels.group(1)
    # Web Audio speakers interpretation uses (L+R)/2. FFmpeg's implicit -ac 1
    # can use different weights, so make this comparison conversion explicit.
    filters = ['-af', 'pan=mono|c0=0.5*c0+0.5*c1'] if layout == 'stereo' else []
    run = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', str(original),
                          '-map', '0:a:0', '-vn', *filters, '-ac', '1', '-ar', '16000',
                          '-c:a', 'pcm_f32le', '-f', 'f32le', str(pcm)], capture_output=True, text=True)
    (dest / (role + '.decode.log')).write_text(run.stderr)
    if run.returncode:
        raise RuntimeError(f'FFmpeg failed for {role}; see local decode log')
    audio = np.memmap(pcm, dtype='<f4', mode='r')
    arrays[role] = audio
    rms = [float(np.sqrt(np.mean(audio[i:i+1600].astype(np.float64)**2))) for i in range(0, len(audio), 1600)]
    report['tracks'][role] = dict(
        original=str(original), bytes=original.stat().st_size,
        inputChannelLayout=layout, downmix='(L+R)/2' if layout=='stereo' else 'mono identity',
        sha256=hashlib.sha256(original.read_bytes()).hexdigest(), pcm=str(pcm),
        pcmSha256=hashlib.sha256(pcm.read_bytes()).hexdigest(), samples=len(audio),
        seconds=len(audio)/16000, nonFinite=int(np.sum(~np.isfinite(audio))),
        samplesAtOrAboveOne=int(np.sum(np.abs(audio) >= 1)), peak=float(np.max(np.abs(audio))),
        rms=float(np.sqrt(np.mean(audio.astype(np.float64)**2))),
        rms100ms=rms, energyThresholdDbfs=-40,
        energyActiveSeconds=sum(x>=.01 for x in rms)/10,
        digitalZeroSeconds=float(np.sum(audio==0))/16000,
    )
    print(role, round(len(audio)/16000, 3), 'seconds', flush=True)


def align(reference, other, limit=8000):
    """FFT correlation, full-window norm; positive lag delays other to reference."""
    n = min(len(reference), len(other))
    a, b = np.asarray(reference[:n], dtype=np.float64), np.asarray(other[:n], dtype=np.float64)
    a -= a.mean(); b -= b.mean()
    if np.linalg.norm(a)*np.linalg.norm(b) < 1e-9:
        return dict(lagSamples=0, lagMs=0, correlation=0)
    size = 1 << (2*n-1).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(a, size)*np.conj(np.fft.rfft(b, size)), size)
    limit = min(limit, n-1)
    lags = np.arange(-limit, limit+1)
    values = correlation[lags % size] / (np.linalg.norm(a)*np.linalg.norm(b))
    best = int(np.argmax(np.abs(values)))
    return dict(lagSamples=int(lags[best]), lagMs=float(lags[best])/16, correlation=float(values[best]))


length = min(len(a) for a in arrays.values())
report['durationSpreadMs'] = (max(len(a) for a in arrays.values())-length)/16
# Preselect non-overlapping 8s clips by energy only, before looking at ASR text.
# Distinguish source activity; never present these energy categories as speakers.
windows=[]
for at in range(0, length-8*16000+1, 8*16000):
    energy={role:float(np.sqrt(np.mean(a[at:at+8*16000].astype(np.float64)**2))) for role,a in arrays.items()}
    windows.append(dict(startSample=at,startSeconds=at/16000,endSeconds=at/16000+8,rms=energy))
selected=[]
rules=[('tab-dominant',lambda x:x['rms']['tab']/(x['rms']['microphone']+.001)),
       ('microphone-dominant',lambda x:x['rms']['microphone']/(x['rms']['tab']+.001)),
       ('both-active',lambda x:min(x['rms']['tab'],x['rms']['microphone']))]
for category, key in rules:
    eligible=[x for x in windows if x['startSample'] not in {s['startSample'] for s in selected} and max(x['rms'].values())>=.01]
    for window in sorted(eligible,key=key,reverse=True)[:2]:
        selected.append(dict(category=category,**window))
selected.sort(key=lambda x:x['startSample'])
report['pilotSelection'] = selected
report['signalChecks']=[]
for window in selected:
    at=window['startSample']; n=8*16000
    parts={role:a[at:at+n] for role,a in arrays.items()}
    mix=(parts['tab']+parts['microphone'])*.5
    check=dict(startSeconds=at/16000,sourceCrossCorrelation=align(parts['tab'],parts['microphone']),
               mixedAgainstExpected=align(parts['combined'],mix))
    check['combinedAgainstTab']=align(parts['combined'],parts['tab'])
    check['combinedAgainstMicrophone']=align(parts['combined'],parts['microphone'])
    lag=check['mixedAgainstExpected']['lagSamples']
    # Align source prediction with combined before estimating linear gains.
    if lag>=0:
        y=parts['combined'][lag:]; t=parts['tab'][:n-lag]; m=parts['microphone'][:n-lag]
    else:
        y=parts['combined'][:n+lag]; t=parts['tab'][-lag:]; m=parts['microphone'][-lag:]
    matrix=np.column_stack([t,m,np.ones(len(y))])
    coefficients, _, _, _=np.linalg.lstsq(matrix,y,rcond=None)
    residual=y-matrix@coefficients
    variance=np.sum((y-y.mean())**2)
    check['fittedGains']=dict(tab=float(coefficients[0]),microphone=float(coefficients[1]),offset=float(coefficients[2]))
    check['rSquared']=float(1-np.sum(residual**2)/variance) if variance>1e-12 else None
    # Each independent MediaRecorder path can have a distinct codec/timeline
    # offset. A single lag cannot align two differently delayed sources.
    lag_t=check['combinedAgainstTab']['lagSamples']
    lag_m=check['combinedAgainstMicrophone']['lagSamples']
    lo=max(0,lag_t,lag_m); hi=min(n,n+lag_t,n+lag_m)
    y=np.asarray(parts['combined'][lo:hi],dtype=np.float64)
    t=parts['tab'][lo-lag_t:hi-lag_t]; m=parts['microphone'][lo-lag_m:hi-lag_m]
    matrix=np.column_stack([t,m,np.ones(len(y))])
    coefficients, _, _, _=np.linalg.lstsq(matrix,y,rcond=None)
    variance=np.sum((y-y.mean())**2)
    check['independentlyAlignedFit']=dict(
        tabGain=float(coefficients[0]),microphoneGain=float(coefficients[1]),
        rSquared=float(1-np.sum((y-matrix@coefficients)**2)/variance) if variance>1e-12 else None,
        limitation='Weak/inactive sources have unreliable correlation lags and gain estimates; Opus and channel downmix differ between files.')
    report['signalChecks'].append(check)
    # Persist lossless, aligned-in-file-time pilot samples for paired ASR replay.
    for role, audio in parts.items():
        (dest / f'{int(at/16000):04d}-{role}.f32').write_bytes(audio.tobytes())
report['holdout']=dict(policy='All unselected audio reserved from this pilot; no training or tuning performed.',
                      selectedSeconds=len(selected)*8,totalSeconds=length/16000)
(dest/'intake.json').write_text(json.dumps(report,indent=2))
print('Saved',dest/'intake.json',flush=True)
