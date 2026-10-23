'use strict';
function openText(options) {
    var doc = options.document || document, L = options.Lampa, html = doc.createElement('div');
    var wrap = options.$ || (typeof window !== 'undefined' && (window.jQuery || window.$));
    if (typeof wrap !== 'function') throw new Error('Lampa jQuery is unavailable');
    html.textContent = String(options.text || '');html.style.whiteSpace = 'pre-wrap';
    function close() { L.Modal.close();if (options.onBack) options.onBack(); }
    L.Modal.open({title:options.title,html:wrap(html),size:options.size || 'large',onBack:close,
        buttons:options.buttons || [{name:'Назад',onSelect:close}]});
}
module.exports = {openText:openText};
