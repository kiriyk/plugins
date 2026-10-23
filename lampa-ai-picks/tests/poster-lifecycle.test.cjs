'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createDOMHarness}=require('./helpers.cjs'),{movie}=require('./fixtures.cjs');
const {createResults}=require('../src/results');

// Characterizes Lampa's non-idempotent poster lifecycle: each visible event
// starts a watchdog, and onload clears only the last stored timer handle.
function setup(ratings=false){
    const h=createDOMHarness(),mapping={Card:{onCreate:function(){
        const view=h.document.createElement('div'),image=h.document.createElement('img');
        view.className='card__view';image.className='card__img';view.appendChild(image);this.html.appendChild(view);this.html.card_data=this.data;this.img=image;
        this.use({onVisible:function(){
            this.imageTimer=h.clock.setTimeout(()=>this.img.onerror(),15000);
            this.img.onload=()=>h.clock.clearTimeout(this.imageTimer);
            this.img.onerror=()=>{this.img.src='img_broken.svg';};
            this.img.src=this.data.poster_path;
        }});
    }}};
    const make=h.Lampa.Maker.make;
    h.Lampa.Maker.map=()=>mapping;
    h.Lampa.Maker.make=(name,data)=>{
        const card=make(name,data),create=card.create,destroy=card.destroy;
        card.create=()=>{create();card.html=card.render(true);mapping.Card.onCreate.call(card);};
        card.destroy=()=>{h.clock.clearTimeout(card.imageTimer);card.img.onload=card.img.onerror=()=>{};card.img.src='';destroy();};
        return card;
    };
    if(ratings){
        const script=fs.readFileSync(path.join(__dirname,'../../lampa-catalog-ratings/catalog-ratings.js'),'utf8');
        vm.runInNewContext(script,{window:h.window,document:h.document,Lampa:h.Lampa,console:h.window.console,
            setTimeout:h.clock.setTimeout,clearTimeout:h.clock.clearTimeout,Date:{now:h.clock.now}});
    }
    const renderer=createResults({Lampa:h.Lampa,document:h.document,$:h.$,onOpen(){},onMore(){},onRefine(){}});
    h.document.getElementById('content').appendChild(renderer.element());
    const render=(id=1)=>renderer.render({items:[{candidate:movie({id,key:'tmdb:movie:'+id,card:{id,source:'tmdb',title:'Fixture',poster_path:'poster-'+id+'.svg',rating_kp:8.2,rating_imdb:7.9}}),reason:'Fixture'}]});
    return {...h,renderer,render};
}
for(const ratings of [false,true]){
    test('loaded posters survive 120 seconds and repeated native visibility, ratings '+(ratings?'on':'off'),()=>{
        const h=setup(ratings);h.render();h.Lampa.Layer.visible(h.renderer.element());
        const card=h.madeCards[0],image=card.img;image.onload();
        for(let i=0;i<4;i++){h.advance(30000);h.Lampa.Layer.visible(h.renderer.element());}
        assert.equal(image.src,'poster-1.svg','successful image must not be replaced by a stale watchdog');
        assert.equal(card.visibleCount,1,'the renderer and native Layer must share one visibility lifecycle');
        assert.equal(h.renderer.element().querySelector('.card__img'),image);
        if(ratings)assert.match(h.renderer.element().querySelector('.cr-ratings').textContent,/КП8.2IMDb7.9/);
        h.renderer.destroy();assert.equal(h.timers.size,0);
    });
}
test('replacing results and leaving the screen cancel pending poster watchdogs',()=>{
    const h=setup();h.render();h.render(2);
    assert.equal(h.madeCards[0].destroyed,true);
    h.madeCards[1].img.onload();h.advance(120000);
    assert.equal(h.madeCards[1].img.src,'poster-2.svg');
    h.render(3);h.renderer.destroy();assert.equal(h.timers.size,0);
    h.advance(120000);assert.equal(h.renderer.element().querySelector('.card'),null);
});
test('a genuinely unfinished image retains the native error fallback',()=>{
    const h=setup();h.render();h.advance(15000);
    assert.equal(h.madeCards[0].img.src,'img_broken.svg');h.renderer.destroy();
});
