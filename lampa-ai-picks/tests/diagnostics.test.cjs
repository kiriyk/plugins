'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{createTransport}=require('../src/transport');
const {createDiagnostics}=require('../src/diagnostics');
function setup(options={}){const h=createHarness(),stored={...options.stored},lines=[];
 const Storage={get:(key,def)=>key in stored?stored[key]:def,set:(key,value)=>{if(options.storageError)throw Error('quota');stored[key]=value;}};
 const journal=createDiagnostics({Storage,clock:h.clock,console:{log:(...args)=>lines.push(args)},request:createTransport(h.Lampa,h.clock)});
 return {...h,stored,Storage,lines,journal,records:()=>JSON.parse(journal.exportText()).records};
}
test('diagnostics are opt-in and never record disabled requests',()=>{
 const h=setup();let result;
 h.journal.record('stage',{stage:'searching'});h.journal.request({url:'https://example/search/movie',method:'GET',headers:{},timeoutMs:1000},(e,v)=>result=v);
 h.nativeReply(0,{results:[]});assert.ok(result);assert.equal(h.records().length,0);assert.equal(h.lines.length,0);
});
test('real transport success timeout and cancellation get endpoint duration and safe parameters',()=>{
 const h=setup();h.journal.setEnabled(true);
 const runId=h.journal.begin({mode:'new'});
 const spec={url:'https://user:password@proxy.example/3/discover/movie?api_key=TMDB-SECRET&email=private%40mail.test&query=PRIVATE-QUERY&with_genres=18%7C35&with_runtime.lte=120',method:'GET',headers:{Authorization:'Bearer ROUTER-SECRET'},json:{key:'BODY-SECRET'},timeoutMs:1000};
 let result;h.journal.request(spec,(e,v)=>result=v,runId);h.advance(123);h.nativeReply(0,{results:[{id:1},{id:2}]});
 assert.equal(result.results.length,2);
 const start=h.records().find(r=>r.event==='request_start');
 assert.equal(start.endpoint,'discover/movie');assert.equal(start.host,'proxy.example');assert.equal(start.params.with_genres,'18|35');assert.equal(start.params['with_runtime.lte'],'120');
 const end=h.records().find(r=>r.event==='request_end');assert.equal(end.elapsedMs,123);assert.equal(end.count,2);assert.equal(end.ok,true);
 let error;h.journal.request(spec,e=>error=e,runId);h.advance(1000);assert.equal(error.code,'timeout');
 assert.ok(h.records().some(r=>r.event==='request_end'&&r.code==='timeout'&&r.elapsedMs===1000));
 const cancel=h.journal.request(spec,()=>assert.fail('cancelled callback'),runId);h.advance(50);cancel();h.nativeReply(2,{});
 assert.equal(h.records().filter(r=>r.event==='request_cancel').length,1);
 const serialized=h.journal.exportText()+JSON.stringify(h.lines);
 for(const secret of ['password','user:','TMDB-SECRET','private@mail.test','PRIVATE-QUERY','ROUTER-SECRET','BODY-SECRET','api_key','Authorization'])assert.equal(serialized.includes(secret),false,secret);
});
test('event schemas reject arbitrary secret fields and error messages even after reload',()=>{
 const h=setup();h.journal.setEnabled(true);
 h.journal.record('filters',{runId:1,filters:{media:'movie',genres:{movie:{include:[18],exclude:[27]}},countries:['US'],maxRuntimeMinutes:120,query:'HIDDEN'},key:'HIDDEN',prompt:'HIDDEN',response:'HIDDEN'});
 h.journal.record('run_error',{runId:1,code:'RAW-SECRET',message:'HIDDEN',status:502});
 h.journal.record('RAW-SECRET',{message:'HIDDEN'});
 const records=h.records();assert.equal(records.length,2);assert.equal(records[0].filters.genres.movie.exclude[0],27);assert.equal(records[1].code,'unknown');
 const loaded=createDiagnostics({Storage:h.Storage,clock:h.clock});assert.equal(loaded.isEnabled(),true);assert.equal(JSON.parse(loaded.exportText()).records.length,2);
 assert.equal(loaded.exportText().includes('HIDDEN'),false);assert.equal(loaded.exportText().includes('RAW-SECRET'),false);
 h.stored.aip_diagnostic_journal=JSON.stringify({version:1,records:[{event:'stage',at:1,stage:'searching',message:'TAMPERED-SECRET'}]});
 const tampered=createDiagnostics({Storage:h.Storage,clock:h.clock});assert.equal(tampered.exportText().includes('TAMPERED-SECRET'),false);
});
test('journal remains bounded clears persisted records and survives storage failures',()=>{
 const h=setup();h.journal.setEnabled(true);
 for(let i=0;i<500;i++)h.journal.record('stage',{runId:i+1,stage:'searching'});
 assert.equal(h.records().length,200);assert.ok(h.journal.exportText().length<=120000);
 h.journal.clear();assert.equal(h.records().length,0);
 const loaded=createDiagnostics({Storage:h.Storage,clock:h.clock});assert.equal(JSON.parse(loaded.exportText()).records.length,0);
 const broken=setup({storageError:true});assert.doesNotThrow(()=>{broken.journal.setEnabled(true);broken.journal.record('stage',{stage:'searching'});});
 assert.equal(broken.records().length,1);assert.equal(JSON.parse(broken.journal.exportText()).persistence,'memory');
});
test('unknown or encoded proxy paths cannot smuggle credentials into the journal',()=>{
 const h=setup();h.journal.setEnabled(true);
 h.journal.request({url:'https://proxy.example/token-SECRET/https%3A%2F%2Fapi.themoviedb.org%2F3%2Fsearch%2Fmovie%3Fapi_key%3DSECRET?url=SECRET&with_genres=SECRET',headers:{},method:'GET',timeoutMs:1000},()=>{});
 h.nativeReject(0,{status:403,responseText:'SECRET',message:'SECRET'});
 const data=h.journal.exportText();assert.equal(data.includes('SECRET'),false);
 assert.ok(h.records().some(r=>r.code==='auth'&&r.status===403));
});

test('rating requests retain provider scope and decimal filters without leaking KP headers',()=>{
 const h=setup();h.journal.setEnabled(true);h.journal.record('filters',{filters:{ratingSource:'kp',ratingMin:7.5}});
 h.journal.request({url:'https://kinopoiskapiunofficial.tech/api/v2.2/films?imdbId=tt0111161',method:'GET',headers:{'X-API-KEY':'KP-PRIVATE-KEY'},timeoutMs:1000},()=>{});
 h.nativeReply(0,{items:[]});const records=h.records();
 assert.equal(records[0].filters.ratingMin,7.5);assert.ok(records.some(r=>r.event==='request_start'&&r.scope==='rating'&&r.endpoint==='api/v2.2/films'));
 assert.equal(h.journal.exportText().includes('KP-PRIVATE-KEY'),false);
});
