'use strict';
var appError = require('./transport').appError;
var CACHE = 'aip_rating_cache', DAY = 86400000, KP = 'https://kinopoiskapiunofficial.tech/api/v2.2/films';
function score(value) { return typeof value === 'number' && isFinite(value) && value > 0 && value <= 10 ? value : null; }
function imdbId(value) { return /^tt[0-9]+$/.test(String(value || '')) ? String(value) : ''; }
function normal(value) { return String(value || '').toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/g,''); }
function createRatings(options) {
    var storage = options.Lampa.Storage, cache = {}, usedKp = 0, blocked = null, ids = {};
    try { cache = storage.get(CACHE,{});if (typeof cache === 'string') cache = JSON.parse(cache);if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {}; } catch (ignore) { cache = {}; }
    function cached(key) {
        var row = cache[key];return row && row.expires > options.clock.now() && (row.value === null || score(row.value) !== null) ? row : null;
    }
    function remember(key, value) {
        cache[key] = {value:value,expires:options.clock.now() + (value === null ? DAY / 2 : DAY)};
        var keys = Object.keys(cache).sort(function (a,b) { return cache[b].expires - cache[a].expires; });
        keys.slice(500).forEach(function (name) { delete cache[name]; });
        try { storage.set(CACHE,cache); } catch (ignore) {}
    }
    function getMany(candidates, source, done) {
        var active = true, cancels = [], rows = {}, pending = [], byId = {};
        function cancel() { active = false;cancels.forEach(function (fn) { if (fn) fn(); }); }
        function finish() { if (active) { active = false;done(null,rows); } }
        function result(c, value, error) {
            if (!active) return;
            value = score(value);rows[c.key] = {value:value,error:error || null};
            if (!error && source !== 'tmdb') remember(source + ':' + c.key,value);
        }
        function resolve(c, callback) {
            var card = c.card || {}, id = imdbId(card.imdb_id || (card.external_ids || {}).imdb_id || ids[c.key]);
            if (id) return callback(null,id);
            cancels.push(options.catalog.getExternalIds(c.key,function (error, data) {
                if (!active) return;
                var found = imdbId(data && data.imdb_id);if (!error) ids[c.key] = found;
                callback(error,found);
            }));
        }
        function request(url, headers, callback) {
            cancels.push(options.request({url:url,method:'GET',headers:headers,timeoutMs:10000},function (error, body) { if (active) callback(error,body); }));
        }
        candidates.forEach(function (c) {
            var hit = source !== 'tmdb' && cached(source + ':' + c.key);
            if (hit) rows[c.key] = {value:hit.value,error:null};
            else if (source === 'tmdb') result(c,(c.card || {}).vote_average,null);
            else pending.push(c);
        });
        if (!pending.length) { finish();return cancel; }
        if (source === 'imdb') {
            var left = pending.length;
            pending.forEach(function (c) {
                resolve(c,function (error,id) {
                    if (error) result(c,null,error);
                    else if (!id) result(c,null,null);
                    else { if (!byId[id]) byId[id] = [];byId[id].push(c); }
                    if (--left) return;
                    var keys = Object.keys(byId);
                    if (!keys.length) return finish();
                    request('https://api.agregarr.org/api/ratings?' + keys.map(function (key) { return 'id=' + encodeURIComponent(key); }).join('&'),{Accept:'application/json'},function (error, data) {
                        if (!error && !Array.isArray(data)) error = appError('invalid_response');
                        var found = {};
                        if (!error) data.forEach(function (row) { if (row && imdbId(row.imdbId) && byId[row.imdbId]) found[row.imdbId] = score(row.rating); });
                        keys.forEach(function (key) { byId[key].forEach(function (c) { result(c,found[key],error); }); });finish();
                    });
                });
            });
        } else if (source === 'kp') {
            var token = '';
            try { token = String(storage.get('cr_api_key','') || '').trim(); } catch (ignore) {}
            var at = 0, cap = options.maxKpRequests || 10;
            function api(suffix, callback) {
                if (blocked) return callback(blocked);
                if (!token) return callback(appError('kp_key'));
                if (usedKp >= cap) return callback(appError('kp_limit'));
                usedKp++;
                request(KP + suffix,{'X-API-KEY':token,Accept:'application/json'},function (error,data) {
                    if (error && [401,402,403,429].indexOf(error.status) >= 0) blocked = error;
                    callback(error,data);
                });
            }
            function next() {
                if (!active) return;
                if (at >= pending.length) return finish();
                var c = pending[at++], card = c.card || {}, kpId = String(card.kinopoiskId || card.kinopoisk_id || card.kp_id || '');
                function accept(error, value) { result(c,value,error);next(); }
                function search(id) {
                    var names = [normal(c.title),normal(c.originalTitle)].filter(Boolean);
                    if (!c.year || !names.length) return accept(null,null);
                    api('?keyword=' + encodeURIComponent(c.title || c.originalTitle) + '&yearFrom=' + (c.year - 1) + '&yearTo=' + (c.year + 1),function (error,data) {
                        if (error) return accept(error);
                        if (!data || !Array.isArray(data.items)) return accept(appError('invalid_response'));
                        var matches = data.items.filter(function (film) {
                            return film && (!id || !film.imdbId || film.imdbId === id) && Math.abs(Number(film.year) - c.year) <= 1 &&
                                (c.type === 'tv' ? /^(TV_SERIES|MINI_SERIES|TV_SHOW)$/.test(film.type) : /^(FILM|VIDEO)$/.test(film.type)) &&
                                [film.nameRu,film.nameEn,film.nameOriginal].some(function (name) { return !!normal(name) && names.indexOf(normal(name)) >= 0; });
                        });
                        accept(null,matches.length === 1 ? matches[0].ratingKinopoisk : null);
                    });
                }
                if (blocked || !token || usedKp >= cap) return accept(blocked || appError(!token ? 'kp_key' : 'kp_limit'));
                if (/^[1-9][0-9]*$/.test(kpId)) api('/' + kpId,function (error,data) {
                    if (error) return accept(error);
                    if (!data || String(data.kinopoiskId) !== kpId) return accept(appError('invalid_response'));
                    accept(null,data.ratingKinopoisk);
                });
                else resolve(c,function (error,id) {
                    if (error) return accept(error);
                    if (!id) return search('');
                    api('?imdbId=' + encodeURIComponent(id),function (err,data) {
                        if (err) return accept(err);
                        if (!data || !Array.isArray(data.items)) return accept(appError('invalid_response'));
                        var matches = data.items.filter(function (film) { return film && film.imdbId === id; });
                        if (matches.length === 1) accept(null,matches[0].ratingKinopoisk);
                        else if (matches.length > 1) accept(appError('invalid_response'));
                        else search(id);
                    });
                });
            }
            next();
        } else { pending.forEach(function (c) { result(c,null,appError('invalid_arguments')); });finish(); }
        return cancel;
    }
    return {getMany:getMany};
}
module.exports = {createRatings:createRatings};
