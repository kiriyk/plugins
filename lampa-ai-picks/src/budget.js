'use strict';
var appError = require('./transport').appError;
function noop() {}
function createBudget(options) {
    var clock = options.clock, started = clock.now(), stopped = false, queue = [], records = [];
    var counts = {modelCalls:0,toolCalls:0,catalogRequests:0,activeCatalog:0}, pumping = false;
    function remainingMs() { return Math.max(0,90000 - (clock.now() - started)); }
    function pump() {
        if (pumping || stopped) return;
        pumping = true;
        while (queue.length && counts.activeCatalog < 3 && !stopped) {
            var job = queue.shift();
            if (job.settled) continue;
            if (!remainingMs()) { job.finish(appError('timeout')); continue; }
            if (counts.catalogRequests >= 40) { job.finish(appError('catalog_limit')); continue; }
            counts.catalogRequests++; counts.activeCatalog++; job.started = true;
            job.spec.timeoutMs = Math.min(job.spec.timeoutMs || 10000,10000,remainingMs());
            (function (row) {
                row.timer = clock.setTimeout(function () {
                    if (row.cancelNetwork) row.cancelNetwork();
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
        var job = {spec:{url:spec.url,method:spec.method,json:spec.json,headers:spec.headers,timeoutMs:spec.timeoutMs},settled:false,started:false,timer:null};
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
        consumeModel:function () { return consume('modelCalls',5); },
        consumeTool:function () { return consume('toolCalls',12); },
        snapshot:function () { return {modelCalls:counts.modelCalls,toolCalls:counts.toolCalls,catalogRequests:counts.catalogRequests,activeCatalog:counts.activeCatalog}; },
        cancel:function () {
            if (stopped) return;
            stopped = true; queue = [];
            records.forEach(function (job) { job.settled = true; if (job.timer !== null) clock.clearTimeout(job.timer); if (job.cancelNetwork) job.cancelNetwork(); });
            counts.activeCatalog = 0;
        }
    };
}
module.exports = {createBudget:createBudget};
