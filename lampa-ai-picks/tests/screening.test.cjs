'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCandidateStore}=require('../src/domain'),{createScreening}=require('../src/screening');
const {movie,filters}=require('./fixtures.cjs');
function setup(items,overrides={}){const store=createCandidateStore(80);items.forEach(c=>store.add(c));let ratingCalls=[],details=[];const progress=[];
 const catalog={getTitleDetails:(args,done)=>{details.push(args.keys);done(null,[]);return ()=>{};},...overrides.catalog};
 const ratings={getMany:(candidates,source,done)=>{ratingCalls.push({keys:candidates.map(c=>c.key),source});done(null,Object.fromEntries(candidates.map(c=>[c.key,{value:c.id===3?6:8,error:null}])));return ()=>{};},...overrides.ratings};
 const screening=createScreening({store,catalog,ratings,onProgress:s=>progress.push(s)});
 return {store,screening,ratingCalls,details,progress,check:(f=filters(),excluded=[])=>{let done=false;screening.check(f,excluded,()=>done=true);return done;}};
}
const c=(id,extra={})=>movie({id,key:'tmdb:movie:'+id,...extra});
test('all unique candidates are checked before ranking; cheap rejections consume no rating lookups',()=>{
 const h=setup([c(1),c(1),c(2,{year:1990}),c(3),c(4)]);h.check(filters({yearMin:2000,ratingMin:7.5,ratingSource:'imdb'}),['tmdb:movie:4']);
 const s=h.screening.snapshot();assert.equal(s.candidates,3);assert.equal(s.checked,3);assert.equal(s.conditionsPassed,2);assert.equal(s.ratingChecked,2);assert.equal(s.ratingPassed,1);
 assert.deepEqual(h.ratingCalls[0].keys,['tmdb:movie:1','tmdb:movie:3']);assert.deepEqual(h.screening.eligible().map(c=>c.key),['tmdb:movie:1']);
});
test('missing required metadata triggers actual detail checks, and failed lookups stay unverified',()=>{
 const h=setup([c(1,{runtimeMinutes:null}),c(2,{runtimeMinutes:null})],{catalog:{getTitleDetails:(args,done)=>{
  const rows=[c(1,{runtimeMinutes:110})];rows.errors=[{key:'tmdb:movie:2',code:'catalog_limit'}];done(null,rows);return ()=>{};}}});
 h.check(filters({maxRuntimeMinutes:120}));const s=h.screening.snapshot();assert.equal(s.checked,1);assert.equal(s.unverified,1);assert.equal(s.metadataErrors,1);assert.equal(s.stopReason,'catalog_limit');
 assert.deepEqual(h.screening.eligible().map(c=>c.key),['tmdb:movie:1']);
});
test('missing rating and timeout are separate from below-threshold scores and cannot pass',()=>{
 const h=setup([c(1),c(2),c(3)],{ratings:{getMany:(items,source,done)=>{done(null,{'tmdb:movie:1':{value:null,error:null},'tmdb:movie:2':{value:null,error:{code:'timeout'}},'tmdb:movie:3':{value:6,error:null}});return ()=>{};}}});
 h.check(filters({ratingMin:7,ratingSource:'imdb'}));const s=h.screening.snapshot();assert.equal(s.checked,1);assert.equal(s.missingRatings,1);assert.equal(s.ratingErrors,1);assert.equal(s.ratingPassed,0);assert.equal(s.unverified,2);assert.deepEqual(h.screening.eligible(),[]);
});
test('changed rating source/threshold invalidates eligibility and repeated checks do not recount or re-request',()=>{
 const h=setup([c(1),c(2,{year:1990})]);h.check(filters({ratingMin:7,ratingSource:'imdb'}));h.check(filters({ratingMin:9,ratingSource:'imdb'}));
 assert.equal(h.screening.eligible().length,0);assert.equal(h.ratingCalls.length,1);
 h.check(filters({ratingMin:7,ratingSource:'kp',yearMin:2000}));assert.equal(h.ratingCalls.length,2);assert.equal(h.ratingCalls[1].source,'kp');assert.equal(h.screening.snapshot().candidates,2);
});
test('progress shows in-flight candidates and cancellation suppresses late verification',()=>{
 let reply;const h=setup([c(1)],{ratings:{getMany:(items,source,done)=>{reply=done;return ()=>{};}}});
 assert.equal(h.check(filters({ratingMin:7,ratingSource:'imdb'})),false);assert.equal(h.progress.at(-1).candidates,1);assert.equal(h.progress.at(-1).checked,0);
 h.screening.cancel();const count=h.progress.length;reply(null,{'tmdb:movie:1':{value:8,error:null}});assert.equal(h.progress.length,count);
});
