'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWebSearch}=require('../src/web-search'),{createWebState}=require('../src/web-state');
const {createHarness}=require('./helpers.cjs');
function setup(){const h=createHarness();h.state=createWebState({clock:h.clock});h.api=createWebSearch({request:h.request,state:h.state});return h;}
test('basic request has fixed options, bounded safe pages, cache hit and no secret in normalized content',()=>{
 const h=setup();let result;h.api.search({key:'tvly-secret',query:'cinema'},(e,r)=>{assert.equal(e,null);result=r;});
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].json.search_depth,'basic');assert.equal(h.requests[0].json.auto_parameters,false);
 assert.equal(h.requests[0].headers.Authorization,'Bearer tvly-secret');assert.equal(h.requests[0].json.include_raw_content,false);
 h.reply(0,{results:[{url:'https://films.example/list',title:'Films',content:'a'.repeat(2000)},{url:'javascript:evil()',title:'x',content:'x'},{url:'https://films.example/list',title:'duplicate'}]});
 assert.equal(result.pages.length,1);assert.equal(result.pages[0].content.length,1500);
 h.api.search({key:'tvly-secret',query:'cinema'},(e,r)=>{assert.equal(e,null);assert.equal(r.cacheHit,true);});assert.equal(h.requests.length,1);
});
test('cancel ignores late reply and does not cache it, quota reserves uncertain requests',()=>{
 const h=setup();let called=0;const cancel=h.api.search({key:'key',query:'q'},()=>called++);cancel();h.reply(0,{results:[]});
 assert.equal(called,0);assert.equal(h.state.getCache(h.state.fingerprint('key'),'q'),null);
 assert.equal(h.state.usage(h.state.fingerprint('key')),1);
});
for(const status of [432,433,429,401,403])test('provider error '+status+' does not retry',()=>{
 const h=setup();let error;h.api.search({key:'key',query:'q'},e=>error=e);h.reject(0,{status,code:'network'});
 assert.equal(error.code,status===432||status===433?'web_quota':status===429?'rate_limit':'web_auth');assert.equal(h.requests.length,1);
});
