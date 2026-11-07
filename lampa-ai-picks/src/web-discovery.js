'use strict';
var d = require('./domain'), appError = require('./transport').appError, normalizeLimits = require('./limits').normalizeLimits;
function name(value) { return String(value || '').toLowerCase().replace(/ё/g,'е').replace(/[\s.,:;!?…'"«»()\[\]{}\-–—_/\\]+/g,''); }
function createWebDiscovery(options) {
    var limits = normalizeLimits(options.limits);
    function run(args, done, onProgress) {
        var active = true, cancels = [], timer = null, pages = [], pageIds = Object.create(null), proposals = [], accepted = [], queries = [];
        (args.queries || []).slice(0,2).forEach(function (query) { query = String(query).trim();if (query && query.length <= 500 && queries.indexOf(query) < 0) queries.push(query); });
        function progress(stage) { if (onProgress) onProgress(stage); }
        function track(cancel) { if (active) cancels.push(cancel);else if (cancel) cancel(); }
        function stop() { active = false;if (timer !== null) options.clock.clearTimeout(timer);cancels.forEach(function (cancel) { if (cancel) cancel(); }); }
        function finish(error) {
            if (!active) return;
            var snapshot = {extractorId:args.extractorId || 'primary',schemaVersion:1,primaryModelId:args.extractorId === 'scaledown/extract' ? null : args.model,queries:queries,pages:pages,proposals:proposals,resolvedCandidates:accepted.map(function (key) { return d.clone(options.store.get(key)); }),expiresAt:options.clock.now() + 86400000};
            stop();done(error || null,{candidateKeys:accepted,stats:{pages:pages.length,proposals:proposals.length,resolved:accepted.length},webSnapshot:snapshot});
        }
        function resolve(at) {
            if (!active) return;
            if (at >= proposals.length) { finish();return; }
            var proposal = proposals[at], media = args.intent.filters.media;
            if (media !== 'all' && proposal.type !== 'unknown' && proposal.type !== media) { resolve(at + 1);return; }
            var type = proposal.type === 'unknown' ? media : proposal.type, cost = type === 'all' ? 2 : 1;
            var available = limits.catalogRequests - options.budget.snapshot().catalogRequests - Math.ceil(limits.catalogRequests * 0.6);
            if (cost > available || resolveCount + cost > 20) { finish();return; }
            resolveCount += cost;
            track(options.catalog.searchTitles({query:proposal.title,type:type},function (error, result) {
                if (!active) return;
                if (!error && result && !result.hasMore) {
                    var expected = [name(proposal.title),name(proposal.originalTitle)].filter(Boolean);
                    var matches = result.items.filter(function (c) {
                        return (type === 'all' || c.type === type) && (proposal.year === undefined || c.year !== null && Math.abs(c.year - proposal.year) <= 1) &&
                            [name(c.title),name(c.originalTitle)].some(function (value) { return value && expected.indexOf(value) >= 0; });
                    });
                    if (matches.length === 1) {
                        var candidate = d.clone(matches[0]);
                        candidate.webSources = pages.filter(function (page) { return proposal.sourceIds.indexOf(page.id) >= 0; }).map(function (page) { var source = {id:page.id,url:page.url,title:page.title,domain:page.domain};if (proposal.evidenceBySource && d.own(proposal.evidenceBySource,page.id)) source.evidenceText = String(proposal.evidenceBySource[page.id]).slice(0,250);return source; });
                        if (options.store.add(candidate) && accepted.indexOf(candidate.key) < 0) accepted.push(candidate.key);
                    }
                }
                resolve(at + 1);
            }));
        }
        var resolveCount = 0;
        function extract() {
            if (!active) return;
            if (!pages.length) { finish();return; }
            if (options.budget.snapshot().modelCalls >= limits.modelCalls - 1 || !options.budget.consumeModel()) { finish(appError('search_limit'));return; }
            progress('web_resolving');
            timer = options.clock.setTimeout(function () { finish(appError('timeout')); },Math.min(limits.modelTimeoutMs,options.budget.remainingMs()));
            var extractor = options.extractor || require('./primary-extractor').createPrimaryExtractor({routerai:options.routerai});
            track(extractor.extract({key:args.key,model:args.model,query:args.query,intent:args.intent,pages:pages,traceId:args.traceId,timeoutMs:Math.min(limits.modelTimeoutMs,options.budget.remainingMs())},function (error, result) {
                if (!active) return;
                options.clock.clearTimeout(timer);timer = null;
                if (error) { finish(error);return; }
                proposals = result.titles;resolve(0);
            }));
        }
        function search(at) {
            if (!active) return;
            if (at >= queries.length) { extract();return; }
            track(options.webSearch.search({key:args.webKey,query:queries[at],timeoutMs:15000},function (error, result) {
                if (!active) return;
                if (error) { finish(error);return; }
                result.pages.slice(0,10).forEach(function (page) {
                    if (!pageIds[page.id] && pages.length < 20) { pageIds[page.id] = true;var copy = d.clone(page);copy.content = String(copy.content || '').slice(0,1500);pages.push(copy); }
                });
                search(at + 1);
            }));
        }
        progress('web_searching');search(0);
        return stop;
    }
    return {run:run};
}
module.exports = {createWebDiscovery:createWebDiscovery};
