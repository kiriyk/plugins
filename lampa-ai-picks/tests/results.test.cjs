'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDOMHarness}=require('./helpers.cjs'),{movie,tv,intent}=require('./fixtures.cjs');
const {createResults}=require('../src/results');
test('uses real Maker lifecycle, explicit TV identity and keyboard-accessible explanation',()=>{
    const h=createDOMHarness(),opened=[];let more=0,refine=0;
    const r=createResults({Lampa:h.Lampa,document:h.document,onMore:()=>more++,onRefine:()=>refine++,onOpen:c=>opened.push(c)});
    h.document.body.appendChild(r.element());
    r.render({items:[{candidate:tv(),reason:'<img src=x onerror=evil()> Без спойлеров.'}],partial:true,notice:'Меньше десяти.'},intent());
    assert.equal(h.madeCards.length,1);assert.equal(h.madeCards[0].visibleCount,1);
    h.enter('.card',r.element());assert.equal(opened[0].key,'tmdb:tv:1');
    h.enter('[data-action="why"]',r.element());const dialog=h.modals.at(-1);
    assert.equal(dialog.title,'Почему предложен');assert.ok(dialog.html.textContent.includes('<img src=x'));assert.equal(dialog.html.querySelector('img'),null);
    dialog.onBack();assert.ok(h.focuses.at(-1));
    h.enter('[data-action="more"]',r.element());h.enter('[data-action="refine"]',r.element());
    assert.equal(more,1);assert.equal(refine,1);
    r.destroy();assert.equal(h.madeCards[0].destroyed,true);
});
test('empty results offer changing conditions and replace old cards without leaking Maker instances',()=>{
    const h=createDOMHarness(),r=createResults({Lampa:h.Lampa,document:h.document,onMore(){},onRefine(){},onOpen(){}});
    r.render({items:[{candidate:movie(),reason:'x'}],partial:false,notice:null},intent());
    r.render({items:[],partial:true,notice:'Ничего не найдено.'},intent());
    assert.equal(h.madeCards[0].destroyed,true);assert.equal(r.element().querySelectorAll('.aip-pick').length,0);
    assert.ok(r.element().textContent.includes('Изменить условия'));r.destroy();
});
