'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{intent,movie,dictionaries}=require('./fixtures.cjs');
const {createCandidateStore}=require('../src/domain'),{createTools}=require('../src/tools'),{createCatalog}=require('../src/catalog');
function setup(){const h=createHarness(),store=createCandidateStore(80),clarifications=[];
    const tools=createTools({catalog:createCatalog({request:h.request,Lampa:h.Lampa}),store,formFilters:{},dictionaries,intent:intent(),onClarification:c=>clarifications.push(c)});
    return {...h,store,tools,clarifications};}
let nextId=0;
function call(h,name,args,done=()=>{},id){return h.tools.execute({id:id||'id-'+(++nextId),name,arguments:typeof args==='string'?args:JSON.stringify(args)},done);}
function ready(h){call(h,'set_search_intent',{filters:{media:'movie'}});}
test('search is blocked until intent is normalized',()=>{
    const h=setup();let error;call(h,'search_titles',{query:'x',type:'movie'},e=>error=e);
    assert.equal(error.code,'intent_required');assert.equal(h.requests.length,0);
    ready(h);call(h,'search_titles',{query:'x',type:'movie'});assert.equal(h.requests.length,1);
});
test('unknown functions, invalid JSON and extra properties never reach catalog',()=>{
    const h=setup();ready(h);
    for(const [name,args] of [['eval',{}],['search_titles','{bad'],['search_titles',{query:'x',type:'movie',url:'https://evil.example'}]]){
        let error;call(h,name,args,e=>error=e);assert.ok(error);assert.equal(h.requests.length,0);
    }
});
test('invented title and keyword IDs do not execute a network request',()=>{
    const h=setup();ready(h);let error;
    call(h,'get_related',{key:'tmdb:movie:99',relation:'similar'},e=>error=e);assert.equal(error.code,'unknown_title');
    call(h,'discover_titles',{type:'movie',keywordIds:[999]},e=>error=e);assert.equal(error.code,'unknown_keyword');
    call(h,'get_title_details',{keys:Array.from({length:11},(_,i)=>'tmdb:movie:'+(i+1))},e=>error=e);assert.equal(error.code,'invalid_arguments');
    assert.equal(h.requests.length,0);
});
test('resolved keyword enables discovery and hard restrictions are preserved',()=>{
    const h=setup();call(h,'set_search_intent',{filters:{maxRuntimeMinutes:120}});
    call(h,'resolve_keywords',{query:'detective'});h.reply(0,{results:[{id:703,name:'detective'}]});
    let result;call(h,'discover_titles',{type:'movie',genreIds:[18],keywordIds:[703]},(e,r)=>result=r);
    assert.equal(new URL(h.requests[1].url).searchParams.get('with_runtime.lte'),'120');
    h.reply(1,{results:[{id:1,title:'A',overview:'я'.repeat(501)}]});
    assert.equal(result.items[0].overview.length,500);assert.equal(h.store.get('tmdb:movie:1').overview.length,501);
});
test('details enrich known candidates and related requests use exact identity',()=>{
    const h=setup();ready(h);h.store.add(movie({runtimeMinutes:null}));
    let result;call(h,'get_title_details',{keys:['tmdb:movie:1']},(e,r)=>result=r);
    h.reply(0,{id:1,title:'A',runtime:119});assert.equal(result.items[0].runtimeMinutes,119);
    call(h,'get_related',{key:'tmdb:movie:1',relation:'recommendations'});
    assert.match(h.requests[1].url,/movie\/1\/recommendations/);
});
test('each tool response limits results to twenty and only accepted candidates enter store',()=>{
    const h=setup();ready(h);let result;
    call(h,'search_titles',{query:'x',type:'movie'},(e,r)=>result=r);
    h.reply(0,{results:Array.from({length:25},(_,i)=>({id:i+1,title:'x'}))});
    assert.equal(result.items.length,20);assert.equal(h.store.all().length,20);
});
test('duplicate call IDs replay once, including concurrent callbacks, but cannot change arguments',()=>{
    const h=setup();ready(h);let replies=0,error;
    call(h,'search_titles',{query:'x',type:'movie'},()=>replies++,'same');
    call(h,'search_titles',{query:'x',type:'movie'},()=>replies++,'same');
    assert.equal(h.requests.length,1);h.reply(0,{results:[]});assert.equal(replies,2);
    call(h,'search_titles',{query:'x',type:'movie'},()=>replies++,'same');assert.equal(replies,3);
    call(h,'search_titles',{query:'other',type:'movie'},e=>error=e,'same');assert.equal(error.code,'invalid_arguments');
});
test('ambiguous text example pauses for user selection instead of guessing',()=>{
    const h=setup();ready(h);
    call(h,'search_titles',{query:'Crash',type:'movie',purpose:'example'});
    h.reply(0,{results:[{id:1,title:'Crash',release_date:'1996-01-01'},{id:2,title:'Crash',release_date:'2004-01-01'}]});
    assert.equal(h.clarifications.length,1);assert.equal(h.clarifications[0].kind,'example');assert.equal(h.clarifications[0].options.length,2);
});
test('explicit form conflict produces a filter clarification',()=>{
    const h=createHarness();const clarification=[];
    const tools=createTools({catalog:{},store:createCandidateStore(80),formFilters:{yearMin:2000},dictionaries,intent:intent(),onClarification:c=>clarification.push(c)});
    tools.execute({id:'x',name:'set_search_intent',arguments:'{"filters":{"yearMin":2010}}'},()=>{});
    assert.equal(clarification[0].kind,'filters');
});
