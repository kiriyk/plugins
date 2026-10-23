'use strict';
var definitions = [
    {key:'modelCalls',storage:'aip_model_steps',title:'Шагов ИИ (включая итог)',min:3,max:12,value:5,unit:1},
    {key:'toolCalls',storage:'aip_tool_calls',title:'Действий ИИ в каталоге',min:4,max:48,value:12,unit:1},
    {key:'catalogRequests',storage:'aip_catalog_requests',title:'Запросов к каталогу',min:10,max:120,value:40,unit:1},
    {key:'modelTimeoutMs',storage:'aip_model_timeout_seconds',title:'Ожидание ответа ИИ, секунд',min:5000,max:120000,value:25000,unit:1000},
    {key:'catalogTimeoutMs',storage:'aip_catalog_timeout_seconds',title:'Ожидание каталога, секунд',min:3000,max:60000,value:10000,unit:1000},
    {key:'totalTimeoutMs',storage:'aip_search_timeout_seconds',title:'Время всего поиска, секунд',min:30000,max:600000,value:90000,unit:1000},
    {key:'resultCount',storage:'aip_result_count',title:'Карточек в подборке',min:1,max:10,value:10,unit:1}
];
function valid(value, def) { return typeof value === 'number' && isFinite(value) && Math.floor(value / def.unit) === value / def.unit && value >= def.min && value <= def.max; }
function normalizeLimits(values) {
    var result = {};values = values || {};
    definitions.forEach(function (def) { result[def.key] = valid(values[def.key],def) ? values[def.key] : def.value; });
    return result;
}
function readLimits(storage) {
    var values = {};
    definitions.forEach(function (def) {
        try { var raw = storage.get(def.storage,def.value / def.unit);if (String(raw).trim()) values[def.key] = Number(raw) * def.unit; } catch (ignore) {}
    });
    return normalizeLimits(values);
}
module.exports = {definitions:definitions,valid:valid,normalizeLimits:normalizeLimits,readLimits:readLimits};
