'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDOMHarness}=require('./helpers.cjs'),{movie,tv,intent}=require('./fixtures.cjs');
const {createResults}=require('../src/results');
test('uses real Maker lifecycle, explicit TV identity and keyboard-accessible explanation',()=>{
    const h=createDOMHarness(),opened=[];let more=0,refine=0;
    const r=createResults({Lampa:h.Lampa,document:h.document,$:h.$,onMore:()=>more++,onRefine:()=>refine++,onOpen:c=>opened.push(c)});
    h.document.body.appendChild(r.element());
    r.render({items:[{candidate:tv(),reason:'<img src=x onerror=evil()> Без спойлеров.'}],partial:true,notice:'Меньше десяти.'},intent());
    assert.equal(h.madeCards.length,1);assert.equal(h.madeCards[0].visibleCount,1);
    h.enter('.card',r.element());assert.equal(opened[0].key,'tmdb:tv:1');
    h.enter('[data-action="why"]',r.element());const dialog=h.modals.at(-1);
    assert.equal(dialog.title,'Почему предложен');assert.ok(dialog.html[0].textContent.includes('<img src=x'));assert.equal(dialog.html[0].querySelector('img'),null);
    dialog.onBack();assert.ok(h.focuses.at(-1));
    h.enter('[data-action="more"]',r.element());h.enter('[data-action="refine"]',r.element());
    assert.equal(more,1);assert.equal(refine,1);
    r.destroy();assert.equal(h.madeCards[0].destroyed,true);
});
test('empty results offer changing conditions and replace old cards without leaking Maker instances',()=>{
    const h=createDOMHarness(),r=createResults({Lampa:h.Lampa,document:h.document,$:h.$,onMore(){},onRefine(){},onOpen(){}});
    r.render({items:[{candidate:movie(),reason:'x'}],partial:false,notice:null},intent());
    r.render({items:[],partial:true,notice:'Ничего не найдено.'},intent());
    assert.equal(h.madeCards[0].destroyed,true);assert.equal(r.element().querySelectorAll('.aip-pick').length,0);
    assert.ok(r.element().textContent.includes('Изменить условия'));r.destroy();
});

test('large results reveal twenty at a time without another search and sources are safe plain text',()=>{
 const h=createDOMHarness();let more=0;
 const r=createResults({Lampa:h.Lampa,document:h.document,$:h.$,onMore:()=>more++,onRefine(){},onOpen(){}});
 h.document.body.appendChild(r.element());
 const items=Array.from({length:25},(_,i)=>({candidate:movie({id:i+1,key:'tmdb:movie:'+(i+1),webSources:[{id:'p',title:'<img src=x onerror=evil()>',domain:'films.example'}]}),reason:'Подходит.'}));
 r.render({items});assert.equal(h.madeCards.length,20);assert.match(r.element().textContent,/25.*20/);
 h.enter('[data-action="why"]',r.element());assert.match(h.modals.at(-1).html[0].textContent,/films.example/);assert.equal(h.modals.at(-1).html[0].querySelector('img'),null);h.modals.at(-1).onBack();
 h.enter('[data-action="next-page"]',r.element());assert.equal(h.madeCards.length,25);assert.equal(more,0);assert.equal(r.element().querySelector('[data-action="next-page"]'),null);
 r.destroy();assert.ok(h.madeCards.every(c=>c.destroyed));
});
