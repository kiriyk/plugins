/* KADR Probe 0.1.0 | Lampa + KADR integration diagnostics.
 * Stores masked launch data only: no full URLs, query strings or header values.
 */
(function () {
    'use strict';
    if (window.__kadrProbeLoaded) return;
    window.__kadrProbeLoaded = true;

    var L, LOG_KEY = 'kadr_probe_log', MAX_RECORDS = 30, PROBE_HEADER = 'X-Kadr-Probe';
    var CARD_FIELDS = ['id', 'source', 'title', 'original_title', 'name', 'original_name',
        'number_of_seasons', 'imdb_id', 'kinopoisk_id'];
    var SECRET_KEYS = /token|key|auth|cookie|pass|secret|sign/i;

    function maskUrl(text) {
        var match = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)(.*)$/i.exec(text);
        return match ? match[1] + '/…(' + match[2].length + ')' : '<url>';
    }
    function maskString(key, text) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return maskUrl(text);
        if (SECRET_KEYS.test(key)) return '<' + text.length + ' chars>';
        return text.length > 120 ? text.slice(0, 60) + '…(' + text.length + ')' : text;
    }
    function pickCard(card) {
        if (!card || typeof card !== 'object') return null;
        var out = {};
        CARD_FIELDS.forEach(function (name) {
            if (card[name] === undefined) return;
            out[name] = typeof card[name] === 'string' ? maskString(name, card[name]) : card[name];
        });
        return out;
    }
    function maskHeaders(headers) {
        var out = {};
        Object.keys(headers).forEach(function (name) {
            out[name] = name === PROBE_HEADER ? headers[name] : '<' + String(headers[name]).length + ' chars>';
        });
        return out;
    }
    function mask(value, key, depth) {
        if (typeof value === 'function') return '[function]';
        if (typeof value === 'string') return maskString(key || '', value);
        if (value === null || typeof value !== 'object') return value;
        if (depth >= 4) return '[depth]';
        if (Array.isArray(value)) {
            return value.slice(0, 60).map(function (item) { return mask(item, key, depth + 1); });
        }
        var out = {};
        Object.keys(value).slice(0, 80).forEach(function (name) {
            var item = value[name];
            if (name === 'headers' && item && typeof item === 'object') out[name] = maskHeaders(item);
            else if (name === 'card' || name === 'movie') out[name] = pickCard(item);
            else out[name] = mask(item, name, depth + 1);
        });
        return out;
    }

    function field(name) {
        return L.Storage.field ? L.Storage.field(name) : L.Storage.get(name);
    }
    function headerEnabled() {
        var value = L.Storage.get('kadr_probe_header', false);
        return value === true || value === 'true';
    }
    function readLog() {
        var log = L.Storage.get(LOG_KEY, []);
        return Array.isArray(log) ? log : [];
    }
    function record(type, payload) {
        var log = readLog();
        payload.type = type;
        payload.at = new Date().toISOString();
        log.push(payload);
        while (log.length > MAX_RECORDS) log.shift();
        L.Storage.set(LOG_KEY, log);
        if (window.console && console.log) console.log('[KADR probe]', JSON.stringify(payload));
    }
    function context() {
        var active = L.Activity && L.Activity.active ? L.Activity.active() : null;
        return {
            component: active && active.component || null,
            card: pickCard(active && (active.movie || active.card)),
            player: field('player'),
            timecode: field('player_timecode'),
            android: !!(L.Platform && L.Platform.is && L.Platform.is('android'))
        };
    }

    function onCreate(event) {
        var data = event && event.data;
        if (!data) return;
        var payload = context();
        if (headerEnabled() && payload.player === 'android') {
            var nonce = 'p' + Date.now().toString(36);
            if (!data.headers || typeof data.headers !== 'object') data.headers = {};
            data.headers[PROBE_HEADER] = nonce;
            payload.nonce = nonce;
        }
        payload.data = mask(data, '', 0);
        record('create', payload);
    }
    function onTimeline(event) {
        if (field('player') !== 'android') return;
        var data = event && event.data || {};
        var road = data.road || {};
        record('timeline', {hash: data.hash, time: road.time, duration: road.duration, percent: road.percent});
    }
    function wrapPlaylist() {
        var original = L.Player.playlist;
        if (typeof original !== 'function' || original.__kadrProbe) return;
        var wrapped = function (list) {
            var items = Array.isArray(list) ? list : [];
            record('playlist', {count: items.length, items: items.slice(0, 60).map(function (item) {
                item = item || {};
                return {title: mask(item.title, 'title', 0), url: typeof item.url,
                    hash: item.timeline ? item.timeline.hash : null,
                    season: item.season, episode: item.episode, voice_name: mask(item.voice_name, 'voice_name', 0)};
            })});
            return original.apply(this, arguments);
        };
        wrapped.__kadrProbe = true;
        L.Player.playlist = wrapped;
    }

    function showLog() {
        var text = JSON.stringify(readLog(), null, 2);
        if (L.Modal && L.Modal.open && window.$) {
            var body = window.$('<pre style="white-space:pre-wrap;font-size:0.8em"></pre>').text(text);
            L.Modal.open({title: 'KADR Probe', html: body, size: 'large', onBack: function () {
                L.Modal.close();
                L.Controller.toggle('settings_component');
            }});
        } else {
            L.Noty.show(text.slice(0, 500));
        }
    }
    function addSettings() {
        if (!L.SettingsApi) return;
        L.SettingsApi.addComponent({component: 'kadr_probe', name: 'KADR Probe',
            icon: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M10 8l6 4-6 4V8Z" fill="currentColor"/></svg>'});
        L.SettingsApi.addParam({component: 'kadr_probe',
            param: {name: 'kadr_probe_header', type: 'trigger', 'default': false},
            field: {name: 'Передавать тестовый заголовок',
                description: 'Добавляет X-Kadr-Probe при запуске во внешнем плеере Android, чтобы проверить его получение в KADR.'}});
        L.SettingsApi.addParam({component: 'kadr_probe',
            param: {name: 'kadr_probe_show', type: 'button'},
            field: {name: 'Показать журнал'}, onChange: showLog});
        L.SettingsApi.addParam({component: 'kadr_probe',
            param: {name: 'kadr_probe_clear', type: 'button'},
            field: {name: 'Очистить журнал'}, onChange: function () {
                L.Storage.set(LOG_KEY, []);
                L.Noty.show('Журнал KADR Probe очищен');
            }});
    }

    function start() {
        if (start.done) return;
        start.done = true;
        L = window.Lampa;
        if (L.Player && L.Player.listener) L.Player.listener.follow('create', onCreate);
        if (L.Player) wrapPlaylist();
        if (L.Timeline && L.Timeline.listener) L.Timeline.listener.follow('update', onTimeline);
        addSettings();
    }
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
