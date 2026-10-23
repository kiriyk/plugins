'use strict';
var appError = require('./transport').appError, normalizeLimits = require('./limits').normalizeLimits;
function noop() {}
function createBudget(options) {
    var limits = normalizeLimits(options.limits);
    var clock = options.clock, started = clock.now(), stopped = false, queue = [], records = [];
    var counts = {modelCalls:0,toolCalls:0,catalogRequests:0,activeCatalog:0}, pumping = false;
    function remainingMs() { return Math.max(0,limits.totalTimeoutMs - (clock.now() - started)); }
    function pump() {
        if (pumping || stopped) return;
        pumping = true;
        while (queue.length && counts.activeCatalog < 3 && !stopped) {
            var job = queue.shift();
            if (job.settled) continue;
            if (!remainingMs()) { job.finish(appError('timeout')); continue; }
            if (counts.catalogRequests >= limits.catalogRequests) { job.finish(appError('catalog_limit')); continue; }
            counts.catalogRequests++; counts.activeCatalog++; job.started = true;
            job.spec.timeoutMs = Math.min(job.spec.timeoutMs || limits.catalogTimeoutMs,limits.catalogTimeoutMs,remainingMs());
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
    function catalogRequest(spec, done) {
        if (stopped) return noop;
        var job = {spec:{url:spec.url,method:spec.method,json:spec.json,headers:spec.headers,timeoutMs:spec.timeoutMs,traceId:options.traceId},settled:false,started:false,timer:null};
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
        catalogRequest:catalogRequest,remainingMs:remainingMs,
        consumeModel:function () { return consume('modelCalls',limits.modelCalls); },
        consumeTool:function () { return consume('toolCalls',limits.toolCalls); },
        snapshot:function () { return {modelCalls:counts.modelCalls,toolCalls:counts.toolCalls,catalogRequests:counts.catalogRequests,activeCatalog:counts.activeCatalog}; },
        cancel:function (reason) {
            if (stopped) return;
            stopped = true; queue = [];
            records.forEach(function (job) { job.settled = true; if (job.timer !== null) clock.clearTimeout(job.timer); if (job.cancelNetwork) job.cancelNetwork(reason); });
            counts.activeCatalog = 0;
        }
    };
}
module.exports = {createBudget:createBudget};
