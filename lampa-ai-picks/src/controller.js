'use strict';
var d = require('./domain'), appError = require('./transport').appError;
var normalizeLimits = require('./limits').normalizeLimits;
var createBudget = require('./budget').createBudget, createCatalog = require('./catalog').createCatalog;
var createTools = require('./tools').createTools, prompts = require('./prompts');
var createRatings = require('./ratings').createRatings, createScreening = require('./screening').createScreening;
function createController(options) {
    var active = null, next = 0, stage = 'idle', pending = null, rememberedExamples = [], rememberedQuery = '';
    function emit(run, type, data) { if (options.onEvent) options.onEvent({type:type,runId:run.id,data:data}); }
    function log(run, event, data) { if (options.diagnostics) { data = data || {};data.runId = run.traceId;options.diagnostics.record(event,data); } }
    function change(run, value) { stage = value;log(run,'stage',{stage:value});emit(run,'stage',{stage:value}); }
    function alive(run) { return active === run && run.alive; }
    function stop(run, reason) {
        if (!run) return;
        run.alive = false;
        options.clock.clearTimeout(run.deadline);
        if (run.modelTimer) options.clock.clearTimeout(run.modelTimer);
        run.budget.cancel(reason);
        run.cancels.forEach(function (cancel) { if (cancel) cancel(reason); });
        run.key = '';
    }
    function fail(run, error, scope) {
        if (!alive(run)) return;
        if (run.screening) { var progress = run.screening.snapshot();progress.stopReason = error.code;emit(run,'progress',progress); }
        log(run,'run_error',{stage:stage,code:error.code,status:error.status,scope:scope,budget:run.budget.snapshot()});
        stop(run,error.code === 'timeout' ? scope === 'search' ? 'search_timeout' : 'timeout' : undefined);stage = 'error';emit(run,'error',error);
    }
    function complete(run, result) {
        if (!alive(run)) return;
        var intent = run.tools.getIntent();
        if (run.args.mode === 'new') options.session.reset(intent);
        else options.session.setIntent(intent);
        result.items = options.session.commit(result.items);
        if (options.session.size() >= 200) { result.partial = true; result.notice = 'Показано 200 вариантов. Начните новую подборку.'; }
        rememberedExamples = intent.examples.map(function (key) { return run.store.get(key); }).filter(Boolean);
        rememberedQuery = run.query;
        result.stats = run.screening.snapshot();result.stats.selected = result.items.length;
        if (result.stats.unverified) result.notice = (result.notice ? result.notice + ' ' : '') + 'Не проверено кандидатов: ' + result.stats.unverified + '. См. счётчик поиска.';
        emit(run,'progress',result.stats);
        log(run,'run_done',{count:result.items.length,candidates:result.stats.candidates,budget:run.budget.snapshot()});
        stop(run);stage = 'done'; emit(run,'result',{result:result,intent:intent,mode:run.args.mode,dictionaries:run.dictionaries});
    }
    function pause(run, clarification) {
        if (!alive(run)) return;
        log(run,'clarification',{kind:clarification.kind,count:clarification.options && clarification.options.length});
        pending = {value:clarification,args:d.clone(run.args),examples:run.tools.getIntent().examples.map(function (key) { return run.store.get(key); }).filter(Boolean)};
        stop(run); stage = 'clarification'; emit(run,'clarification',clarification);
    }
    function finalResult(run, content) {
        if (!alive(run)) return;
        change(run,'ranking');
        try {
            var intent = run.tools.getIntent();
            complete(run,prompts.parseFinal(content,run.store,intent.filters,run.shown.concat(intent.examples),{limit:run.limits.resultCount,eligibleKeys:run.screening.eligible().map(function (c) { return c.key; }),onReject:function (value) { var c = run.store.get(value.key);if (c) value.facts = {type:c.type,year:c.year,runtimeMinutes:c.runtimeMinutes,genreIds:c.genreIds,countries:c.countries};log(run,'candidate_rejected',value); }}));
        } catch (error) {
            if (run.budget.snapshot().modelCalls < run.limits.modelCalls && run.budget.remainingMs() > 0) {
                run.trace.push({role:'assistant',content:String(content).slice(0,3000)});
                takeStep(run,true,true);
            } else fail(run,appError('invalid_response'));
        }
    }
    function takeStep(run, finalOnly, repair, screened) {
        if (!alive(run)) return;
        if (!screened) {
            change(run,'checking');
            var intent = run.tools.getIntent();
            run.cancels.push(run.screening.check(intent.filters,run.shown.concat(intent.examples),function () { if (alive(run)) takeStep(run,finalOnly,repair,true); }));
            return;
        }
        var count = run.budget.snapshot();
        finalOnly = finalOnly || count.modelCalls >= run.limits.modelCalls - 1 || count.toolCalls >= run.limits.toolCalls;
        if (finalOnly && !repair && !run.store.all().length) return complete(run,{items:[],partial:true,notice:'Подходящие варианты не найдены. Попробуйте изменить условия.'});
        if (!run.budget.consumeModel()) return fail(run,appError('search_limit'));
        change(run,finalOnly ? 'ranking' : count.modelCalls ? 'searching' : 'parsing');
        var timeout = Math.min(run.limits.modelTimeoutMs,run.budget.remainingMs()), messages;
        try { messages = prompts.buildMessages({query:run.query,intent:run.tools.getIntent(),formFilters:run.args.formFilters,examples:run.tools.getIntent().examples,
            shown:run.shown,candidates:run.screening.eligible(),eligibleKeys:run.screening.eligible().map(function (c) { return c.key; }),trace:run.trace,dictionaries:run.dictionaries,resultCount:run.limits.resultCount}); }
        catch (error) { return fail(run,error); }
        if (repair) messages.push({role:'user',content:'Предыдущий итоговый ответ некорректен. Верни только JSON {"picks":[{"key":"...","reason":"..."}]} с известными кандидатами.'});
        var choice = finalOnly ? 'none' : count.modelCalls === 0 ? {type:'function',function:{name:'set_search_intent'}} : 'auto';
        var settled = false;
        run.modelTimer = options.clock.setTimeout(function () { if (!settled && alive(run)) { settled = true; fail(run,appError('timeout'),'model'); } },timeout);
        var cancel = options.routerai.chat({key:run.key,model:run.args.model,messages:messages,tools:run.tools.definitions(),toolChoice:choice,timeoutMs:timeout,traceId:run.traceId},function (error, message) {
            if (settled || !alive(run)) return;
            settled = true; options.clock.clearTimeout(run.modelTimer); run.modelTimer = null;
            if (error) return fail(run,error,'model');
            if (!message.tool_calls.length) {
                if (count.modelCalls === 0) return fail(run,appError('incompatible_model'));
                return finalResult(run,message.content);
            }
            if (finalOnly) return fail(run,appError('invalid_response'));
            var calls = message.tool_calls, replies = [], left = calls.length;
            run.trace.push({role:'assistant',content:message.content,tool_calls:calls.map(function (call) {
                return {id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}};
            })});
            calls.forEach(function (call, index) {
                if (!alive(run)) return;
                function received(toolError, data) {
                    if (!alive(run)) return;
                    log(run,'tool_result',{tool:call.name,code:toolError && toolError.code,ok:!toolError,count:data && data.items && data.items.length});
                    if (!toolError && call.name === 'set_search_intent') log(run,'filters',{filters:run.tools.getIntent().filters});
                    replies[index] = {role:'tool',tool_call_id:call.id,content:JSON.stringify(toolError ? {error:{code:toolError.code,message:toolError.message}} : data)};
                    if (!--left) {
                        run.trace = run.trace.concat(replies);
                        takeStep(run,false,false);
                    }
                }
                log(run,'tool_start',{tool:call.name});
                var permitted = run.budget.consumeTool();
                if (!permitted || index >= 4) received(appError('tool_limit'));
                else if (count.modelCalls === 0 && call.name !== 'set_search_intent') received(appError('intent_required'));
                else run.cancels.push(run.tools.execute(call,received));
            });
        });
        run.cancels.push(cancel);
    }
    function start(args) {
        if (active) stop(active);
        pending = null;
        var id = ++next;
        var mode = args.mode || 'new';
        var query = mode === 'more' ? rememberedQuery : String(args.query || '');
        var examples = Array.isArray(args.examples) ? args.examples : [];
        if (!args.key || !args.model || mode === 'new' && !query.trim() && !Object.keys(args.formFilters || {}).length && !examples.length) {
            stage = 'error'; emit({id:id},'error',appError('invalid_arguments')); return null;
        }
        if (mode !== 'new' && options.session.size() >= 200) { stage = 'error'; emit({id:id},'error',appError('session_limit')); return null; }
        var base = mode === 'new' ? d.emptyIntent() : options.session.getIntent() || d.emptyIntent();
        var run = {id:id,alive:true,args:d.clone(args),query:query,key:String(args.key).trim(),cancels:[],trace:[],store:d.createCandidateStore(80),
            shown:mode === 'new' ? [] : options.session.getShown()};
        run.args.mode = mode;run.limits = normalizeLimits(args.limits);
        if (options.diagnostics) run.traceId = options.diagnostics.begin({mode:mode,limits:run.limits,filters:args.formFilters || {},queryLength:query.length});
        run.budget = createBudget({clock:options.clock,request:options.request,limits:run.limits,traceId:run.traceId});
        active = run;
        var seeds = examples.length ? examples : mode !== 'new' ? rememberedExamples : [];
        seeds.slice(0,3).forEach(function (c) { run.store.add(c); });
        base.examples = seeds.slice(0,3).map(function (c) { return c.key; });
        run.base = base;
        run.deadline = options.clock.setTimeout(function () { fail(run,appError('timeout'),'search'); },run.limits.totalTimeoutMs);
        change(run,'parsing');
        var catalog = createCatalog({request:run.budget.catalogRequest,Lampa:options.Lampa,timeoutMs:run.limits.catalogTimeoutMs});
        var ratings = createRatings({request:run.budget.catalogRequest,catalog:catalog,Lampa:options.Lampa,clock:options.clock,maxKpRequests:run.limits.kpRequests});
        run.screening = createScreening({store:run.store,catalog:catalog,ratings:ratings,onProgress:function (stats) { if (alive(run)) { log(run,'screening',{stats:stats});emit(run,'progress',stats); } }});
        run.cancels.push(run.screening.cancel);
        run.cancels.push(catalog.getDictionaries(function (error, dictionaries) {
            if (!alive(run)) return;
            if (error) return fail(run,error,'catalog');
            run.dictionaries = dictionaries;
            run.tools = createTools({catalog:catalog,store:run.store,formFilters:run.args.formFilters || {},dictionaries:dictionaries,intent:base,
                onClarification:function (value) { pause(run,value); }});
            takeStep(run,false,false);
        }));
        return id;
    }
    function resolveClarification(choice) {
        if (!pending || !choice || pending.value.kind !== choice.kind) return null;
        var held = pending, args = d.clone(held.args);
        if (choice.kind === 'example') {
            var selected = held.value.options.filter(function (c) { return c.key === choice.key; })[0];
            if (!selected || held.examples.length >= 3) return null;
            args.examples = held.examples.concat([selected]);
        } else if (choice.kind === 'filters' && choice.formFilters) args.formFilters = choice.formFilters;
        else return null;
        return start(args);
    }
    return {start:start,resolveClarification:resolveClarification,
        cancel:function () { pending = null; if (active && active.alive) { log(active,'run_cancel',{budget:active.budget.snapshot()});stop(active);change(active,'cancelled'); } },
        getState:function () { return {runId:active ? active.id : next,stage:stage}; }};
}
module.exports = {createController:createController};
