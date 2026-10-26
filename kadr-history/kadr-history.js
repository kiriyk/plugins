/* KADR History 0.1.0 | Lampa + KADR: resume, next episode and watch history sync.
 * The profile key stays in Lampa storage on this device; KADR receives only a per-playback token.
 */
(function () {
    'use strict';
    if (window.KadrHistory) return;

    var L;
    var REWIND_MS = 10000, RESUME_MIN_MS = 10000, PENDING_TTL_MS = 12 * 3600000, NEXT_RECHECK_MS = 3000, INTENT_TTL_MS = 30 * 60000;
    var KH = window.KadrHistory = {version: '0.1.0'};
    var syncing = false, waiting = [], captured = null, pending = null, intent = null;

    // ==== basics ====
    function get(name, fallback) { return L.Storage.get('kh_' + name, fallback); }
    function put(name, value) { L.Storage.set('kh_' + name, value); }
    function now() { return Date.now(); }
    function clean(text) { return String(text == null ? '' : text).replace(/[​\s]+/g, ' ').replace(/^\s+|\s+$/g, ''); }
    function uid(prefix) {
        var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789', out = prefix;
        for (var i = 0; i < 20; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        return out;
    }
    function hash(text) { return String(L.Utils.hash(text)); }
    function notify(text) { if (L.Noty && L.Noty.show) L.Noty.show(text); }
    function clock(ms) {
        var total = Math.floor(Math.max(0, ms) / 1000), hours = Math.floor(total / 3600);
        var minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
        return (hours ? hours + ':' + (minutes < 10 ? '0' : '') : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }
    function enabled() { var value = get('enabled', true); return value === true || value === 'true'; }
    function server() { return clean(get('server', '')).replace(/\/+$/, ''); }
    function deviceId() {
        var id = get('device', '');
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) { id = uid('tv'); put('device', id); }
        return id;
    }
    function profiles() { var list = get('profiles', []); return Array.isArray(list) ? list : []; }
    function activeProfile() {
        var list = profiles(), name = get('active', '');
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return list[i];
        return list[0] || null;
    }
    function permanent(error) { var status = error && error.status; return status >= 400 && status < 500 && status !== 408 && status !== 429; }

    // ==== server ====
    function api(path, body, ok, fail, key) {
        var profile = activeProfile(), secret = key || (profile && profile.key), base = server();
        if (!base || !secret) { if (fail) fail({status: 0, error: 'not_configured'}); return; }
        var headers = {Authorization: 'Bearer ' + secret};
        if (body) headers['Content-Type'] = 'application/json';
        var request = new L.Reguest();
        request.timeout(15000);
        request.native(base + path, function (data) {
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { if (fail) fail({status: 0, error: 'bad_json'}); return; }
            }
            if (ok) ok(data || {});
        }, function (error) { if (fail) fail(error || {status: 0}); }, body ? JSON.stringify(body) : false, {headers: headers});
    }
    function stateKey() { var profile = activeProfile(); return profile ? 'state_' + hash(profile.key) : null; }
    function emptyState() { return {cursor: '', items: {}, prefs: {}, conflicts: {}, playbacks: {}, outbox: [], deferred: [], synced: 0}; }
    function load() {
        var key = stateKey(), state = key ? get(key, null) : null;
        if (!state || typeof state !== 'object' || !state.items) return emptyState();
        if (!Array.isArray(state.outbox)) state.outbox = [];
        if (!Array.isArray(state.deferred)) state.deferred = [];
        return state;
    }
    function save(state) { var key = stateKey(); if (key) put(key, state); }
    function merge(state, data) {
        (data.items || []).forEach(function (item) { if (item && item.item_key) state.items[item.item_key] = item; });
        (data.prefs || []).forEach(function (pref) { if (pref && pref.content_id) state.prefs[pref.content_id] = pref.prefs; });
        (data.conflicts || []).forEach(function (conflict) {
            if (!conflict || !conflict.id) return;
            if (conflict.status === 'open') state.conflicts[conflict.id] = conflict; else delete state.conflicts[conflict.id];
        });
        (data.playbacks || []).forEach(function (playback) { if (playback && playback.playback_id) state.playbacks[playback.playback_id] = playback; });
        if (data.cursor) state.cursor = data.cursor;
        state.synced = now();
    }
    function enqueue(event) {
        var state = load();
        event.event_id = event.event_id || uid('ev');
        event.device_id = deviceId();
        event.client_ms = now();
        state.outbox.push(event);
        if (state.outbox.length > 500) state.outbox = state.outbox.slice(-500);
        save(state);
    }
    function flushOutbox(done) {
        var batch = load().outbox.slice(0, 100);
        if (!batch.length) return done();
        var forget = function () { var fresh = load(); fresh.outbox = fresh.outbox.slice(batch.length); save(fresh); };
        api('/v1/events', {events: batch}, function () {
            forget();
            flushOutbox(done);
        }, function (error) {
            if (permanent(error)) forget();
            done();
        });
    }
    function flushDeferred(done) {
        var job = load().deferred[0];
        if (!job) return done();
        var forget = function () { var fresh = load(); fresh.deferred.shift(); save(fresh); };
        api('/v1/playbacks', job.body, function () {
            forget();
            if (job.progress) enqueue(job.progress);
            flushDeferred(done);
        }, function (error) {
            if (!permanent(error)) return done();
            forget();
            flushDeferred(done);
        });
    }
    function pull(state, round, done) {
        api('/v1/changes' + (state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''), null, function (data) {
            merge(state, data);
            save(state);
            if (data.more && round < 20) pull(state, round + 1, done); else done(state, null);
        }, function (error) { done(state, error || {status: 0}); });
    }
    function finishSync(state, error) {
        syncing = false;
        var calls = waiting;
        waiting = [];
        calls.forEach(function (fn) { fn(state, error); });
        if (!error && L.Listener && L.Listener.send) L.Listener.send('kadr_history', {type: 'synced'});
    }
    function sync(done) {
        if (done) waiting.push(done);
        if (syncing) return;
        if (!activeProfile() || !server()) return finishSync(load(), {status: 0, error: 'not_configured'});
        syncing = true;
        flushDeferred(function () { flushOutbox(function () { pull(load(), 0, finishSync); }); });
    }

    // ==== identity ====
    function isTv(card) { return !!(card.number_of_seasons || card.original_name || card.first_air_date); }
    function originalTitle(card) {
        return isTv(card) ? (card.original_name || card.original_title || card.name || card.title)
            : (card.original_title || card.title || card.name);
    }
    function episodeHash(season, episode, title) { return hash([season, season > 10 ? ':' : '', episode, title].join('')); }
    function findEpisode(card, timelineHash, hint) {
        var title = originalTitle(card);
        if (hint && +hint.season > 0 && +hint.episode > 0 && episodeHash(+hint.season, +hint.episode, title) === timelineHash) {
            return {season: +hint.season, episode: +hint.episode};
        }
        var seasons = Math.min(+card.number_of_seasons || 40, 60);
        for (var season = 0; season <= seasons; season++) {
            for (var episode = 1; episode <= 300; episode++) {
                if (episodeHash(season, episode, title) === timelineHash) return {season: season, episode: episode};
            }
        }
        return null;
    }
    function contentId(card) {
        var source = String(card.source || 'tmdb').toLowerCase().replace(/[^a-z]/g, '');
        if (source === 'cub' || source.length < 2) source = 'tmdb';
        return source.slice(0, 8) + ':' + (isTv(card) ? 'tv' : 'movie') + ':' + String(card.id).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
    }
    function metaOf(card) {
        var year = parseInt(String(card.release_date || card.first_air_date || '').slice(0, 4), 10);
        var original = originalTitle(card), poster = card.poster_path || card.img;
        return {title: (clean(card.title || card.name) || 'Без названия').slice(0, 300),
            original_title: original ? clean(original).slice(0, 300) : null,
            poster: poster ? String(poster).slice(0, 500) : null,
            year: year >= 1880 && year <= 2100 ? year : null};
    }
    function identify(card, data) {
        if (!card || !card.id) return null;
        data = data || {};
        var timelineHash = data.timeline && data.timeline.hash ? String(data.timeline.hash) : null;
        var content = {content_id: contentId(card), episode_id: null, season: null, episode: null, meta: metaOf(card), hash: timelineHash};
        if (isTv(card)) {
            var found = timelineHash ? findEpisode(card, timelineHash, data) : null;
            if (!found) return null;
            content.season = found.season;
            content.episode = found.episode;
            content.episode_id = 's' + found.season + 'e' + found.episode;
        }
        content.item_key = content.content_id + (content.episode_id ? '/' + content.episode_id : '');
        return content;
    }

    // ==== settings ====
    function param(name, type, title, description, value, onChange) {
        L.SettingsApi.addParam({component: 'kadr_history',
            param: {name: 'kh_' + name, type: type, values: '', 'default': value, placeholder: ''},
            field: {name: title, description: description}, onChange: onChange});
    }
    function saveProfile() {
        var key = clean(get('profile_key', ''));
        if (!/^kadr_[A-Za-z0-9_-]{20,}$/.test(key)) return notify('KADR: вставьте ключ профиля, он начинается с kadr_');
        api('/v1/profile', null, function (profile) {
            var name = String(profile.name || 'Профиль');
            var list = profiles().filter(function (item) { return item.name !== name; });
            list.push({name: name, key: key});
            put('profiles', list);
            put('active', name);
            put('profile_key', '');
            notify('KADR: профиль «' + name + '» сохранён');
            sync();
        }, function (error) {
            put('profile_key', '');
            notify('KADR: сервер не принял ключ' + (error && error.status ? ' (код ' + error.status + ')' : ''));
        }, key);
    }
    function switchProfile() {
        var list = profiles(), current = activeProfile();
        if (!list.length) return notify('KADR: профилей нет. Добавьте ключ профиля.');
        var items = list.map(function (item) {
            return {title: item.name + (current && current.name === item.name ? ' ✓' : ''), name: item.name};
        });
        if (current) items.push({title: 'Удалить профиль «' + current.name + '» с этого устройства', remove: current.name});
        L.Select.show({title: 'Профиль KADR', items: items, onSelect: function (choice) {
            L.Controller.toggle('settings_component');
            if (choice.remove) {
                var key = stateKey();
                if (key) put(key, null);
                put('profiles', profiles().filter(function (item) { return item.name !== choice.remove; }));
                put('active', (profiles()[0] || {}).name || '');
            } else {
                put('active', choice.name);
            }
            sync();
        }, onBack: function () { L.Controller.toggle('settings_component'); }});
    }
    function checkConnection() {
        api('/v1/profile', null, function (profile) {
            var threshold = profile.settings && profile.settings.watched_threshold;
            notify('KADR: сервер доступен, профиль «' + profile.name + '», порог ' + threshold + '%');
        }, function (error) {
            if (error && error.error === 'not_configured') return notify('KADR: укажите адрес сервера и профиль');
            notify('KADR: сервер недоступен' + (error && error.status ? ' (код ' + error.status + ')' : ''));
        });
    }
    function addSettings() {
        if (!L.SettingsApi) return;
        L.SettingsApi.addComponent({component: 'kadr_history', name: 'KADR: история',
            icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/></svg>'});
        param('enabled', 'trigger', 'Продолжение через KADR',
            'Перехватывать запуск во внешнем плеере Android: меню «Продолжить / Сначала», передача позиции и истории в KADR.', true);
        param('server', 'input', 'Адрес сервера истории', 'Например https://kadr.example.com', '');
        param('profile_key', 'input', 'Ключ профиля', 'Ключ из команды create-profile. После сохранения поле очищается.', '');
        param('profile_save', 'button', 'Сохранить профиль', 'Проверяет ключ на сервере и делает профиль активным.', '', saveProfile);
        param('profile_switch', 'button', 'Сменить профиль', 'Выбор сохранённого профиля на этом устройстве.', '', switchProfile);
        param('check', 'button', 'Проверить связь', 'Запрос к серверу с ключом активного профиля.', '', checkConnection);
    }

    // ==== start ====
    function start() {
        if (start.done) return;
        start.done = true;
        L = window.Lampa;
        addSettings();
        sync();
    }
    KH.load = function () { return load(); };
    KH.sync = sync;
    KH.enqueue = enqueue;
    KH.clock = clock;
    KH.identify = identify;
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
