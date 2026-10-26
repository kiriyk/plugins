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

    // ==== settings ====

    // ==== start ====
    function start() {
        if (start.done) return;
        start.done = true;
        L = window.Lampa;
        sync();
    }
    KH.load = function () { return load(); };
    KH.sync = sync;
    KH.enqueue = enqueue;
    KH.clock = clock;
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
