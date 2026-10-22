'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMessages,parseFinal}=require('../src/prompts'),{createCandidateStore}=require('../src/domain');
const {intent,filters,movie,tv,dictionaries}=require('./fixtures.cjs');
test('prompt uses bounded summaries rather than raw cards or provider keys',()=>{
    const candidates=Array.from({length:80},(_,i)=>movie({id:i+1,key:'tmdb:movie:'+(i+1),overview:'я'.repeat(1000),card:{apiKey:'DO-NOT-SEND'}}));
    const messages=buildMessages({query:'лёгкое кино',intent:intent(),formFilters:{},examples:[],shown:[],candidates,dictionaries,trace:[],key:'DO-NOT-SEND'});
    const state=JSON.parse(messages[1].content);
    assert.equal(JSON.stringify(messages).includes('DO-NOT-SEND'),false);
    assert.ok(JSON.stringify(state.candidates).length<=60000);assert.ok(state.candidates.every(c=>c.overview.length<=500));
    assert.ok(messages[0].content.includes('данные'));assert.equal(state.query,'лёгкое кино');
});
test('trace compaction keeps call/result pairs and never loses a pending call',()=>{
    const trace=[];
    for(let i=0;i<20;i++){trace.push({role:'assistant',content:null,tool_calls:[{id:'c'+i,type:'function',function:{name:'search_titles',arguments:'{}'}}]});trace.push({role:'tool',tool_call_id:'c'+i,content:JSON.stringify({items:[{overview:'x'.repeat(10000)}]})});}
    trace.push({role:'assistant',content:null,tool_calls:[{id:'pending',type:'function',function:{name:'search_titles',arguments:'{}'}}]});
    const messages=buildMessages({query:'x',intent:intent(),formFilters:{},candidates:[],examples:[],shown:[],trace,dictionaries});
    assert.equal(messages.at(-1).tool_calls[0].id,'pending');
    const ids=messages.flatMap(m=>m.tool_calls||[]).map(c=>c.id),responses=messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id);
    assert.ok(responses.every(id=>ids.includes(id)));assert.ok(messages.filter(m=>m.role==='tool').reduce((n,m)=>n+m.content.length,0)<=60000);
});
test('final output accepts only known candidates that satisfy filters and exclusions',()=>{
    const store=createCandidateStore(80);store.add(movie());store.add(tv());
    const result=parseFinal(JSON.stringify({picks:[
        {key:'tmdb:movie:999',reason:'fake'},{key:'tmdb:tv:1',reason:'wrong format'},
        {key:'tmdb:movie:1',reason:'Расследование. Тревожная атмосфера. Третий аргумент.'},{key:'tmdb:movie:1',reason:'duplicate'}
    ]}),store,filters(),[]);
    assert.equal(result.items.length,1);assert.equal(result.items[0].reason,'Расследование. Тревожная атмосфера.');
    assert.equal(parseFinal('{"picks":[{"key":"tmdb:movie:1","reason":"x"}]}',store,filters(),['tmdb:movie:1']).items.length,0);
    assert.equal(parseFinal('{"picks":[{"key":"tmdb:movie:1","reason":"x"}]}',store,filters({maxRuntimeMinutes:100}),[]).items.length,0);
});
test('malformed final fails, missing reasons are dropped, and HTML is plain text data',()=>{
    const store=createCandidateStore(80);store.add(movie());
    assert.throws(()=>parseFinal('not json',store,filters(),[]),e=>e.code==='invalid_response');
    assert.throws(()=>parseFinal('{"other":[]}',store,filters(),[]),e=>e.code==='invalid_response');
    assert.equal(parseFinal('{"picks":[{"key":"tmdb:movie:1"}]}',store,filters(),[]).items.length,0);
    assert.equal(parseFinal('{"picks":[{"key":"tmdb:movie:1","reason":"<img src=x>"}]}',store,filters(),[]).items[0].reason,'<img src=x>');
});
test('final results have at most ten entries with reasons bounded to 300 characters',()=>{
    const store=createCandidateStore(80),picks=[];
    for(let i=1;i<=12;i++){store.add(movie({id:i,key:'tmdb:movie:'+i}));picks.push({key:'tmdb:movie:'+i,reason:'а'.repeat(400)});}
    const result=parseFinal(JSON.stringify({picks}),store,filters(),[]);
    assert.equal(result.items.length,10);assert.ok(result.items.every(p=>p.reason.length<=300));
});
