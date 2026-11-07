'use strict';
var d = require('./domain'), appError = require('./transport').appError;
var normalizeLimits = require('./limits').normalizeLimits;
var createBudget = require('./budget').createBudget, createCatalog = require('./catalog').createCatalog;
var createTools = require('./tools').createTools, prompts = require('./prompts');
var createRatings = require('./ratings').createRatings, createScreening = require('./screening').createScreening;
var buildExampleContext = require('./request-context').buildExampleContext;
var createSelectionReview = require('./selection-review').createSelectionReview;
var createWebState = require('./web-state').createWebState, createWebSearch = require('./web-search').createWebSearch, createWebDiscovery = require('./web-discovery').createWebDiscovery;
function createController(options) {
    var active = null, next = 0, stage = 'idle', pending = null, rememberedExamples = [], rememberedQuery = '';
    var webState = options.webState || createWebState({Storage:options.Lampa.Storage,clock:options.clock}), rememberedWeb = null;
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
        if (run.reviewingSelection && run.selection) {
            log(run,'selection',{code:error.code,status:error.status});
            complete(run,run.selection.finish('Дополнительный отбор ИИ не завершён: ' + error.message));return;
        }
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
        if (options.session.size() >= 200) { result.partial = true; result.notice = 'Предложено 200 вариантов. Начните новую подборку.'; }
        rememberedExamples = intent.examples.map(function (key) { return run.store.get(key); }).filter(Boolean);
        rememberedQuery = run.query;
        rememberedWeb = run.webSnapshot || null;
        if (run.webNotice) result.notice = (result.notice ? result.notice + ' ' : '') + run.webNotice;
        result.stats = run.screening.snapshot();result.stats.selected = result.items.length;
        Object.keys(result.selectionStats || {}).forEach(function (key) { result.stats[key] = result.selectionStats[key]; });
        if (result.stats.unverified) result.notice = (result.notice ? result.notice + ' ' : '') + 'Не проверено кандидатов: ' + result.stats.unverified + '. См. счётчик поиска.';
        emit(run,'progress',result.stats);
        log(run,'run_done',{count:result.items.length,candidates:result.stats.candidates,budget:run.budget.snapshot()});
        stop(run);stage = 'done'; emit(run,'result',{result:result,intent:intent,mode:run.args.mode,dictionaries:run.dictionaries});
    }
    function searchWeb(run) {
        var extractorId = run.args.stages && run.args.stages.extraction === 'scaledown/extract' ? 'scaledown/extract' : 'primary';
        var intent = run.tools.getIntent(), identity = webState.fingerprint(run.args.web.key), filterHash = JSON.stringify(intent.filters);
        run.webDone = true;
        if (run.args.mode === 'more' && rememberedWeb && rememberedWeb.extractorId === extractorId && rememberedWeb.schemaVersion === 1 && (extractorId !== 'primary' || rememberedWeb.primaryModelId === run.args.model) && rememberedWeb.expiresAt > options.clock.now() && rememberedWeb.query === run.query && rememberedWeb.fingerprint === identity && rememberedWeb.filterHash === filterHash) {
            run.webSnapshot = d.clone(rememberedWeb);
            run.webSnapshot.resolvedCandidates.forEach(function (c) { run.store.add(c); });
            takeStep(run,false,false);return;
        }
        var webSearch = createWebSearch({request:run.budget.webRequest,state:webState});
        var discovery = createWebDiscovery({extractor:extractorId === 'scaledown/extract' ? require('./scaledown').createScaleDown({request:options.request,clock:options.clock}) : null,webSearch:webSearch,routerai:options.routerai,catalog:run.catalog,store:run.store,budget:run.budget,clock:options.clock,limits:run.limits});
        run.cancels.push(discovery.run({key:run.key,model:run.args.model,webKey:run.args.web.key,query:run.query,queries:run.tools.getWebQueries(),extractorId:extractorId,intent:intent,traceId:run.traceId},function (error, result) {
            if (!alive(run)) return;
            if (error) {
                run.webNotice = 'Интернет-поиск не завершён: ' + error.message + ' Подбор продолжен через TMDB.';
                emit(run,'notice',{message:run.webNotice});log(run,'web_state',{provider:'tavily',code:error.code,status:error.status});
            } else {
                run.webSnapshot = result.webSnapshot;run.webSnapshot.query = run.query;run.webSnapshot.fingerprint = identity;run.webSnapshot.filterHash = filterHash;
                log(run,'web_state',{provider:'tavily',count:result.candidateKeys.length,localCredits:webState.usage(identity)});
            }
            takeStep(run,false,false);
        },function (value) { if (alive(run)) change(run,value); }));
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
            var eligibleKeys = run.screening.eligible().map(function (c) { return c.key; });
            if (run.reviewingSelection) {
                var review = run.selection.hint();
                eligibleKeys = eligibleKeys.filter(function (key) { return review.selectedKeys.indexOf(key) >= 0 || review.pendingKeys.indexOf(key) >= 0; });
            }
            var result = prompts.parseFinal(content,run.store,intent.filters,run.shown.concat(intent.examples),{resultLimit:run.limits.resultLimit,remaining:200 - run.shown.length,eligibleKeys:eligibleKeys,onReject:function (value) { var c = run.store.get(value.key);if (c) value.facts = {type:c.type,year:c.year,runtimeMinutes:c.runtimeMinutes,genreIds:c.genreIds,countries:c.countries};log(run,'candidate_rejected',value); }});
            if (!run.selection) run.selection = createSelectionReview({eligibleKeys:eligibleKeys,resultLimit:run.limits.resultLimit,remaining:200 - run.shown.length});
            run.selection.accept(result);
            log(run,'selection',{stats:run.selection.finish().selectionStats});
            if (!run.reviewingSelection && run.selection.needsReview() && run.budget.snapshot().modelCalls < run.limits.modelCalls && run.budget.remainingMs() > 0) {
                var progress = run.screening.snapshot(), selectionStats = run.selection.finish().selectionStats;
                Object.keys(selectionStats).forEach(function (key) { progress[key] = selectionStats[key]; });progress.selected = result.items.length;emit(run,'progress',progress);
                run.reviewingSelection = true;takeStep(run,true,false);return;
            }
            complete(run,run.selection.finish());
        } catch (error) {
            if (run.reviewingSelection) { fail(run,appError('invalid_response'),'model');return; }
            if (run.budget.snapshot().modelCalls < run.limits.modelCalls && run.budget.remainingMs() > 0) {
                run.trace.push({role:'assistant',content:String(content).slice(0,3000)});
                takeStep(run,true,true);
            } else fail(run,appError('invalid_response'));
        }
    }
    function takeStep(run, finalOnly, repair, screened) {
        if (!alive(run)) return;
        var exampleKeys = run.tools.getIntent().examples.filter(function (key) {
            var c = run.store.get(key);
            return c && (!c.title || !c.overview) && !run.exampleAttempts[key];
        }).slice(0,3);
        if (exampleKeys.length) {
            exampleKeys.forEach(function (key) { run.exampleAttempts[key] = true; });
            run.cancels.push(run.catalog.getTitleDetails({keys:exampleKeys},function (error, rows) {
                if (!alive(run)) return;
                if (!error) rows.forEach(function (c) { run.store.add(c); });
                takeStep(run,finalOnly,repair,screened);
            }));return;
        }
        if (!run.webDone && run.tools.isReady()) { searchWeb(run);return; }
        if (!screened) {
            change(run,'checking');
            var intent = run.tools.getIntent();
            run.cancels.push(run.screening.check(intent.filters,run.shown.concat(intent.examples),function () { if (alive(run)) takeStep(run,finalOnly,repair,true); }));
            return;
        }
        var count = run.budget.snapshot();
        finalOnly = finalOnly || count.modelCalls >= run.limits.modelCalls - 1 || count.toolCalls >= run.limits.toolCalls;
        if (finalOnly && !run.tools.isReady()) return fail(run,appError('intent_required'));
        if (finalOnly && !repair && !run.store.all().length) return complete(run,{items:[],partial:true,notice:'Подходящие варианты не найдены. Попробуйте изменить условия.'});
        if (!run.budget.consumeModel()) return fail(run,appError('search_limit'));
        change(run,run.reviewingSelection ? 'selection_review' : finalOnly ? 'ranking' : count.modelCalls ? 'searching' : 'parsing');
        var timeout = Math.min(run.limits.modelTimeoutMs,run.budget.remainingMs()), messages;
        try { messages = prompts.buildMessages({query:run.query,intent:run.tools.getIntent(),formFilters:run.args.formFilters,examples:run.tools.getIntent().examples,
            exampleContext:buildExampleContext(run.store,run.tools.getIntent().examples),shown:run.shown,candidates:run.screening.eligible(),eligibleKeys:run.screening.eligible().map(function (c) { return c.key; }),trace:run.trace,dictionaries:run.dictionaries,resultLimit:run.limits.resultLimit,remaining:200 - run.shown.length,webEnabled:run.args.webEnabled,selectionReview:run.reviewingSelection ? run.selection.hint() : null}); }
        catch (error) { return fail(run,error); }
        if (repair) messages.push({role:'user',content:'Предыдущий итоговый ответ некорректен. Верни только JSON {"picks":[{"key":"...","reason":"..."}]} с известными кандидатами.'});
        var choice = finalOnly ? 'none' : !run.tools.isReady() ? {type:'function',function:{name:'set_search_intent'}} : 'auto';
        var settled = false;
        run.modelTimer = options.clock.setTimeout(function () { if (!settled && alive(run)) { settled = true; fail(run,appError('timeout'),'model'); } },timeout);
        var outputTokens = count.modelCalls === 0 ? 2048 : run.limits.resultLimit === null ? 16384 : run.limits.resultLimit === 20 ? 8192 : 4096;
        var cancel = options.routerai.chat({key:run.key,model:run.args.model,messages:messages,maxOutputTokens:outputTokens,tools:run.tools.definitions(),toolChoice:choice,timeoutMs:timeout,traceId:run.traceId},function (error, message) {
            if (settled || !alive(run)) return;
            settled = true; options.clock.clearTimeout(run.modelTimer); run.modelTimer = null;
            if (error) {
                if (run.reviewingSelection) return fail(run,error,'model');
                if (error.code === 'model_output_limit' && !run.outputRepair && run.budget.snapshot().modelCalls < run.limits.modelCalls && run.budget.remainingMs() > 0) {
                    run.outputRepair = true;takeStep(run,true,true);return;
                }
                return fail(run,error,'model');
            }
            if (!message.tool_calls.length) {
                if (count.modelCalls === 0) return fail(run,appError('incompatible_model'));
                if (!run.tools.isReady() || !run.webDone) return fail(run,appError('intent_required'));
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
                else if ((!run.tools.isReady() || !run.webDone) && call.name !== 'set_search_intent') received(appError('intent_required'));
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
        if (args.webEnabled && (!args.web || !String(args.web.key || '').trim())) { stage = 'error';emit({id:id},'error',appError('web_key'));return null; }
        if (!args.key || !args.model || mode === 'new' && !query.trim() && !Object.keys(args.formFilters || {}).length && !examples.length) {
            stage = 'error'; emit({id:id},'error',appError('invalid_arguments')); return null;
        }
        if (mode !== 'new' && options.session.size() >= 200) { stage = 'error'; emit({id:id},'error',appError('session_limit')); return null; }
        var base = mode === 'new' ? d.emptyIntent() : options.session.getIntent() || d.emptyIntent();
        var run = {id:id,alive:true,args:d.clone(args),webDone:!args.webEnabled,query:query,key:String(args.key).trim(),cancels:[],trace:[],exampleAttempts:Object.create(null),store:d.createCandidateStore(80),
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
        run.catalog = catalog;
        var ratings = createRatings({request:run.budget.catalogRequest,catalog:catalog,Lampa:options.Lampa,clock:options.clock,maxKpRequests:run.limits.kpRequests});
        run.screening = createScreening({store:run.store,catalog:catalog,ratings:ratings,onProgress:function (stats) { if (alive(run)) { log(run,'screening',{stats:stats});emit(run,'progress',stats); } }});
        run.cancels.push(run.screening.cancel);
        run.cancels.push(catalog.getDictionaries(function (error, dictionaries) {
            if (!alive(run)) return;
            if (error) return fail(run,error,'catalog');
            run.dictionaries = dictionaries;
            run.tools = createTools({catalog:catalog,store:run.store,webEnabled:!!run.args.webEnabled,formFilters:run.args.formFilters || {},dictionaries:dictionaries,intent:base,
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
