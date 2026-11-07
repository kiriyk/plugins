'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStageProbes}=require('../src/stage-probes'),{createHarness}=require('./helpers.cjs');
test('explicit stage probe uses selected roles only, at most two RouterAI calls and no Tavily',()=>{
 const h=createHarness(),probe=createStageProbes({request:h.request,clock:h.clock});let result;
 probe.probe({key:'k',stages:{extraction:'scaledown/extract',ranking:'~typesafe/jev-latest'}},(e,r)=>{assert.equal(e,null);result=r});
 assert.equal(h.requests.length,1);const text=h.requests[0].json.messages[0].content,at=text.indexOf('Прибытие');
 h.reply(0,{choices:[{message:{content:JSON.stringify({entities:[{type:'movie_title',text:'Прибытие',start:at,end:at+8,confidence:1}]})}}]});
 assert.equal(h.requests.length,2);const questions=h.requests[1].json.questions,answers={};
 for(const key of Object.keys(questions))answers[key]={type:'choice',choice:'match',confidence:1,probabilities:Object.fromEntries(Object.keys(questions[key].criteria).map(k=>[k,k==='match'?1:0]))};
 h.reply(1,{answers});assert.deepEqual(result,{checked:2});assert.equal(h.requests.some(r=>r.url.includes('tavily')),false);assert.equal(h.timers.size,0);
 const empty=createHarness();let value;createStageProbes({request:empty.request,clock:empty.clock}).probe({key:'k',stages:{extraction:'primary',ranking:'primary'}},(e,r)=>value=r);assert.equal(value.checked,0);assert.equal(empty.requests.length,0);
});
