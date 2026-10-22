/* AI Picks 0.1.0 | Lampa 3.3.8 */
'use strict';
var createTransport = require('./transport').createTransport;
var createRouterAI = require('./routerai').createRouterAI, createCatalog = require('./catalog').createCatalog;
var registerSettings = require('./settings').registerSettings, escapeText = require('./settings').escapeText, createScreen = require('./ui').createScreen;
var createSession = require('./session').createSession, createController = require('./controller').createController, createResults = require('./results').createResults;
function registerPlugin(options) {
    var win = options.window, L = options.Lampa, doc = win.document;
    if (win.__aipPicksPlugin) return win.__aipPicksPlugin;
    if (!L || !L.Component || !L.Storage || !L.Controller || !L.Scroll) return null;
    var clock = options.clock || {now:function () { return Date.now(); },setTimeout:function (fn,ms) { return win.setTimeout(fn,ms); },clearTimeout:function (id) { win.clearTimeout(id); }};
    var request = createTransport(L,clock), routerai = createRouterAI({request:request}), catalog = createCatalog({request:request,Lampa:L});
    var contexts = [];
    var settings = registerSettings({Lampa:L,routerai:routerai,onChange:function () {
        contexts.forEach(function (ctx) { ctx.controller.cancel();ctx.screen.setStage('cancelled');ctx.screen.setMessage('Настройки ИИ изменены. Можно запустить новую подборку.'); });
    }});
    function open() { L.Activity.push({url:'',component:'aip_picks',title:'ИИ-подборки',source:'tmdb',page:1}); }
    L.Component.add('aip_picks',function () {
        var screen, renderer, controller, context, lastResult = null, setupShown = false, destroyed = false;
        function focusResult() {
            L.Controller.toggle('aip_picks');L.Controller.collectionSet(screen.element(),false,true);
            L.Controller.collectionFocus(renderer.element().querySelector('.selector'),screen.element(),true);
        }
        function launch(payload) {
            var config = settings.getConfig();
            if (!config.key || !config.model) { screen.setMessage('Введите ключ RouterAI и выберите модель.');settings.open();return; }
            payload.key = config.key;payload.model = config.model;controller.start(payload);
        }
        screen = createScreen({Lampa:L,document:doc,navigator:win.Navigator,catalog:catalog,onSubmit:launch,onCancel:function () { if (controller) controller.cancel(); },onSettings:settings.open});
        renderer = createResults({Lampa:L,document:doc,onFocus:screen.focusElement,onMore:function () { launch(screen.getRequest('more')); },onRefine:function () {
            L.Input.edit({title:'Как изменить подборку?',value:'',free:true,nosave:true},function (text) {
                if (destroyed) return;
                L.Controller.toggle('aip_picks');
                if (!String(text || '').trim()) { focusResult();return; }
                var payload = screen.getRequest('refine');payload.query = String(text).slice(0,2000);launch(payload);
            });
        },onOpen:function (candidate) {
            controller.cancel();
            L.Activity.push({url:'',component:'full',id:candidate.id,method:candidate.type,card:candidate.card,source:'tmdb',page:1});
        }});
        screen.resultsHost().appendChild(renderer.element());
        controller = createController({Lampa:L,request:request,routerai:routerai,session:createSession(),clock:clock,onEvent:function (event) {
            if (destroyed) return;
            if (event.type === 'stage') screen.setStage(event.data.stage);
            else if (event.type === 'error') { screen.setStage('error');screen.setMessage(event.data.message); }
            else if (event.type === 'result') {
                screen.setStage('done');
                if (!(event.data.mode === 'more' && !event.data.result.items.length && lastResult)) {
                    renderer.render(event.data.result,event.data.intent);lastResult = event.data.result;
                }
                screen.applyIntent(event.data.intent,event.data.dictionaries);screen.setMessage(event.data.result.notice || 'Подборка готова.');focusResult();
            } else if (event.type === 'clarification') {
                screen.setStage('clarification');screen.setMessage('Нужно уточнить условия подбора.');
                if (event.data.kind === 'example') L.Select.show({title:'Какой фильм или сериал вы имели в виду?',items:event.data.options.map(function (candidate) {
                    return {title:escapeText(candidate.title),subtitle:escapeText((candidate.year || 'Год неизвестен') + ' · ' + (candidate.type === 'tv' ? 'Сериал' : 'Фильм')),value:candidate.key};
                }),onSelect:function (item) { controller.resolveClarification({kind:'example',key:item.value}); },onBack:function () { controller.cancel();screen.start(); }});
                else {
                    var html = doc.createElement('div');html.textContent = event.data.issues.join(' ') + ' Вернитесь к запросу и исправьте текст или фильтры.';
                    L.Modal.open({title:'Уточните условия',html:html,onBack:function () { L.Modal.close();controller.cancel();screen.start(); }});
                }
            }
        }});
        context = {controller:controller,screen:screen};contexts.push(context);
        var originalStart = screen.start, originalDestroy = screen.destroy;
        screen.start = function () {
            originalStart();
            if (!setupShown) {
                setupShown = true;var config = settings.getConfig();
                if (!config.key || !config.model) { screen.setMessage('Для начала настройте подключение к RouterAI.');settings.open(); }
            }
        };
        screen.destroy = function () {
            destroyed = true;controller.cancel();renderer.destroy();contexts = contexts.filter(function (c) { return c !== context; });originalDestroy();
        };
        return screen;
    });
    var menu = doc.querySelector('.menu .menu__list');
    if (menu) {
        var item = doc.createElement('li');item.className = 'menu__item selector aip-menu';item.setAttribute('role','button');item.setAttribute('tabindex','0');
        var text = doc.createElement('div');text.className = 'menu__text';text.textContent = 'ИИ-подборки';item.appendChild(text);
        item.addEventListener('hover:enter',open);menu.appendChild(item);
    }
    if (!doc.getElementById('aip-style')) {
        var style = doc.createElement('style');style.id = 'aip-style';
        style.textContent = typeof __AIP_CSS__ !== 'undefined' ? __AIP_CSS__ : '';doc.head.appendChild(style);
    }
    win.__aipPicksPlugin = {open:open,settings:settings};
    return win.__aipPicksPlugin;
}
function boot(win) {
    if (win.__aipPicksBoot) return;
    win.__aipPicksBoot = true;
    if (win.appready) registerPlugin({window:win,Lampa:win.Lampa});
    else if (win.Lampa && win.Lampa.Listener) win.Lampa.Listener.follow('app',function (event) { if (event.type === 'ready') registerPlugin({window:win,Lampa:win.Lampa}); });
}
if (typeof window !== 'undefined') boot(window);
module.exports = {registerPlugin:registerPlugin};
