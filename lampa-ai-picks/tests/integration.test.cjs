'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDOMHarness}=require('./helpers.cjs'),{assistant,dictionaries}=require('./fixtures.cjs');
const {registerPlugin}=require('../src/index');
function setup(t,options={}){
    const h=createDOMHarness({...options,storage:{aip_api_key:'test-key',aip_model:'test/model',...options.storage}});
    registerPlugin({window:h.window,Lampa:h.Lampa,clock:h.clock});
    const factory=h.registrations.find(x=>x.name==='aip_picks').constructor;
    const screen=new factory();h.document.getElementById('content').appendChild(screen.render());screen.create();screen.start();
    t.after(()=>screen.destroy());
    function boot(){
        for(let i=0;i<h.nativeRequests.length;i++){
            const r=h.nativeRequests[i];if(r.answered||r.post)continue;let data;
            if(r.url.includes('genre/movie'))data={genres:dictionaries.genres.movie};
            if(r.url.includes('genre/tv'))data={genres:dictionaries.genres.tv};
            if(r.url.includes('configuration/countries'))data=dictionaries.countries.map(c=>({iso_3166_1:c.code,native_name:c.name}));
            if(data){r.answered=true;h.nativeReply(i,data);}
        }
    }
    function model(calls=[],content=null){
        const i=h.nativeRequests.findIndex(r=>r.post&&!r.answered);assert.ok(i>=0,'pending RouterAI request');
        h.nativeRequests[i].answered=true;h.nativeReply(i,assistant(calls,content));return i;
    }
    function found(id,type='movie'){
        const i=h.nativeRequests.findIndex(r=>r.url.includes('discover/')&&!r.answered);assert.ok(i>=0,'pending discovery');
        h.nativeRequests[i].answered=true;
        const raw={id,genre_ids:[18],production_countries:[{iso_3166_1:'US'}],overview:'Без спойлеров.',runtime:110};
        if(type==='tv'){raw.name='Сериал '+id;raw.first_air_date='2010-01-01';raw.episode_run_time=[40,50];}
        else{raw.title='Фильм '+id;raw.release_date='2010-01-01';}
        h.nativeReply(i,{results:[raw]});
    }
    function text(query){h.enter('[data-action="query"]');h.inputs.at(-1).done(query);}
    function submit(){h.enter('[data-action="submit"]');boot();model([{id:'intent-'+h.nativeRequests.length,name:'set_search_intent',arguments:{}}]);}
    function finish(id,type='movie'){
        model([{id:'discover-'+h.nativeRequests.length,name:'discover_titles',arguments:{type}}]);found(id,type);
        model([],JSON.stringify({picks:[{key:'tmdb:'+type+':'+id,reason:'Подходит по настроению.'}]}));
    }
    return {...h,screen,boot,model,found,text,submit,finish};
}
test('full text search opens standard TV card with explicit type and returns to selection',t=>{
    const h=setup(t);h.text('Детективный сериал');h.enter('[data-action="filters"]');h.enter('[data-action="format"]');h.choose('tv');
    h.submit();h.finish(2,'tv');
    assert.equal(h.screen.element().querySelector('[data-key]').getAttribute('data-key'),'tmdb:tv:2');
    h.enter('.card');assert.equal(h.pushes.at(-1).component,'full');assert.equal(h.pushes.at(-1).method,'tv');assert.equal(h.pushes.at(-1).source,'tmdb');
    h.screen.stop();h.screen.start();assert.equal(h.screen.element().querySelectorAll('.aip-pick').length,1);
});
test('refinement preserves explicit year, keeps old cards until success and ignores late old reply',t=>{
    const h=setup(t);h.text('Кино');h.enter('[data-action="filters"]');h.enter('[data-action="year-min"]');h.inputs.at(-1).done('2000');
    h.submit();h.finish(2);
    h.enter('[data-action="refine"]');h.inputs.at(-1).done('меньше драмы');h.boot();
    assert.equal(h.screen.element().querySelector('[data-key]').getAttribute('data-key'),'tmdb:movie:2');
    h.model([{id:'refine',name:'set_search_intent',arguments:{preferences:['меньше драмы']}}]);
    h.finish(3);
    assert.equal(h.screen.getRequest('new').formFilters.yearMin,2000);
    assert.equal(h.screen.element().querySelector('[data-key]').getAttribute('data-key'),'tmdb:movie:3');
});
test('more excludes shown IDs and API error preserves current cards and query',t=>{
    const h=setup(t);h.text('Кино');h.submit();h.finish(2);
    h.enter('[data-action="more"]');h.boot();
    const i=h.nativeRequests.findIndex(r=>r.post&&!r.answered),body=JSON.parse(h.nativeRequests[i].post);
    assert.deepEqual(JSON.parse(body.messages[1].content).shown,['tmdb:movie:2']);
    h.nativeReject(i,{status:402});
    assert.equal(h.screen.element().querySelector('[data-key]').getAttribute('data-key'),'tmdb:movie:2');
    assert.equal(h.screen.getRequest('new').query,'Кино');assert.ok(h.screen.element().textContent.includes('Недостаточно'));
});
test('settings change cancels in-flight generation and late final cannot overwrite existing cards',t=>{
    const h=setup(t);h.text('Кино');h.submit();h.finish(2);
    h.enter('[data-action="refine"]');h.inputs.at(-1).done('другое');h.boot();
    const i=h.nativeRequests.findIndex(r=>r.post&&!r.answered);
    h.enter('[data-action="settings"]');h.choose('Ключ RouterAI');h.inputs.at(-1).done('new-key');
    h.nativeReply(i,assistant([], '{"picks":[]}'));
    assert.equal(h.screen.element().querySelector('[data-key]').getAttribute('data-key'),'tmdb:movie:2');
});
test('parsed text conditions are displayed without becoming explicit form locks',t=>{
    const h=setup(t);h.text('Кино до двух часов');h.enter('[data-action="submit"]');h.boot();
    h.model([{id:'intent',name:'set_search_intent',arguments:{filters:{maxRuntimeMinutes:120}}}]);h.finish(2);
    assert.equal(h.screen.getRequest('new').formFilters.maxRuntimeMinutes,undefined);
    assert.ok(h.screen.element().textContent.includes('120'));
});

