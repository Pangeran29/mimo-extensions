import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {build} from 'esbuild';
import {createRelay} from '../server/relay.mjs';import {reserveLiveRequest} from './provider-batching-budget.mjs';
const cfg=JSON.parse(await readFile('.local/deepinfra.json','utf8'));
const relay=createRelay({...cfg,providerFetch:async(...args)=>{await reserveLiveRequest('deepinfra','adjacent-reviewed-ASR-batch-comparison',0.01);return fetch(...args);}});
await new Promise(r=>relay.listen(0,'127.0.0.1',r));
try{
 await build({stdin:{contents:"export {selectBatch} from './src/transcription/batch';export {encodeWav} from './src/transcription/wav';export {removeOverlap} from './src/transcription/segmenter';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:'artifacts/provider-batching/batch-runtime.mjs'});
 const {selectBatch,encodeWav,removeOverlap}=await import('../artifacts/provider-batching/batch-runtime.mjs');
 const root='training:meeting/verified-excerpts-v1-76136748b154';
 const ref=JSON.parse(await readFile(root+'/reference.json','utf8'));
 const annotations=['864:combined','872:combined'].map(id=>ref.annotations.find(a=>a.id===id));
 if(annotations[0].endSeconds!==annotations[1].startSeconds)throw Error('Source excerpts are not adjacent');
 const parts=[];for(const a of annotations){const wav=await readFile(root+'/clips/'+String(a.startSeconds).padStart(4,'0')+'-combined.wav');const pcm=wav.subarray(44);if(createHash('sha256').update(pcm).digest('hex')!==a.inputHash)throw Error('Frozen source hash mismatch');parts.push(pcm);}
 const bytes=Buffer.concat(parts);const pcm=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4).slice();
 const base=[[0,8],[7,15],[14,16]].map(([start,end],i)=>({pendingId:'paired:'+i,sessionId:'paired',traceId:i,startSample:start*16000,endSample:end*16000,overlap:i>0,audio:pcm.slice(start*16000,end*16000)}));
 const rows=[];
 // One run per configuration, descriptive only; 24s cannot be distinguished on a 16s source.
 for(const cap of [8,16,24]){
  const queue=base.slice();let previous='';const text=[],calls=[];const start=performance.now();let failure;
  while(queue.length){const batch=selectBatch(queue,cap);const sent=performance.now();
   try{const response=await fetch(`http://127.0.0.1:${relay.address().port}/transcribe`,{method:'POST',headers:{Authorization:`Bearer ${cfg.relayToken}`,'Content-Type':'audio/wav'},body:encodeWav(batch.audio),signal:AbortSignal.timeout(50000)});
    const data=await response.json();if(!response.ok)throw Error('HTTP '+response.status);
    const clean=removeOverlap(previous,data.text,batch.overlap);previous=clean;text.push(clean);calls.push({windows:batch.jobs.length,audioSeconds:batch.audio.length/16000,requestMs:performance.now()-sent});queue.splice(0,batch.jobs.length);
   }catch(error){failure=error.name==='Error'?error.message:error.name;break;}}
  rows.push({cap,drainMs:performance.now()-start,calls,text:text.join(' '),failure});
  console.log(JSON.stringify({cap,requests:calls.length,drainMs:rows.at(-1).drainMs,failure}));
 }
 await writeFile('artifacts/provider-batching/batch-comparison.json',JSON.stringify({scope:'One exploratory already-queued backlog drain per cap. Exact adjacent human-reviewed 864–880s combined audio; overlapping evaluation windows are formed explicitly. No real-time capture/queue-age claim or population quality claim.',sourceHash:createHash('sha256').update(bytes).digest('hex'),reference:annotations.map(a=>a.text).join(' '),rows},null,2));
}finally{relay.closeAllConnections();await new Promise(r=>relay.close(r));}
