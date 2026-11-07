'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildSourceDocument,resolveSpan}=require('../src/web-sources');
test('exact Cyrillic spans resolve after emoji in UTF16 and codepoint coordinates with evidence',()=>{
 const doc=buildSourceDocument([{id:'p1',title:'Кино',content:'😀 Прибытие (2016)'},{id:'p2',title:'Прибытие',content:'Другое упоминание.'}]);
 const start=doc.text.indexOf('Прибытие');
 for(const offset of [start,Array.from(doc.text.slice(0,start)).length]){
  const found=resolveSpan(doc,{text:'Прибытие',start:offset,end:offset+8});
  assert.deepEqual(found.sourceIds,['p1','p2']);assert.match(found.evidenceBySource.p1,/😀 Прибытие/);
 }
 assert.equal(resolveSpan(doc,{text:'Выдумка',start,end:start+7}),null);
 assert.equal(resolveSpan(doc,{text:'Source',start:0,end:6}),null);
 assert.equal(resolveSpan(doc,{text:'Прибытие',start:-1,end:8}),null);
});
test('ambiguous unicode positions and spans across different sources are rejected',()=>{
 const doc=buildSourceDocument([{id:'p',title:'',content:'😀AAA'}]);
 const at=doc.text.indexOf('AAA');assert.equal(resolveSpan(doc,{text:'AA',start:at,end:at+2}),null);
 const other=buildSourceDocument([{id:'p',title:'X',content:'Y'},{id:'q',title:'Z',content:'Q'}]);
 const start=other.text.indexOf('Y'),end=other.text.indexOf('Z')+1;
 assert.equal(resolveSpan(other,{text:other.text.slice(start,end),start,end}),null);
});
