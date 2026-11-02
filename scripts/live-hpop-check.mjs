import {readFile,writeFile} from 'node:fs/promises';import {build} from 'esbuild';import {reserveLiveRequest} from './provider-batching-budget.mjs';
// One bounded production HPOP call; reserve US$1 conservatively rather than assuming DeepInfra prices apply.
await reserveLiveRequest('hpop','single-production-native-Claude-regression',1);
const cfg=JSON.parse(await readFile('.local/hpop.json','utf8'));
await build({entryPoints:['src/assistant/provider.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'artifacts/provider-batching/hpop-runtime.mjs'});
const {analyzeNativeClaude}=await import('../artifacts/provider-batching/hpop-runtime.mjs');
const ref=JSON.parse(await readFile('training:meeting/verified-excerpts-v1-76136748b154/reference.json','utf8'));
const a=ref.annotations.find(a=>a.id==='472:combined');const input={sessionId:'hpop-regression',version:1,goal:'',segments:[{id:0,sessionId:'hpop-regression',startMs:0,endMs:8000,text:a.text}],memory:[],history:[],contextGap:false};
let report;
try{const result=await analyzeNativeClaude(cfg.apiKey,'claude-sonnet-5-5',input,new AbortController().signal);report={valid:true,...result};console.log(JSON.stringify({valid:true,latencyMs:result.latencyMs,summaryCharacters:result.analysis.summary.length}));}
catch(e){report={valid:false,status:e.status,category:e.category,reason:e.reason,issues:e.validationIssues};console.log(JSON.stringify(report));}
await writeFile('artifacts/provider-batching/hpop-live.json',JSON.stringify({scope:'One real HPOP call through the unchanged native Claude route. HPOP billing rates unavailable; US$1 conservative budget reservation, not an observed charge.',...report},null,2).replaceAll(cfg.apiKey,'[REDACTED]'));
