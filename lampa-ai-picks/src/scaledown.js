'use strict';
var net = require('./transport'), sources = require('./web-sources');
function createScaleDown(options) {
    function extract(args, done) {
        var doc = sources.buildSourceDocument(args.pages || []), active = true, cancelNetwork = null, timer = null;
        function stop() { active = false;if (timer !== null) options.clock.clearTimeout(timer);if (cancelNetwork) cancelNetwork(); }
        function finish(error, result) { if (!active) return;stop();done(error,result); }
        if (!args.key || !doc.ranges.length) { finish(net.appError('invalid_arguments'));return stop; }
        var timeout = Math.min(args.timeoutMs === undefined ? 15000 : args.timeoutMs,15000);
        if (!(timeout > 0)) { finish(net.appError('timeout'));return stop; }
        timer = options.clock.setTimeout(function () { finish(net.appError('timeout')); },timeout);
        try {
            cancelNetwork = options.request({url:'https://routerai.ru/api/v1/chat/completions',method:'POST',headers:{Authorization:'Bearer ' + args.key.trim()},timeoutMs:timeout,traceId:args.traceId,
                json:{model:'scaledown/extract',messages:[{role:'user',content:doc.text}],stream:false,max_tokens:4096,
                    provider:{options:{scaledown:{entities:{movie_title:'Exact title of a movie or TV series explicitly mentioned in the source text, in its original language. Exclude people, websites and article headings that are not titles of works.'}}}}}},function (error, body) {
                if (!active) return;
                if (error) { finish(error.code ? net.appError(error.code,error.status) : net.normalizeError(error));return; }
                var choice = body && body.choices && body.choices[0], value;
                if (choice && choice.finish_reason === 'length') { finish(net.appError('model_output_limit'));return; }
                try { value = JSON.parse(choice.message.content); } catch (ignore) {}
                if (!value || !Array.isArray(value.entities) || value.entities.length > 200 || !value.entities.every(function (entity) {
                    return entity && typeof entity.type === 'string' && typeof entity.text === 'string' && entity.text.trim() &&
                        typeof entity.start === 'number' && isFinite(entity.start) && Math.floor(entity.start) === entity.start &&
                        typeof entity.end === 'number' && isFinite(entity.end) && Math.floor(entity.end) === entity.end &&
                        typeof entity.confidence === 'number' && isFinite(entity.confidence) && entity.confidence >= 0 && entity.confidence <= 1;
                })) { finish(net.appError('invalid_response'));return; }
                var titles = [], resolved = [], seen = Object.create(null);
                value.entities.forEach(function (entity) {
                    if (!entity || entity.type !== 'movie_title' || typeof entity.confidence !== 'number' || !isFinite(entity.confidence) || entity.confidence < 0 || entity.confidence > 1) return;
                    var span = sources.resolveSpan(doc,entity);
                    if (span) resolved.push({entity:entity,span:span});
                });
                resolved.sort(function (a,b) { return a.span.start - b.span.start || (a.entity.text < b.entity.text ? -1 : a.entity.text > b.entity.text ? 1 : 0); }).forEach(function (row) {
                    var entity = row.entity, span = row.span;
                    if (seen[entity.text] || titles.length >= 20) return;
                    seen[entity.text] = true;titles.push({title:entity.text,type:'unknown',sourceIds:span.sourceIds,confidence:entity.confidence,evidenceBySource:span.evidenceBySource});
                });
                finish(null,{titles:titles,stats:{count:titles.length},modelVersion:typeof body.model === 'string' ? body.model : null,usage:body.usage});
            });
            if (!active && cancelNetwork) cancelNetwork();
        } catch (ignore) { finish(net.appError('network')); }
        return stop;
    }
    return {extract:extract};
}
module.exports = {createScaleDown:createScaleDown};