test('pult focus scrolls to result cards and actions and survives full-card return',t=>{
    const h=setup(t);h.text('Кино');h.submit();h.finish(2);
    const card=h.screen.element().querySelector('.card'), more=h.screen.element().querySelector('[data-action="more"]');
    assert.ok(h.scrollUpdates.at(-1).element===card,'card focus must scroll its DOM element');
    more.dispatchEvent(new h.window.Event('hover:focus'));
    assert.ok(h.scrollUpdates.at(-1).element===more,'result action must scroll');
    h.screen.stop();h.screen.start();assert.ok(h.focuses.at(-1)===more,'return must restore result action');
    card.dispatchEvent(new h.window.Event('hover:focus'));h.enter(card);
    h.screen.stop();h.screen.start();
    assert.ok(h.focuses.at(-1)===card,'return must restore card');assert.ok(h.scrollUpdates.at(-1).element===card,'card focus must scroll its DOM element');
    h.enter('[data-action="why"]');h.modals.at(-1).onBack();
    assert.equal(h.scrollUpdates.at(-1).element.getAttribute('data-action'),'why');
});


test('stored search limits are passed from app settings into the live screen controller',t=>{
    const h=setup(t);h.storage.aip_model_steps='3';h.text('Кино');h.submit();
    h.model([{id:'discover',name:'discover_titles',arguments:{type:'movie'}}]);h.found(2);
    const pending=h.nativeRequests.find(r=>r.post&&!r.answered);
    assert.equal(JSON.parse(pending.post).tool_choice,'none');
    h.model([], '{"picks":[{"key":"tmdb:movie:2","reason":"Подходит."}]}');
    assert.equal(h.screen.element().querySelectorAll('.aip-pick').length,1);
});


