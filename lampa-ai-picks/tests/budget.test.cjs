'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{createBudget}=require('../src/budget');
const spec={url:'https://catalog.example',method:'GET',headers:{},timeoutMs:10000};
test('catalog queue allows three concurrent HTTP requests and at most forty total',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:h.request});let errors=0,replies=0;
    for(let i=0;i<50;i++)b.catalogRequest(spec,e=>{if(e)errors++;else replies++;});
    assert.equal(h.requests.length,3);assert.equal(b.snapshot().activeCatalog,3);
    for(let i=0;i<40;i++){assert.ok(b.snapshot().activeCatalog<=3);h.reply(i,{});}
    assert.equal(h.requests.length,40);assert.equal(replies,40);assert.equal(errors,10);
    assert.equal(b.snapshot().catalogRequests,40);assert.equal(b.snapshot().activeCatalog,0);
});
test('budgets bound model and tool attempts and refuse new work after deadline',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:h.request});
    assert.equal(Array.from({length:6},()=>b.consumeModel()).filter(Boolean).length,5);
    assert.equal(Array.from({length:13},()=>b.consumeTool()).filter(Boolean).length,12);
    h.advance(90001);let error;b.catalogRequest(spec,e=>error=e);
    assert.equal(error.code,'timeout');assert.equal(h.requests.length,0);assert.equal(b.remainingMs(),0);
});
test('request timeout is capped by remaining total time, cancellation suppresses queued and late replies',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:h.request});h.advance(85000);
    let error;b.catalogRequest(spec,e=>error=e);
    assert.equal(h.requests[0].timeoutMs,5000);h.advance(5000);assert.equal(error.code,'timeout');
    assert.equal(b.snapshot().activeCatalog,0);
    const h2=createHarness(),b2=createBudget({clock:h2.clock,request:h2.request});let replies=0;
    for(let i=0;i<5;i++)b2.catalogRequest(spec,()=>replies++);
    b2.cancel();h2.reply(0,{});h2.advance(90001);
    assert.equal(replies,0);assert.equal(h2.requests.length,3);assert.equal(h2.timers.size,0);
});
test('synchronous request callbacks do not corrupt queue accounting',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:(s,done)=>{done(null,{});return ()=>{};}});
    for(let i=0;i<40;i++)b.catalogRequest(spec,()=>{});
    assert.equal(b.snapshot().activeCatalog,0);assert.equal(b.snapshot().catalogRequests,40);
});


test('configured model tool HTTP and overall limits actually stop new work',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:h.request,limits:{modelCalls:3,toolCalls:4,catalogRequests:10,totalTimeoutMs:30000}});
    assert.equal(Array.from({length:4},()=>b.consumeModel()).filter(Boolean).length,3);
    assert.equal(Array.from({length:5},()=>b.consumeTool()).filter(Boolean).length,4);
    let rejected=0;for(let i=0;i<11;i++)b.catalogRequest(spec,e=>{if(e)rejected++;});
    for(let i=0;i<10;i++)h.reply(i,{});
    assert.equal(h.requests.length,10);assert.equal(rejected,1);
    h.advance(30000);assert.equal(b.remainingMs(),0);b.cancel();
});
test('catalog timeout can be raised and still respects the overall deadline',()=>{
    const h=createHarness(),b=createBudget({clock:h.clock,request:h.request,limits:{catalogTimeoutMs:20000,totalTimeoutMs:30000}});
    let error;b.catalogRequest({...spec,timeoutMs:20000},e=>error=e);
    assert.equal(h.requests[0].timeoutMs,20000);h.advance(10001);assert.equal(error,undefined);
    h.advance(9999);assert.equal(error.code,'timeout');b.cancel();
});
