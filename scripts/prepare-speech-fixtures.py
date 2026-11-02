"""Download two CC-BY-4.0 FLEURS test clips without downloading full archives."""
import csv, io, json, tarfile, urllib.request, struct
from pathlib import Path
root=Path('artifacts/speech');root.mkdir(parents=True,exist_ok=True)
manifest=[]
filenames={'id_id':'10000183170391984234.wav','en_us':'1003119935936341070.wav'}
for language in ['id_id','en_us']:
    base=f'https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/{language}'
    rows={row[1]:row for row in csv.reader(io.StringIO(urllib.request.urlopen(base+'/test.tsv',timeout=45).read().decode()),delimiter='\t')}
    response=urllib.request.urlopen(base+'/audio/test.tar.gz',timeout=90)
    with tarfile.open(fileobj=response,mode='r|gz') as archive:
        for member in archive:
            if not member.name.endswith('.wav'):continue
            name=Path(member.name).name
            if name!=filenames[language] or name not in rows:continue
            content=archive.extractfile(member).read()
            offset=12;rate=16000;byte_rate=64000;pcm=b''
            while offset+8<=len(content):
                kind=content[offset:offset+4];size=struct.unpack_from('<I',content,offset+4)[0];payload=content[offset+8:offset+8+size]
                if kind==b'fmt ':rate=struct.unpack_from('<I',payload,4)[0];byte_rate=struct.unpack_from('<I',payload,8)[0]
                if kind==b'data':pcm=payload
                offset+=8+size+(size%2)
            duration=len(pcm)/byte_rate
            if not 4<=duration<=12:continue
            dest=root/f'{language}.wav';dest.write_bytes(content)
            manifest.append({'id':language,'file':str(dest),'seconds':duration,'reference':rows[name][2],'source':base+'/audio/test.tar.gz','original':name,'license':'CC-BY-4.0','dataset':'Google FLEURS'})
            print(language,duration,rows[name][2],flush=True);break
    response.close()
(root/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
# Construct a language-switch test from the two public clips; not natural code-switching speech.
parts=[]
for entry in manifest:
    content=Path(entry['file']).read_bytes();offset=12
    while offset+8<=len(content):
        kind=content[offset:offset+4];size=struct.unpack_from('<I',content,offset+4)[0];payload=content[offset+8:offset+8+size]
        if kind==b'fmt ':fmt=payload
        if kind==b'data':parts.append(payload)
        offset+=8+size+(size%2)
normalized=[]
for part in parts:
    values=struct.unpack('<'+'f'*(len(part)//4),part)
    gain=.5/max(abs(v) for v in values)
    normalized.append(struct.pack('<'+'f'*len(values),*(v*gain for v in values)))
pcm=normalized[0]+b'\0'*(16000*4//2)+normalized[1]
body=b'WAVE'+b'fmt '+struct.pack('<I',len(fmt))+fmt+b'data'+struct.pack('<I',len(pcm))+pcm
mixed=root/'mixed.wav';mixed.write_bytes(b'RIFF'+struct.pack('<I',len(body))+body)
manifest.append({'id':'mixed-sequence','file':str(mixed),'seconds':sum(e['seconds'] for e in manifest)+.5,'reference':' '.join(e['reference'] for e in manifest),'license':'CC-BY-4.0','dataset':'Google FLEURS; concatenated test clips, Indonesian then English; each clip peak-normalized to 0.5'})
(root/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
# Continuous speech stress fixture: trim boundary silence and repeat the same attributed clip.
continuous_pcm=parts[0][int(.45*16000)*4:int(7*16000)*4]*4
body=b'WAVE'+b'fmt '+struct.pack('<I',len(fmt))+fmt+b'data'+struct.pack('<I',len(continuous_pcm))+continuous_pcm
continuous=root/'continuous.wav';continuous.write_bytes(b'RIFF'+struct.pack('<I',len(body))+body)
manifest.append({'id':'continuous','file':str(continuous),'seconds':len(continuous_pcm)/64000,'reference':'Derived repeated/truncated Indonesian clip; stress test, not a verbatim accuracy target.','license':'CC-BY-4.0','dataset':'Google FLEURS; original id_id clip trimmed to 0.45–7.00 seconds and repeated four times'})
(root/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
