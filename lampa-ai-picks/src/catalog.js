'use strict';
var domain = require('./domain'), appError = require('./transport').appError;
function noop() {}
function createCatalog(options) {
    var request = options.request, L = options.Lampa, language = options.language || 'ru-RU';
    function invalid(done) { done(appError('invalid_arguments')); return noop; }
    function get(path, params, done) {
        var query = {api_key:L.TMDB && L.TMDB.key ? L.TMDB.key() : '',language:language,include_adult:false};
        if (!L.TMDB || !L.TMDB.api || !L.TMDB.key) { done(appError('unsupported')); return noop; }
        Object.keys(params || {}).forEach(function (key) { if (params[key] !== null && params[key] !== undefined && params[key] !== '') query[key] = params[key]; });
        var suffix = Object.keys(query).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]); }).join('&');
        return request({url:L.TMDB.api(path + '?' + suffix),method:'GET',headers:{Accept:'application/json'},timeoutMs:10000},done);
    }
    function page(args) { return args.page === undefined ? 1 : args.page; }
    function validPage(args) { return domain.positive(page(args)) && page(args) <= 500; }
    function typed(type) { return type === 'movie' || type === 'tv'; }
    function batch(jobs, done) {
        if (!jobs.length) { done(null,[]); return noop; }
        var active = true, left = jobs.length, values = [], cancels = [];
        jobs.forEach(function (job, index) {
            cancels.push(job(function (error, value) {
                if (!active) return;
                values[index] = {error:error,value:value};
                if (!--left) { active = false; done(null,values); }
            }));
        });
        return function () { active = false; cancels.forEach(function (cancel) { if (cancel) cancel(); }); };
    }
    function list(path, params, type, done) {
        return get(path,params,function (error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.results)) return done(appError('invalid_response'));
            done(null,{items:body.results.map(function (raw) { return domain.normalizeTitle(raw,type); }).filter(Boolean),hasMore:Number(body.total_pages) > Number(body.page || 1)});
        });
    }
    function searchTitles(args, done) {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500 || !validPage(args) ||
            !(typed(args.type) || args.type === 'all') || args.year !== undefined && args.year !== null && !domain.positive(args.year)) return invalid(done);
        var types = args.type === 'all' ? ['movie','tv'] : [args.type];
        return batch(types.map(function (type) { return function (next) {
            var params = {query:args.query,page:page(args)};
            if (args.year) params[type === 'tv' ? 'first_air_date_year' : 'year'] = args.year;
            return list('search/' + type,params,type,next);
        }; }),function (unused, rows) {
            var error = rows.filter(function (row) { return row.error; })[0];
            if (error) return done(error.error);
            var items = [], max = Math.max.apply(Math,rows.map(function (row) { return row.value.items.length; }));
            for (var i = 0; i < max; i++) rows.forEach(function (row) { if (row.value.items[i]) items.push(row.value.items[i]); });
            done(null,{items:items,hasMore:rows.some(function (row) { return row.value.hasMore; })});
        });
    }
    function discoverTitles(args, done) {
        if (!typed(args.type) || !validPage(args) || !args.filters || !Array.isArray(args.keywordIds || []) || !(args.keywordIds || []).every(domain.positive)) return invalid(done);
        var f = args.filters, g = f.genres && f.genres[args.type];
        if (!g || !Array.isArray(g.include) || !Array.isArray(g.exclude)) return invalid(done);
        var params = {page:page(args),sort_by:'popularity.desc',with_genres:g.include.join('|'),without_genres:g.exclude.join('|'),
            with_origin_country:f.countries.join('|'),with_keywords:(args.keywordIds || []).join('|'),'with_runtime.lte':f.maxRuntimeMinutes};
        var prefix = args.type === 'tv' ? 'first_air_date' : 'primary_release_date';
        if (f.yearMin) params[prefix + '.gte'] = f.yearMin + '-01-01';
        if (f.yearMax) params[prefix + '.lte'] = f.yearMax + '-12-31';
        return list('discover/' + args.type,params,args.type,done);
    }
    function resolveKeywords(args, done) {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200 || !validPage(args)) return invalid(done);
        return get('search/keyword',{query:args.query,page:page(args)},function (error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.results)) return done(appError('invalid_response'));
            done(null,{items:body.results.filter(function (x) { return domain.positive(x.id) && typeof x.name === 'string'; }).map(function (x) { return {id:x.id,name:x.name}; })});
        });
    }
    function getRelated(args, done) {
        var parsed = domain.parseKey(args.key);
        if (!parsed || ['recommendations','similar'].indexOf(args.relation) < 0 || !validPage(args)) return invalid(done);
        return list(parsed.type + '/' + parsed.id + '/' + args.relation,{page:page(args)},parsed.type,done);
    }
    function getTitleDetails(args, done) {
        if (!Array.isArray(args.keys) || args.keys.length > 10 || !args.keys.every(domain.parseKey)) return invalid(done);
        return batch(args.keys.map(function (key) { return function (next) {
            var parsed = domain.parseKey(key);
            return get(parsed.type + '/' + parsed.id,{},function (error, raw) {
                if (error) return next(error);
                var c = domain.normalizeTitle(raw,parsed.type);
                if (!c || c.key !== key) return next(appError('invalid_response'));
                next(null,c);
            });
        }; }),function (unused, rows) {
            var result = [], errors = [];
            rows.forEach(function (row, i) { if (row.error) errors.push({key:args.keys[i],code:row.error.code}); else result.push(row.value); });
            if (!result.length && errors.length) return done(rows[0].error || appError('network'));
            result.errors = errors;
            done(null,result);
        });
    }
    function getDictionaries(done) {
        var paths = ['genre/movie/list','genre/tv/list','configuration/countries'];
        return batch(paths.map(function (path) { return function (next) { return get(path,{},next); }; }),function (unused, rows) {
            var failed = rows.filter(function (row) { return row.error; })[0];
            if (failed) return done(failed.error);
            if (!rows[0].value || !Array.isArray(rows[0].value.genres) || !rows[1].value || !Array.isArray(rows[1].value.genres) || !Array.isArray(rows[2].value)) return done(appError('invalid_response'));
            function genres(body) { return body.genres.filter(function (x) { return domain.positive(x.id) && typeof x.name === 'string'; }).map(function (x) { return {id:x.id,name:x.name}; }); }
            done(null,{genres:{movie:genres(rows[0].value),tv:genres(rows[1].value)},countries:rows[2].value.filter(function (x) { return /^[A-Z]{2}$/.test(x.iso_3166_1); }).map(function (x) { return {code:x.iso_3166_1,name:x.native_name || x.english_name || x.iso_3166_1}; })});
        });
    }
    return {getDictionaries:getDictionaries,searchTitles:searchTitles,resolveKeywords:resolveKeywords,discoverTitles:discoverTitles,getRelated:getRelated,getTitleDetails:getTitleDetails};
}
module.exports = {createCatalog:createCatalog};
