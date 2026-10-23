'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs');
const {createTransport}=require('../src/transport');
test('sends exactly one JSON POST with no cache or retries',()=>{
    const h=createHarness(), replies=[];
    const send=createTransport(h.Lampa,h.clock);
    send({url:'https://routerai.ru/api/v1/chat/completions',method:'POST',json:{message:'Кино'},headers:{Authorization:'Bearer test-key'},timeoutMs:25},(...x)=>replies.push(x));
    const r=h.nativeRequests[0];
    assert.equal(h.nativeRequests.length,1);
    assert.equal(r.post,'{"message":"Кино"}');
    assert.equal(r.params.headers['Content-Type'],'application/json');
    assert.equal(r.params.attempts,0);assert.equal(r.params.cache,false);
    h.nativeReply(0,{ok:true});h.nativeReply(0,{ok:false});
    assert.deepEqual(replies,[[null,{ok:true}]]);assert.equal(h.timers.size,0);
});
test('cancel suppresses late success and errors',()=>{
    const h=createHarness(), replies=[];
    const cancel=createTransport(h.Lampa,h.clock)({url:'https://a.example',method:'GET',headers:{},timeoutMs:25},(...x)=>replies.push(x));
    cancel();cancel();h.nativeReply(0,{});h.nativeReject(0,{status:500});h.advance(26);
    assert.equal(replies.length,0);assert.equal(h.timers.size,0);
});
test('deadline fires once and late replies cannot change timeout',()=>{
    const h=createHarness(), replies=[];
    createTransport(h.Lampa,h.clock)({url:'https://a.example',method:'GET',headers:{},timeoutMs:25},(...x)=>replies.push(x));
    assert.equal(h.nativeRequests[0].post,false);h.advance(25);h.nativeReply(0,{});
    assert.equal(replies.length,1);assert.equal(replies[0][0].code,'timeout');
});
for(const [status,code] of [[401,'auth'],[402,'balance'],[403,'auth'],[429,'rate_limit'],[500,'server'],[0,'network']]){
    test('normalizes HTTP '+status+' without copying secret error content',()=>{
        const h=createHarness();let error;
        createTransport(h.Lampa,h.clock)({url:'https://a.example',method:'POST',json:{},headers:{Authorization:'Bearer test-key'},timeoutMs:25},e=>{error=e;});
        h.nativeReject(0,{status,responseText:'test-key'});h.advance(30);
        assert.equal(error.code,code);assert.equal(JSON.stringify(error).includes('test-key'),false);
        assert.equal(h.nativeRequests.length,1);
    });
}
test('unsupported environment reports a controlled error',()=>{
    const h=createHarness();let error;
    createTransport({},h.clock)({url:'https://a.example',method:'GET',headers:{},timeoutMs:25},e=>{error=e;});
    assert.equal(error.code,'unsupported');
});