test('opt-in journal traces real filters endpoints timeouts and final rejection reasons',t=>{
 const h=setup(t);h.storage.aip_diagnostics='true';h.text('PRIVATE-QUERY');h.enter('[data-action="runtime"]');h.inputs.at(-1).done('120');
 h.submit();h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);
 const i=h.nativeRequests.findIndex(r=>r.url.includes('discover/')&&!r.answered);h.nativeRequests[i].answered=true;
 h.nativeReply(i,{results:[{id:2,title:'Длинный',runtime:138},{id:3,title:'Короткий',runtime:100}]});
 h.model([], '{"picks":[{"key":"tmdb:movie:2","reason":"PRIVATE-REASON"},{"key":"tmdb:movie:3","reason":"Подходит."}]}');
 const journal=h.window.__aipPicksPlugin.diagnostics,records=JSON.parse(journal.exportText()).records;
 assert.ok(records.some(r=>r.event==='filters'&&r.filters.maxRuntimeMinutes===120));
 assert.ok(records.some(r=>r.event==='request_start'&&r.endpoint==='discover/movie'&&r.params['with_runtime.lte']==='120'));
 assert.ok(records.some(r=>r.event==='candidate_rejected'&&r.key==='tmdb:movie:2'&&r.reason==='runtime'));
 assert.equal(records.find(r=>r.event==='candidate_rejected').facts.runtimeMinutes,138);
 assert.ok(records.some(r=>r.event==='run_done'&&r.count===1));
 for(const secret of ['test-key','PRIVATE-QUERY','PRIVATE-REASON'])assert.equal(journal.exportText().includes(secret),false);
 h.enter('[data-action="more"]');h.boot();h.advance(25000);
 assert.ok(JSON.parse(journal.exportText()).records.some(r=>r.event==='run_error'&&r.code==='timeout'));
});

test('journal distinguishes a catalog timeout from the whole-search deadline',t=>{
 const h=setup(t);h.storage.aip_diagnostics='true';h.text('Кино');h.submit();
 h.model([{id:'find',name:'discover_titles',arguments:{type:'movie'}}]);h.advance(10000);
 const rows=JSON.parse(h.window.__aipPicksPlugin.diagnostics.exportText()).records;
 const start=rows.find(r=>r.event==='request_start'&&r.endpoint==='discover/movie');
 const end=rows.find(r=>r.event==='request_end'&&r.requestId===start.requestId);
 assert.equal(end.code,'timeout');assert.equal(end.scope,'catalog');assert.equal(end.elapsedMs,10000);
});
test('journal labels cancellation caused by the overall deadline as search timeout',t=>{
 const h=setup(t);h.storage.aip_diagnostics='true';h.storage.aip_model_timeout_seconds='60';h.storage.aip_search_timeout_seconds='30';
 h.text('Кино');h.submit();h.advance(30000);
 const rows=JSON.parse(h.window.__aipPicksPlugin.diagnostics.exportText()).records;
 assert.ok(rows.some(r=>r.event==='run_error'&&r.code==='timeout'&&r.scope==='search'));
 assert.ok(rows.some(r=>r.event==='request_end'&&r.code==='timeout'&&r.scope==='search'));
});
test('app can enable diagnostics in memory under storage failure and keep its choice across searches',t=>{
 const h=setup(t,{storageError:true}),journal=h.window.__aipPicksPlugin.diagnostics;
 h.enter('[data-action="settings"]');h.choose('Диагностика');h.choose('toggle');
 assert.equal(journal.isEnabled(),true,'explicit toggle must work without persistent writes');
 h.text('Кино');h.submit();h.finish(2);
 const first=JSON.parse(journal.exportText());assert.equal(first.persistence,'memory');assert.ok(first.records.some(r=>r.event==='run_done'));
 h.enter('[data-action="settings"]');h.choose('Диагностика');h.choose('view');
 assert.ok(JSON.parse(h.modals.at(-1).html[0].textContent).records.length>0);h.modals.at(-1).onBack();
 h.enter('[data-action="settings"]');h.choose('Диагностика');h.choose('toggle');assert.equal(journal.isEnabled(),false);
 const count=JSON.parse(journal.exportText()).records.length;
 h.text('Другое кино');h.submit();h.finish(3);
 assert.equal(journal.isEnabled(),false);assert.equal(JSON.parse(journal.exportText()).records.length,count);
});
