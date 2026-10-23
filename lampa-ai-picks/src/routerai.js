'use strict';
var net = require('./transport'), appError = net.appError;
var BASE = 'https://routerai.ru/api/v1';
function noop() {}
function createRouterAI(options) {
    function send(spec, done) {
        return options.request(spec,function (error, value) { done(error ? error.code ? appError(error.code,error.status) : net.normalizeError(error) : null,value); });
    }
    function chat(args, done) {
        if (!args || typeof args.key !== 'string' || !args.key.trim() || typeof args.model !== 'string' || !args.model.trim() || !Array.isArray(args.messages)) {
            done(appError('invalid_arguments')); return noop;
        }
        var json = {model:args.model.trim(),messages:args.messages,max_tokens:2048,stream:false};
        if (args.tools && args.tools.length) json.tools = args.tools;
        if (args.toolChoice) json.tool_choice = args.toolChoice;
        return send({url:BASE + '/chat/completions',method:'POST',json:json,
            headers:{Authorization:'Bearer ' + args.key.trim()},timeoutMs:Math.min(args.timeoutMs || 25000,25000)},function (error, body) {
            if (error) return done(error);
            var raw = body && Array.isArray(body.choices) && body.choices[0] && body.choices[0].message;
            if (!raw || raw.content !== null && raw.content !== undefined && typeof raw.content !== 'string') return done(appError('invalid_response'));
            var calls = raw.tool_calls || [], seen = Object.create(null), valid = Array.isArray(calls);
            if (!valid) return done(appError('invalid_response'));
            var normalized = [];
            calls.forEach(function (call) {
                var f = call && call.function;
                if (!call || typeof call.id !== 'string' || !call.id || seen[call.id] || !f || typeof f.name !== 'string' || typeof f.arguments !== 'string') { valid = false; return; }
                seen[call.id] = true;
                normalized.push({id:call.id,name:f.name,arguments:f.arguments});
            });
            if (!valid || !normalized.length && typeof raw.content !== 'string') return done(appError('invalid_response'));
            done(null,{role:'assistant',content:typeof raw.content === 'string' ? raw.content : null,tool_calls:normalized});
        });
    }
    function listModels(key, done) {
        if (typeof key !== 'string' || !key.trim()) { done(appError('invalid_arguments')); return noop; }
        return send({url:BASE + '/models',method:'GET',headers:{Authorization:'Bearer ' + key.trim()},timeoutMs:10000},function (error, body) {
            if (error) return done(error);
            if (!body || !Array.isArray(body.data)) return done(appError('invalid_response'));
            var seen = Object.create(null);
            done(null,body.data.filter(function (model) {
                if (!model || typeof model.id !== 'string' || !model.id || seen[model.id]) return false;
                seen[model.id] = true;
                var modalities = model.architecture && model.architecture.output_modalities;
                return !Array.isArray(modalities) || modalities.indexOf('text') >= 0;
            }).map(function (model) { return {id:model.id,name:typeof model.name === 'string' ? model.name : model.id,
                supportsTools:Array.isArray(model.supported_parameters) && model.supported_parameters.indexOf('tools') >= 0}; }));
        });
    }
    function probe(args, done) {
        var tool = {type:'function',function:{name:'connection_check',description:'Проверка вызова инструмента. Верните ok=true.',
            parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}};
        return chat({key:args.key,model:args.model,messages:[{role:'user',content:'Вызови connection_check с ok=true.'}],
            tools:[tool],toolChoice:{type:'function',function:{name:'connection_check'}},timeoutMs:25000},function (error, message) {
            if (error) return done(error);
            var call = message.tool_calls.length === 1 && message.tool_calls[0], data;
            try { data = call && JSON.parse(call.arguments); } catch (ignore) {}
            if (!call || call.name !== 'connection_check' || !data || data.ok !== true || Object.keys(data).length !== 1) {
                var incompatible = appError('incompatible_model');
                incompatible.message = 'Модель не выполнила проверочный вызов инструмента. Выберите другую модель.';
                return done(incompatible);
            }
            done(null,{ok:true});
        });
    }
    return {chat:chat,listModels:listModels,probe:probe};
}
module.exports = {createRouterAI:createRouterAI};
