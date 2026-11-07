'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createJev}=require('../src/jev'),{createHarness}=require('./helpers.cjs');
const criteria={strong_match:'Да',match:'Подходит',weak_match:'Слабо',not_match:'Нет',insufficient_data:'Нет данных'};
const questions={movie_1_fit:{type:'choice',instructions:'Подходит?',criteria}};
function answer(choice='match'){return {type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===choice?1:0]))};}
function setup(){const h=createHarness();return {...h,api:createJev({request:h.request,clock:h.clock})};}
test('Jev uses typed Decisions endpoint and checks every answer with model version',()=>{
 const h=setup();let result;h.api.evaluate({key:'k',state:{query:'кино'},questions},(e,r)=>{assert.equal(e,null);result=r});
 const req=h.requests[0];assert.equal(req.url,'https://routerai.ru/api/v1/decisions');assert.equal(req.headers.Authorization,'Bearer k');assert.deepEqual(Object.keys(req.json).sort(),['model','questions','state']);
 h.reply(0,{model:'typesafe/jev-real',answers:{movie_1_fit:answer()},usage:{input_tokens:15}});
 assert.equal(result.answers.movie_1_fit.choice,'match');assert.equal(result.modelVersion,'typesafe/jev-real');assert.equal(h.timers.size,0);
});
test('missing, extra and malformed choices or probabilities fail the entire evaluation',()=>{
 const cases=[{}, {movie_1_fit:answer(),other:answer()}, {movie_1_fit:{...answer(),choice:'other'}}, {movie_1_fit:{...answer(),confidence:-1}}, {movie_1_fit:{...answer(),probabilities:{...answer().probabilities,match:0.4}}}, {movie_1_fit:{...answer(),probabilities:{...answer().probabilities,match:NaN}}}, {movie_1_fit:{...answer(),probabilities:{...answer().probabilities,alien:0}}}];
 for(const answers of cases){const h=setup();let error;h.api.evaluate({key:'k',state:{},questions},e=>error=e);h.reply(0,{answers});assert.equal(error.code,'invalid_response');assert.equal(h.requests.length,1);}
});
test('Decision HTTP failures never retry, timeout settles once, cancel suppresses callbacks',()=>{
 for(const status of [401,402,429,503]){const h=setup();let error;h.api.evaluate({key:'k',state:{},questions},e=>error=e);h.reject(0,{status});assert.equal(error.status,status);assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);}
 for(const cancel of [false,true]){const h=setup();let calls=0;const stop=h.api.evaluate({key:'k',state:{},questions,timeoutMs:10},()=>calls++);if(cancel)stop();h.advance(11);h.reply(0,{answers:{movie_1_fit:answer()}});assert.equal(calls,cancel?0:1);assert.equal(h.timers.size,0);}
});
module.exports={answer};
test('recorded live RouterAI Choice response passes strict adapter contract',()=>{
 const fixture=require('./fixtures/jev-response.json'),h=setup();let result;
 h.api.evaluate({key:'k',state:fixture.request.state,questions:fixture.request.questions},(e,r)=>{assert.equal(e,null);result=r});h.reply(0,fixture.response);
 assert.equal(result.answers.movie_329865_fit.choice,'strong_match');assert.equal(result.modelVersion,'typesafe/jev-1.14-20261014');
});
