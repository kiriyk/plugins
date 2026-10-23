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
