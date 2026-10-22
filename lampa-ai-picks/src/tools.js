'use strict';
var d = require('./domain'), appError = require('./transport').appError, summarize = require('./prompts').summarize;
function noop() {}
function object(properties, required) { return {type:'object',properties:properties,required:required || [],additionalProperties:false}; }
var integer = {type:'integer',minimum:1}, page = {type:'integer',minimum:1,maximum:500};
function array(items, max) { return {type:'array',items:items,maxItems:max}; }
var text = {type:'string',maxLength:500,minLength:1};
var key = {type:'string',pattern:'^tmdb:(movie|tv):[1-9][0-9]*$'};
var genre = object({include:array(integer,40),exclude:array(integer,40)});
var filtersSchema = object({media:{type:'string',enum:['movie','tv','all']},genres:object({movie:genre,tv:genre}),
    yearMin:{type:['integer','null'],minimum:1},yearMax:{type:['integer','null'],minimum:1},
    countries:array({type:'string',pattern:'^[A-Z]{2}$'},50),maxRuntimeMinutes:{type:['integer','null'],minimum:1}});
var schemas = {
    set_search_intent:object({filters:filtersSchema,preferences:array({type:'string',maxLength:500},20),examples:array(key,3)}),
    search_titles:object({query:text,year:integer,type:{type:'string',enum:['movie','tv','all']},page:page,purpose:{type:'string',enum:['candidate','example']}},['query','type']),
    resolve_keywords:object({query:{type:'string',minLength:1,maxLength:200},page:page},['query']),
    discover_titles:object({type:{type:'string',enum:['movie','tv']},genreIds:array(integer,40),keywordIds:array(integer,20),page:page},['type']),
    get_related:object({key:key,relation:{type:'string',enum:['recommendations','similar']},page:page},['key','relation']),
    get_title_details:object({keys:array(key,10)},['keys'])
};
var descriptions = {
    set_search_intent:'Зафиксировать смысл запроса и обязательные условия до поиска; изменяй только явно уточнённые поля. Пустые поля формы не являются запретами.',
    search_titles:'Искать конкретное название. Для названного пользователем примера укажи purpose=example; для кандидата purpose=candidate.',
    resolve_keywords:'Найти реальные ключевые слова TMDB; можно использовать английские термины.',
    discover_titles:'Подобрать по условиям намерения; genreIds задаёт направление поиска, keywordIds — только ранее найденные ключевые слова.',
    get_related:'Получить рекомендации или похожие к известной карточке.',
    get_title_details:'Получить фактические жанры, длительность, страны и описание до десяти известных карточек.'
};
function valid(value, schema) {
    if (Array.isArray(schema.type)) {
        return schema.type.some(function (type) { var copy = d.merge(schema,{type:type}); return valid(value,copy); });
    }
    if (schema.type === 'null') return value === null;
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (!Object.keys(value).every(function (name) { return d.own(schema.properties,name) && valid(value[name],schema.properties[name]); })) return false;
        return (schema.required || []).every(function (name) { return d.own(value,name); });
    }
    if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.every(function (item) { return valid(item,schema.items); });
    if (schema.type === 'integer' && !d.positive(value)) return false;
    if (schema.type === 'string' && typeof value !== 'string') return false;
    if (schema.minimum && value < schema.minimum || schema.maximum && value > schema.maximum) return false;
    if (schema.minLength && value.length < schema.minLength || schema.maxLength && value.length > schema.maxLength) return false;
    if (schema.enum && schema.enum.indexOf(value) < 0 || schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    return true;
}
function createTools(options) {
    var catalog = options.catalog, store = options.store, current = d.clone(options.intent || d.emptyIntent()), ready = false;
    var keywords = Object.create(null), calls = Object.create(null);
    function clarification(value) { if (options.onClarification) options.onClarification(value); }
    function execute(call, done) {
        if (!call || typeof call.id !== 'string' || !call.id) { done(appError('invalid_arguments')); return noop; }
        var signature = call.name + ':' + call.arguments;
        var previous = calls[call.id];
        if (previous) {
            if (previous.signature !== signature) { done(appError('invalid_arguments')); return noop; }
            if (previous.complete) done(previous.error,previous.value);
            else previous.listeners.push(done);
            return noop;
        }
        var record = calls[call.id] = {signature:signature,listeners:[done],complete:false};
        function finish(error, value) {
            if (record.complete) return;
            record.complete = true; record.error = error; record.value = value;
            record.listeners.forEach(function (listener) { listener(error,value); }); record.listeners = [];
        }
        var args;
        try { args = JSON.parse(call.arguments); } catch (ignore) { finish(appError('invalid_arguments')); return noop; }
        if (!d.own(schemas,call.name) || !valid(args,schemas[call.name])) { finish(appError('invalid_arguments')); return noop; }
        if (call.name === 'set_search_intent') {
            if (args.examples && !args.examples.every(function (k) { return !!store.get(k); })) { finish(appError('unknown_title')); return noop; }
            var resolved = d.resolveIntent(current,args,options.formFilters || {},options.dictionaries);
            if (resolved.status !== 'ready') {
                clarification({kind:'filters',query:null,options:[],issues:resolved.issues});
                finish(appError('clarification')); return noop;
            }
            current = resolved.intent; ready = true; finish(null,{intent:current}); return noop;
        }
        if (!ready) { finish(appError('intent_required')); return noop; }
        if (call.name === 'resolve_keywords') return catalog.resolveKeywords(args,function (error, result) {
            if (error) return finish(error);
            result.items = result.items.slice(0,20);
            result.items.forEach(function (item) { keywords[item.id] = true; });
            finish(null,result);
        });
        if (call.name === 'get_title_details') {
            if (!args.keys.every(function (k) { return !!store.get(k); })) { finish(appError('unknown_title')); return noop; }
            return catalog.getTitleDetails(args,function (error, result) {
                if (error) return finish(error);
                result.forEach(function (c) { store.add(c); });
                finish(null,{items:result.map(function (c) { return summarize(store.get(c.key)); }),errors:result.errors || []});
            });
        }
        if (call.name === 'get_related' && !store.get(args.key)) { finish(appError('unknown_title')); return noop; }
        if (call.name === 'discover_titles') {
            if (!(args.keywordIds || []).every(function (id) { return keywords[id]; })) { finish(appError('unknown_keyword')); return noop; }
            var known = options.dictionaries.genres[args.type];
            if (!(args.genreIds || []).every(function (id) { return known.some(function (g) { return g.id === id; }); })) { finish(appError('invalid_arguments')); return noop; }
            args.filters = d.clone(current.filters);
            if (args.genreIds) args.filters.genres[args.type].include = args.genreIds;
        }
        var method = call.name === 'search_titles' ? 'searchTitles' : call.name === 'discover_titles' ? 'discoverTitles' : 'getRelated';
        return catalog[method](args,function (error, result) {
            if (error) return finish(error);
            var accepted = [];
            result.items.slice(0,20).forEach(function (candidate) {
                if (store.add(candidate)) accepted.push(store.get(candidate.key));
            });
            if (call.name === 'search_titles' && args.purpose === 'example') {
                var query = args.query.toLowerCase().trim();
                var exact = accepted.filter(function (c) { return c.title.toLowerCase() === query || c.originalTitle.toLowerCase() === query; });
                var matches = exact.length ? exact : accepted;
                if (matches.length > 1) {
                    clarification({kind:'example',query:args.query,options:matches,issues:[]});
                    return finish(appError('clarification'));
                }
                if (matches.length === 1 && current.examples.indexOf(matches[0].key) < 0) {
                    if (current.examples.length >= 3) return finish(appError('invalid_arguments'));
                    current.examples.push(matches[0].key);
                }
            }
            finish(null,{items:accepted.map(summarize),hasMore:result.hasMore || result.items.length > 20});
        });
    }
    return {
        definitions:function () { return Object.keys(schemas).map(function (name) { return {type:'function',function:{name:name,description:descriptions[name],parameters:schemas[name]}}; }); },
        execute:execute,getIntent:function () { return d.clone(current); }
    };
}
module.exports = {createTools:createTools};
