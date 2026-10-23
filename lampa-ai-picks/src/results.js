'use strict';
var clone = require('./domain').clone, openText = require('./dialog').openText;
function createResults(options) {
    var L = options.Lampa, doc = options.document || document, root = doc.createElement('section'), cards = [], alive = true, modalOpen = false;
    root.className = 'aip-results';root.setAttribute('aria-label','Результаты подбора');
    function clear() { cards.forEach(function (card) { card.destroy(); });cards = [];root.textContent = ''; }
    function restore(target) {
        if (!alive) return;
        var parent = root;
        while (parent.parentNode && !(parent.classList && parent.classList.contains('aip-picks'))) parent = parent.parentNode;
        L.Controller.toggle('aip_picks');L.Controller.collectionSet(parent,false,true);L.Controller.collectionFocus(target,parent,true);
    }
    function button(action, title, callback) {
        var b = doc.createElement('button');b.type = 'button';b.className = 'selector aip-control';b.textContent = title;b.setAttribute('data-action',action);
        b.addEventListener('hover:focus',function () { if (alive && options.onFocus) options.onFocus(b); });
        b.addEventListener('hover:enter',function () { if (alive && !b.disabled) callback(b); });
        return b;
    }
    function render(result) {
        if (!alive) return;
        clear();
        var heading = doc.createElement('h2');heading.className = 'aip-results-title';heading.textContent = result.items.length ? 'Для вашего вечера' : 'Подходящие варианты не найдены';
        root.appendChild(heading);
        if (result.notice) { var notice = doc.createElement('p');notice.className = 'aip-results-notice';notice.textContent = result.notice;root.appendChild(notice); }
        var grid = doc.createElement('div');grid.className = 'aip-grid';root.appendChild(grid);
        result.items.slice(0,10).forEach(function (item) {
            var wrapper = doc.createElement('article');wrapper.className = 'aip-pick';wrapper.setAttribute('data-key',item.candidate.key);
            var card = L.Maker.make('Card',clone(item.candidate.card));
            card.use({onEnter:function () { if (alive) options.onOpen(item.candidate); },
                onFocus:function () { if (alive && options.onFocus) options.onFocus(card.render(true)); }});
            card.create();wrapper.appendChild(card.render(true));
            wrapper.appendChild(button('why','Почему предложен',function (target) {
                openText({Lampa:L,document:doc,$:options.$,title:'Почему предложен',text:item.candidate.title + '\n\n' + item.reason.slice(0,300),
                    onBack:function () { modalOpen = false;restore(target); }});
                modalOpen = true;
            }));
            grid.appendChild(wrapper);cards.push(card);
        });
        var actions = doc.createElement('div');actions.className = 'aip-result-actions';
        if (result.items.length) actions.appendChild(button('more','Ещё варианты',options.onMore));
        actions.appendChild(button('refine',result.items.length ? 'Уточнить' : 'Изменить условия',options.onRefine));
        root.appendChild(actions);
        L.Layer.visible(root);
    }
    return {render:render,element:function () { return root; },destroy:function () { alive = false;if (modalOpen) L.Modal.close();clear();root.remove(); }};
}
module.exports = {createResults:createResults};
