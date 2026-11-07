'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildExampleContext}=require('../src/request-context'),{createCandidateStore}=require('../src/domain'),{movie}=require('./fixtures.cjs');
test('example context includes bounded facts only and ignores unknown keys',()=>{
 const store=createCandidateStore(80);store.add(movie({overview:'Я'.repeat(600),card:{secret:'PRIVATE'},secret:'PRIVATE'}));
 const rows=buildExampleContext(store,['tmdb:movie:1','tmdb:movie:999']);
 assert.deepEqual(rows,[{key:'tmdb:movie:1',title:'Фильм',type:'movie',year:2010,overview:'Я'.repeat(500)}]);assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
});
