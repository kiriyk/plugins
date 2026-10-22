'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDOMHarness}=require('./helpers.cjs'),{createScreen}=require('../src/ui'),{movie,dictionaries}=require('./fixtures.cjs');
function setup(){const h=createDOMHarness(),submissions=[];let cancelled=0;
    const catalog={getDictionaries:done=>{done(null,dictionaries);return ()=>{};},searchTitles:(args,done)=>{done(null,{items:[movie()],hasMore:false});return ()=>{};}};
    const screen=createScreen({Lampa:h.Lampa,document:h.document,catalog,onSubmit:q=>submissions.push(q),onCancel:()=>cancelled++,onSettings(){}});
    h.document.getElementById('content').appendChild(screen.render());screen.create();screen.start();
    return {...h,screen,catalog,submissions,cancelled:()=>cancelled};}
test('empty query is blocked but filters-only submission works',()=>{
    const h=setup();h.enter('[data-action="submit"]');assert.equal(h.submissions.length,0);
    h.enter('[data-action="filters"]');h.enter('[data-action="runtime"]');h.inputs.at(-1).done('120');
    h.enter('[data-action="submit"]');assert.equal(h.submissions.length,1);assert.equal(h.submissions[0].query,'');
    assert.equal(h.submissions[0].formFilters.maxRuntimeMinutes,120);
});
test('text entry and format selection update request and TV duration label',()=>{
    const h=setup();h.enter('[data-action="query"]');h.inputs.at(-1).done('Лёгкое кино');
    h.enter('[data-action="format"]');h.choose('tv');
    assert.ok(h.screen.element().textContent.includes('Длительность серии'));
    assert.equal(h.screen.getRequest('new').formFilters.media,'tv');assert.equal(h.screen.getRequest('new').query,'Лёгкое кино');
});
test('examples alone can start and fourth example is not added',()=>{
    const h=setup();
    let next=0;h.catalog.searchTitles=(args,done)=>{const id=++next;done(null,{items:[movie({id,key:'tmdb:movie:'+id})]});return ()=>{};};
    for(let i=0;i<3;i++){h.enter('[data-action="example"]');h.inputs.at(-1).done('Фильм');h.choose('tmdb:movie:'+(i+1));}
    const inputCount=h.inputs.length;h.enter('[data-action="example"]');
    assert.equal(h.inputs.length,inputCount);assert.equal(h.screen.getRequest('new').examples.length,3);
    h.enter('[data-action="submit"]');assert.equal(h.submissions.length,1);
});
test('filter dialog restores focus, invalid number never starts a search',()=>{
    const h=setup();h.enter('[data-action="filters"]');h.enter('[data-action="runtime"]');h.inputs.at(-1).done('не число');
    assert.equal(h.screen.getRequest('new').formFilters.maxRuntimeMinutes,undefined);
    h.enter('[data-action="format"]');h.selects.at(-1).onBack();assert.ok(h.focuses.length>0);
});
test('busy state blocks duplicate submission and cancellation restores controls',()=>{
    const h=setup();h.enter('[data-action="query"]');h.inputs.at(-1).done('Кино');h.screen.setStage('searching');
    h.enter('[data-action="submit"]');assert.equal(h.submissions.length,0);
    h.enter('[data-action="cancel"]');assert.equal(h.cancelled(),1);
    h.screen.destroy();assert.equal(h.cancelled(),2);
});

test('checking then clearing a genre does not turn empty input into a valid request',()=>{
    const h=setup();h.enter('[data-action="filters"]');h.enter('[data-action="movie-genres"]');
    h.choose(18);h.choose(18);h.selects.at(-1).onBack();h.enter('[data-action="submit"]');assert.equal(h.submissions.length,0);
});
test('search stage disables editable controls so old results cannot overwrite new edits',()=>{
    const h=setup();h.screen.setStage('searching');h.enter('[data-action="query"]');assert.equal(h.inputs.length,0);
});

test('form genre selection leaves textual exclusions and other media unlocked',()=>{
    const h=setup(), d=require('../src/domain');
    h.enter('[data-action="movie-genres"]');h.choose(18);h.selects.at(-1).onBack();
    const locks=h.screen.getRequest('new').formFilters;
    assert.deepEqual(locks,{genres:{movie:{include:[18]}}});
    const result=d.resolveIntent(d.emptyIntent(),{filters:{genres:{movie:{exclude:[27]}}}},locks,dictionaries);
    assert.equal(result.status,'ready');
    assert.deepEqual(result.intent.filters.genres.movie,{include:[18],exclude:[27]});
    h.enter('[data-action="movie-exclude"]');h.choose(27);
    assert.deepEqual(h.screen.getRequest('new').formFilters.genres.movie,{include:[18],exclude:[27]});
});
