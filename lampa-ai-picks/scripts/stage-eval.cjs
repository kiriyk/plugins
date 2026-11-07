'use strict';
// Developer-only evaluation. Runtime plugin stays ES5; network requires explicit --live.
const fs=require('node:fs'),path=require('node:path');
const d=require('../src/domain'),prompts=require('../src/prompts');
const clock={now:Date.now,setTimeout,clearTimeout};
function safeBody(body){
 const out={};for(const k of ['model','answers','usage'])if(body?.[k]!==undefined)out[k]=body[k];
 if(Array.isArray(body?.choices))out.choices=body.choices.map(c=>({finish_reason:c.finish_reason,message:{role:'assistant',content:c.message?.content,tool_calls:c.message?.tool_calls}}));
 return out;
}
function requestFactory({live,key,recorded,capture}){
 let at=0;
 return (spec,done)=>{
  if(!live){const saved=recorded?.[at++];let active=true;queueMicrotask(()=>{if(active)done(saved?.error||null,saved?.body)});return ()=>{active=false};}
  const controller=new AbortController();let active=true;
  const timer=setTimeout(()=>controller.abort(),spec.timeoutMs||15000);
  fetch(spec.url,{method:spec.method,headers:{...spec.headers,'Content-Type':'application/json'},body:JSON.stringify(spec.json),signal:controller.signal}).then(async res=>{
   const body=await res.json();if(!active)return;clearTimeout(timer);
   const error=res.ok?null:require('../src/transport').normalizeError({status:res.status});
   capture.push({error,body:safeBody(body)});done(error,body);
  }).catch(e=>{if(!active)return;clearTimeout(timer);const error={code:e.name==='AbortError'?'timeout':'network'};capture.push({error});done(error)});
  return ()=>{active=false;clearTimeout(timer);controller.abort();};
 };
}
function call(operation){return new Promise(resolve=>operation((error,result)=>resolve({error:error?.code||null,result})));}
function norm(title){return title.toLowerCase().replace(/ё/g,'е').replace(/[«»"']/g,'').trim();}
async function lane(mode,c,role,{live,key,model,saved}){
 const capture=[],started=Date.now(),request=requestFactory({live,key,recorded:saved?.responses,capture});let value;
 if(mode==='extract'){
  const api=role==='specialized'?require('../src/scaledown').createScaleDown({request,clock}):require('../src/primary-extractor').createPrimaryExtractor({routerai:require('../src/routerai').createRouterAI({request})});
  value=await call(done=>api.extract({key,model,pages:c.pages,query:'Все явно упомянутые фильмы и сериалы, включая отрицательные упоминания',intent:d.emptyIntent(),timeoutMs:15000},done));
 }else{
  const intent=d.emptyIntent();intent.filters.media='all';intent.examples=c.examples.map(x=>x.key);
  if(role==='specialized'){
   const budget=require('../src/budget').createBudget({clock,request});
   value=await call(done=>require('../src/candidate-ranking').createCandidateRanker({clock,budget,decisions:require('../src/jev').createJev({clock,request})}).rank({key,query:c.query,intent,examples:c.examples,candidates:c.candidates,resultLimit:null,remaining:200},done));budget.cancel();
  }else{
   const store=d.createCandidateStore(80);c.candidates.forEach(x=>store.add(x));
   const messages=prompts.buildMessages({query:c.query,intent,exampleContext:c.examples,candidates:c.candidates,resultLimit:null});
   value=await call(done=>require('../src/routerai').createRouterAI({request}).chat({key,model,messages,toolChoice:'none',maxOutputTokens:2048,timeoutMs:15000},done));
   if(!value.error){try{const parsed=prompts.parseFinal(value.result.content,store,intent.filters,[],{resultLimit:null,eligibleKeys:c.candidates.map(x=>x.key)});value.result={selectedKeys:parsed.items.map(i=>i.candidate.key)};}catch(e){value={error:e.code||'invalid_response'};}}
  }
 }
 return {responses:live?capture:saved?.responses||[],elapsedMs:live?Date.now()-started:saved?.elapsedMs||0,error:value.error,result:value.result};
}
function metrics(mode,cases,rows,role){
 let tp=0,predicted=0,expected=0,sourceHits=0,sourceTotal=0,errors=0,fallbacks=0,falseTop10=0;const versions=new Set();let inputTokens=0,outputTokens=0,cost=0,latency=0,calls=0;
 for(let i=0;i<cases.length;i++){
  const c=cases[i],r=rows[i][role];latency+=r.elapsedMs;
  for(const response of r.responses){calls++;const b=response.body||{},u=b.usage||{};if(b.model)versions.add(b.model);inputTokens+=u.input_tokens||u.prompt_tokens||0;outputTokens+=u.output_tokens||u.completion_tokens||0;cost+=typeof u.cost==='number'?u.cost:0;}
  if(r.error){errors++;if(role==='specialized'&&mode==='ranking')fallbacks++;}
  if(mode==='extract'){
   const expectedTitles=Object.keys(c.expected),actual=r.result?.titles||[];expected+=expectedTitles.length;predicted+=actual.length;
   for(const t of actual){const match=expectedTitles.find(x=>norm(x)===norm(t.title));if(match)tp++;for(const id of t.sourceIds||[]){sourceTotal++;if(match&&c.expected[match].includes(id))sourceHits++;}}
  }else{
   if(c.expectedFallback)continue;
   const actual=r.result?.selectedKeys||[];expected+=c.expectedAdmitted.length;predicted+=actual.length;
   for(const key of actual)if(c.expectedAdmitted.includes(key))tp++;
   falseTop10+=actual.slice(0,10).filter(k=>!c.expectedAdmitted.includes(k)).length;
  }
 }
 return {precision:predicted?tp/predicted:1,recall:expected?tp/expected:1,errors,fallbackRate:fallbacks/cases.length,falseTop10,sourceAccuracy:sourceTotal?sourceHits/sourceTotal:null,tmdbResolution:null,calls,inputTokens,outputTokens,reportedCost:cost||null,meanLatencyMs:Math.round(latency/cases.length),modelVersions:[...versions]};
}
async function run(mode){
 const args=process.argv.slice(2),live=args.includes('--live'),arg=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
 const fixtureDir=path.resolve(__dirname,'../tests/fixtures'),recordFile=arg('--records',path.join(fixtureDir,mode+'-recorded.json')),output=arg('--output',recordFile);
 const model=arg('--model',process.env.ROUTERAI_MODEL||''),key=live?process.env.ROUTERAI_APIKEY:'offline';
 if(live&&(!key||!model))throw Error('--live requires ROUTERAI_APIKEY and --model (or ROUTERAI_MODEL)');
 const cases=JSON.parse(fs.readFileSync(path.join(fixtureDir,mode==='extract'?'extract-cases.json':'ranking-cases.json'),'utf8'));
 const recorded=live?null:JSON.parse(fs.readFileSync(recordFile,'utf8'));
 const rows=new Array(cases.length);let cursor=0;
 async function worker(){for(;;){const i=cursor++;if(i>=cases.length)return;const c=cases[i],saved=recorded?.cases.find(x=>x.id===c.id);rows[i]={id:c.id,split:c.split};for(const role of ['primary','specialized'])rows[i][role]=await lane(mode,c,role,{live,key,model:model||recorded.primaryModel,saved:saved?.[role]});}}
 await Promise.all([worker(),worker()]);
 const report={mode,live,primaryModel:model||recorded.primaryModel,methodology:'Synthetic fixed labels; primary single final call; offline replays recorded provider bodies, not new quality measurements. TMDB and TV not measured. Ranking precision/recall exclude the same two expected-insufficient cases in both lanes; fallback rate includes all cases.',cases:cases.length,primary:metrics(mode,cases,rows,'primary'),specialized:metrics(mode,cases,rows,'specialized'),splits:{}};
 for(const split of ['development','holdout']){const indices=cases.map((c,i)=>c.split===split?i:-1).filter(i=>i>=0);report.splits[split]={primary:metrics(mode,indices.map(i=>cases[i]),indices.map(i=>rows[i]),'primary'),specialized:metrics(mode,indices.map(i=>cases[i]),indices.map(i=>rows[i]),'specialized')};}
 if(live){
  const data={recordedAt:new Date().toISOString(),primaryModel:model,cases:rows.map(r=>({id:r.id,split:r.split,primary:{responses:r.primary.responses,elapsedMs:r.primary.elapsedMs},specialized:{responses:r.specialized.responses,elapsedMs:r.specialized.elapsedMs}})),report};
  const serialized=JSON.stringify(data,null,2);if(serialized.includes(key))throw Error('Refusing to save credential in fixture');fs.writeFileSync(output,serialized+'\n');
 }
 console.log(JSON.stringify(report,null,2));return report;
}
module.exports={run};
