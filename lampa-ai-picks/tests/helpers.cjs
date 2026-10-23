'use strict';
function createHarness() {
    let now = 0, next = 0;
    const timers = new Map(), requests = [], nativeRequests = [], logs = [];
    const clock = {now: () => now, setTimeout(fn, ms) {const id=++next;timers.set(id,{at:now+ms,fn});return id;},clearTimeout(id){timers.delete(id);}};
    function advance(ms) {
        const until=now+ms;
        for (;;) {const due=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}
        now=until;
    }
    const Lampa={
        TMDB:{api:p=>'https://configured-tmdb.example/'+p,key:()=> 'catalog-test-key'},
        Storage:{field:()=> 'ru-RU'},
        Reguest:function() {
            this.native=(url,ok,fail,post,params)=>nativeRequests.push({url,ok,fail,post,params});
            this.clear=()=>{};
        }
    };
    const request=(spec,done)=>{const row={...spec,done,cancelled:false};requests.push(row);return ()=>{row.cancelled=true;};};
    return {clock,advance,Lampa,request,requests,nativeRequests,logs,timers,
        reply(i,body){requests[i].done(null,body);},reject(i,error){requests[i].done(error);},
        nativeReply(i,body){nativeRequests[i].ok(body);},nativeReject(i,error){nativeRequests[i].fail(error);}};
}
module.exports={createHarness};

function createDOMHarness(options={}) {
    const {parseHTML}=require('linkedom');
    const {window:domWindow,document}=parseHTML('<html><head></head><body><nav class="menu"><ul class="menu__list"></ul></nav><main id="content"></main></body></html>');
    const window={document,Event:domWindow.Event,setTimeout,clearTimeout};
    const h=createHarness(),selects=[],inputs=[],modals=[],notices=[],registrations=[],params=[],pushes=[],focuses=[],scrollUpdates=[],controllers={};
    const storage={...options.storage};let enabled='aip_picks',focused=null;
    h.Lampa.Storage={get:(k,f)=>k in storage?storage[k]:f,field:()=> 'ru-RU',set(k,v){if(options.storageError)throw Error('storage unavailable');storage[k]=v;}};
    h.Lampa.Select={show:p=>selects.push(p),close(){}};
    h.Lampa.Input={edit:(p,done)=>inputs.push({params:p,done})};
    h.Lampa.Modal={open:p=>modals.push(p),close(){}};
    h.Lampa.Noty={show:m=>notices.push(m)};
    h.Lampa.SettingsApi={addComponent:p=>registrations.push(p),addParam:p=>params.push(p),removeComponent(){}};
    h.Lampa.Controller={add:(n,c)=>controllers[n]=c,toggle(n){enabled=n;if(controllers[n]?.toggle)controllers[n].toggle();},
        enabled:()=>({name:enabled}),collectionSet(){},collectionFocus(e,root){focused=e||root?.querySelector('.selector');focuses.push(focused);if(focused)focused.dispatchEvent(new window.Event('hover:focus'));},focus:e=>{focused=e;focuses.push(e);}};
    h.Lampa.Navigator={move(){}};
    h.Lampa.Component={add:(n,c)=>{registrations.push({name:n,constructor:c});},get:()=>null};
    h.Lampa.Activity={push:p=>pushes.push(p),backward(){}};
    h.Lampa.Listener={follow:(n,cb)=>{h.appListener=cb;}};
    h.Lampa.Scroll=function(){const root=document.createElement('div');root.className='scroll';
        this.append=e=>root.appendChild(e);this.render=()=>root;this.update=(element,center)=>scrollUpdates.push({element,center});this.destroy=()=>root.remove();};
    const madeCards=[];
    h.Lampa.Maker={make(name,card){
        if(name!=='Card')throw Error('unsupported Maker type');
        const modules=[],el=document.createElement('div');el.className='card selector';el.setAttribute('data-title',card.title||card.name);
        const instance={data:card,use(m){modules.push(m);},create(){el.textContent=card.title||card.name;el.addEventListener('hover:enter',()=>modules.forEach(m=>m.onEnter?.call(instance,el,card)));el.addEventListener('hover:focus',()=>modules.forEach(m=>m.onFocus?.call(instance,{0:el},card)));},
            render(js){return js?el:{0:el};},visible(){instance.visibleCount=(instance.visibleCount||0)+1;},destroy(){el.remove();instance.destroyed=true;}};
        madeCards.push(instance);return instance;
    }};
    h.madeCards=madeCards;
    window.Lampa=h.Lampa;window.appready=true;
    function enter(selector,root=document){const e=typeof selector==='string'?root.querySelector(selector):selector;assertElement(e);e.dispatchEvent(new window.Event('hover:enter',{bubbles:true}));}
    function choose(title){const select=selects.at(-1),item=select.items.find(x=>x.title===title||x.value===title||x.id===title);assertElement(item);
        if(item.checkbox){item.checked=!item.checked;(item.onCheck||select.onCheck)?.(item);}else(item.onSelect||select.onSelect)?.(item);}
    function assertElement(e){if(!e)throw Error('Test target not found');}
    return {...h,window,document,storage,selects,inputs,modals,notices,registrations,params,pushes,focuses,scrollUpdates,controllers,enter,choose};
}
module.exports.createDOMHarness=createDOMHarness;
