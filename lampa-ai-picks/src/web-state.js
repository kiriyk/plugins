'use strict';
var clone = require('./domain').clone, DAY = 86400000;
function bytes(text) {
    var size = 0;
    for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        if (code < 128) size++;
        else if (code < 2048) size += 2;
        else if (code >= 55296 && code <= 56319 && i + 1 < text.length && text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) { size += 4;i++; }
        else size += 3;
    }
    return size;
}
// Local cache identity only; never sent to a server or used for authentication.
function fingerprint(text) {
    var a = 2166136261, b = 5381;
    text = String(text);
    for (var i = 0; i < text.length; i++) { a ^= text.charCodeAt(i);a += (a << 1) + (a << 4) + (a << 7) + (a << 8) + (a << 24);b = ((b << 5) + b) ^ text.charCodeAt(i); }
    return ('00000000' + (a >>> 0).toString(16)).slice(-8) + ('00000000' + (b >>> 0).toString(16)).slice(-8);
}
function createWebState(options) {
    options = options || {};
    var clock = options.clock || {now:function () { return Date.now(); }}, storage = options.Storage;
    var cache = [], usage = Object.create(null);
    function month() { return new Date(clock.now()).toISOString().slice(0,7); }
    try {
        var saved = storage && storage.get('aip_web_state','');
        if (typeof saved === 'string' && saved.length <= 1048576) saved = JSON.parse(saved);
        if (saved && saved.version === 1) {
            if (Array.isArray(saved.cache)) cache = saved.cache.filter(function (row) { return row && typeof row.identity === 'string' && typeof row.query === 'string' && Array.isArray(row.pages) && row.expires > clock.now(); }).slice(-20);
            Object.keys(saved.usage || {}).forEach(function (key) {
                var row = saved.usage[key];
                if (/^[a-f0-9]{16}$/.test(key) && row && row.month === month() && typeof row.count === 'number' && row.count >= 0 && row.count <= 950) usage[key] = row;
            });
        }
    } catch (ignore) {}
    function persist() {
        cache = cache.filter(function (row) { return row.expires > clock.now(); });
        while (cache.length > 20 || bytes(JSON.stringify(cache)) > 500000) cache.shift();
        try { if (storage) storage.set('aip_web_state',JSON.stringify({version:1,cache:cache,usage:usage})); } catch (ignore) {}
    }
    function row(identity) {
        if (!usage[identity] || usage[identity].month !== month()) usage[identity] = {month:month(),count:0};
        return usage[identity];
    }
    return {fingerprint:fingerprint,
        getCache:function (identity, query) {
            for (var i = 0;i < cache.length;i++) if (cache[i].identity === identity && cache[i].query === query && cache[i].expires > clock.now()) {
                var hit = cache.splice(i,1)[0];cache.push(hit);persist();return clone(hit.pages);
            }
            return null;
        },
        putCache:function (identity, query, pages) {
            cache = cache.filter(function (item) { return item.identity !== identity || item.query !== query; });
            cache.push({identity:identity,query:query,expires:clock.now() + DAY,pages:clone(pages)});persist();
        },
        reserveCredit:function (identity) { var item = row(identity);if (item.count >= 950) return false;item.count++;persist();return true; },
        usage:function (identity) { return row(identity).count; }
    };
}
module.exports = {createWebState:createWebState};
