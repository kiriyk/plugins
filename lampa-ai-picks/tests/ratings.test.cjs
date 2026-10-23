'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs'),{movie}=require('./fixtures.cjs');
const {createRatings}=require('../src/ratings');
function setup(opts={}){const h=createHarness(),storage={cr_api_key:'kp-test-key',...opts.storage};
 h.Lampa.Storage={get:(k,f)=>k in storage?storage[k]:f,set:(k,v)=>storage[k]=v};
 const ids=[];const catalog={getExternalIds:(key,done)=>{ids.push(key);done(null,{imdb_id:'tt000000'+key.split(':').at(-1)});return ()=>{};}};
 const service=createRatings({Lampa:h.Lampa,request:h.request,catalog,clock:h.clock,maxKpRequests:opts.cap||10});
 return {...h,service,storage,ids,catalog};}
const item=(id,extra={})=>movie({id,key:'tmdb:movie:'+id,...extra});
test('IMDb bulk requests exact IDs without KP key or quota and ignores unsolicited identities',()=>{
 const h=setup({storage:{cr_api_key:''}});let rows;
 h.service.getMany([item(1),item(2)],'imdb',(e,r)=>rows=r);
 assert.equal(h.requests.length,1);assert.match(h.requests[0].url,/api.agregarr.org/);
 assert.deepEqual(new URL(h.requests[0].url).searchParams.getAll('id'),['tt0000001','tt0000002']);
 assert.equal(h.requests[0].headers['X-API-KEY'],undefined);
 h.reply(0,[{imdbId:'tt0000002',rating:8.1},{imdbId:'tt0000001',rating:7.5},{imdbId:'tt999',rating:10}]);
 assert.equal(rows['tmdb:movie:1'].value,7.5);assert.equal(rows['tmdb:movie:2'].value,8.1);assert.equal(Object.keys(rows).length,2);
});
test('IMDb errors are not cached, successful data persists between service instances',()=>{
 const h=setup();let rows;h.service.getMany([item(1)],'imdb',(e,r)=>rows=r);h.reject(0,{code:'timeout'});
 assert.equal(rows['tmdb:movie:1'].error.code,'timeout');
 h.service.getMany([item(1)],'imdb',(e,r)=>rows=r);h.reply(1,[{imdbId:'tt0000001',rating:8}]);
 const other=createRatings({Lampa:h.Lampa,request:h.request,catalog:h.catalog,clock:h.clock});other.getMany([item(1)],'imdb',(e,r)=>rows=r);
 assert.equal(rows['tmdb:movie:1'].value,8);assert.equal(h.requests.length,2);
});
test('absent and invalid IMDb scores cannot masquerade as TMDB ratings',()=>{
 const h=setup();let rows;h.service.getMany([item(1,{card:{vote_average:9}}),item(2)],'imdb',(e,r)=>rows=r);
 h.reply(0,[{imdbId:'tt0000001',rating:null},{imdbId:'tt0000002',rating:11}]);
 assert.equal(rows['tmdb:movie:1'].value,null);assert.equal(rows['tmdb:movie:2'].value,null);
});
test('TMDB source uses its own available score without external provider requests',()=>{
 const h=setup();let rows;h.service.getMany([item(1,{card:{vote_average:6.8}}),item(2,{card:{vote_average:0}})],'tmdb',(e,r)=>rows=r);
 assert.equal(rows['tmdb:movie:1'].value,6.8);assert.equal(rows['tmdb:movie:2'].value,null);assert.equal(h.requests.length,0);assert.equal(h.ids.length,0);
});
test('KP requires an explicit key and never contacts IMDb as fallback',()=>{
 const h=setup({storage:{cr_api_key:''}});let rows;h.service.getMany([item(1)],'kp',(e,r)=>rows=r);
 assert.equal(rows['tmdb:movie:1'].error.code,'kp_key');assert.equal(h.requests.length,0);
});
test('KP obeys per-search cap and checks exact IMDb identity',()=>{
 const h=setup({cap:1});let rows;h.service.getMany([item(1),item(2)],'kp',(e,r)=>rows=r);
 assert.equal(h.requests[0].headers['X-API-KEY'],'kp-test-key');
 h.reply(0,{items:[{imdbId:'tt0000001',ratingKinopoisk:7.8,kinopoiskId:123}]});
 assert.equal(rows['tmdb:movie:1'].value,7.8);assert.equal(rows['tmdb:movie:2'].error.code,'kp_limit');assert.equal(h.requests.length,1);
});
for(const status of [401,402,429])test('KP HTTP '+status+' stops remaining requests',()=>{
 const h=setup();let rows;h.service.getMany([item(1),item(2)],'kp',(e,r)=>rows=r);h.reject(0,{code:'auth',status});
 assert.equal(h.requests.length,1);assert.equal(rows['tmdb:movie:2'].error.status,status);
});
test('KP-only titles use strict title/year/type fallback, ambiguous matches are rejected',()=>{
 const h=setup();h.catalog.getExternalIds=(k,done)=>{done(null,{imdb_id:null});return ()=>{};};let rows;
 h.service.getMany([item(1,{title:'Лёд',originalTitle:'Ice',year:2018})],'kp',(e,r)=>rows=r);
 assert.match(h.requests[0].url,/keyword=/);
 h.reply(0,{items:[{kinopoiskId:10,nameRu:'Лёд',year:2018,type:'FILM',ratingKinopoisk:7.2},{kinopoiskId:11,nameRu:'Лёд',year:2018,type:'FILM',ratingKinopoisk:8}]});
 assert.equal(rows['tmdb:movie:1'].value,null);
});
test('cancelled rating batch ignores late replies and never persists them',()=>{
 const h=setup();let called=false;const cancel=h.service.getMany([item(1)],'imdb',()=>called=true);cancel();
 h.reply(0,[{imdbId:'tt0000001',rating:8}]);assert.equal(called,false);assert.equal(h.storage.aip_rating_cache,undefined);
});

test('cached rating rows are reported before uncached requests finish',()=>{
 const h=setup();h.service.getMany([item(1)],'imdb',()=>{});h.reply(0,[{imdbId:'tt0000001',rating:8}]);
 const progress=[];h.service.getMany([item(1),item(2)],'imdb',()=>{},(key,row)=>progress.push({key,value:row.value}));
 assert.deepEqual(progress,[{key:'tmdb:movie:1',value:8}]);assert.equal(h.requests.length,2);
});
