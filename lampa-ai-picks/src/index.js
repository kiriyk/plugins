/* AI Picks 0.1.0 | Lampa 3.3.8 */
'use strict';
var createTransport = require('./transport').createTransport;
var createRouterAI = require('./routerai').createRouterAI, createCatalog = require('./catalog').createCatalog;
var registerSettings = require('./settings').registerSettings, createScreen = require('./ui').createScreen;
function registerPlugin(options) {
    var win = options.window, L = options.Lampa, doc = win.document;
    if (win.__aipPicksPlugin) return win.__aipPicksPlugin;
    if (!L || !L.Component || !L.Storage || !L.Controller || !L.Scroll) return null;
    var clock = {now:function () { return Date.now(); },setTimeout:function (fn,ms) { return win.setTimeout(fn,ms); },clearTimeout:function (id) { win.clearTimeout(id); }};
    var request = createTransport(L,clock), routerai = createRouterAI({request:request}), catalog = createCatalog({request:request,Lampa:L});
    var settings = registerSettings({Lampa:L,routerai:routerai,onChange:function () {}});
    function open() { L.Activity.push({url:'',component:'aip_picks',title:'ИИ-подборки',source:'tmdb',page:1}); }
    L.Component.add('aip_picks',function () { return createScreen({Lampa:L,document:doc,navigator:win.Navigator,catalog:catalog,
        onSubmit:function () {},onCancel:function () {},onSettings:settings.open}); });
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
