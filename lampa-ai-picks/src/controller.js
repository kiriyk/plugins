'use strict';
var d = require('./domain'), appError = require('./transport').appError;
var createBudget = require('./budget').createBudget, createCatalog = require('./catalog').createCatalog;
var createTools = require('./tools').createTools, prompts = require('./prompts');
function createController(options) {
    var active = null, next = 0, stage = 'idle', pending = null, rememberedExamples = [], rememberedQuery = '';
    function emit(run, type, data) { if (options.onEvent) options.onEvent({type:type,runId:run.id,data:data}); }
    function change(run, value) { stage = value; emit(run,'stage',{stage:value}); }
    function alive(run) { return active === run && run.alive; }
    function stop(run) {
        if (!run) return;
        run.alive = false;
        options.clock.clearTimeout(run.deadline);
        if (run.modelTimer) options.clock.clearTimeout(run.modelTimer);
        run.budget.cancel();
        run.cancels.forEach(function (cancel) { if (cancel) cancel(); });
        run.key = '';
    }
    function fail(run, error) {
        if (!alive(run)) return;
        stop(run); stage = 'error'; emit(run,'error',error);
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
        stop(run); stage = 'done'; emit(run,'result',{result:result,intent:intent,mode:run.args.mode});
    }
    function pause(run, clarification) {
        if (!alive(run)) return;
        pending = {value:clarification,args:d.clone(run.args),examples:run.tools.getIntent().examples.map(function (key) { return run.store.get(key); }).filter(Boolean)};
        stop(run); stage = 'clarification'; emit(run,'clarification',clarification);
    }
    function finalResult(run, content) {
        if (!alive(run)) return;
        change(run,'ranking');
        try {
            var intent = run.tools.getIntent();
            complete(run,prompts.parseFinal(content,run.store,intent.filters,run.shown.concat(intent.examples)));
        } catch (error) {
            if (run.budget.snapshot().modelCalls < 5 && run.budget.remainingMs() > 0) {
                run.trace.push({role:'assistant',content:String(content).slice(0,3000)});
                takeStep(run,true,true);
            } else fail(run,appError('invalid_response'));
        }
    }
    function takeStep(run, finalOnly, repair) {
        if (!alive(run)) return;
        var count = run.budget.snapshot();
        finalOnly = finalOnly || count.modelCalls >= 4 || count.toolCalls >= 12;
        if (finalOnly && !repair && !run.store.all().length) return complete(run,{items:[],partial:true,notice:'Подходящие варианты не найдены. Попробуйте изменить условия.'});
        if (!run.budget.consumeModel()) return fail(run,appError('search_limit'));
        change(run,finalOnly ? 'ranking' : count.modelCalls ? 'searching' : 'parsing');
        var timeout = Math.min(25000,run.budget.remainingMs()), messages;
        try { messages = prompts.buildMessages({query:run.query,intent:run.tools.getIntent(),formFilters:run.args.formFilters,examples:run.tools.getIntent().examples,
            shown:run.shown,candidates:run.store.all(),trace:run.trace,dictionaries:run.dictionaries}); }
        catch (error) { return fail(run,error); }
        if (repair) messages.push({role:'user',content:'Предыдущий итоговый ответ некорректен. Верни только JSON {"picks":[{"key":"...","reason":"..."}]} с известными кандидатами.'});
        var choice = finalOnly ? 'none' : count.modelCalls === 0 ? {type:'function',function:{name:'set_search_intent'}} : 'auto';
        var settled = false;
        run.modelTimer = options.clock.setTimeout(function () { if (!settled && alive(run)) { settled = true; fail(run,appError('timeout')); } },timeout);
        var cancel = options.routerai.chat({key:run.key,model:run.args.model,messages:messages,tools:run.tools.definitions(),toolChoice:choice,timeoutMs:timeout},function (error, message) {
            if (settled || !alive(run)) return;
            settled = true; options.clock.clearTimeout(run.modelTimer); run.modelTimer = null;
            if (error) return fail(run,error);
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
                    replies[index] = {role:'tool',tool_call_id:call.id,content:JSON.stringify(toolError ? {error:{code:toolError.code,message:toolError.message}} : data)};
                    if (!--left) {
                        run.trace = run.trace.concat(replies);
                        takeStep(run,false,false);
                    }
                }
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
        run.args.mode = mode;
        run.budget = createBudget({clock:options.clock,request:options.request});
        active = run;
        var seeds = examples.length ? examples : mode !== 'new' ? rememberedExamples : [];
        seeds.slice(0,3).forEach(function (c) { run.store.add(c); });
        base.examples = seeds.slice(0,3).map(function (c) { return c.key; });
        run.base = base;
        run.deadline = options.clock.setTimeout(function () { fail(run,appError('timeout')); },90000);
        change(run,'parsing');
        var catalog = createCatalog({request:run.budget.catalogRequest,Lampa:options.Lampa,language:options.Lampa.Storage && options.Lampa.Storage.field('tmdb_lang') || 'ru-RU'});
        run.cancels.push(catalog.getDictionaries(function (error, dictionaries) {
            if (!alive(run)) return;
            if (error) return fail(run,error);
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
        cancel:function () { pending = null; if (active) { stop(active); change(active,'cancelled'); } },
        getState:function () { return {runId:active ? active.id : next,stage:stage}; }};
}
module.exports = {createController:createController};
