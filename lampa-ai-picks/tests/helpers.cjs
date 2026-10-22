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
