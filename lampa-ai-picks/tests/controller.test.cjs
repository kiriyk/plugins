'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{createRouterAI}=require('../src/routerai'),{createController}=require('../src/controller');
const {createSession}=require('../src/session'),{assistant,movie,dictionaries}=require('./fixtures.cjs');
function setup(){
    const h=createHarness(),events=[],session=createSession();
    const c=createController({Lampa:h.Lampa,request:h.request,routerai:createRouterAI({request:h.request}),session,clock:h.clock,onEvent:e=>events.push(e)});
    function catalogReply(row){
        if(row.url.includes('genre/movie'))return {genres:dictionaries.genres.movie};
        if(row.url.includes('genre/tv'))return {genres:dictionaries.genres.tv};
        if(row.url.includes('configuration/countries'))return dictionaries.countries.map(c=>({iso_3166_1:c.code,native_name:c.name}));
        return null;
    }
    function boot(args={}){
        const id=c.start({query:'лёгкое кино',formFilters:{},examples:[],key:'test-key',model:'test/model',mode:'new',...args});
        for(let i=0;i<h.requests.length;i++){const row=h.requests[i];const data=catalogReply(row);if(data&&!row.answered){row.answered=true;h.reply(i,data);}}
        return id;
    }
    function model(calls=[],content=null){
        const index=h.requests.findIndex(r=>r.method==='POST'&&!r.answered);assert.ok(index>=0,'pending model request');
        h.requests[index].answered=true;h.reply(index,assistant(calls,content));return index;
    }
    function intent(patch={}){return model([{id:'intent-'+h.requests.length,name:'set_search_intent',arguments:patch}]);}
    function found(id=2){
        const index=h.requests.findIndex(r=>r.url.includes('discover/')&&!r.answered);assert.ok(index>=0);
        h.requests[index].answered=true;h.reply(index,{results:[{id,title:'Найденный',release_date:'2010-01-01',genre_ids:[18],runtime:110,production_countries:[{iso_3166_1:'US'}],overview:'Расследование.'}]});
    }
    return {...h,events,session,c,boot,model,intent,found,posts:()=>h.requests.filter(r=>r.method==='POST')};
}
test('complete search commits only validated final picks and suppresses duplicate callbacks',()=>{
    const h=setup();h.boot({formFilters:{yearMin:2000,maxRuntimeMinutes:120}});h.intent();
    h.model([{id:'discover',name:'discover_titles',arguments:{type:'movie'}}]);h.found();
    const i=h.model([], '{"picks":[{"key":"tmdb:movie:2","reason":"Расследование."},{"key":"tmdb:movie:999","reason":"fake"}]}');
    assert.equal(h.c.getState().stage,'done');assert.deepEqual(h.session.getShown(),['tmdb:movie:2']);
    h.reply(i,assistant([], '{"picks":[]}'));assert.equal(h.events.filter(e=>e.type==='result').length,1);
    assert.equal(h.posts().length,3);assert.equal(h.timers.size,0);
});
test('fifth call is reserved for finalization and unknown tools consume bounded attempts',()=>{
    const h=setup();h.boot({examples:[movie()]});h.intent();
    for(let round=0;round<3;round++)h.model(Array.from({length:5},(_,i)=>({id:'bad-'+round+'-'+i,name:'unknown',arguments:{}})));
    assert.equal(h.posts().length,5);assert.equal(h.posts()[4].json.tool_choice,'none');
    h.model([], '{"picks":[]}');assert.equal(h.posts().length,5);assert.equal(h.c.getState().stage,'done');
});
test('invalid final JSON may be corrected only within the five-call budget',()=>{
    const h=setup();h.boot({examples:[movie()]});h.intent();
    h.model([], 'bad');h.model([], 'bad');h.model([], 'bad');h.model([], 'bad');
    assert.equal(h.posts().length,5);assert.equal(h.c.getState().stage,'error');assert.equal(h.session.size(),0);
});
test('cancellation and replacement ignore late replies and preserve previous session',()=>{
    const h=setup();const old=h.boot();h.intent();const pending=h.requests.findIndex(r=>r.method==='POST'&&!r.answered);
    const next=h.boot({query:'другое',model:'test/other'});
    assert.notEqual(old,next);h.reply(pending,assistant([], '{"picks":[]}'));
    assert.equal(h.events.filter(e=>e.type==='result').length,0);assert.equal(h.session.size(),0);
    h.c.cancel();h.advance(90001);assert.equal(h.c.getState().stage,'cancelled');assert.equal(h.timers.size,0);
});
for(const status of [402,429]){
    test('RouterAI HTTP '+status+' stops without automatic retry',()=>{
        const h=setup();h.boot();const i=h.requests.findIndex(r=>r.method==='POST');
        h.reject(i,{status});assert.equal(h.c.getState().stage,'error');assert.equal(h.posts().length,1);
        assert.equal(h.events.at(-1).data.code,status===402?'balance':'rate_limit');
    });
}
test('model timeout ends search and never shows raw candidates',()=>{
    const h=setup();h.boot({examples:[movie()]});h.advance(25000);
    assert.equal(h.c.getState().stage,'error');assert.equal(h.events.at(-1).data.code,'timeout');
    h.advance(90001);assert.equal(h.events.some(e=>e.type==='result'),false);assert.equal(h.posts().length,1);
});
test('overall ninety-second deadline bounds otherwise timely model calls',()=>{
    const h=setup();h.boot({examples:[movie()]});h.advance(24000);h.intent();
    for(let i=0;i<2;i++){h.advance(24000);h.model([{id:'bad-'+i,name:'unknown',arguments:{}}]);}
    h.advance(18001);assert.equal(h.c.getState().stage,'error');assert.equal(h.events.at(-1).data.code,'timeout');assert.equal(h.posts().length,4);
});
test('empty candidate pool completes without a pointless final model request',()=>{
    const h=setup();h.boot();h.intent();
    for(let i=0;i<3;i++)h.model([{id:'bad-'+i,name:'unknown',arguments:{}}]);
    assert.equal(h.posts().length,4);assert.equal(h.c.getState().stage,'done');
    assert.equal(h.events.at(-1).data.result.items.length,0);
});
test('ambiguous example selection starts a new run and refuses unoffered choices',()=>{
    const h=setup();h.boot();h.intent();
    h.model([{id:'example',name:'search_titles',arguments:{query:'Crash',type:'movie',purpose:'example'}}]);
    const i=h.requests.findIndex(r=>r.url.includes('search/movie'));h.reply(i,{results:[{id:10,title:'Crash'},{id:11,title:'Crash'}]});
    assert.equal(h.c.getState().stage,'clarification');const before=h.c.getState().runId;
    assert.equal(h.c.resolveClarification({kind:'example',key:'tmdb:movie:999'}),null);
    const after=h.c.resolveClarification({kind:'example',key:'tmdb:movie:10'});assert.ok(after>before);
    h.c.cancel();
});
test('more retains intent and excludes already shown titles without clearing it on error',()=>{
    const h=setup();h.boot({formFilters:{yearMin:2000}});h.intent();h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);h.found();h.model([], '{"picks":[{"key":"tmdb:movie:2","reason":"x"}]}');
    h.boot({mode:'more',query:''});assert.equal(h.session.getIntent().filters.yearMin,2000);
    const state=JSON.parse(h.posts().at(-1).json.messages[1].content);assert.deepEqual(state.shown,['tmdb:movie:2']);
    h.c.cancel();assert.deepEqual(h.session.getShown(),['tmdb:movie:2']);
});


