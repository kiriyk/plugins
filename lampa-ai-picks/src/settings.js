'use strict';
var limits = require('./limits'), openText = require('./dialog').openText;
function escapeText(value) { return String(value).replace(/[&<>"']/g,function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function registerSettings(options) {
    var L = options.Lampa, alive = true, revision = 0, cancels = [], diagnosticChoice = null;
    function notify(message) { if (L.Noty) L.Noty.show(message); }
    function getConfig() {
        var config = {key:'',model:'',limits:limits.readLimits(L.Storage),diagnostics:false};
        try {
            config.key = String(L.Storage.get('aip_api_key','') || '');config.model = String(L.Storage.get('aip_model','') || '');
            var enabled = L.Storage.get('aip_diagnostics',false);config.diagnostics = enabled === true || enabled === 'true';
        } catch (ignore) {}
        if (diagnosticChoice !== null) config.diagnostics = diagnosticChoice;
        return config;
    }
    function save(name, value) {
        if (!alive) return false;
        try {
            L.Storage.set(name,String(value).trim());revision++;
            cancels.forEach(function (cancel) { if (cancel) cancel(); });cancels = [];
            if (options.onChange) options.onChange(getConfig());
            return true;
        } catch (ignore) { notify('Не удалось сохранить настройки. Проверьте свободное место в хранилище Lampa.');return false; }
    }
    function restore(name) { if (L.Controller) L.Controller.toggle(name || 'content'); }
    function origin() { return L.Controller.enabled().name; }
    function input(title, name, password, previous) {
        var config = getConfig();
        L.Input.edit({title:title,value:name === 'aip_api_key' ? config.key : config.model,password:!!password,nosave:true,free:true},function (value) {
            if (alive) { save(name,String(value || '').slice(0,password ? 4096 : 200));restore(previous); }
        });
    }
    function number(def, previous) {
        var value = getConfig().limits[def.key] / def.unit;
        L.Input.edit({title:def.title + ' (' + def.min / def.unit + '–' + def.max / def.unit + ')',value:String(value),nosave:true,free:true},function (text) {
            if (!alive) return;
            var raw = String(text || '').trim(), next = Number(raw) * def.unit;
            if (!/^\d+$/.test(raw) || !limits.valid(next,def)) notify('Введите целое число от ' + def.min / def.unit + ' до ' + def.max / def.unit + '.');
            else save(def.storage,raw);
            restore(previous);
        });
    }
    function advanced(previous) {
        var current = getConfig().limits;
        L.Select.show({title:'Параметры поиска',items:limits.definitions.map(function (def) {
            return {title:def.title,subtitle:String(current[def.key] / def.unit) + ' · от ' + def.min / def.unit + ' до ' + def.max / def.unit,value:def.key,definition:def};
        }),onSelect:function (item) { number(item.definition,previous); },onBack:function () { restore(previous); }});
    }
    function models(previous) {
        var config = getConfig(), generation = revision;
        if (!config.key.trim()) { notify('Сначала введите ключ RouterAI.');return; }
        cancels.push(options.routerai.listModels(config.key,function (error, values) {
            if (!alive || generation !== revision) return;
            var available = (values || []).filter(function (model) { return model.supportsTools; });
            if (error) notify('Не удалось загрузить список моделей. Можно ввести ID вручную.');
            function show(query) {
                if (!alive || generation !== revision) return;
                var needle = query.toLowerCase();
                var matches = available.filter(function (model) { return (model.name + ' ' + model.id).toLowerCase().indexOf(needle) >= 0; });
                var items = [{title:'Найти модель',subtitle:query ? escapeText(query) : 'По названию или ID',value:'search'}];
                matches.forEach(function (model) { items.push({title:escapeText(model.name),subtitle:escapeText(model.id),value:model.id}); });
                items.push({title:'Ввести ID модели',value:'manual'});
                if (query && !matches.length) notify('Подходящих моделей не найдено. Измените поиск или введите ID.');
                L.Select.show({title:'Модель RouterAI',items:items,onSelect:function (item) {
                    if (item.value === 'search') L.Input.edit({title:'Найти модель по названию или ID',value:query,nosave:true,free:true},function (text) { show(String(text || '').trim().slice(0,120)); });
                    else if (item.value === 'manual') input('ID модели RouterAI','aip_model',false,previous);
                    else { save('aip_model',item.value);restore(previous); }
                },onBack:function () { restore(previous); }});
            }
            show('');
        }));
    }
    function probe() {
        var config = getConfig(), generation = revision;
        if (!config.key.trim() || !config.model.trim()) { notify('Введите ключ RouterAI и выберите модель.');return; }
        notify('Проверяем подключение. Выполняется запрос к ИИ.');
        cancels.push(options.routerai.probe(config,function (error) {
            if (!alive || generation !== revision) return;
            notify(error ? error.message || 'Не удалось проверить подключение.' : 'Подключение работает. Модель поддерживает поиск через инструменты.');
        }));
    }
    function diagnostics(previous) {
        var journal = options.diagnostics, doc = options.document || (typeof document !== 'undefined' ? document : null);
        var win = options.window || (typeof window !== 'undefined' ? window : {});
        if (!journal) { notify('Журнал диагностики недоступен.');restore(previous);return; }
        function copy() {
            function success() { notify('Журнал скопирован.'); }
            function fallback() {
                var input;
                try {
                    input = doc.createElement('textarea');input.value = journal.exportText();input.style.position = 'fixed';input.style.opacity = '0';
                    doc.body.appendChild(input);input.focus();if (input.select) input.select();
                    if (!doc.execCommand || !doc.execCommand('copy')) throw new Error('copy');
                    success();
                } catch (ignore) { notify('Копирование недоступно. Используйте консоль Lampa или скачивание журнала.'); }
                if (input) input.remove();
            }
            if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
                try { win.navigator.clipboard.writeText(journal.exportText()).then(success,fallback); } catch (ignore) { fallback(); }
            } else fallback();
        }
        function download() {
            if (!doc || !win.Blob || !win.URL || !win.URL.createObjectURL) { notify('Скачивание недоступно. Используйте копирование или консоль Lampa.');return; }
            var url;
            try {
                url = win.URL.createObjectURL(new win.Blob([journal.exportText()],{type:'application/json'}));
                var link = doc.createElement('a');link.href = url;link.download = 'ai-picks-diagnostics.json';
                doc.body.appendChild(link);link.click();link.remove();
                win.setTimeout(function () { win.URL.revokeObjectURL(url); },1000);
            } catch (ignore) {
                if (url) win.URL.revokeObjectURL(url);
                notify('Не удалось скачать журнал. Используйте консоль Lampa.');
            }
        }
        L.Select.show({title:'Диагностика ИИ-подборок',items:[
            {title:journal.isEnabled() ? 'Диагностика: включена' : 'Диагностика: выключена',subtitle:'Включите перед повторением ошибки',value:'toggle'},
            {title:'Показать журнал',subtitle:'Фильтры, запросы, время и причины отказа',value:'view'},
            {title:'Скопировать журнал',value:'copy'},
            {title:'Скачать журнал JSON',subtitle:'Если скачивание поддерживается устройством',value:'download'},
            {title:'Открыть консоль Lampa',subtitle:'Записи с меткой AIPicks',value:'console'},
            {title:'Очистить журнал',value:'clear'}
        ],onSelect:function (item) {
            if (item.value === 'toggle') {
                var wanted = !journal.isEnabled();diagnosticChoice = wanted;
                var saved = save('aip_diagnostics',String(wanted));journal.setEnabled(wanted);
                if (saved) diagnosticChoice = null;
                else {
                    notify('Состояние диагностики изменено только в памяти до перезапуска Lampa.');
                    if (options.onChange) options.onChange(getConfig());
                }
                restore(previous);
            }
            else if (item.value === 'view') openText({Lampa:L,document:doc,$:options.$,title:'Журнал · ↑↓ прокрутка, Назад — закрыть',buttons:[],text:journal.exportText(),onBack:function () { restore(previous); }});
            else if (item.value === 'copy') { copy();restore(previous); }
            else if (item.value === 'download') { download();restore(previous); }
            else if (item.value === 'console') L.Controller.toggle('console');
            else if (item.value === 'clear') { journal.clear();notify('Журнал очищен.');restore(previous); }
        },onBack:function () { restore(previous); }});
    }
    function open() {
        if (!alive) return;
        var config = getConfig(), previous = origin();
        L.Select.show({title:'ИИ-подборки · настройки',items:[
            {title:'Ключ RouterAI',subtitle:config.key ? 'Задан на этом устройстве' : 'Не задан',value:'key'},
            {title:'Модель',subtitle:escapeText(config.model || 'Выберите модель с инструментами'),value:'model'},
            {title:'Проверить подключение',subtitle:'Короткий платный запрос к выбранной модели',value:'probe'},
            {title:'Параметры поиска',subtitle:'Шаги, запросы, тайм-ауты и число карточек',value:'limits'},
            {title:'Диагностика',subtitle:config.diagnostics ? 'Включена' : 'Выключена',value:'diagnostics'}
        ],onSelect:function (item) {
            if (item.value === 'key') input('Ключ RouterAI','aip_api_key',true,previous);
            else if (item.value === 'model') models(previous);
            else if (item.value === 'limits') advanced(previous);
            else if (item.value === 'diagnostics') diagnostics(previous);
            else probe();
        },onBack:function () { restore(previous); }});
    }
    if (L.SettingsApi) {
        L.SettingsApi.addComponent({component:'aip_settings',name:'ИИ-подборки',icon:''});
        function addButton(name, title, description, callback) {
            L.SettingsApi.addParam({component:'aip_settings',param:{name:'aip_button_' + name,type:'button'},field:{name:title,description:description},
                onRender:function (item) { item.on('hover:enter',function () { callback(origin()); }); }});
        }
        addButton('key','Ключ RouterAI','Сохраняется только на этом устройстве',function (previous) { input('Ключ RouterAI','aip_api_key',true,previous); });
        addButton('model','Модель','Поиск по названию и ID, ручной ввод',models);
        addButton('probe','Проверить подключение','Короткий платный запрос к выбранной модели',probe);
        addButton('diagnostics','Диагностика и журнал','Включение, просмотр, копирование и скачивание',diagnostics);
        limits.definitions.forEach(function (def) { addButton(def.key,def.title,'От ' + def.min / def.unit + ' до ' + def.max / def.unit,function (previous) { number(def,previous); }); });
    }
    return {getConfig:getConfig,open:open,destroy:function () { alive = false;revision++;cancels.forEach(function (cancel) { if (cancel) cancel(); }); }};
}
module.exports = {registerSettings:registerSettings,escapeText:escapeText};
