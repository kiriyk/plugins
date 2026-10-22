'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSession}=require('../src/session');const {intent,movie,tv}=require('./fixtures.cjs');
test('session excludes exact keys and accepts no more than two hundred unique titles',()=>{
    const s=createSession();s.reset(intent());
    const picks=Array.from({length:195},(_,i)=>({candidate:movie({id:i+1,key:'tmdb:movie:'+(i+1)}),reason:'x'}));
    assert.equal(s.commit(picks).length,195);
    assert.equal(s.commit(Array.from({length:10},(_,i)=>({candidate:movie({id:i+196,key:'tmdb:movie:'+(i+196)}),reason:'x'}))).length,5);
    assert.equal(s.size(),200);assert.equal(s.commit([{candidate:tv(),reason:'x'}]).length,0);
    assert.equal(s.getShown()[0],'tmdb:movie:1');
});
test('session does not confuse movie and tv and reset starts a new selection',()=>{
    const s=createSession();s.reset(intent());assert.equal(s.commit([{candidate:movie(),reason:'a'},{candidate:tv(),reason:'b'}]).length,2);
    assert.equal(s.commit([{candidate:movie(),reason:'a'}]).length,0);
    s.reset(intent({preferences:['лёгкое']}));assert.equal(s.size(),0);assert.deepEqual(s.getIntent().preferences,['лёгкое']);
});
