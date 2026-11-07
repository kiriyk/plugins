'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareRanking,createCandidateRanker}=require('../src/candidate-ranking'),{createBudget}=require('../src/budget'),{createHarness}=require('./helpers.cjs'),{movie}=require('./fixtures.cjs');
const choices=['strong_match','match','weak_match','not_match','insufficient_data'];
function answer(choice){return {choice,confidence:1,probabilities:Object.fromEntries(choices.map(k=>[k,k===choice?1:0]))};}
function input(n=1){return {key:'k',query:'Космос 😀',intent:{preferences:['Не страшное']},examples:[],candidates:Array.from({length:n},(_,i)=>movie({id:i+1,key:'tmdb:movie:'+(i+1)})),resultLimit:null,remaining:200};}
test('pack all IDs exactly once in final UTF8 bounded requests including Cyrillic and emoji',()=>{
 for(const n of [1,20,21,80]){
  const data=input(n);data.candidates.forEach(c=>c.overview='Космос 😀'.repeat(70));
  const result=prepareRanking(data),keys=result.batches.flatMap(b=>Object.keys(b.questions));
  assert.equal(keys.length,n);assert.equal(new Set(keys).size,n);assert.equal(keys[0],'movie_1_fit');assert.equal(keys.at(-1),'movie_'+n+'_fit');
  assert.ok(result.batches.every(b=>Object.keys(b.questions).length<=20&&Buffer.byteLength(JSON.stringify(b))<=24000));
  assert.match(result.batches[0].questions.movie_1_fit.instructions,/tmdb:movie:1/);assert.match(result.batches[0].questions.movie_1_fit.instructions,/Космос/);
 }
});
test('ranker chooses only strong and match, caps in code with deterministic source-neutral ordering',()=>{
 const h=createHarness(),budget=createBudget({clock:h.clock,request:h.request}),data=input(4);let result;
 data.candidates[1].webSources=[{evidenceText:'Упоминание.'}];
 const ranker=createCandidateRanker({clock:h.clock,budget,decisions:{evaluate:(args,done)=>{done(null,{answers:{movie_1_fit:answer('match'),movie_2_fit:answer('match'),movie_3_fit:answer('strong_match'),movie_4_fit:answer('weak_match')},modelVersion:'v1'});return ()=>{};}}});
 ranker.rank({...data,resultLimit:2},(e,r)=>{assert.equal(e,null);result=r});
 assert.deepEqual(result.selectedKeys,['tmdb:movie:3','tmdb:movie:1']);assert.equal(result.rows.length,4);assert.equal(budget.snapshot().decisionCalls,1);assert.deepEqual(result.modelVersions,['v1']);
});
test('preflight oversized plans do no HTTP; partial or insufficient batches never become a selection',()=>{
 for(const mode of ['preflight','second_failure','insufficient']){
  const h=createHarness(),budget=createBudget({clock:h.clock,request:h.request,limits:{decisionCalls:mode==='preflight'?1:4}}),data=input(21);let calls=0,result,error;
  const decisions={evaluate:(args,done)=>{calls++;if(mode==='second_failure'&&calls===2)done({code:'network'});else done(null,{answers:Object.fromEntries(Object.keys(args.questions).map(k=>[k,answer(mode==='insufficient'?'insufficient_data':'match')]))});return ()=>{};}};
  createCandidateRanker({clock:h.clock,budget,decisions}).rank(data,(e,r)=>{error=e;result=r});
  assert.ok(error);assert.equal(result,undefined);assert.equal(calls,mode==='preflight'?0:mode==='second_failure'?2:1);
 }
});
test('cancel ignores late evaluation and preserves budget and deadline bounds',()=>{
 const h=createHarness(),budget=createBudget({clock:h.clock,request:h.request});let callback,calls=0;
 const stop=createCandidateRanker({clock:h.clock,budget,decisions:{evaluate:(args,done)=>{callback=done;return ()=>{};}}}).rank(input(),()=>calls++);
 stop();callback(null,{answers:{movie_1_fit:answer('match')}});assert.equal(calls,0);assert.equal(budget.snapshot().decisionCalls,1);
});
