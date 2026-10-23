'use strict';
var appError = require('./transport').appError, domain = require('./domain'), normalizeLimits = require('./limits').normalizeLimits;
var STORAGE = 'aip_diagnostic_journal';
var events = ['run_start','screening','stage','filters','tool_start','tool_result','request_start','request_end','request_cancel','candidate_rejected','run_done','run_error','run_cancel','clarification'];
var codes = ['timeout','network','auth','balance','rate_limit','server','unsupported','invalid_arguments','invalid_response','catalog_limit','tool_limit','search_limit','context_limit','incompatible_model','unknown_title','unknown_keyword','intent_required','clarification','session_limit','cancelled','kp_key','kp_limit','unknown'];
var reasons = ['invalid_pick','unknown_key','already_shown','duplicate','count_limit','invalid','type','unknown_genres','genres','excluded_genres','year','country','runtime','rating','unknown_rating','not_verified'];
var tools = ['set_search_intent','search_titles','resolve_keywords','discover_titles','get_related','get_title_details','unknown'];
var endpointPattern = /^(genre\/(movie|tv)\/list|configuration\/countries|search\/(movie|tv|keyword)|discover\/(movie|tv)|(movie|tv)\/[1-9][0-9]*(\/(recommendations|similar|external_ids))?|api\/ratings|api\/v2.2\/films(\/[1-9][0-9]*)?|chat\/completions|models)$/;
var paramPatterns = {
    page:/^[1-9][0-9]{0,2}$/,year:/^[0-9]{4}$/,first_air_date_year:/^[0-9]{4}$/,
    with_genres:/^[0-9|,]{1,300}$/,without_genres:/^[0-9|,]{1,300}$/,with_keywords:/^[0-9|,]{1,300}$/,
    with_origin_country:/^[A-Z]{2}([|,][A-Z]{2})*$/,
    'with_runtime.lte':/^[0-9]{1,5}$/,
    'primary_release_date.gte':/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    'primary_release_date.lte':/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    'first_air_date.gte':/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    'first_air_date.lte':/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    sort_by:/^popularity\.desc$/,language:/^[a-z]{2}(-[A-Z]{2})?(,[a-z]{2}(-[A-Z]{2})?)*$/,include_adult:/^(true|false)$/
};
function integer(value, max) { return typeof value === 'number' && isFinite(value) && value >= 0 && value <= (max || 1000000) && Math.floor(value) === value; }
function safeParams(source) {
    var result = {};
    Object.keys(paramPatterns).forEach(function (name) {
        var value = source && source[name];
        if (typeof value === 'string' && value.length <= 300 && paramPatterns[name].test(value)) result[name] = value;
    });
    return result;
}
function safeFilters(source) {
    var result = {};if (!source || typeof source !== 'object') return result;
    if (['movie','tv','all'].indexOf(source.media) >= 0) result.media = source.media;
    ['yearMin','yearMax','maxRuntimeMinutes'].forEach(function (key) {
        if (source[key] === null || integer(source[key],10000)) result[key] = source[key];
    });
    if (['imdb','kp','tmdb'].indexOf(source.ratingSource) >= 0) result.ratingSource = source.ratingSource;
    if (source.ratingMin === null || typeof source.ratingMin === 'number' && isFinite(source.ratingMin) && source.ratingMin >= 0 && source.ratingMin <= 10) result.ratingMin = source.ratingMin;
    if (Array.isArray(source.countries)) result.countries = source.countries.filter(function (value) { return typeof value === 'string' && /^[A-Z]{2}$/.test(value); }).slice(0,50);
    if (source.genres) {
        result.genres = {};
        ['movie','tv'].forEach(function (type) {
            var input = source.genres[type];if (!input) return;
            result.genres[type] = {};
            ['include','exclude'].forEach(function (kind) {
                if (Array.isArray(input[kind])) result.genres[type][kind] = input[kind].filter(function (value) { return integer(value) && value > 0; }).slice(0,40);
            });
        });
    }
    return result;
}
function safeRecord(event, source, at) {
    if (events.indexOf(event) < 0) return null;
    source = source || {};
    var row = {at:integer(at,9007199254740991) ? at : 0,event:event};
    ['runId','requestId','elapsedMs','count','candidates','rejected','queryLength'].forEach(function (key) { if (integer(source[key])) row[key] = source[key]; });
    if (['new','more','refine'].indexOf(source.mode) >= 0) row.mode = source.mode;
    if (['idle','parsing','searching','checking','ranking','done','error','cancelled','clarification'].indexOf(source.stage) >= 0) row.stage = source.stage;
    if (['filters','example'].indexOf(source.kind) >= 0) row.kind = source.kind;
    if (['catalog','model','search','rating'].indexOf(source.scope) >= 0) row.scope = source.scope;
    if (source.tool !== undefined) row.tool = tools.indexOf(source.tool) >= 0 ? source.tool : 'unknown';
    if (source.code !== undefined) row.code = codes.indexOf(source.code) >= 0 ? source.code : 'unknown';
    if (reasons.indexOf(source.reason) >= 0) row.reason = source.reason;
    if (domain.parseKey(source.key)) row.key = source.key;
    if (typeof source.ok === 'boolean') row.ok = source.ok;
    if (integer(source.status,599) && source.status >= 100) row.status = source.status;
    if (typeof source.host === 'string' && /^[a-z0-9.-]+(:[0-9]+)?$/i.test(source.host) && source.host.length <= 200) row.host = source.host;
    if (typeof source.endpoint === 'string' && endpointPattern.test(source.endpoint)) row.endpoint = source.endpoint;
    if (['GET','POST'].indexOf(source.method) >= 0) row.method = source.method;
    if (source.params) row.params = safeParams(source.params);
    if (source.filters) row.filters = safeFilters(source.filters);
    if (source.facts) {
        row.facts = {};
        if (['movie','tv'].indexOf(source.facts.type) >= 0) row.facts.type = source.facts.type;
        ['year','runtimeMinutes'].forEach(function (key) { if (source.facts[key] === null || integer(source.facts[key],10000)) row.facts[key] = source.facts[key]; });
        if (Array.isArray(source.facts.genreIds)) row.facts.genreIds = source.facts.genreIds.filter(function (id) { return integer(id) && id > 0; }).slice(0,40);
        if (Array.isArray(source.facts.countries)) row.facts.countries = source.facts.countries.filter(function (code) { return typeof code === 'string' && /^[A-Z]{2}$/.test(code); }).slice(0,50);
    }
    if (source.stats) {
        row.stats = {};
        ['candidates','checked','conditionsPassed','ratingChecked','ratingPassed','missingRatings','ratingErrors','metadataErrors','metadataMissing','unverified','selected'].forEach(function (key) { if (integer(source.stats[key])) row.stats[key] = source.stats[key]; });
        if (['imdb','kp','tmdb'].indexOf(source.stats.ratingSource) >= 0) row.stats.ratingSource = source.stats.ratingSource;
        if (codes.indexOf(source.stats.stopReason) >= 0) row.stats.stopReason = source.stats.stopReason;
    }
    if (source.limits) row.limits = normalizeLimits(source.limits);
    if (source.budget) {
        row.budget = {};
        ['modelCalls','toolCalls','catalogRequests','activeCatalog'].forEach(function (key) { if (integer(source.budget[key])) row.budget[key] = source.budget[key]; });
    }
    return row;
}
function networkInfo(spec) {
    var url = String(spec.url || ''), match = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url), params = {};
    var host = match ? match[1].split('@').pop() : '', path = match ? match[2] : '';
    var endpoint = path.match(/\/(genre\/(?:movie|tv)\/list|configuration\/countries|search\/(?:movie|tv|keyword)|discover\/(?:movie|tv)|(?:movie|tv)\/[1-9][0-9]*(?:\/(?:recommendations|similar|external_ids))?|api\/ratings|api\/v2.2\/films(?:\/[1-9][0-9]*)?|chat\/completions|models)$/);
    var query = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
    query.split('&').forEach(function (part) {
        var at = part.indexOf('='), name, value;if (at < 0) return;
        try { name = decodeURIComponent(part.slice(0,at));value = decodeURIComponent(part.slice(at + 1)); } catch (ignore) { return; }
        if (Object.prototype.hasOwnProperty.call(paramPatterns,name)) params[name] = value;
    });
    return {host:host,endpoint:endpoint ? endpoint[1] : undefined,method:spec.method,params:safeParams(params),scope:endpoint && (endpoint[1] === 'chat/completions' || endpoint[1] === 'models') ? 'model' : endpoint && /^api\//.test(endpoint[1]) ? 'rating' : endpoint ? 'catalog' : undefined};
}
function createDiagnostics(options) {
    var records = [], enabled = false, persistent = true, runNumber = 0, requestNumber = 0;
    var clock = options.clock || {now:function () { return Date.now(); }}, storage = options.Storage;
    function exportText() { return JSON.stringify({version:1,pluginVersion:'0.3.0',persistence:persistent ? 'local' : 'memory',records:records},null,2); }
    function trim() { while (records.length > 200 || exportText().length > 120000) records.shift(); }
    function persist() {
        try { if (!storage) throw new Error('storage');storage.set(STORAGE,exportText());persistent = true; }
        catch (ignore) { persistent = false; }
    }
    try {
        var flag = storage.get('aip_diagnostics',false);enabled = flag === true || flag === 'true';
        var loaded = storage.get(STORAGE,'');
        if (typeof loaded === 'string') loaded = loaded.length <= 240000 ? JSON.parse(loaded || '{}') : {};
        if (loaded && loaded.version === 1 && Array.isArray(loaded.records)) {
            loaded.records.slice(-200).forEach(function (row) { var clean = safeRecord(row.event,row,row.at);if (clean) records.push(clean); });
        }
    } catch (ignore) { persistent = false; }
    trim();
    records.forEach(function (row) { runNumber = Math.max(runNumber,row.runId || 0);requestNumber = Math.max(requestNumber,row.requestId || 0); });
    function record(event, data) {
        if (!enabled) return;
        var row = safeRecord(event,data,clock.now());if (!row) return;
        records.push(row);trim();persist();
        try { if (options.console && options.console.log) options.console.log('AIPicks',JSON.stringify(row)); } catch (ignore) {}
    }
    function request(spec, done, runId) {
        var id = ++requestNumber, started = clock.now(), settled = false, cancelNetwork, tracing = enabled;
        var info = networkInfo(spec);info.requestId = id;info.runId = runId || spec.traceId;
        if (tracing) record('request_start',info);
        function finish(error, value) {
            if (settled) return;settled = true;
            if (tracing) {
                var count = value && (Array.isArray(value) ? value.length : Array.isArray(value.results) ? value.results.length : Array.isArray(value.genres) ? value.genres.length : undefined);
                record('request_end',{runId:info.runId,requestId:id,elapsedMs:clock.now() - started,ok:!error,scope:info.scope,code:error && error.code || undefined,status:error && error.status,count:count});
            }
            done(error,value);
        }
        try { cancelNetwork = options.request(spec,finish); } catch (error) { if (settled) throw error;finish(appError('network')); }
        return function (reason) {
            if (settled) return;settled = true;
            var timedOut = reason === 'timeout' || reason === 'search_timeout';
            if (tracing) record(timedOut ? 'request_end' : 'request_cancel',{runId:info.runId,requestId:id,elapsedMs:clock.now() - started,ok:false,scope:reason === 'search_timeout' ? 'search' : info.scope,code:timedOut ? 'timeout' : 'cancelled'});
            if (cancelNetwork) cancelNetwork();
        };
    }
    return {
        record:record,request:request,exportText:exportText,isEnabled:function () { return enabled; },
        setEnabled:function (value) { enabled = !!value;try { storage.set('aip_diagnostics',String(enabled)); } catch (ignore) { persistent = false; } },
        begin:function (data) { var id = ++runNumber, copy = {};Object.keys(data || {}).forEach(function (key) { copy[key] = data[key]; });copy.runId = id;record('run_start',copy);return id; },
        clear:function () { records = [];persist(); }
    };
}
module.exports = {createDiagnostics:createDiagnostics};
