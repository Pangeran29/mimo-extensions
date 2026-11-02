import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderEngine } from '../src/engine';
import * as db from '../src/db';
let tracks: FakeTrack[];
let graph: FakeNode[];
class FakeTrack { readyState = 'live'; onended: (()=>void) | null = null; stop = vi.fn(() => {this.readyState='ended';}); }
class FakeStream {
  track = new FakeTrack();
  constructor() { tracks.push(this.track); }
  getTracks() {return [this.track];} getAudioTracks() {return this.getTracks();}
}
class FakeNode {
  gain={value:1}; fftSize=256; channelCount=2; channelCountMode='max'; stream?: FakeStream;
  connections: FakeNode[]=[];
  constructor(public label='node') { graph.push(this); }
  connect(node: FakeNode) {this.connections.push(node);return node;}
  getFloatTimeDomainData(array: Float32Array) {array.fill(0.02);}
}
class FakeContext {
  destination = new FakeNode('speakers');
  resume=vi.fn(async()=>{}); close=vi.fn(async()=>{});
  createMediaStreamSource(stream: FakeStream) {return new FakeNode(tracks.indexOf(stream.track)===0?'tab':'mic');}
  createMediaStreamDestination() {const n=new FakeNode('mix'); n.stream=new FakeStream();return n;}
  createGain() {return new FakeNode('gain');} createAnalyser(){return new FakeNode('analyser');}
}
class FakeRecorder {
  static latest: FakeRecorder;
  static instances: FakeRecorder[] = [];
  static isTypeSupported=()=>true;
  state='inactive';
  ondataavailable?: (e:{data:Blob})=>void;
  onstop?: ()=>void;
  onerror?: ()=>void;
  constructor() {FakeRecorder.latest=this;FakeRecorder.instances.push(this);}
  start=vi.fn(()=>{this.state='recording';});
  stop=vi.fn(()=>{
    this.state='inactive';
    // Model the browser: final dataavailable is queued before onstop.
    queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['final'])});this.onstop?.();});
  });
}
let ready: ReturnType<typeof vi.fn>;
let engine: RecorderEngine;
beforeEach(()=>{
  tracks=[];graph=[];ready=vi.fn();FakeRecorder.instances=[];
  vi.stubGlobal('AudioContext',FakeContext);vi.stubGlobal('MediaRecorder',FakeRecorder);
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async()=>new FakeStream())}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:test'); vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  engine=new RecorderEngine(vi.fn(),ready);
});
afterEach(async()=>{
  for(const row of await db.sessions())await db.deleteSession(row.id);
  vi.restoreAllMocks();vi.unstubAllGlobals();
});
async function start(){await engine.start('stream',1,'YouTube');}
async function startLegacy(){
  await start();
  // Existing retained recordings predate the new bundle export policy.
  await db.updateSession((await engine.status()).session!.id,{exportKind:undefined});
}
async function finalized(){await vi.waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));return (await engine.status()).session!;}
describe('recording lifecycle',()=>{
  it('keeps the three streams isolated and retries only unfinished files',async()=>{
    await startLegacy();
    ['combined-','microphone-','tab-'].forEach((data,index)=>FakeRecorder.instances[index].ondataavailable?.({data:new Blob([data])}));
    engine.stop();const session=await finalized();
    for(const [source,expected] of [['mixed','combined-final'],['microphone','microphone-final'],['tab','tab-final']] as const){
      expect(await (await db.audioBlob(session.id,'audio/webm',source)).text()).toBe(expected);
    }
    await engine.export(session.id);await engine.downloadDone(session.id,true);
    expect((await db.getSession(session.id))?.savedSources).toEqual(['mixed']);
    const mic=await engine.export(session.id);expect(mic.session.filename).toContain('-microphone.webm');
    await engine.downloadDone(session.id,false,'Canceled');
    const recovered=new RecorderEngine(vi.fn(),vi.fn());
    expect((await recovered.export(session.id)).session.filename).toContain('-microphone.webm');
    await recovered.downloadDone(session.id,true);
    expect((await recovered.export(session.id)).session.filename).toContain('-tab.webm');
    await recovered.downloadDone(session.id,true);
    expect(await db.getSession(session.id)).toBeUndefined();
  });

  it('starts both sources and rejects duplicate starts',async()=>{
    await start();expect((await engine.status()).phase).toBe('recording');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    await expect(start()).rejects.toThrow('already active');
    engine.stop();await finalized();
  });
  it('routes tab playback to speakers without microphone monitoring',async()=>{
    await start();
    expect(graph.find(n=>n.label==='tab')!.connections.map(n=>n.label)).toContain('speakers');
    expect(graph.find(n=>n.label==='mic')!.connections.map(n=>n.label)).not.toContain('speakers');
    expect(graph.find(n=>n.label==='mix')!.channelCount).toBe(1);
    expect(graph.filter(n=>n.label==='gain').map(n=>n.gain.value)).toEqual([.5,.5]);
    engine.stop();await finalized();
  });
  it('waits for the final chunk, releases tracks and makes stop idempotent',async()=>{
    await start();FakeRecorder.instances[0].ondataavailable?.({data:new Blob(['first-'])});
    engine.stop();engine.stop();const session=await finalized();
    expect(await (await db.audioBlob(session.id,'audio/webm')).text()).toBe('first-final');
    expect(tracks.every(t=>t.stop.mock.calls.length===1)).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(3);
    FakeRecorder.instances.forEach(recorder=>expect(recorder.stop).toHaveBeenCalledTimes(1));
  });
  it('releases tab audio if microphone access fails; never records only one side',async()=>{
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(Error('tab unavailable'));
    await expect(start()).rejects.toThrow('could not start');
    expect((await engine.status()).phase).toBe('error');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(new FakeStream() as unknown as MediaStream).mockRejectedValueOnce(Error('mic blocked'));
    await expect(start()).rejects.toThrow('mic blocked');
    expect(tracks.every(t=>t.readyState==='ended')).toBe(true);
    expect(await db.sessions()).toHaveLength(0);
  });
  it('keeps audio after interrupted download, supports retry, and deletes only on success',async()=>{
    await startLegacy();engine.stop();const session=await finalized();
    await engine.export(session.id);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await engine.downloadDone(session.id,false,'Download canceled');
    expect((await engine.status()).phase).toBe('save-failed');
    expect((await db.getSession(session.id))?.bytes).toBeGreaterThan(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    for (const source of ['combined','microphone','tab']) {
      const file = await engine.export(session.id);
      expect(file.session.filename).toContain(`-${source}.webm`);
      await engine.downloadDone(session.id,true);
    }
    expect(await db.getSession(session.id)).toBeUndefined();
    expect((await engine.status()).phase).toBe('idle');
  });
  it('treats canceled saving as a clean finish and skips the remaining exports',async()=>{
    await startLegacy();engine.stop();const session=await finalized();
    await engine.export(session.id);
    await engine.downloadDone(session.id,false,undefined,true);
    const status=await engine.status();
    expect(status.phase).toBe('idle');expect(status.error).toBeUndefined();
    expect(status.session).toBeUndefined();expect(status.retained).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    await expect(db.audioBlob(session.id,'audio/webm')).rejects.toThrow();
    expect(ready).toHaveBeenCalledTimes(1);
    await engine.downloadDone(session.id,false,undefined,true);
    expect((await engine.status()).phase).toBe('idle');
  });
  it('cleans remaining audio when a separate export is canceled after saving the mix',async()=>{
    await startLegacy();engine.stop();const session=await finalized();
    await engine.export(session.id);await engine.downloadDone(session.id,true);
    expect((await db.getSession(session.id))?.savedSources).toEqual(['mixed']);
    await engine.export(session.id);
    await engine.downloadDone(session.id,false,undefined,true);
    expect(await db.getSession(session.id)).toBeUndefined();
    expect((await engine.status()).phase).toBe('idle');
    expect(ready).toHaveBeenCalledTimes(2);
    await start();expect((await engine.status()).phase).toBe('recording');
    engine.stop();await vi.waitFor(()=>expect(ready).toHaveBeenCalledTimes(3));
  });
  it('marks source disconnection partial and saves committed audio',async()=>{
    await start();tracks[0].onended?.();
    const session=await finalized();expect(session.partial).toBe(true);expect(session.error).toContain('disconnected');
  });
  it('refuses discard during recording and allows it after failed saving',async()=>{
    await start();const id=(await engine.status()).session!.id;
    await expect(engine.discard(id)).rejects.toThrow('Stop recording');
    engine.stop();await finalized();await engine.downloadDone(id,false);
    await engine.discard(id);expect(await db.sessions()).toHaveLength(0);
  });
  it('recovers committed interrupted audio in a fresh engine without claiming it is live',async()=>{
    await startLegacy();FakeRecorder.instances[0].ondataavailable?.({data:new Blob(['committed'])});
    await vi.waitFor(async()=>expect((await db.sessions())[0].chunks).toBe(1));
    const fresh=new RecorderEngine(vi.fn(),vi.fn());
    const status=await fresh.status();expect(status.phase).toBe('idle');expect(status.retained).toHaveLength(1);
    const id=status.retained[0].id;await fresh.export(id);
    expect((await db.getSession(id))?.partial).toBe(true);
    engine.stop();await finalized();
  });
  it('retains a finished bundle while allowing the next capture and protecting its audio',async()=>{
    await start();engine.stop();const previous=await finalized();
    expect(previous.exportKind).toBe('meeting-bundle-v1');
    expect((await engine.status()).phase).toBe('idle');
    await expect(engine.export(previous.id)).rejects.toThrow('Save meeting');
    expect(await (await db.audioBlob(previous.id,'audio/webm')).text()).toBe('final');
    await start();
    const current=(await engine.status()).session!;
    await expect(engine.completeBundle(current.id)).rejects.toThrow('still recording');
    await engine.completeBundle(previous.id);
    expect((await engine.status()).phase).toBe('recording');
    expect(await db.getSession(previous.id)).toBeUndefined();
    expect(await db.getSession(current.id)).toBeDefined();
    engine.stop();await vi.waitFor(()=>expect(ready).toHaveBeenCalledTimes(2));
  });
  it('can stop from its in-memory identity even if audio-session reads fail',async()=>{
    await start();
    const id=engine.captureState().session!.id;
    const read=vi.spyOn(db,'sessions').mockRejectedValue(new Error('Local storage read failed'));
    expect(engine.captureState().session!.id).toBe(id);
    engine.stop();
    await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
    expect(tracks.every(track=>track.readyState==='ended')).toBe(true);
    read.mockRestore();
  });
});
