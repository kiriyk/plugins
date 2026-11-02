'use strict';
var appError = require('./transport').appError;
function noop() {}
function createWebSearch(options) {
    var state = options.state;
    function pages(rows, secret) {
        var found = {}, output = [];
        rows.slice(0,10).forEach(function (row) {
            if (!row || typeof row.url !== 'string' || row.url.length > 2000) return;
            var url = row.url.split('#')[0], match = /^https?:\/\/([a-z0-9.-]+)(?::[0-9]+)?(?:[/?]|$)/i.exec(url);
            if (!match || url.indexOf(secret) >= 0 || found[url]) return;
            function text(value, limit) { return String(value || '').split(secret).join('[скрыто]').slice(0,limit); }
            found[url] = true;
            output.push({id:'web-' + state.fingerprint(url),url:url,domain:match[1].toLowerCase(),title:text(row.title,500),content:text(row.content,1500)});
        });
        return output;
    }
    function search(args, done) {
        var key = String(args.key || '').trim(), query = String(args.query || '').trim().replace(/\s+/g,' ');
        if (!key) { done(appError('web_key'));return noop; }
        if (!query || query.length > 500) { done(appError('invalid_arguments'));return noop; }
        var identity = state.fingerprint(key), hit = state.getCache(identity,query);
        if (hit !== null) { done(null,{pages:pages(hit,key),cacheHit:true,estimatedCredits:0});return noop; }
        if (!state.reserveCredit(identity)) { done(appError('web_quota'));return noop; }
        var active = true;
        var cancel = options.request({url:'https://api.tavily.com/search',method:'POST',headers:{Authorization:'Bearer ' + key},
            json:{query:query,topic:'general',search_depth:'basic',max_results:10,auto_parameters:false,include_answer:false,include_raw_content:false,include_images:false},timeoutMs:Math.min(args.timeoutMs || 15000,15000)},function (error, body) {
            if (!active) return;
            active = false;
            if (error) {
                var status = error.status;
                done(appError(status === 432 || status === 433 || status === 402 ? 'web_quota' : status === 401 || status === 403 ? 'web_auth' : status === 429 ? 'rate_limit' : error.code || 'network',status));return;
            }
            if (!body || !Array.isArray(body.results)) { done(appError('invalid_response'));return; }
            var output = pages(body.results,key);state.putCache(identity,query,output);
            done(null,{pages:output,cacheHit:false,estimatedCredits:1});
        });
        return function () { active = false;if (cancel) cancel(); };
    }
    return {search:search,probe:function (args, done) { return search({key:args.key,query:'science fiction movies',timeoutMs:15000},done); }};
}
module.exports = {createWebSearch:createWebSearch};
