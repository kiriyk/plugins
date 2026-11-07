'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWebDiscovery}=require('../src/web-discovery');
const {createHarness}=require('./helpers.cjs'),{emptyIntent,createCandidateStore}=require('../src/domain'),{movie}=require('./fixtures.cjs');
function setup(limit=40){const h=createHarness(),store=createCandidateStore(80),searches=[],models=[];let used=3,modelCalls=1;
 const discovery=createWebDiscovery({clock:h.clock,store,limits:{catalogRequests:limit},
  budget:{snapshot:()=>({catalogRequests:used,modelCalls}),remainingMs:()=>90000,consumeModel:()=>{modelCalls++;return true;}},
  webSearch:{search:(args,done)=>{done(null,{pages:[{id:'p1',url:'https://films.example/list',domain:'films.example',title:'List',content:'Film 2010'}]});return ()=>{};}},
  routerai:{chat:(args,done)=>{models.push({args,done});return ()=>{};}},
  catalog:{searchTitles:(args,done)=>{used+=args.type==='all'?2:1;searches.push(args);done(null,{items:[movie({title:'Film',year:2011})],hasMore:false});return ()=>{};}}
 });
 return {...h,discovery,store,searches,models,used:()=>used};
}
test('web proposals resolve against TMDB without exact year and retain references',()=>{
 const h=setup();let result;h.discovery.run({key:'model-key',model:'m',webKey:'web-key',queries:['films'],intent:emptyIntent()},(e,r)=>{assert.equal(e,null);result=r;});
 h.models[0].done(null,{tool_calls:[],content:JSON.stringify({titles:[{title:'Film',year:2010,type:'movie',sourceIds:['p1']}]})});
 assert.equal(h.searches.length,1);assert.equal(h.searches[0].year,undefined);
 assert.deepEqual(result.candidateKeys,['tmdb:movie:1']);assert.equal(h.store.get('tmdb:movie:1').webSources[0].domain,'films.example');
 assert.equal(result.webSnapshot.resolvedCandidates.length,1);assert.equal(h.timers.size,0);
});
test('invalid source IDs and malformed extraction never become candidates',()=>{
 for(const payload of ['bad',JSON.stringify({titles:[{title:'Film',type:'movie',sourceIds:['invented']}]})]){
  const h=setup();let error;h.discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],intent:emptyIntent()},e=>error=e);
  h.models[0].done(null,{tool_calls:[],content:payload});assert.equal(error.code,'invalid_response');assert.equal(h.searches.length,0);
 }
});
test('matching leaves sixty percent of catalog budget available for verification',()=>{
 const h=setup(10);let result;h.discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],intent:emptyIntent()},(e,r)=>result=r);
 h.models[0].done(null,{tool_calls:[],content:JSON.stringify({titles:Array.from({length:20},()=>({title:'Film',type:'movie',sourceIds:['p1']}))})});
 assert.equal(h.used(),4);assert.equal(h.searches.length,1);assert.ok(result);
});
test('cancel prevents a late model response from searching the catalog',()=>{
 const h=setup();let calls=0;const cancel=h.discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],intent:emptyIntent()},()=>calls++);cancel();
 h.models[0].done(null,{content:'{"titles":[]}',tool_calls:[]});assert.equal(calls,0);assert.equal(h.searches.length,0);assert.equal(h.timers.size,0);
});

test('ambiguous results and incomplete result pages are not resolved as the first title',()=>{
 for(const hasMore of [true,false]){
  const h=setup();const match=movie({title:'Film'}),other=movie({id:2,key:'tmdb:movie:2',title:'Film'});
  const discovery=createWebDiscovery({clock:h.clock,store:h.store,limits:{},budget:{snapshot:()=>({catalogRequests:3,modelCalls:1}),consumeModel:()=>true,remainingMs:()=>90000},
   webSearch:{search:(args,done)=>{done(null,{pages:[{id:'p',content:'Film'}]});return ()=>{};}},
   routerai:{chat:(args,done)=>{done(null,{content:JSON.stringify({titles:[{title:'Film',type:'movie',sourceIds:['p']}]})});return ()=>{};}},
   catalog:{searchTitles:(args,done)=>{done(null,{items:hasMore?[match]:[match,other],hasMore});return ()=>{};}}});
  let result;discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],intent:emptyIntent()},(e,r)=>result=r);assert.deepEqual(result.candidateKeys,[]);
 }
});

test('inherited JavaScript property names cannot be used as web source IDs',()=>{
 for(const sourceId of ['constructor','toString','__proto__']){
  const h=setup();let error;h.discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],intent:emptyIntent()},e=>error=e);
  h.models[0].done(null,{content:JSON.stringify({titles:[{title:'Film',type:'movie',sourceIds:[sourceId]}]}),tool_calls:[]});
  assert.equal(error&&error.code,'invalid_response');assert.equal(h.searches.length,0);
 }
});
test('configured Extract replaces primary extraction, counts once and retains evidence',()=>{
 const h=setup(),{createScaleDown}=require('../src/scaledown');let result;
 const discovery=createWebDiscovery({clock:h.clock,store:h.store,limits:{},extractor:createScaleDown({request:h.request,clock:h.clock}),
  budget:{snapshot:()=>({catalogRequests:3,modelCalls:1}),consumeModel:()=>true,remainingMs:()=>90000},
  webSearch:{search:(a,done)=>{done(null,{pages:[{id:'p',title:'',content:'Film'}]});return ()=>{};}},
  routerai:{chat:()=>assert.fail('primary must not extract')},
  catalog:{searchTitles:(a,done)=>{done(null,{items:[movie({title:'Film'})],hasMore:false});return ()=>{};}}});
 discovery.run({key:'k',model:'m',webKey:'w',queries:['q'],extractorId:'scaledown/extract',intent:emptyIntent()},(e,r)=>{assert.equal(e,null);result=r});
 assert.equal(h.requests.length,1);const text=h.requests[0].json.messages[0].content,at=text.indexOf('Film');
 h.reply(0,{choices:[{message:{content:JSON.stringify({entities:[{type:'movie_title',text:'Film',confidence:1,start:at,end:at+4}]})}}]});
 assert.deepEqual(result.candidateKeys,['tmdb:movie:1']);assert.equal(h.store.get('tmdb:movie:1').webSources[0].evidenceText,'\nFilm');
 assert.equal(result.webSnapshot.extractorId,'scaledown/extract');assert.equal(result.webSnapshot.schemaVersion,1);
});