test('configured step count reserves its last model request for finalization',()=>{
    const h=setup();h.boot({examples:[movie()],limits:{modelCalls:3,toolCalls:48}});h.intent();
    h.model([{id:'unknown',name:'unknown',arguments:{}}]);
    assert.equal(h.posts().length,3);assert.equal(h.posts()[2].json.tool_choice,'none');
    h.model([], '{"picks":[]}');assert.equal(h.c.getState().stage,'done');assert.equal(h.posts().length,3);
});
test('configured request timeouts reach catalog and model transports',()=>{
    const h=setup();h.boot({limits:{modelTimeoutMs:60000,catalogTimeoutMs:20000}});
    assert.equal(h.requests[0].timeoutMs,20000);assert.equal(h.posts()[0].timeoutMs,60000);
    h.advance(25001);assert.notEqual(h.c.getState().stage,'error');h.c.cancel();
});
test('configured total deadline stops a model that has a longer timeout',()=>{
    const h=setup();h.boot({limits:{modelTimeoutMs:60000,totalTimeoutMs:30000}});
    assert.equal(h.posts()[0].timeoutMs,30000);h.advance(29999);assert.notEqual(h.c.getState().stage,'error');
    h.advance(1);assert.equal(h.c.getState().stage,'error');assert.equal(h.events.at(-1).data.code,'timeout');
});
test('requested card count limits accepted picks without a false partial warning',()=>{
    const h=setup();h.boot({limits:{resultCount:1}});h.intent();h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);
    const i=h.requests.findIndex(r=>r.url.includes('discover/'));
    h.reply(i,{results:[{id:2,title:'Первый'},{id:3,title:'Второй'}]});
    h.model([], '{"picks":[{"key":"tmdb:movie:2","reason":"Первый."},{"key":"tmdb:movie:3","reason":"Второй."}]}');
    const result=h.events.at(-1).data.result;assert.equal(result.items.length,1);assert.equal(result.partial,false);assert.equal(result.notice,null);
});

