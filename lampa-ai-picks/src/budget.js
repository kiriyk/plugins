'use strict';
var appError = require('./transport').appError, normalizeLimits = require('./limits').normalizeLimits;
function noop() {}
function createBudget(options) {
    var limits = normalizeLimits(options.limits);
    var clock = options.clock, started = clock.now(), stopped = false, queue = [], records = [];
    var counts = {modelCalls:0,decisionCalls:0,toolCalls:0,catalogRequests:0,webRequests:0,activeCatalog:0}, pumping = false;
    function remainingMs() { return Math.max(0,limits.totalTimeoutMs - (clock.now() - started)); }
    function pump() {
        if (pumping || stopped) return;
        pumping = true;
        while (queue.length && counts.activeCatalog < 3 && !stopped) {
            var job = queue.shift();
            if (job.settled) continue;
            if (!remainingMs()) { job.finish(appError('timeout')); continue; }
            var counter = job.web ? 'webRequests' : 'catalogRequests', cap = job.web ? 2 : limits.catalogRequests;
            if (counts[counter] >= cap) { job.finish(appError(job.web ? 'web_limit' : 'catalog_limit')); continue; }
            counts[counter]++; counts.activeCatalog++; job.started = true;
            var timeout = job.web ? 15000 : limits.catalogTimeoutMs;
            job.spec.timeoutMs = Math.min(job.spec.timeoutMs || timeout,timeout,remainingMs());
            (function (row) {
                row.timer = clock.setTimeout(function () {
                    if (row.cancelNetwork) row.cancelNetwork('timeout');
                    row.finish(appError('timeout'));
                },row.spec.timeoutMs);
                try { row.cancelNetwork = options.request(row.spec,row.finish); }
                catch (ignore) { row.finish(appError('network')); }
            }(job));
        }
        pumping = false;
    }
    function enqueue(spec, done, web) {
        if (stopped) return noop;
        var job = {web:web,spec:{url:spec.url,method:spec.method,json:spec.json,headers:spec.headers,timeoutMs:spec.timeoutMs,traceId:options.traceId},settled:false,started:false,timer:null};
        job.finish = function (error, value) {
            if (job.settled || stopped) return;
            job.settled = true;
            if (job.timer !== null) clock.clearTimeout(job.timer);
            if (job.started) counts.activeCatalog--;
            done(error,value); pump();
        };
        records.push(job); queue.push(job); pump();
        return function () {
            if (job.settled) return;
            job.settled = true;
            if (job.timer !== null) clock.clearTimeout(job.timer);
            if (job.cancelNetwork) job.cancelNetwork();
            if (job.started) counts.activeCatalog--;
            pump();
        };
    }
    function consume(key, max) { if (stopped || !remainingMs() || counts[key] >= max) return false; counts[key]++; return true; }
    return {
        catalogRequest:function (spec, done) { return enqueue(spec,done,false); },webRequest:function (spec, done) { return enqueue(spec,done,true); },remainingMs:remainingMs,
        consumeDecision:function () { return consume('decisionCalls',limits.decisionCalls); },
        consumeModel:function () { return consume('modelCalls',limits.modelCalls); },
        consumeTool:function () { return consume('toolCalls',limits.toolCalls); },
        snapshot:function () { return {modelCalls:counts.modelCalls,decisionCalls:counts.decisionCalls,toolCalls:counts.toolCalls,catalogRequests:counts.catalogRequests,webRequests:counts.webRequests,activeCatalog:counts.activeCatalog}; },
        cancel:function (reason) {
            if (stopped) return;
            stopped = true; queue = [];
            records.forEach(function (job) { job.settled = true; if (job.timer !== null) clock.clearTimeout(job.timer); if (job.cancelNetwork) job.cancelNetwork(reason); });
            counts.activeCatalog = 0;
        }
    };
}
module.exports = {createBudget:createBudget};
