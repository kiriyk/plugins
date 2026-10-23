'use strict';
function filters(o={}) {return {media:'movie',genres:{movie:{include:[],exclude:[]},tv:{include:[],exclude:[]}},yearMin:null,yearMax:null,countries:[],maxRuntimeMinutes:null,...o};}
function intent(o={}) {return {filters:filters(),preferences:[],examples:[],...o};}
function movie(o={}) {return {key:'tmdb:movie:1',id:1,type:'movie',title:'Фильм',originalTitle:'Film',year:2010,genreIds:[18],countries:['US'],runtimeMinutes:110,overview:'Описание фильма.',card:{id:1,title:'Фильм',original_title:'Film',release_date:'2010-01-01',source:'tmdb',media_type:'movie'},...o};}
function tv(o={}) {return movie({key:'tmdb:tv:1',type:'tv',card:{id:1,name:'Сериал',first_air_date:'2010-01-01',source:'tmdb',media_type:'tv'},...o});}
const dictionaries={genres:{movie:[{id:18,name:'Драма'},{id:27,name:'Ужасы'},{id:35,name:'Комедия'}],tv:[{id:18,name:'Драма'},{id:35,name:'Комедия'}]},countries:[{code:'US',name:'США'},{code:'RU',name:'Россия'}]};
function assistant(calls, content=null){return {choices:[{message:{role:'assistant',content,tool_calls:calls.map((x,i)=>({id:x.id||'call-'+i,type:'function',function:{name:x.name,arguments:typeof x.arguments==='string'?x.arguments:JSON.stringify(x.arguments||{})}}))}}]};}
module.exports={filters,intent,movie,tv,dictionaries,assistant};
