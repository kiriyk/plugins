'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const d=require('../src/domain');
const {filters,intent,movie,tv,dictionaries}=require('./fixtures.cjs');
test('normalizes catalog identity without confusing movie and tv',()=>{
    const a=d.normalizeTitle({id:1,title:'Локальное',original_title:'Original',release_date:'2010-01-01',genre_ids:[18]},'movie');
    const b=d.normalizeTitle({id:1,name:'Сериал',first_air_date:'2020-01-01',episode_run_time:[40,60],production_countries:[{iso_3166_1:'RU'}]},'tv');
    assert.equal(a.key,'tmdb:movie:1');assert.equal(b.key,'tmdb:tv:1');assert.equal(b.runtimeMinutes,60);assert.deepEqual(b.countries,['RU']);
    assert.equal(a.runtimeMinutes,null);assert.equal(a.countries,null);assert.equal(b.card.source,'tmdb');
    assert.equal(d.normalizeTitle({id:'1/../../',title:'x'},'movie'),null);
    assert.equal(d.normalizeTitle({id:1,title:'x'},'person'),null);
});
test('unknown duration and country cannot pass mandatory filters',()=>{
    for(const [duration,ok] of [[null,false],[0,false],[120,true],[121,false]]){
        assert.equal(d.validateCandidate(movie({runtimeMinutes:duration}),filters({maxRuntimeMinutes:120})).ok,ok);
    }
    assert.equal(d.validateCandidate(movie({countries:null}),filters({countries:['US']})).ok,false);
    const fromLanguage=d.normalizeTitle({id:1,title:'x',original_language:'ru'},'movie');
    assert.equal(fromLanguage.countries,null);
});
test('genres have OR inclusion and strict exclusions, missing is not known empty',()=>{
    const f=filters({genres:{movie:{include:[18,35],exclude:[27]},tv:{include:[],exclude:[]}}});
    assert.equal(d.validateCandidate(movie(),f).ok,true);
    assert.equal(d.validateCandidate(movie({genreIds:[18,27]}),f).ok,false);
    assert.equal(d.validateCandidate(movie({genreIds:null}),f).ok,false);
    assert.equal(d.validateCandidate(movie({genreIds:[]}),filters()).ok,true);
    assert.equal(d.validateCandidate(tv(),filters()).ok,false);
});
test('year boundaries are inclusive and unknown values fail',()=>{
    const f=filters({yearMin:2000,yearMax:2010});
    assert.equal(d.validateCandidate(movie(),f).ok,true);
    assert.equal(d.validateCandidate(movie({year:1999}),f).ok,false);
    assert.equal(d.validateCandidate(movie({year:null}),f).ok,false);
});
test('refinement preserves unspecified conditions without modifying current intent',()=>{
    const current=intent({filters:filters({yearMin:2000})});
    const r=d.resolveIntent(current,{filters:{maxRuntimeMinutes:120},preferences:['детектив']},{},dictionaries);
    assert.equal(r.status,'ready');assert.equal(r.intent.filters.yearMin,2000);assert.equal(r.intent.filters.maxRuntimeMinutes,120);
    assert.equal(current.filters.maxRuntimeMinutes,null);
});
test('form conflicts, invalid intervals and invented genres require clarification',()=>{
    assert.equal(d.resolveIntent(intent(),{filters:{yearMin:2001}},{yearMin:2000},dictionaries).status,'clarify');
    assert.equal(d.resolveIntent(intent(),{filters:{yearMin:2020,yearMax:2010}},{},dictionaries).status,'clarify');
    assert.equal(d.resolveIntent(intent(),{filters:{genres:{movie:{include:[999]}}}},{},dictionaries).status,'clarify');
    assert.equal(d.resolveIntent(intent(),{filters:{countries:['XX']}},{},dictionaries).status,'clarify');
    const all=filters({media:'all',genres:{movie:{include:[],exclude:[27]},tv:{include:[],exclude:[]}}});
    assert.equal(d.resolveIntent(intent(),{filters:all},{},dictionaries).status,'clarify');
});
test('candidate store keeps eighty unique identities and enriches without erasing known data',()=>{
    const store=d.createCandidateStore(80);
    for(let i=1;i<=80;i++)assert.equal(store.add(movie({id:i,key:'tmdb:movie:'+i})),true);
    assert.equal(store.add(tv()),false);assert.equal(store.all().length,80);
    assert.equal(store.add(movie({runtimeMinutes:null,overview:''})),true);
    assert.equal(store.get('tmdb:movie:1').runtimeMinutes,110);assert.equal(store.get('tmdb:movie:1').overview,'Описание фильма.');
});

test('rating intent accepts decimals, defaults IMDb and preserves explicit source locks',()=>{
    const result=d.resolveIntent(d.emptyIntent(),{filters:{ratingMin:7.5}},{},dictionaries);
    assert.equal(result.status,'ready');assert.equal(result.intent.filters.ratingSource,'imdb');
    for(const source of ['imdb','kp','tmdb']) assert.equal(d.resolveIntent(d.emptyIntent(),{filters:{ratingSource:source,ratingMin:7}},{},dictionaries).status,'ready');
    for(const value of [-1,10.1,'7',NaN]) assert.equal(d.resolveIntent(d.emptyIntent(),{filters:{ratingMin:value}},{},dictionaries).status,'clarify');
    assert.equal(d.resolveIntent(d.emptyIntent(),{filters:{ratingSource:'other'}},{},dictionaries).status,'clarify');
    assert.equal(d.resolveIntent(d.emptyIntent(),{filters:{ratingSource:'kp'}},{ratingSource:'imdb'},dictionaries).status,'clarify');
});
test('rating gate uses only the chosen source and never accepts unknown or fabricated TMDB fallback',()=>{
    const f=filters({ratingSource:'imdb',ratingMin:7.5});
    assert.equal(d.validateCandidate(movie({ratings:{imdb:7.5,tmdb:9}}),f).ok,true);
    assert.equal(d.validateCandidate(movie({ratings:{imdb:7.4,tmdb:9}}),f).reason,'rating');
    assert.equal(d.validateCandidate(movie({ratings:{tmdb:9}}),f).reason,'unknown_rating');
    assert.equal(d.validateCandidate(movie(),filters({ratingMin:null})).ok,true);
});
