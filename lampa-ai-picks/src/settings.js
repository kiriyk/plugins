'use strict';
function escapeText(value) { return String(value).replace(/[&<>"']/g,function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function registerSettings(options) {
    var L = options.Lampa, alive = true, revision = 0, cancels = [];
    function notify(message) { if (L.Noty) L.Noty.show(message); }
    function getConfig() {
        try { return {key:String(L.Storage.get('aip_api_key','') || ''),model:String(L.Storage.get('aip_model','') || '')}; }
        catch (ignore) { return {key:'',model:''}; }
    }
    function save(name, value) {
        if (!alive) return;
        try {
            L.Storage.set(name,String(value).trim());
            revision++;
            cancels.forEach(function (cancel) { if (cancel) cancel(); }); cancels = [];
            if (options.onChange) options.onChange(getConfig());
        } catch (ignore) { notify('Не удалось сохранить настройки. Проверьте свободное место в хранилище Lampa.'); }
    }
    function restore(name) { if (L.Controller) L.Controller.toggle(name || 'content'); }
    function input(title, name, password, origin) {
        var config = getConfig();
        L.Input.edit({title:title,value:name === 'aip_api_key' ? config.key : config.model,password:!!password,nosave:true,free:true},function (value) {
            if (alive) { save(name,String(value || '').slice(0,password ? 4096 : 200)); restore(origin); }
        });
    }
    function models(origin) {
        var config = getConfig(), generation = revision;
        if (!config.key.trim()) { notify('Сначала введите ключ RouterAI.'); return; }
        function show(error, values) {
            if (!alive || generation !== revision) return;
            var items = (values || []).filter(function (model) { return model.supportsTools; }).map(function (model) {
                return {title:escapeText(model.name),subtitle:escapeText(model.id),value:model.id};
            });
            items.push({title:'Ввести ID модели',value:'manual'});
            if (error) notify('Не удалось загрузить список моделей. Можно ввести ID вручную.');
            L.Select.show({title:'Модель RouterAI',items:items,onSelect:function (item) {
                if (item.value === 'manual') input('ID модели RouterAI','aip_model',false,origin);
                else { save('aip_model',item.value); restore(origin); }
            },onBack:function () { restore(origin); }});
        }
        cancels.push(options.routerai.listModels(config.key,show));
    }
    function probe() {
        var config = getConfig(), generation = revision;
        if (!config.key.trim() || !config.model.trim()) { notify('Введите ключ RouterAI и выберите модель.'); return; }
        notify('Проверяем подключение. Выполняется запрос к ИИ.');
        cancels.push(options.routerai.probe(config,function (error) {
            if (!alive || generation !== revision) return;
            notify(error ? error.message || 'Не удалось проверить подключение.' : 'Подключение работает. Модель поддерживает поиск через инструменты.');
        }));
    }
    function open() {
        if (!alive) return;
        var config = getConfig(), origin = L.Controller.enabled().name;
        L.Select.show({title:'ИИ-подборки · RouterAI',items:[
            {title:'Ключ RouterAI',subtitle:config.key ? 'Задан на этом устройстве' : 'Не задан',value:'key'},
            {title:'Модель',subtitle:escapeText(config.model || 'Выберите модель с инструментами'),value:'model'},
            {title:'Проверить подключение',subtitle:'Короткий платный запрос к выбранной модели',value:'probe'}
        ],onSelect:function (item) {
            if (item.value === 'key') input('Ключ RouterAI','aip_api_key',true,origin);
            else if (item.value === 'model') models(origin);
            else probe();
        },onBack:function () { restore(origin); }});
    }
    if (L.SettingsApi) {
        L.SettingsApi.addComponent({component:'aip_settings',name:'ИИ-подборки',icon:''});
        L.SettingsApi.addParam({component:'aip_settings',param:{name:'aip_setup',type:'button'},field:{name:'Настроить RouterAI',description:'Ключ, модель и проверка подключения'},
            onRender:function (item) { item.on('hover:enter',open); }});
    }
    return {getConfig:getConfig,open:open,destroy:function () { alive = false; revision++; cancels.forEach(function (cancel) { if (cancel) cancel(); }); }};
}
module.exports = {registerSettings:registerSettings,escapeText:escapeText};
