'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs');const {filters}=require('./fixtures.cjs');
const {createCatalog}=require('../src/catalog');
function setup(){const h=createHarness();return {...h,catalog:createCatalog({request:h.request,Lampa:h.Lampa,language:'ru-RU'})};}
test('preserves configured TMDB access and encodes non-Latin title',()=>{
    const h=setup();let result;
    h.catalog.searchTitles({query:'Остров проклятых',year:2010,type:'movie'},(e,r)=>{assert.equal(e,null);result=r;});
    const url=new URL(h.requests[0].url);
    assert.equal(url.host,'configured-tmdb.example');assert.equal(url.pathname,'/search/movie');
    assert.equal(url.searchParams.get('query'),'Остров проклятых');assert.equal(url.searchParams.get('api_key'),'catalog-test-key');
    assert.equal(url.searchParams.get('year'),'2010');
    h.reply(0,{results:[{id:1,title:'Остров',release_date:'2010-01-01'}],page:1,total_pages:2});
    assert.equal(result.items[0].key,'tmdb:movie:1');assert.equal(result.items[0].card.source,'tmdb');assert.equal(result.hasMore,true);
});
test('mixed search retains explicit TV type even without original_name',()=>{
    const h=setup();let result;
    h.catalog.searchTitles({query:'x',type:'all'},(e,r)=>result=r);
    h.reply(1,{results:[{id:1,name:'Сериал',first_air_date:'2020-01-01'}],total_pages:1});
    h.reply(0,{results:[{id:1,title:'Фильм',release_date:'2010-01-01'}],total_pages:1});
    assert.deepEqual(result.items.map(c=>c.key),['tmdb:movie:1','tmdb:tv:1']);
});
test('discovery uses OR genres, excludes genres and has no unsolicited rating cutoff',()=>{
    const h=setup();const f=filters({yearMin:2000,yearMax:2020,countries:['US','RU'],maxRuntimeMinutes:120,genres:{movie:{include:[18,35],exclude:[27]},tv:{include:[],exclude:[]}}});
    h.catalog.discoverTitles({type:'movie',filters:f,keywordIds:[703],page:2},()=>{});
    const q=new URL(h.requests[0].url).searchParams;
    assert.equal(q.get('with_genres'),'18|35');assert.equal(q.get('without_genres'),'27');assert.equal(q.get('with_origin_country'),'US|RU');
    assert.equal(q.get('with_runtime.lte'),'120');assert.equal(q.get('primary_release_date.gte'),'2000-01-01');assert.equal(q.get('vote_average.gte'),null);
});
test('dictionary queries and keyword resolution preserve actual IDs',()=>{
    const h=setup();let dictionaries,keywords;
    h.catalog.getDictionaries((e,r)=>dictionaries=r);
    assert.equal(h.requests.length,3);
    h.reply(0,{genres:[{id:18,name:'Драма'}]});h.reply(1,{genres:[{id:35,name:'Комедия'}]});
    h.reply(2,[{iso_3166_1:'RU',native_name:'Россия',english_name:'Russia'}]);
    assert.equal(dictionaries.genres.movie[0].id,18);assert.equal(dictionaries.countries[0].code,'RU');
    h.catalog.resolveKeywords({query:'detective'},(e,r)=>keywords=r);
    h.reply(3,{results:[{id:703,name:'detective'}]});assert.equal(keywords.items[0].id,703);
});
test('details expose each HTTP request, normalize TV runtime, and preserve partial failures',()=>{
    const h=setup();let result;
    h.catalog.getTitleDetails({keys:['tmdb:movie:1','tmdb:tv:1']},(e,r)=>{assert.equal(e,null);result=r;});
    assert.equal(h.requests.length,2);
    h.reply(1,{id:1,name:'Сериал',episode_run_time:[40,60],production_countries:[{iso_3166_1:'US'}]});
    h.reject(0,{code:'network',status:0,message:'network'});
    assert.equal(result.length,1);assert.equal(result[0].runtimeMinutes,60);
    assert.equal(result.errors[0].key,'tmdb:movie:1');
});
test('catalog error is not a successful empty search',()=>{
    const h=setup();let error,result;
    h.catalog.searchTitles({query:'x',type:'movie'},(e,r)=>{error=e;result=r;});
    h.reject(0,{code:'network'});assert.equal(error.code,'network');assert.equal(result,undefined);
});
test('rejects arbitrary type, ID, relation, page and malformed response',()=>{
    const h=setup();
    for(const args of [{query:'x',type:'https://evil.example'},{query:'x',type:'movie',page:-1}]){
        let error;h.catalog.searchTitles(args,e=>error=e);assert.equal(error.code,'invalid_arguments');
    }
    let error;h.catalog.getRelated({key:'tmdb:movie:1',relation:'../../'},e=>error=e);assert.equal(error.code,'invalid_arguments');
    h.catalog.getTitleDetails({keys:['https://evil.example']},e=>error=e);assert.equal(error.code,'invalid_arguments');
    assert.equal(h.requests.length,0);
    h.catalog.searchTitles({query:'x',type:'movie'},e=>error=e);h.reply(0,{wrong:[]});assert.equal(error.code,'invalid_response');
});

test('catalog follows the current Lampa TMDB language and preserves explicit overrides',()=>{
    const h=createHarness();let language='ru';
    h.Lampa.Storage.field=key=>key==='tmdb_lang'?language:'other-setting';
    const catalog=createCatalog({request:h.request,Lampa:h.Lampa});
    const search=api=>api.searchTitles({query:'Остров проклятых',type:'movie'},()=>{});
    search(catalog);assert.equal(new URL(h.requests.at(-1).url).searchParams.get('language'),'ru');
    language='en';search(catalog);assert.equal(new URL(h.requests.at(-1).url).searchParams.get('language'),'en');
    search(createCatalog({request:h.request,Lampa:h.Lampa,language:'fr-FR'}));
    assert.equal(new URL(h.requests.at(-1).url).searchParams.get('language'),'fr-FR');
    language='';search(catalog);assert.equal(new URL(h.requests.at(-1).url).searchParams.get('language'),'ru');
});
