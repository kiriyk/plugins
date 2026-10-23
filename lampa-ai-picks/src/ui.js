'use strict';
var d = require('./domain'), escapeText = require('./settings').escapeText;
function createScreen(options) {
    var L = options.Lampa, doc = options.document || document, nav = options.navigator || L.Navigator;
    var root = doc.createElement('section'), scroll = new L.Scroll({mask:true,over:true});
    var query = '', form = {}, recognized = null, examples = [], dictionaries = null, busy = false, alive = true, lastFocus = null, cancels = [], created = false;
    root.className = 'aip-picks'; root.setAttribute('aria-label','ИИ-подборки');
    function elem(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
    function focus() {
        if (!alive) return;
        L.Controller.toggle('aip_picks');
        L.Controller.collectionSet(root,false,true);
        L.Controller.collectionFocus(lastFocus,root,true);
    }
    function focusElement(element) {
        if (!alive) return;
        lastFocus = element;scroll.update(element,true);
    }
    function button(action, label, fn, cls) {
        var e = elem('button','selector aip-control' + (cls ? ' ' + cls : ''),label);
        e.type = 'button'; e.setAttribute('data-action',action);
        e.addEventListener('hover:focus',function () { focusElement(e); });
        e.addEventListener('hover:enter',function () { if (!alive || e.disabled) return; lastFocus = e; fn(); });
        return e;
    }
    function notify(message) { if (L.Noty) L.Noty.show(message); }
    function edit(title, value, callback) {
        L.Input.edit({title:title,value:String(value || ''),free:true,nosave:true},function (text) { if (alive) { callback(String(text || '').trim()); focus(); } });
    }
    function select(title, items, callback, onCheck) {
        L.Select.show({title:title,items:items,nohide:!!onCheck,onSelect:function (item) { if (alive) { callback(item); update(); focus(); } },
            onCheck:onCheck ? function (item) { if (alive) { onCheck(item); update(); } } : undefined,onBack:focus});
    }
    var heading = elem('div','aip-heading');
    heading.appendChild(elem('h1','aip-title','Что посмотреть?'));
    heading.appendChild(elem('p','aip-intro','Опишите настроение, сюжет или фильм, на который хочется что-то похожее.'));
    heading.appendChild(button('settings','Настройки ИИ',function () { options.onSettings(); },'aip-settings'));
    root.appendChild(heading);
    var queryButton = button('query','',function () { edit('Что хотите посмотреть?',query,function (value) { query = value.slice(0,2000); update(); }); },'aip-query');
    root.appendChild(queryButton);
    var exampleSection = elem('div','aip-examples'), exampleList = elem('div','aip-example-list');
    exampleSection.appendChild(elem('h2','aip-label','Похожие на'));
    exampleSection.appendChild(exampleList);
    exampleSection.appendChild(button('example','Добавить фильм или сериал',function () {
        if (examples.length >= 3) { notify('Можно выбрать до трёх примеров.'); return; }
        edit('Найти фильм или сериал','',function (value) {
            if (!value) return;
            cancels.push(options.catalog.searchTitles({query:value,type:'all'},function (error, result) {
                if (!alive) return;
                if (error) { notify(error.message); return; }
                if (!result.items.length) { notify('По этому названию ничего не найдено. Попробуйте другое.'); return; }
                select('Выберите пример',result.items.slice(0,20).map(function (c) {
                    return {title:escapeText(c.title),subtitle:escapeText((c.year || 'Год неизвестен') + ' · ' + (c.type === 'tv' ? 'Сериал' : 'Фильм')),value:c.key,candidate:c};
                }),function (item) {
                    if (examples.length < 3 && !examples.some(function (c) { return c.key === item.value; })) examples.push(item.candidate);
                });
            }));
        });
    },'aip-secondary'));
    root.appendChild(exampleSection);
    var filterToggle = button('filters','Добавить условия',function () { filtersBox.hidden = !filtersBox.hidden; filterToggle.setAttribute('aria-expanded',String(!filtersBox.hidden)); focus(); },'aip-secondary');
    filterToggle.setAttribute('aria-expanded','false'); root.appendChild(filterToggle);
    var filtersBox = elem('div','aip-filters'); filtersBox.hidden = true;
    var formatButton = button('format','',function () {
        select('Формат',[{title:'Фильмы',value:'movie'},{title:'Сериалы',value:'tv'},{title:'Фильмы и сериалы',value:'all'}],function (item) { form.media = item.value; });
    });
    filtersBox.appendChild(formatButton);
    function numberControl(action, label, key, year) {
        return button(action,label,function () {
            edit(label,form[key],function (value) {
                if (!value) delete form[key];
                else if (/^[1-9]\d*$/.test(value) && (!year || value.length === 4) && Number(value) <= (year ? 9999 : 10000)) form[key] = Number(value);
                else notify(year ? 'Введите год четырьмя цифрами или очистите поле.' : 'Введите длительность в минутах или очистите поле.');
                update();
            });
        });
    }
    var yearMin = numberControl('year-min','Год от','yearMin',true), yearMax = numberControl('year-max','Год до','yearMax',true);
    var runtime = numberControl('runtime','Длительность до, минут','maxRuntimeMinutes',false);
    filtersBox.appendChild(yearMin);filtersBox.appendChild(yearMax);filtersBox.appendChild(runtime);
    function requireDictionaries(callback) {
        if (dictionaries) callback();
        else {
            notify('Загружаем фильтры каталога…');
            cancels.push(options.catalog.getDictionaries(function (error, value) {
                if (!alive) return;
                if (error) notify(error.message); else { dictionaries = value; callback(); }
            }));
        }
    }
    function genreControl(action, title, type, exclude) {
        return button(action,title,function () { requireDictionaries(function () {
            if (!form.genres) form.genres = d.emptyFilters().genres;
            var key = exclude ? 'exclude' : 'include', ids = form.genres[type][key];
            select(title,dictionaries.genres[type].map(function (g) { return {title:escapeText(g.name),value:g.id,checkbox:true,checked:ids.indexOf(g.id) >= 0}; }),function () {},function (item) {
                var at = ids.indexOf(item.value);
                if (item.checked && at < 0) ids.push(item.value); else if (!item.checked && at >= 0) ids.splice(at,1);
            });
        }); });
    }
    filtersBox.appendChild(genreControl('movie-genres','Жанры фильмов','movie',false));
    filtersBox.appendChild(genreControl('movie-exclude','Исключить жанры фильмов','movie',true));
    filtersBox.appendChild(genreControl('tv-genres','Жанры сериалов','tv',false));
    filtersBox.appendChild(genreControl('tv-exclude','Исключить жанры сериалов','tv',true));
    filtersBox.appendChild(button('countries','Страны производства',function () { requireDictionaries(function () {
        if (!form.countries) form.countries = [];
        select('Страны производства',dictionaries.countries.map(function (c) { return {title:escapeText(c.name),value:c.code,checkbox:true,checked:form.countries.indexOf(c.code) >= 0}; }),function () {},function (item) {
            var at = form.countries.indexOf(item.value);
            if (item.checked && at < 0) form.countries.push(item.value); else if (!item.checked && at >= 0) form.countries.splice(at,1);
        });
    }); }));
    filtersBox.appendChild(button('reset','Сбросить условия',function () { form = {}; update(); }));
    root.appendChild(filtersBox);
    var summary = elem('p','aip-summary'), status = elem('p','aip-status');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    root.appendChild(summary);
    var actions = elem('div','aip-actions'), submit = button('submit','Подобрать',function () {
        if (busy) return;
        if (!query.trim() && !Object.keys(cleanForm()).length && !examples.length) { notify('Опишите пожелание, добавьте условие или фильм-пример.'); return; }
        var resolved = d.resolveIntent(d.emptyIntent(),{filters:form},{},dictionaries);
        if (resolved.status !== 'ready') { notify(resolved.issues[0]); return; }
        options.onSubmit(getRequest('new'));
    },'aip-primary');
    var cancel = button('cancel','Отменить поиск',function () { options.onCancel(); setStage('cancelled'); });
    cancel.hidden = true;actions.appendChild(submit);actions.appendChild(cancel);root.appendChild(actions);root.appendChild(status);
    var resultHost = elem('div','aip-result-host');root.appendChild(resultHost);
    function update() {
        queryButton.textContent = query || 'Например: лёгкое кино на вечер, без романтики';
        queryButton.classList.toggle('aip-query--filled',!!query);
        formatButton.textContent = 'Формат: ' + ({movie:'Фильмы',tv:'Сериалы',all:'Фильмы и сериалы'}[form.media || 'movie']);
        yearMin.textContent = 'Год от: ' + (form.yearMin || 'любой');yearMax.textContent = 'Год до: ' + (form.yearMax || 'любой');
        runtime.textContent = (form.media === 'tv' ? 'Длительность серии' : form.media === 'all' ? 'Длительность фильма / серии' : 'Длительность фильма') + ': ' + (form.maxRuntimeMinutes ? 'до ' + form.maxRuntimeMinutes + ' мин' : 'любая');
        summary.textContent = Object.keys(form).length ? 'Заданные условия обязательны. Распознанные пожелания появятся в подборке.' : 'Условия можно сочетать с текстом и примерами.';
        exampleList.textContent = '';
        examples.forEach(function (c) {
            exampleList.appendChild(button('remove-example',c.title + (c.year ? ' · ' + c.year : '') + ' · Убрать',function () { examples = examples.filter(function (x) { return x.key !== c.key; }); update(); focus(); },'aip-example'));
        });
    }
    function cleanForm() {
        var copy = d.clone(form);
        if (copy.countries && !copy.countries.length) delete copy.countries;
        if (copy.genres) {
            ['movie','tv'].forEach(function (type) {
                ['include','exclude'].forEach(function (kind) { if (!copy.genres[type][kind].length) delete copy.genres[type][kind]; });
                if (!Object.keys(copy.genres[type]).length) delete copy.genres[type];
            });
            if (!Object.keys(copy.genres).length) delete copy.genres;
        }
        return copy;
    }
    function getRequest(mode) { return {query:query,formFilters:cleanForm(),examples:d.clone(examples),mode:mode || 'new'}; }
    function setStage(value) {
        busy = ['parsing','searching','ranking'].indexOf(value) >= 0;
        Array.prototype.forEach.call(root.querySelectorAll('button[data-action]'),function (control) {
            var action = control.getAttribute('data-action');
            control.disabled = busy && action !== 'cancel' && action !== 'settings';
            control.setAttribute('aria-disabled',String(control.disabled));
        });
        cancel.hidden = !busy;
        status.textContent = {parsing:'Разбираем запрос…',searching:'Ищем фильмы…',ranking:'Выбираем варианты…',cancelled:'Поиск отменён.'}[value] || '';
        root.setAttribute('aria-busy',String(busy));
        if (busy) { lastFocus = cancel; focus(); }
    }
    scroll.append(root);update();
    return {
        create:function () { if (!created) { created = true; } return scroll.render(); },
        render:function () { return scroll.render(); },element:function () { return root; },resultsHost:function () { return resultHost; },
        getRequest:getRequest,focusElement:focusElement,setStage:setStage,setMessage:function (text) { status.textContent = text; },
        applyIntent:function (intent, values) {
            recognized = d.clone(intent);if (values) dictionaries = values;update();
            var f = recognized.filters, parts = [{movie:'Фильмы',tv:'Сериалы',all:'Фильмы и сериалы'}[f.media]];
            if (f.yearMin || f.yearMax) parts.push('Годы: ' + (f.yearMin || 'любой') + '–' + (f.yearMax || 'любой'));
            if (f.maxRuntimeMinutes) parts.push((f.media === 'tv' ? 'Серия' : 'Длительность') + ' до ' + f.maxRuntimeMinutes + ' мин');
            ['movie','tv'].forEach(function (type) {
                ['include','exclude'].forEach(function (kind) {
                    var ids = f.genres[type][kind];
                    if (!ids.length) return;
                    var known = dictionaries && dictionaries.genres[type] || [];
                    var names = ids.map(function (id) { var match = known.filter(function (g) { return g.id === id; })[0];return match ? match.name : 'выбранный жанр'; });
                    parts.push((kind === 'exclude' ? 'Без жанров: ' : 'Жанры: ') + names.join(', '));
                });
            });
            if (f.countries.length) parts.push('Страны: ' + f.countries.map(function (code) { var match = (dictionaries && dictionaries.countries || []).filter(function (c) { return c.code === code; })[0];return match ? match.name : code; }).join(', '));
            summary.textContent = 'Учтено: ' + parts.join(' · ');
        },
        start:function () {
            L.Controller.add('aip_picks',{toggle:function () { L.Controller.collectionSet(root,false,true);L.Controller.collectionFocus(lastFocus,root,true); },
                up:function () { if (nav) nav.move('up'); },down:function () { if (nav) nav.move('down'); },
                left:function () { if (nav) nav.move('left'); },right:function () { if (nav) nav.move('right'); },
                back:function () { options.onCancel();L.Activity.backward(); }});
            focus();
        },
        stop:function () { options.onCancel(); },
        destroy:function () { alive = false; options.onCancel();cancels.forEach(function (cancelRequest) { if (cancelRequest) cancelRequest(); });scroll.destroy(); }
    };
}
module.exports = {createScreen:createScreen};
