'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeLimits,readLimits}=require('../src/limits');
test('display modes normalize ten twenty and unlimited while stored legacy values migrate',()=>{
 for(const value of [10,20,null])assert.equal(normalizeLimits({resultLimit:value}).resultLimit,value);
 for(const [raw,value] of [['all',null],['20',20],['10',10],['4',10],['garbage',10]]){
  const limits=readLimits({get:(key,fallback)=>key==='aip_result_count'?raw:fallback});
  assert.equal(limits.resultLimit,value);
 }
});
