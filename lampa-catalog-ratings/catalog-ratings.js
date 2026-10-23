/* Catalog Ratings 1.1.0 | MIT | Lampa 3.x (target: 3.3.8).
 * No bundled API keys. Configure Settings > Ratings on posters.
 */
(function () {
    'use strict';
    if (window.__catalogRatingsLoaded) return;
    window.__catalogRatingsLoaded = true;

    var L, records = [], queue = [], pending = {}, active = 0;
    var cache = {}, revision = 0, blocked = false, pauseUntil = 0;
    var CACHE_KEY = 'cr_cache_v2', MAX_CACHE = 500, MAX_FAILURES = 3, RETRY = 60000;
    var DAY = 86400000, API = 'https://kinopoiskapiunofficial.tech/api/v2.2/films';
    var started = false, observer, resumeTimer, retryTimer, quotaNotified = false;

    function setting(name, fallback) {
        return L.Storage.get('cr_' + name, fallback);
    }
    function enabled(name) {
        var value = setting(name, true);
        return value !== false && value !== 'false' && value !== 0 && value !== '0';
    }
    function token() {
        return String(setting('api_key', '') || '').replace(/^\s+|\s+$/g, '');
    }
    function notify(message) {
        if (L.Noty && L.Noty.show) L.Noty.show(message);
    }
    function number(value) {
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        if (typeof value === 'string' && !/^\d+(?:[.,]\d+)?$/.test(value)) return null;
        var n = Number(String(value).replace(',', '.'));
        return isFinite(n) && n > 0 && n <= 10 ? n : null;
    }
    function first(values) {
        for (var i = 0; i < values.length; i++) {
            var n = number(values[i]);
            if (n !== null) return n;
        }
        return null;
    }
    function ratings(data) {
        var nested = data.rating && typeof data.rating === 'object' ? data.rating : {};
        return {
            kp: first([data.ratingKinopoisk, data.rating_kp, data.kp_rating, data.kinopoisk_rating, nested.kp]),
            imdb: first([data.ratingImdb, data.rating_imdb, data.imdb_rating, nested.imdb])
        };
    }
    function merge(base, extra) {
        return {kp: extra.kp || base.kp, imdb: extra.imdb || base.imdb};
    }
    function numericId(value) {
        return /^[1-9]\d*$/.test(String(value || '')) ? String(value) : '';
    }
    function imdbId(value) {
        return /^tt\d+$/.test(String(value || '')) ? String(value) : '';
    }
    function identity(data) {
        var kp = numericId(data.kinopoisk_id || data.kinopoiskId || data.kp_id);
        var imdb = imdbId(data.imdb_id || data.imdbId || (data.external_ids || {}).imdb_id);
        var type = data.media_type || data.type;
        if (type !== 'tv' && type !== 'movie') type = data.name || data.first_air_date ? 'tv' : 'movie';
        var tmdb = numericId(data.tmdb_id);
        if (!tmdb && (data.source === 'tmdb' || data.source === 'cub')) tmdb = numericId(data.id);
        return {kp: kp, imdb: imdb, tmdb: tmdb, type: type,
            key: kp ? 'kp:' + kp : imdb ? 'imdb:' + imdb : tmdb ? 'tmdb:' + type + ':' + tmdb : ''};
    }
    function normal(value) {
        return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
    }
    function year(value) {
        var match = /^(\d{4})/.exec(String(value || ''));
        return match ? Number(match[1]) : 0;
    }
    function sameType(type, film) {
        var kind = String(film.type || '');
        if (!kind) return true;
        return type === 'tv' ? /^(TV_SERIES|MINI_SERIES|TV_SHOW)$/.test(kind) : /^(FILM|VIDEO)$/.test(kind);
    }
    function loadCache() {
        try {
            var old = L.Storage.get('cr_cache_v1', null);
            if (old && typeof old === 'object' && Object.keys(old).length) L.Storage.set('cr_cache_v1', {});
        } catch (e) { /* Old cache only takes space. */ }
        try {
            var stored = L.Storage.get(CACHE_KEY, {});
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
            Object.keys(stored).slice(-MAX_CACHE).forEach(function (key) {
                var entry = stored[key];
                if (entry && typeof entry.expires === 'number' && entry.expires > Date.now()) {
                    cache[key] = {kp: number(entry.kp), imdb: number(entry.imdb), expires: entry.expires};
                }
            });
        } catch (e) { cache = {}; }
    }
    function cached(key) {
        var entry = cache[key];
        return entry && entry.expires > Date.now() ? entry : null;
    }
    function remember(key, value) {
        cache[key] = {kp: value.kp, imdb: value.imdb,
            expires: Date.now() + (value.kp || value.imdb ? DAY * 7 : DAY / 2)};
        var keys = Object.keys(cache).sort(function (a, b) { return cache[a].expires - cache[b].expires; });
        while (keys.length > MAX_CACHE) delete cache[keys.shift()];
        try { L.Storage.set(CACHE_KEY, cache); } catch (e) { /* A full TV storage must not break catalog. */ }
    }
    function rootNode(html) {
        return html && html.querySelector ? html : html && html[0];
    }
    function removeBadge(record) {
        var badge = record.root.querySelector('.cr-ratings');
        if (badge) badge.parentNode.removeChild(badge);
        record.root.classList.remove('cr-has-ratings');
    }
    function draw(record, value) {
        if (record.dead) return;
        removeBadge(record);
        if (!enabled('enabled')) return;
        if (!value.kp && !value.imdb) {
            if (!enabled('fallback')) record.root.classList.add('cr-has-ratings');
            return;
        }
        var view = record.root.querySelector('.card__view');
        if (!view) return;
        var container = document.createElement('div');
        container.className = 'cr-ratings';
        function badge(label, score, kind) {
            if (!score) return;
            var elem = document.createElement('div');
            elem.className = 'cr-rating cr-rating--' + kind;
            var name = document.createElement('span');
            name.className = 'cr-rating__name'; name.textContent = label;
            var val = document.createElement('span');
            val.className = 'cr-rating__value'; val.textContent = score.toFixed(1);
            elem.appendChild(name); elem.appendChild(val);
            container.appendChild(elem);
        }
        badge('КП', value.kp, 'kp'); badge('IMDb', value.imdb, 'imdb');
        view.appendChild(container);
        record.root.classList.add('cr-has-ratings');
    }
    function apiGet(path, key, callback) {
        var settled = false, network;
        var timer = setTimeout(function () { finish(null, 0); if (network && network.clear) network.clear(); }, 10000);
        function finish(value, error) {
            if (settled) return;
            settled = true; clearTimeout(timer); callback(value, error);
        }
        try {
            var Request = L.Reguest || L.Request;
            network = new Request();
            network.timeout(8000);
            network.silent(API + path, function (data) {
                if (!data || typeof data !== 'object') finish(null, 0);
                else finish(data, null);
            }, function (error) {
                finish(null, error && error.status ? Number(error.status) : 0);
            }, false, {headers: {'X-API-KEY': key, 'Accept': 'application/json'}});
        } catch (e) { finish(null, 0); }
    }
    function resolve(job, callback) {
        var id = job.id;
        // Films without an IMDb match: strict title + year + type search, accepted only if unambiguous.
        function search(imdb) {
            var data = job.data || {}, when = year(data.release_date || data.first_air_date);
            var titles = [data.title, data.name, data.original_title, data.original_name].map(normal)
                .filter(function (title) { return title; });
            var keyword = data.title || data.name || data.original_title || data.original_name;
            if (!when || !titles.length || !keyword) return callback({kp: null, imdb: null}, null);
            apiGet('?keyword=' + encodeURIComponent(keyword) + '&yearFrom=' + (when - 1) + '&yearTo=' + (when + 1),
                job.token, function (result, error) {
                    if (error !== null) return callback(null, error);
                    if (!Array.isArray(result.items)) return callback(null, 0);
                    var matches = result.items.filter(function (film) {
                        if (!film || !sameType(id.type, film)) return false;
                        if (imdb && film.imdbId && film.imdbId !== imdb) return false;
                        if (Math.abs(year(film.year) - when) > 1) return false;
                        return [film.nameRu, film.nameEn, film.nameOriginal].some(function (name) {
                            return name && titles.indexOf(normal(name)) !== -1;
                        });
                    });
                    callback(matches.length === 1 ? ratings(matches[0]) : {kp: null, imdb: null}, null);
                });
        }
        function find(imdb) {
            if (job.revision !== revision) return callback(null, 0);
            if (!imdb) return search('');
            apiGet('?imdbId=' + encodeURIComponent(imdb), job.token, function (data, error) {
                if (error !== null) return callback(null, error);
                if (!Array.isArray(data.items)) return callback(null, 0);
                var found = null;
                data.items.some(function (film) {
                    if (film && film.imdbId === imdb) { found = film; return true; }
                    return false;
                });
                if (found) callback(ratings(found), null);
                else search(imdb);
            });
        }
        if (id.kp) {
            apiGet('/' + id.kp, job.token, function (data, error) {
                if (error !== null) return callback(null, error);
                if (numericId(data.kinopoiskId) !== id.kp) return callback(null, 0);
                callback(ratings(data), null);
            });
        } else if (id.imdb) find(id.imdb);
        else if (id.tmdb && L.Api && L.Api.sources.tmdb && L.Api.sources.tmdb.external_ids) {
            var settled = false;
            var timer = setTimeout(function () { done('', true); }, 10000);
            function done(imdb, failed) {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (failed) callback(null, 0);
                else find(imdbId(imdb));
            }
            try {
                L.Api.sources.tmdb.external_ids({id: Number(id.tmdb), type: id.type}, function (data) {
                    done(data && data.imdb_id, false);
                }, function () { done('', true); });
            } catch (e) { done('', true); }
        } else callback(null, 0);
    }
    function requestError(error) {
        if (error === 401 || error === 403) {
            if (!blocked) notify('Рейтинги: API отклонил ключ (HTTP ' + error + '). Проверьте ключ и лимит в настройках.');
            blocked = true;
        } else if (error === 402 || error === 429) {
            // 402: daily quota is over, 429: per-second limit. Deferred cards return after the pause.
            var pause = error === 402 ? DAY / 24 : RETRY;
            if (error === 402 && !quotaNotified) notify('Рейтинги: исчерпан лимит запросов API. Повтор через час.');
            quotaNotified = quotaNotified || error === 402;
            pauseUntil = Date.now() + pause;
            clearTimeout(resumeTimer);
            resumeTimer = setTimeout(function () { pump(); }, pause);
        }
    }
    function retryLater(delay) {
        if (retryTimer) return;
        retryTimer = setTimeout(function () {
            retryTimer = null;
            records.slice().forEach(function (r) { if (r.deferred && r.visible && !r.loading) refresh(r); });
        }, Math.max(delay, 1000));
    }
    function wanted(job) {
        return job.revision === revision && enabled('enabled') && job.records.some(function (r) { return !r.dead; });
    }
    function pump() {
        if (blocked || pauseUntil > Date.now() || !enabled('enabled')) return;
        while (active < 2 && queue.length) {
            var job = queue.shift();
            if (!wanted(job)) { if (pending[job.id.key] === job) delete pending[job.id.key]; continue; }
            run(job);
        }
    }
    function run(job) {
        active++;
        resolve(job, function (value, error) {
            active--;
            if (pending[job.id.key] === job) delete pending[job.id.key];
            if (job.revision === revision) {
                if (error === null) remember(job.id.key, value);
                else requestError(error);
                job.records.forEach(function (record) {
                    if (record.dead) return;
                    record.loading = false;
                    record.retryAt = error === null ? 0 : Math.max(Date.now() + RETRY, pauseUntil);
                    if (error !== null && error !== 402 && error !== 429) record.failures++;
                    if (value) record.value = merge(ratings(record.data), value);
                    draw(record, record.value);
                    if (error !== null) {
                        record.deferred = true;
                        if (!blocked && record.failures < MAX_FAILURES) retryLater(record.retryAt - Date.now());
                    }
                });
            }
            pump();
        });
    }
    function refresh(record) {
        if (record.dead || !record.visible) return;
        var base = ratings(record.data), id = identity(record.data), hit = id.key && cached(id.key);
        record.value = hit ? merge(base, hit) : base;
        draw(record, record.value);
        record.deferred = false;
        if (!enabled('enabled') || (record.value.kp && record.value.imdb) || hit || !id.key || !token() ||
            record.loading || blocked || record.failures >= MAX_FAILURES) return;
        var wait = Math.max(record.retryAt, pauseUntil) - Date.now();
        if (wait > 0) { record.deferred = true; return retryLater(wait); }
        record.loading = true;
        var job = pending[id.key];
        if (job && job.revision === revision) job.records.push(record);
        else {
            job = {id: id, data: record.data, token: token(), revision: revision, records: [record]};
            pending[id.key] = job; queue.push(job);
        }
        pump();
    }
    function attach(root, data) {
        if (!root || !root.querySelector || !data || root.__crRecord) return root && root.__crRecord;
        var record = {root: root, data: data, visible: false, dead: false, loading: false, retryAt: 0,
            failures: 0, deferred: false, value: {kp: null, imdb: null}};
        root.__crRecord = record; records.push(record);
        return record;
    }
    function detach(record) {
        if (!record || record.dead) return;
        record.dead = true; removeBadge(record);
        if (observer) observer.unobserve(record.root);
        records = records.filter(function (r) { return r !== record; });
        delete record.root.__crRecord;
    }
    var events = {
        onVisible: function () {
            var root = rootNode(this.html), record = root && root.__crRecord;
            if (record) { record.visible = true; refresh(record); }
        },
        onUpdate: function () {
            var root = rootNode(this.html), record = root && root.__crRecord;
            if (record) refresh(record);
        },
        onDestroy: function () { var root = rootNode(this.html); if (root) detach(root.__crRecord); }
    };
    function change() {
        clearTimeout(resumeTimer); clearTimeout(retryTimer); retryTimer = null;
        revision++; blocked = false; pauseUntil = 0; quotaNotified = false; pending = {}; queue = [];
        records.forEach(function (r) { r.loading = false; r.retryAt = 0; r.failures = 0; refresh(r); });
    }
    function checkApi() {
        if (!token()) return notify('Сначала введите ключ Kinopoisk API Unofficial.');
        apiGet('/326', token(), function (data, error) {
            if (error !== null) notify('Рейтинги: ошибка API ' + (error || '(сеть, CORS или таймаут)') + '.');
            else if (numericId(data.kinopoiskId) !== '326') notify('Рейтинги: неожиданный ответ API.');
            else { notify('API работает. КП: ' + (number(data.ratingKinopoisk) || 'нет') + ', IMDb: ' +
                (number(data.ratingImdb) || 'нет')); change(); }
        });
    }
    function addSettings() {
        if (!L.SettingsApi) return;
        L.SettingsApi.addComponent({component: 'catalog_ratings', name: 'Рейтинги на постерах',
            icon: '<svg viewBox="0 0 24 24" fill="none"><path d="m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1 3-6Z" stroke="currentColor" stroke-width="1.5"/></svg>'});
        function param(name, type, title, description, value, callback) {
            L.SettingsApi.addParam({component: 'catalog_ratings',
                param: {name: 'cr_' + name, type: type, values: '', 'default': value, placeholder: ''},
                field: {name: title, description: description}, onChange: callback || change});
        }
        param('enabled', 'trigger', 'КП и IMDb на постерах', 'Заменять текущую оценку доступными рейтингами.', true);
        param('api_key', 'input', 'Ключ Kinopoisk API Unofficial',
            'Получите ключ на kinopoiskapiunofficial.tech. Ключ хранится в настройках Lampa, в код добавлять его не нужно.', '');
        param('fallback', 'trigger', 'Оставлять исходную оценку', 'Когда КП и IMDb недоступны, показывать прежнюю оценку.', true);
        param('check', 'button', 'Проверить API', 'Один тестовый запрос для проверки ключа и доступа к API.', '', checkApi);
        param('clear', 'button', 'Очистить кэш рейтингов', 'Успешные ответы: 7 дней. Нет оценок: 12 часов. До 500 записей.', '', function () {
            cache = {}; try { L.Storage.set(CACHE_KEY, {}); } catch (e) {}
            change(); notify('Кэш рейтингов очищен.');
        });
    }
    function addStyle() {
        var style = document.createElement('style'); style.id = 'catalog-ratings-style';
        style.textContent = '.card.cr-has-ratings .card__vote{display:none!important}' +
            '.cr-ratings{position:absolute;right:.35em;bottom:.35em;z-index:5;display:flex;flex-direction:column;' +
            'align-items:flex-end;gap:.22em;pointer-events:none;font-size:1.17em;line-height:1.15}' +
            '.cr-rating{display:flex;align-items:center;gap:.45em;border-radius:.25em;padding:.28em .42em;' +
            'background:rgba(12,15,20,.92);color:#fff;box-shadow:0 .08em .3em rgba(0,0,0,.35)}' +
            '.cr-rating__name{font-size:.75em;font-weight:700}.cr-rating__value{font-weight:700;font-variant-numeric:tabular-nums}' +
            '.cr-rating--kp .cr-rating__name{color:#ff9845}.cr-rating--imdb .cr-rating__name{color:#f5c518}';
        (document.head || document.documentElement).appendChild(style);
    }
    function start() {
        if (started) return;
        L = window.Lampa;
        if (!L || !L.Maker || !L.Maker.map || !L.Storage) return;
        var map = L.Maker.map('Card');
        if (!map.Card || typeof map.Card.onCreate !== 'function') {
            notify('Рейтинги: нужен стандартный модуль карточек Lampa 3.x.'); return;
        }
        started = true; loadCache(); addStyle(); addSettings();
        var create = map.Card.onCreate;
        map.Card.onCreate = function () {
            var result = create.apply(this, arguments);
            if (attach(rootNode(this.html), this.data) && this.use) this.use(events);
            return result;
        };
        // Usually plugins load before catalog. Also adopt existing standard cards.
        if (typeof window.IntersectionObserver === 'function') {
            observer = new window.IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    var record = entry.target.__crRecord;
                    if (record && entry.isIntersecting) { record.visible = true; refresh(record); }
                });
            });
            Array.prototype.forEach.call(document.querySelectorAll('.card'), function (root) {
                if (root.card_data) { attach(root, root.card_data); observer.observe(root); }
            });
        }
    }
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
