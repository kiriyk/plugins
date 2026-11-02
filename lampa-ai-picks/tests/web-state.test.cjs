'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWebState}=require('../src/web-state');
function setup(){let now=Date.UTC(2026,10,2);const data={};const state=createWebState({Storage:{get:(k,f)=>data[k]||f,set:(k,v)=>data[k]=v},clock:{now:()=>now}});return {state,data,advance:ms=>now+=ms};}
test('cache and quota isolate keys, expire, roll UTC month and never store raw secrets',()=>{
 const h=setup(),a=h.state.fingerprint('private-key-a'),b=h.state.fingerprint('private-key-b');
 assert.notEqual(a,b);h.state.putCache(a,'query',[{id:'p1',url:'https://film.example/',domain:'film.example',title:'Films',content:'movie'}]);
 assert.equal(h.state.getCache(a,'query').length,1);assert.equal(h.state.getCache(b,'query'),null);
 for(let i=0;i<950;i++)assert.equal(h.state.reserveCredit(a),true);
 assert.equal(h.state.reserveCredit(a),false);assert.equal(h.state.usage(b),0);
 assert.equal(JSON.stringify(h.data).includes('private-key'),false);
 h.advance(86400001);assert.equal(h.state.getCache(a,'query'),null);
 h.advance(31*86400000);assert.equal(h.state.usage(a),0);assert.equal(h.state.reserveCredit(a),true);
});
test('LRU limits entries and UTF8 bytes and storage errors keep an in-memory fallback',()=>{
 const h=setup(),key=h.state.fingerprint('key');
 for(let i=0;i<22;i++)h.state.putCache(key,String(i),[{content:'я'.repeat(18000)}]);
 assert.equal(h.state.getCache(key,'0'),null);
 assert.ok(Buffer.byteLength(JSON.stringify(h.data))<525000);
 const state=createWebState({Storage:{get(){throw Error();},set(){throw Error();}},clock:{now:()=>0}});
 assert.equal(state.reserveCredit('x'),true);state.putCache('x','q',[]);assert.deepEqual(state.getCache('x','q'),[]);
});
