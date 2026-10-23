'use strict';
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }
function positive(value) { return typeof value === 'number' && isFinite(value) && value > 0 && Math.floor(value) === value && value <= 9007199254740991; }
function titleKey(type, id) { return (type === 'movie' || type === 'tv') && positive(Number(id)) && /^\d+$/.test(String(id)) ? 'tmdb:' + type + ':' + id : null; }
function parseKey(key) {
    var match = /^tmdb:(movie|tv):([1-9]\d*)$/.exec(String(key || ''));
    return match && positive(Number(match[2])) ? {type: match[1], id: Number(match[2])} : null;
}
function emptyFilters() { return {media:'movie', genres:{movie:{include:[],exclude:[]},tv:{include:[],exclude:[]}}, yearMin:null,yearMax:null,countries:[],maxRuntimeMinutes:null,ratingSource:'imdb',ratingMin:null}; }
function emptyIntent() { return {filters:emptyFilters(),preferences:[],examples:[]}; }
function merge(base, patch) {
    var out = clone(base), key;
    for (key in patch) if (own(patch,key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) out[key] = merge(out[key] || {},patch[key]);
        else out[key] = clone(patch[key]);
    }
    return out;
}
function normalizeTitle(raw, type) {
    if (!raw || !titleKey(type,raw.id)) return null;
    var date = type === 'tv' ? raw.first_air_date : raw.release_date;
    var runtime = type === 'tv' ? raw.episode_run_time : [raw.runtime];
    var knownRuntime = Array.isArray(runtime) && runtime.length && runtime.every(positive);
    var genreIds = Array.isArray(raw.genres) ? raw.genres.map(function (g) { return g.id; }) : raw.genre_ids;
    if (!Array.isArray(genreIds) || !genreIds.every(positive)) genreIds = null;
    var countries = Array.isArray(raw.production_countries) ? raw.production_countries.map(function (c) { return c.iso_3166_1; }) : null;
    if (countries && !countries.every(function (code) { return /^[A-Z]{2}$/.test(code); })) countries = null;
    var card = clone(raw);
    card.source = 'tmdb'; card.media_type = type;
    return {key:titleKey(type,raw.id),id:Number(raw.id),type:type,title:String(raw.title || raw.name || raw.original_title || raw.original_name || ''),
        originalTitle:String(raw.original_title || raw.original_name || ''),year:/^\d{4}-\d{2}-\d{2}$/.test(date || '') ? Number(date.slice(0,4)) : null,
        genreIds:genreIds,countries:countries,runtimeMinutes:knownRuntime ? Math.max.apply(Math,runtime) : null,
        overview:String(raw.overview || ''),card:card};
}
function resolveIntent(current, patch, form, dictionaries) {
    var next = merge(current || emptyIntent(),patch || {}), issues = [], f = next.filters;
    var rawMinimum = patch && patch.filters && patch.filters.ratingMin;
    if (rawMinimum !== undefined && rawMinimum !== null && (typeof rawMinimum !== 'number' || !isFinite(rawMinimum))) issues.push('Некорректный рейтинг.');
    form = form || {};
    function conflict(value, locked, path) {
        Object.keys(locked).forEach(function (key) {
            if (locked[key] && typeof locked[key] === 'object' && !Array.isArray(locked[key])) conflict(value && value[key] || {},locked[key],path + key + '.');
            else if (value && own(value,key) && JSON.stringify(value[key]) !== JSON.stringify(locked[key])) issues.push('Текст и фильтр «' + path + key + '» противоречат друг другу.');
        });
    }
    conflict(patch && patch.filters || {},form,'');
    next.filters = f = merge(f,form);
    if (f.ratingSource === undefined) f.ratingSource = 'imdb';
    if (f.ratingMin === undefined) f.ratingMin = null;
    if (['imdb','kp','tmdb'].indexOf(f.ratingSource) < 0) issues.push('Выберите источник рейтинга: IMDb, Кинопоиск или TMDB.');
    if (f.ratingMin !== null && (typeof f.ratingMin !== 'number' || !isFinite(f.ratingMin) || f.ratingMin < 0 || f.ratingMin > 10)) issues.push('Рейтинг должен быть числом от 0 до 10.');
    if (['movie','tv','all'].indexOf(f.media) < 0) issues.push('Выберите фильмы, сериалы или всё.');
    ['yearMin','yearMax','maxRuntimeMinutes'].forEach(function (k) { if (f[k] !== null && !positive(f[k])) issues.push('Некорректное числовое ограничение: ' + k); });
    if (f.yearMin !== null && f.yearMax !== null && f.yearMin > f.yearMax) issues.push('Начальный год больше конечного.');
    ['movie','tv'].forEach(function (type) {
        var g = f.genres && f.genres[type];
        if (!g || !Array.isArray(g.include) || !Array.isArray(g.exclude)) { issues.push('Некорректные жанры.'); return; }
        var known = dictionaries && dictionaries.genres && dictionaries.genres[type];
        g.include.concat(g.exclude).forEach(function (id) {
            if (!positive(id) || known && !known.some(function (x) { return x.id === id; })) issues.push('Жанр не поддерживается для выбранного формата.');
        });
        if (g.include.some(function (id) { return g.exclude.indexOf(id) >= 0; })) issues.push('Жанр одновременно включён и исключён.');
    });
    if (f.media === 'all' && f.genres && f.genres.movie && f.genres.tv) {
        var mg = f.genres.movie, tg = f.genres.tv;
        if (!!(mg.include.length + mg.exclude.length) !== !!(tg.include.length + tg.exclude.length)) issues.push('Уточните жанры отдельно для фильмов и сериалов или выберите один формат.');
    }
    if (!Array.isArray(f.countries)) issues.push('Некорректный список стран.');
    else f.countries.forEach(function (code) {
        if (!/^[A-Z]{2}$/.test(code) || dictionaries && dictionaries.countries && !dictionaries.countries.some(function (x) { return x.code === code; })) issues.push('Неизвестная страна производства.');
    });
    if (!Array.isArray(next.preferences) || !next.preferences.every(function (x) { return typeof x === 'string'; })) issues.push('Некорректные пожелания.');
    if (!Array.isArray(next.examples) || next.examples.length > 3 || !next.examples.every(parseKey)) issues.push('Выберите до трёх примеров из каталога.');
    return {status:issues.length ? 'clarify' : 'ready',intent:next,issues:issues};
}
function validateCandidate(c, f) {
    function bad(reason) { return {ok:false,reason:reason}; }
    if (!c || !parseKey(c.key) || !f) return bad('invalid');
    if (f.media !== 'all' && c.type !== f.media) return bad('type');
    var genres = f.genres[c.type];
    if (genres.include.length || genres.exclude.length) {
        if (!c.genreIds) return bad('unknown_genres');
        if (genres.include.length && !genres.include.some(function (id) { return c.genreIds.indexOf(id) >= 0; })) return bad('genres');
        if (genres.exclude.some(function (id) { return c.genreIds.indexOf(id) >= 0; })) return bad('excluded_genres');
    }
    if (f.yearMin !== null && (c.year === null || c.year < f.yearMin)) return bad('year');
    if (f.yearMax !== null && (c.year === null || c.year > f.yearMax)) return bad('year');
    if (f.countries.length && (!c.countries || !f.countries.some(function (code) { return c.countries.indexOf(code) >= 0; }))) return bad('country');
    if (f.maxRuntimeMinutes !== null && (!positive(c.runtimeMinutes) || c.runtimeMinutes > f.maxRuntimeMinutes)) return bad('runtime');
    if (typeof f.ratingMin === 'number') {
        var score = c.ratings && c.ratings[f.ratingSource || 'imdb'];
        if (typeof score !== 'number' || !isFinite(score) || score <= 0 || score > 10) return bad('unknown_rating');
        if (score < f.ratingMin) return bad('rating');
    }
    return {ok:true,reason:null};
}
function createCandidateStore(limit) {
    var records = Object.create(null), keys = [];
    return {
        add:function (c) {
            if (!c || !parseKey(c.key)) return false;
            var old = records[c.key];
            if (!old) { if (keys.length >= limit) return false; keys.push(c.key); records[c.key] = clone(c); return true; }
            Object.keys(c).forEach(function (key) { if (c[key] !== null && c[key] !== '') old[key] = key === 'card' ? merge(old.card,c.card) : clone(c[key]); });
            return true;
        },
        get:function (key) { return own(records,key) ? records[key] : null; },
        all:function () { return keys.map(function (key) { return records[key]; }); }
    };
}
module.exports = {clone:clone,own:own,positive:positive,titleKey:titleKey,parseKey:parseKey,emptyFilters:emptyFilters,emptyIntent:emptyIntent,
    merge:merge,normalizeTitle:normalizeTitle,resolveIntent:resolveIntent,validateCandidate:validateCandidate,createCandidateStore:createCandidateStore};
