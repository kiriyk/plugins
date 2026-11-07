'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{createScaleDown}=require('../src/scaledown');
function setup(){const h=createHarness();return {...h,api:createScaleDown({request:h.request,clock:h.clock})};}
function reply(h,entities){h.reply(0,{model:'scaledown/extract',usage:{prompt_tokens:20},choices:[{message:{content:JSON.stringify({entities})},finish_reason:'stop'}]});}
test('Extract uses one provider entity request without chat tools and assigns sources in code',()=>{
 const h=setup();let result;h.api.extract({key:'test',pages:[{id:'p',title:'',content:'😀 Прибытие'},{id:'q',title:'Прибытие',content:''}]},(e,r)=>{assert.equal(e,null);result=r});
 const req=h.requests[0],text=req.json.messages[0].content,start=text.indexOf('Прибытие');
 assert.equal(req.url,'https://routerai.ru/api/v1/chat/completions');assert.equal(req.json.model,'scaledown/extract');assert.equal(req.headers.Authorization,'Bearer test');
 assert.equal(req.json.tools,undefined);assert.equal(req.json.tool_choice,undefined);assert.equal(typeof req.json.provider.options.scaledown.entities.movie_title,'string');
 reply(h,[{type:'movie_title',text:'Прибытие',start,end:start+8,confidence:0.9},{type:'movie_title',text:'Fake',start:0,end:4,confidence:1}]);
 assert.equal(result.titles.length,1);assert.equal(result.titles[0].type,'unknown');assert.deepEqual(result.titles[0].sourceIds,['p','q']);assert.match(result.titles[0].evidenceBySource.p,/Прибытие/);assert.equal(h.timers.size,0);
 h.reply(0,{});assert.equal(result.titles.length,1);
});
test('empty extraction is success while malformed contract and truncation are errors',()=>{
 for(const mode of ['empty','bad','length']){
  const h=setup();let result,error;h.api.extract({key:'k',pages:[{id:'p',content:'Film'}]},(e,r)=>{error=e;result=r});
  if(mode==='empty')reply(h,[]);else h.reply(0,{choices:[{finish_reason:mode==='length'?'length':'stop',message:{content:'{}'}}]});
  if(mode==='empty')assert.deepEqual(result.titles,[]);else assert.equal(error.code,mode==='length'?'model_output_limit':'invalid_response');
  assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);
 }
});
test('extract timeout and cancel settle once and ignore late responses',()=>{
 for(const cancel of [false,true]){
  const h=setup();let calls=0,error;const stop=h.api.extract({key:'k',pages:[{id:'p',content:'Film'}],timeoutMs:100},e=>{calls++;error=e});
  if(cancel)stop();h.advance(101);reply(h,[]);assert.equal(calls,cancel?0:1);if(!cancel)assert.equal(error.code,'timeout');assert.equal(h.timers.size,0);
 }
});
test('recorded RouterAI response resolves codepoint offsets and repeated sources',()=>{
 const fixture=require('./fixtures/scaledown-response.json'),h=setup();let result;
 h.api.extract({key:'k',pages:fixture.pages},(e,r)=>{assert.equal(e,null);result=r});h.reply(0,fixture.response);
 assert.deepEqual(result.titles.map(t=>t.title),['Прибытие','Coherence']);assert.deepEqual(result.titles[0].sourceIds,['p','q']);
});
test('malformed nonempty entities are contract errors rather than successful empty extraction',()=>{
 for(const entities of [[null],[{name:'Прибытие',offset:9}],[{type:'movie_title',text:'Film',start:0,end:4,confidence:2}]]){
  const h=setup();let error,result;h.api.extract({key:'k',pages:[{id:'a',content:'Film'}]},(e,r)=>{error=e;result=r});reply(h,entities);
  assert.equal(error?.code,'invalid_response');assert.equal(result,undefined);assert.equal(h.timers.size,0);
 }
});
test('Extract proposals use first text occurrence before applying twenty-title limit',()=>{
 const h=setup();let result;const names=Array.from({length:21},(_,i)=>'Movie'+String(i).padStart(2,'0'));
 h.api.extract({key:'k',pages:[{id:'a',content:names.join('; ')}]},(e,r)=>{assert.equal(e,null);result=r});const text=h.requests[0].json.messages[0].content;
 reply(h,names.slice().reverse().map(name=>({type:'movie_title',text:name,start:text.indexOf(name),end:text.indexOf(name)+name.length,confidence:1})));
 assert.deepEqual(result.titles.map(t=>t.title),names.slice(0,20));
});
