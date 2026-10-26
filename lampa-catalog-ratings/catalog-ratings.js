/* Catalog Ratings 1.2.0 | MIT | Lampa 3.x (target: 3.3.8).
 * No bundled API keys. Configure Settings > Ratings on posters.
 */
(function () {
    'use strict';
    if (window.__catalogRatingsLoaded) return;
    window.__catalogRatingsLoaded = true;

    var L, records = [], queue = [], pending = {}, active = 0;
    var cache = {}, revision = 0, kpBlocked = false, kpPauseUntil = 0, batch = null;
    var CACHE_KEY = 'cr_cache_v3', MAX_CACHE = 500, MAX_FAILURES = 3, RETRY = 60000, MAX_ACTIVE = 4;
    var DAY = 86400000, API = 'https://kinopoiskapiunofficial.tech/api/v2.2/films';
    var IMDB_API = 'https://api.agregarr.org/api/ratings', BATCH_DELAY = 100, BATCH_SIZE = 20;
    var started = false, observer, retryTimer, quotaNotified = false;

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
        ['cr_cache_v1', 'cr_cache_v2'].forEach(function (name) {
            try {
                var old = L.Storage.get(name, null);
                if (old && typeof old === 'object' && Object.keys(old).length) L.Storage.set(name, {});
            } catch (e) { /* Old cache only takes space. */ }
        });
        try {
            var stored = L.Storage.get(CACHE_KEY, {});
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
            Object.keys(stored).slice(-MAX_CACHE).forEach(function (key) {
                var entry = stored[key];
                if (!entry || typeof entry.kpUntil !== 'number' || typeof entry.imdbUntil !== 'number') return;
                cache[key] = {kp: number(entry.kp), imdb: number(entry.imdb), kpUntil: entry.kpUntil, imdbUntil: entry.imdbUntil};
            });
        } catch (e) { cache = {}; }
    }
    // Known part of a cache entry: each source has its own expiry.
    function known(key) {
        var entry = key && cache[key], now = Date.now();
        return {kp: entry && entry.kpUntil > now ? entry.kp : null, imdb: entry && entry.imdbUntil > now ? entry.imdb : null,
            kpKnown: !!entry && entry.kpUntil > now, imdbKnown: !!entry && entry.imdbUntil > now};
    }
    function remember(key, out) {
        if (!out.kpDone && !out.imdbDone) return;
        var entry = cache[key] || {kp: null, imdb: null, kpUntil: 0, imdbUntil: 0}, now = Date.now();
        if (out.kpDone) { entry.kp = out.kp; entry.kpUntil = now + (out.kp ? DAY * 30 : DAY / 2); }
        if (out.imdbDone) { entry.imdb = out.imdb; entry.imdbUntil = now + (out.imdb ? DAY * 7 : DAY / 2); }
        cache[key] = entry;
        var keys = Object.keys(cache).sort(function (a, b) {
            return Math.max(cache[a].kpUntil, cache[a].imdbUntil) - Math.max(cache[b].kpUntil, cache[b].imdbUntil);
        });
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
    function httpGet(url, headers, callback) {
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
            network.silent(url, function (data) {
                if (!data || typeof data !== 'object') finish(null, 0);
                else finish(data, null);
            }, function (error) {
                finish(null, error && error.status ? Number(error.status) : 0);
            }, false, {headers: headers});
        } catch (e) { finish(null, 0); }
    }
    function apiGet(path, key, callback) {
        httpGet(API + path, {'X-API-KEY': key, 'Accept': 'application/json'}, callback);
    }
    // IMDb ratings come from the free keyless Agregarr API, batched by exact IMDb ID.
    function imdbRating(imdb, callback) {
        if (!batch) batch = {ids: {}, timer: setTimeout(flush, BATCH_DELAY)};
        (batch.ids[imdb] = batch.ids[imdb] || []).push(callback);
        if (Object.keys(batch.ids).length >= BATCH_SIZE) flush();
    }
    function flush() {
        var current = batch;
        if (!current) return;
        batch = null; clearTimeout(current.timer);
        var ids = Object.keys(current.ids);
        httpGet(IMDB_API + '?' + ids.map(function (id) { return 'id=' + encodeURIComponent(id); }).join('&'),
            {'Accept': 'application/json'}, function (data, error) {
                var found = {};
                if (error === null && !Array.isArray(data)) error = 0;
                if (error === null) data.forEach(function (row) {
                    if (row && current.ids[row.imdbId]) found[row.imdbId] = number(row.rating);
                });
                ids.forEach(function (id) {
                    current.ids[id].forEach(function (callback) { callback(error === null ? found[id] || null : null, error); });
                });
            });
    }
    function kpError(error) {
        if (error === 401 || error === 403) {
            if (!kpBlocked) notify('Рейтинги: API Кинопоиска отклонил ключ (HTTP ' + error + '). Проверьте ключ в настройках.');
            kpBlocked = true;
        } else if (error === 402 || error === 429) {
            // 402: daily quota is over, 429: per-second limit. IMDb keeps working meanwhile.
            if (error === 402 && !quotaNotified) notify('Рейтинги: исчерпан лимит запросов Кинопоиска. Повтор через час, IMDb продолжает работать.');
            quotaNotified = quotaNotified || error === 402;
            kpPauseUntil = Date.now() + (error === 402 ? DAY / 24 : RETRY);
        }
    }
    function resolve(job, callback) {
        var id = job.id, data = job.data || {}, left = 0, kpImdb = null;
        var out = {kp: null, imdb: null, kpDone: false, imdbDone: false, kpSkipped: false, error: null};
        function failed(error) { if (out.error === null) out.error = error; }
        function finish() {
            if (--left) return;
            // Kinopoisk also knows IMDb scores: a fallback when Agregarr has none.
            if (!out.imdb && kpImdb) { out.imdb = kpImdb; out.imdbDone = true; }
            callback(out);
        }
        function kpDone(film) {
            out.kp = film ? number(film.ratingKinopoisk) : null; out.kpDone = true;
            kpImdb = film ? number(film.ratingImdb) : null;
            finish();
        }
        function kpFailed(error) {
            kpError(error);
            if (error === 402 || error === 429) out.kpSkipped = true;
            else if (error !== 401 && error !== 403) failed(error);
            finish();
        }
        // Films without an IMDb match: strict title + year + type search, accepted only if unambiguous.
        function search(imdb) {
            var when = year(data.release_date || data.first_air_date);
            var titles = [data.title, data.name, data.original_title, data.original_name].map(normal)
                .filter(function (title) { return title; });
            var keyword = data.title || data.name || data.original_title || data.original_name;
            if (!when || !titles.length || !keyword) return kpDone(null);
            apiGet('?keyword=' + encodeURIComponent(keyword) + '&yearFrom=' + (when - 1) + '&yearTo=' + (when + 1),
                job.token, function (result, error) {
                    if (error !== null) return kpFailed(error);
                    if (!Array.isArray(result.items)) return kpFailed(0);
                    var matches = result.items.filter(function (film) {
                        if (!film || !sameType(id.type, film)) return false;
                        if (imdb && film.imdbId && film.imdbId !== imdb) return false;
                        if (Math.abs(year(film.year) - when) > 1) return false;
                        return [film.nameRu, film.nameEn, film.nameOriginal].some(function (name) {
                            return name && titles.indexOf(normal(name)) !== -1;
                        });
                    });
                    kpDone(matches.length === 1 ? matches[0] : null);
                });
        }
        function kp(imdb) {
            if (!job.need.kp || kpBlocked || !job.token) return finish();
            if (kpPauseUntil > Date.now()) { out.kpSkipped = true; return finish(); }
            if (id.kp) {
                apiGet('/' + id.kp, job.token, function (film, error) {
                    if (error !== null) return kpFailed(error);
                    if (numericId(film.kinopoiskId) !== id.kp) return kpFailed(0);
                    kpDone(film);
                });
            } else if (imdb) {
                apiGet('?imdbId=' + encodeURIComponent(imdb), job.token, function (result, error) {
                    if (error !== null) return kpFailed(error);
                    if (!Array.isArray(result.items)) return kpFailed(0);
                    var found = null;
                    result.items.some(function (film) {
                        if (film && film.imdbId === imdb) { found = film; return true; }
                        return false;
                    });
                    if (found) kpDone(found);
                    else search(imdb);
                });
            } else search('');
        }
        function imdbPart(imdb) {
            if (!job.need.imdb) return finish();
            if (!imdb) { out.imdbDone = true; return finish(); }
            imdbRating(imdb, function (value, error) {
                if (error !== null) failed(error);
                else { out.imdb = value; out.imdbDone = true; }
                finish();
            });
        }
        function lookup(imdb) {
            if (job.revision !== revision) return callback(out);
            left = 2; imdbPart(imdb); kp(imdb);
        }
        if (id.imdb || id.kp || !id.tmdb) return lookup(id.imdb);
        if (!L.Api || !L.Api.sources.tmdb || !L.Api.sources.tmdb.external_ids) { failed(0); return callback(out); }
        var settled = false;
        var timer = setTimeout(function () { done('', true); }, 10000);
        function done(imdb, error) {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) { failed(0); callback(out); } else lookup(imdbId(imdb));
        }
        try {
            L.Api.sources.tmdb.external_ids({id: Number(id.tmdb), type: id.type}, function (ids) {
                done(ids && ids.imdb_id, false);
            }, function () { done('', true); });
        } catch (e) { done('', true); }
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
        if (!enabled('enabled')) return;
        while (active < MAX_ACTIVE && queue.length) {
            var job = queue.shift();
            if (!wanted(job)) { if (pending[job.id.key] === job) delete pending[job.id.key]; continue; }
            run(job);
        }
    }
    function run(job) {
        active++;
        resolve(job, function (out) {
            active--;
            if (pending[job.id.key] === job) delete pending[job.id.key];
            if (job.revision === revision) {
                remember(job.id.key, out);
                job.records.forEach(function (record) {
                    if (record.dead) return;
                    record.loading = false;
                    record.retryAt = out.error === null ? 0 : Date.now() + RETRY;
                    if (out.error !== null) record.failures++;
                    record.value = merge(merge(ratings(record.data), known(job.id.key)), out);
                    draw(record, record.value);
                    var wait = out.kpSkipped ? kpPauseUntil - Date.now() : 0;
                    if (out.error !== null && record.failures < MAX_FAILURES) wait = Math.max(wait, RETRY);
                    if (wait > 0) { record.deferred = true; retryLater(wait); }
                });
            }
            pump();
        });
    }
    function needs(record) {
        var base = ratings(record.data), id = identity(record.data), hit = known(id.key);
        return {
            imdb: !base.imdb && !hit.imdbKnown,
            kp: !base.kp && !hit.kpKnown && !!token() && !kpBlocked
        };
    }
    function refresh(record) {
        if (record.dead || !record.visible) return;
        var id = identity(record.data);
        record.value = merge(ratings(record.data), known(id.key));
        draw(record, record.value);
        record.deferred = false;
        if (!enabled('enabled') || !id.key || record.loading || record.failures >= MAX_FAILURES) return;
        var need = needs(record), now = Date.now();
        if (need.kp && kpPauseUntil > now && !need.imdb) { record.deferred = true; return retryLater(kpPauseUntil - now); }
        if (!need.imdb && !need.kp) return;
        if (record.retryAt > now) { record.deferred = true; return retryLater(record.retryAt - now); }
        record.loading = true;
        var job = pending[id.key];
        if (job && job.revision === revision) job.records.push(record);
        else {
            job = {id: id, data: record.data, need: need, token: token(), revision: revision, records: [record]};
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
        clearTimeout(retryTimer); retryTimer = null;
        revision++; kpBlocked = false; kpPauseUntil = 0; quotaNotified = false; pending = {}; queue = [];
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
        param('enabled', 'trigger', 'КП и IMDb на постерах', 'Заменять текущую оценку доступными рейтингами. IMDb работает без ключа.', true);
        param('api_key', 'input', 'Ключ Kinopoisk API Unofficial',
            'Нужен только для оценок КП. Получите ключ на kinopoiskapiunofficial.tech. Ключ хранится в настройках Lampa.', '');
        param('fallback', 'trigger', 'Оставлять исходную оценку', 'Когда КП и IMDb недоступны, показывать прежнюю оценку.', true);
        param('check', 'button', 'Проверить API', 'Один тестовый запрос для проверки ключа и доступа к API.', '', checkApi);
        param('clear', 'button', 'Очистить кэш рейтингов', 'КП: 30 дней, IMDb: 7 дней, нет оценки: 12 часов. До 500 записей.', '', function () {
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
