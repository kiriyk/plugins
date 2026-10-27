/* Sled 0.1.0 | Lampa + KADR: resume, next episode and watch history sync.
 * The profile key stays in Lampa storage on this device; KADR receives only a per-playback token.
 */
(function () {
    'use strict';
    if (window.Sled) return;

    var L;
    var PAIR_POLL_MS = 3000, PAIR_MAX_POLLS = 220, REWIND_MS = 10000, RESUME_MIN_MS = 10000, PENDING_TTL_MS = 12 * 3600000, NEXT_RECHECK_MS = 3000, INTENT_TTL_MS = 30 * 60000;
    var KH = window.Sled = {version: '0.1.0'};
    var syncing = false, waiting = [], captured = null, pending = null, intent = null;

    // ==== basics ====
    function get(name, fallback) { return L.Storage.get('sled_' + name, fallback); }
    function put(name, value) { L.Storage.set('sled_' + name, value); }
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
    // TV keyboards capitalise the first letter; scheme and host are case-insensitive, the path is not.
    function server() {
        return clean(get('server', '')).replace(/\/+$/, '')
            .replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i, function (origin) { return origin.toLowerCase(); });
    }
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
        var profile = activeProfile(), secret = key || (profile && profile.key);
        if (!server() || !secret) { if (fail) fail({status: 0, error: 'not_configured'}); return; }
        request(path, body, secret, ok, fail);
    }
    function request(path, body, secret, ok, fail) {
        var headers = {};
        if (secret) headers.Authorization = 'Bearer ' + secret;
        if (body) headers['Content-Type'] = 'application/json';
        var call = new L.Reguest();
        call.timeout(15000);
        call.native(server() + path, function (data) {
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
        if (!error && L.Listener && L.Listener.send) L.Listener.send('sled', {type: 'synced'});
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

    // ==== launch ====
    var BALANSER_KEYS = {online_mod: 'online_mod_balanser', showy_free: 'online_balanser'};
    function unmark(url) { return typeof url === 'string' ? url.replace(/#kadr=.*$/, '') : url; }
    function mark(url, fragment) {
        if (typeof url !== 'string') return url;
        url = unmark(url);
        return url.indexOf('#') === -1 ? url + '#' + fragment : url;
    }
    // Values go unescaped: LampaS escapes '%' once more on the way to KADR, which would break srv.
    // ':' and '/' are valid in a fragment; anything that is not is left out rather than escaped.
    var FRAGMENT_SAFE = /^[A-Za-z0-9._~:\/-]+$/;
    function fragmentOf(record, token) {
        var body = record.body, address = server();
        var parts = ['kadr=1', 'mode=' + body.mode, 'pos=' + body.start_position_ms, 'next=' + (record.next ? 1 : 0)];
        if (token && FRAGMENT_SAFE.test(token) && /^https?:\/\//.test(address) && FRAGMENT_SAFE.test(address)) {
            parts.push('pid=' + body.playback_id, 'tok=' + token, 'srv=' + address, 'dev=' + body.device_id);
            if (FRAGMENT_SAFE.test(body.content.content_id)) parts.push('cid=' + body.content.content_id);
        }
        if (body.content.episode_id) parts.push('eid=' + body.content.episode_id);
        return parts.join('&');
    }
    function nextOf(playlist, data, timelineHash) {
        if (!Array.isArray(playlist)) return null;
        var url = unmark(data.url);
        for (var i = 0; i < playlist.length - 1; i++) {
            var item = playlist[i] || {};
            var same = (timelineHash && item.timeline && String(item.timeline.hash) === timelineHash) || unmark(item.url) === url;
            if (same) {
                var next = playlist[i + 1];
                return next && typeof next.url === 'string' && next.url ? next : null;
            }
        }
        return null;
    }
    function adapterName(component) {
        return String(component || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32) || 'generic';
    }
    function qualityOf(data) {
        if (!data.quality || typeof data.quality !== 'object') return null;
        var names = Object.keys(data.quality);
        for (var i = 0; i < names.length; i++) {
            if (unmark(data.quality[names[i]]) === unmark(data.url)) return clean(names[i]).slice(0, 32) || null;
        }
        return null;
    }
    function sourceOf(data, component) {
        var adapter = adapterName(component), key = BALANSER_KEYS[adapter];
        var balanser = key ? clean(L.Storage.get(key, '')).slice(0, 64) : '';
        return {adapter: adapter, balanser: balanser || null, voice: data.voice_name ? clean(data.voice_name).slice(0, 120) : null,
            quality: qualityOf(data), ids: {}};
    }
    function wrapPlaylist() {
        var original = L.Player.playlist;
        if (typeof original !== 'function' || original.__sled) return;
        var wrapped = function (list) {
            captured = Array.isArray(list) ? list : null;
            return original.apply(this, arguments);
        };
        wrapped.__sled = true;
        L.Player.playlist = wrapped;
    }
    function external() {
        var player = L.Storage.field ? L.Storage.field('player') : L.Storage.get('player');
        return player === 'android' && !!(L.Platform && L.Platform.is && L.Platform.is('android'));
    }
    function onCreate(event) {
        var data = event && event.data;
        if (!data || data.__kadr || data.iptv || !enabled() || !external()) return;
        var activity = L.Activity.active(), card = activity && (activity.movie || activity.card);
        var content = identify(card, data);
        if (!content) return;
        event.abort();
        captured = null;
        setTimeout(function () { prepare(data, card, content, activity.component); }, 0);
    }
    function wanted(content) {
        var want = intent && now() - intent.at < INTENT_TTL_MS
            && ((intent.item_key && intent.item_key === content.item_key) || (intent.hash && intent.hash === content.hash)) ? intent.mode : null;
        intent = null;
        return want;
    }
    function prepare(data, card, content, component) {
        var playlist = captured;
        captured = null;
        var item = load().items[content.item_key];
        var resumable = item && !item.deleted && item.status === 'in_progress' && item.position_ms >= RESUME_MIN_MS ? item : null;
        var info = {data: data, content: content, playlist: playlist, component: component,
            revision: item ? item.revision : 0, duration_ms: item ? item.duration_ms : null};
        var want = wanted(content);
        if (want === 'start' || !resumable) return launch(info, null);
        if (want === 'resume' || want === 'auto') return launch(info, resumable);
        L.Select.show({
            title: content.meta.title + (content.episode_id ? ' · ' + content.season + ' сезон, ' + content.episode + ' серия' : ''),
            items: [{title: 'Продолжить с ' + clock(resumable.position_ms), resume: true}, {title: 'Сначала', resume: false}],
            onSelect: function (choice) { L.Controller.toggle('content'); launch(info, choice.resume ? resumable : null); },
            onBack: function () { L.Controller.toggle('content'); }
        });
    }
    function launch(info, resume) {
        var content = info.content, next = nextOf(info.playlist, info.data, content.hash), source = sourceOf(info.data, info.component);
        var body = {playback_id: uid('pb'), device_id: deviceId(), mode: resume ? 'resume' : 'start',
            start_position_ms: resume ? Math.max(0, resume.position_ms - REWIND_MS) : 0, base_revision: info.revision || 0,
            has_next: !!next, source: source,
            content: {content_id: content.content_id, episode_id: content.episode_id, season: content.season,
                episode: content.episode, meta: content.meta}};
        var record = {playback_id: body.playback_id, hash: content.hash, item_key: content.item_key, body: body, next: next,
            playlist: info.playlist, duration_ms: info.duration_ms, started: now(), registered: false};
        if (!activeProfile() || !server()) return handOver(record, info.data, null);
        enqueue({type: 'prefs', content_id: content.content_id, prefs: source});
        api('/v1/playbacks', body, function (answer) {
            handOver(record, info.data, answer && typeof answer.launch_token === 'string' ? answer.launch_token : null);
        }, function () { handOver(record, info.data, null); });
    }
    function handOver(record, data, token) {
        var fragment = fragmentOf(record, token);
        data.url = mark(data.url, fragment);
        if (data.quality && typeof data.quality === 'object') {
            Object.keys(data.quality).forEach(function (name) { data.quality[name] = mark(data.quality[name], fragment); });
        }
        data.__kadr = true;
        record.registered = !!token;
        pending = record;
        put('pending', {playback_id: record.playback_id, hash: record.hash, item_key: record.item_key, body: record.body,
            registered: record.registered, duration_ms: record.duration_ms, started: record.started});
        L.Player.play(data);
        if (record.playlist) L.Player.playlist(record.playlist);
        captured = null;
    }

    // ==== return ====
    function onTimeline(event) {
        var data = event && event.data || {};
        var record = pending || get('pending', null);
        if (!record || !record.hash || String(data.hash) !== String(record.hash)) return;
        pending = null;
        put('pending', null);
        if (now() - record.started > PENDING_TTL_MS) return;
        var road = data.road || {}, completed = road.percent >= 100;
        reportFallback(record, road, completed);
        sync(function (state, error) { afterReturn(record, completed, state, error, 0); });
    }
    function reportFallback(record, road, completed) {
        if (!activeProfile() || !server()) return;
        var duration = road.duration > 0 ? Math.round(road.duration * 1000) : record.duration_ms;
        var position = completed ? duration : Math.round((road.time || 0) * 1000);
        if (!position || !duration) return;
        // Applied by the server only when KADR itself never reported this playback (sequence null).
        var progress = {type: 'progress', playback_id: record.playback_id, sequence: null, position_ms: position,
            duration_ms: duration, started: true};
        if (record.registered) return enqueue(progress);
        var state = load();
        state.deferred.push({body: record.body, progress: progress});
        if (state.deferred.length > 50) state.deferred = state.deferred.slice(-50);
        save(state);
    }
    function afterReturn(record, completed, state, error, round) {
        if (!completed || !record.next) return;
        if (error || !record.registered) return askNext(record);
        var playback = state.playbacks[record.playback_id];
        if (playback && playback.next_requested) return playNext(record);
        // KADR uploads in the background; give its next-episode event a moment to arrive.
        if (round === 0) {
            setTimeout(function () {
                sync(function (fresh, failure) { afterReturn(record, completed, fresh, failure, 1); });
            }, NEXT_RECHECK_MS);
        }
    }
    function askNext(record) {
        L.Select.show({title: 'Следующая серия?', items: [{title: 'Смотреть', play: true}, {title: 'Не сейчас', play: false}],
            onSelect: function (choice) { L.Controller.toggle('content'); if (choice.play) playNext(record); },
            onBack: function () { L.Controller.toggle('content'); }});
    }
    function copyItem(item) {
        var copy = {};
        Object.keys(item).forEach(function (key) { copy[key] = item[key]; });
        copy.url = unmark(copy.url);
        if (copy.quality && typeof copy.quality === 'object') {
            var quality = {};
            Object.keys(copy.quality).forEach(function (name) { quality[name] = unmark(copy.quality[name]); });
            copy.quality = quality;
        }
        delete copy.__kadr;
        return copy;
    }
    function playNext(record) {
        var item = copyItem(record.next);
        intent = {item_key: null, hash: item.timeline && item.timeline.hash ? String(item.timeline.hash) : null, mode: 'auto', at: now()};
        L.Player.play(item);
        if (record.playlist) L.Player.playlist(record.playlist);
    }

    // ==== history ====
    var LAST_BALANSER_KEYS = {online_mod: 'online_mod_last_balanser', showy_free: 'online_last_balanser'};
    function componentExists(name) {
        try { return !!(L.Component && L.Component.get && L.Component.get(name)); } catch (e) { return false; }
    }
    function seedBalanser(adapter, card, balanser) {
        if (!balanser) return;
        L.Storage.set(BALANSER_KEYS[adapter], balanser);
        var last = L.Storage.get(LAST_BALANSER_KEYS[adapter], {});
        if (!last || typeof last !== 'object' || Array.isArray(last)) last = {};
        last[card.id] = balanser;
        L.Storage.set(LAST_BALANSER_KEYS[adapter], last);
    }
    function searchActivity(card, component) {
        var title = card.title || card.name;
        return {url: '', title: title, component: component, search: title, search_one: title,
            search_two: card.original_title || card.original_name, movie: card, page: 1};
    }
    var OPENERS = {
        online_mod: function (card, prefs) {
            seedBalanser('online_mod', card, prefs.balanser);
            L.Activity.push(searchActivity(card, 'online_mod'));
        },
        showy_free: function (card, prefs) {
            seedBalanser('showy_free', card, prefs.balanser);
            var activity = searchActivity(card, 'showy_free');
            if (prefs.balanser) activity.balanser = prefs.balanser;
            L.Activity.push(activity);
        }
    };
    function open(card, item, mode) {
        var prefs = load().prefs[item.content_id] || item.source || {};
        intent = {item_key: item.item_key, hash: null, mode: mode === 'start' ? 'start' : 'resume', at: now()};
        var opener = OPENERS[prefs.adapter];
        if (opener && componentExists(prefs.adapter)) return opener(card, prefs);
        L.Activity.push({url: '', component: 'full', id: card.id, method: isTv(card) ? 'tv' : 'movie', card: card,
            source: card.source || 'tmdb'});
    }

    // ==== settings ====
    function param(name, type, title, description, value, onChange) {
        L.SettingsApi.addParam({component: 'sled',
            param: {name: 'sled_' + name, type: type, values: '', 'default': value, placeholder: ''},
            field: {name: title, description: description}, onChange: onChange});
    }
    function saveProfile() {
        var key = clean(get('profile_key', ''));
        if (!/^kadr_[A-Za-z0-9_-]{20,}$/.test(key)) return notify('Sled: вставьте ключ профиля, он начинается с kadr_');
        api('/v1/profile', null, function (profile) {
            var name = rememberProfile(profile.name, key);
            put('profile_key', '');
            notify('Sled: профиль «' + name + '» сохранён');
            sync();
        }, function (error) {
            put('profile_key', '');
            notify('Sled: сервер не принял ключ' + (error && error.status ? ' (код ' + error.status + ')' : ''));
        }, key);
    }
    function rememberProfile(rawName, key) {
        var name = String(rawName || 'Профиль');
        var list = profiles().filter(function (item) { return item.name !== name; });
        list.push({name: name, key: key});
        put('profiles', list);
        put('active', name);
        return name;
    }
    var pairingRun = 0;
    function stopPairing() { pairingRun++; }
    function closePairing() {
        if (L.Select.close) L.Select.close();
        L.Controller.toggle('settings_component');
    }
    function showPairing(run, pair) {
        L.Select.show({title: 'Привязка Sled', items: [
            {title: pair.code, subtitle: 'На компьютере с сервером: python -m kadr_sync.cli pair ' + pair.code + ' "Профиль"'},
            {title: 'Отмена', cancel: true}],
            onSelect: function (choice) {
                if (choice.cancel || run !== pairingRun) { stopPairing(); L.Controller.toggle('settings_component'); }
                else showPairing(run, pair);
            },
            onBack: function () { stopPairing(); L.Controller.toggle('settings_component'); }});
    }
    function pollPairing(run, pair, attempt) {
        setTimeout(function () {
            if (run !== pairingRun) return;
            if (attempt > PAIR_MAX_POLLS) { stopPairing(); closePairing(); return notify('Sled: код истёк, начните привязку заново'); }
            request('/v1/pair/poll', {poll_token: pair.poll_token}, null, function (answer) {
                if (run !== pairingRun) return;
                if (!answer || answer.status !== 'approved' || !answer.key) return pollPairing(run, pair, attempt + 1);
                stopPairing();
                var name = rememberProfile(answer.name, answer.key);
                closePairing();
                notify('Sled: устройство привязано к профилю «' + name + '»');
                sync();
            }, function (error) {
                if (run !== pairingRun) return;
                if (error && error.status === 404) { stopPairing(); closePairing(); return notify('Sled: код истёк, начните привязку заново'); }
                pollPairing(run, pair, attempt + 1);
            });
        }, PAIR_POLL_MS);
    }
    function pairDevice() {
        if (!server()) return notify('Sled: сначала укажите адрес сервера истории');
        var run = ++pairingRun;
        request('/v1/pair/start', {}, null, function (pair) {
            if (run !== pairingRun || !pair || !pair.code || !pair.poll_token) return;
            showPairing(run, pair);
            pollPairing(run, pair, 1);
        }, function (error) {
            notify('Sled: сервер не выдал код привязки' + (error && error.status ? ' (код ' + error.status + ')' : ''));
        });
    }
    function switchProfile() {
        var list = profiles(), current = activeProfile();
        if (!list.length) return notify('Sled: профилей нет. Добавьте ключ профиля.');
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
            notify('Sled: сервер доступен, профиль «' + profile.name + '», порог ' + threshold + '%');
        }, function (error) {
            if (error && error.error === 'not_configured') return notify('Sled: укажите адрес сервера и профиль');
            notify('Sled: сервер недоступен' + (error && error.status ? ' (код ' + error.status + ')' : ''));
        });
    }
    function addSettings() {
        if (!L.SettingsApi) return;
        L.SettingsApi.addComponent({component: 'sled', name: 'Sled',
            icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/></svg>'});
        param('enabled', 'trigger', 'Продолжение через KADR',
            'Перехватывать запуск во внешнем плеере Android: меню «Продолжить / Сначала», передача позиции и истории в KADR.', true);
        param('server', 'input', 'Адрес сервера истории', 'Например https://kadr.example.com', '');
        param('pair', 'button', 'Привязать по коду', 'Покажет код; подтвердите его командой pair на компьютере с сервером.', '', pairDevice);
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
        wrapPlaylist();
        L.Player.listener.follow('create', onCreate);
        L.Timeline.listener.follow('update', onTimeline);
        addSettings();
        sync();
    }
    KH.load = function () { return load(); };
    KH.sync = sync;
    KH.enqueue = enqueue;
    KH.clock = clock;
    KH.identify = identify;
    KH.open = open;
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