test('all candidates are screened before final AI selection; IMDb rating failures cannot enter results',()=>{
 const h=setup();h.boot({formFilters:{yearMin:2000,ratingMin:7.5,ratingSource:'imdb'}});h.intent();
 h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);
 const i=h.requests.findIndex(r=>r.url.includes('discover/'));h.reply(i,{results:[
  {id:1,title:'A',release_date:'2010-01-01',imdb_id:'tt0000001'},
  {id:2,title:'B',release_date:'2010-01-01',imdb_id:'tt0000002'},
  {id:3,title:'C',release_date:'1990-01-01',imdb_id:'tt0000003'}]});
 const rating=h.requests.findIndex(r=>r.url.includes('agregarr'));assert.ok(rating>=0);
 assert.equal(h.posts().length,2,'model must wait for all eligible candidates to be rated');
 assert.equal(new URL(h.requests[rating].url).searchParams.getAll('id').length,2);
 h.reply(rating,[{imdbId:'tt0000001',rating:8},{imdbId:'tt0000002',rating:6}]);
 const state=JSON.parse(h.posts().at(-1).json.messages[1].content);assert.deepEqual(state.candidates.map(c=>c.key),['tmdb:movie:1']);
 h.model([],JSON.stringify({picks:[{key:'tmdb:movie:2',reason:'bad'},{key:'tmdb:movie:1',reason:'good'}]}));
 const result=h.events.at(-1).data.result;assert.equal(result.items.length,1);assert.equal(result.stats.candidates,3);assert.equal(result.stats.checked,3);assert.equal(result.stats.conditionsPassed,2);assert.equal(result.stats.ratingPassed,1);assert.equal(result.stats.selected,1);
 assert.equal(h.events.some(e=>e.type==='progress'&&e.data.candidates===3),true);assert.equal(h.timers.size,0);
});
test('global timeout preserves incomplete verification progress and never commits unverified films',()=>{
 const h=setup();h.boot({formFilters:{ratingMin:7,ratingSource:'imdb'},limits:{totalTimeoutMs:30000,catalogTimeoutMs:60000}});h.intent();
 h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);h.found();
 h.advance(30000);assert.equal(h.c.getState().stage,'error');assert.equal(h.session.size(),0);
 assert.ok(h.events.some(e=>e.type==='progress'&&e.data.candidates===1&&e.data.unverified===1));
});
