/* Sled 0.3.0 | Lampa + KADR: resume, next episode and watch history sync.
 * The profile key stays in Lampa storage on this device; KADR receives only a per-playback token.
 */
(function () {
    'use strict';
    if (window.Sled) return;

    var L;
    var PAIR_POLL_MS = 3000, PAIR_MAX_POLLS = 220, REWIND_MS = 10000, RESUME_MIN_MS = 10000, PENDING_TTL_MS = 12 * 3600000, NEXT_RECHECK_MS = 3000, INTENT_TTL_MS = 30 * 60000;
    var SYNC_BEFORE_LAUNCH_MS = 2500, REGISTER_TIMEOUT_MS = 4000;
    var KH = window.Sled = {version: '0.3.0'};
    var syncing = false, waiting = [], captured = null, pending = null, intent = null;

    // ==== basics ====
    function get(name, fallback) { return L.Storage.get('sled_' + name, fallback); }
    function put(name, value) { L.Storage.set('sled_' + name, value); }
    function now() { return Date.now(); }
    function extend(target) {
        for (var i = 1; i < arguments.length; i++) for (var key in arguments[i]) target[key] = arguments[i][key];
        return target;
    }
    function clean(text) { return String(text == null ? '' : text).replace(/[​\s]+/g, ' ').replace(/^\s+|\s+$/g, ''); }
    function uid(prefix) {
        var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789', out = prefix;
        for (var i = 0; i < 20; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        return out;
    }
    function hash(text) { return String(L.Utils.hash(text)); }
    // Lampa renders notices and menu titles as HTML; names come from the server and from other devices.
    function escapeHtml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function notify(text) { if (L.Noty && L.Noty.show) L.Noty.show(escapeHtml(text)); }
    function show(params) {
        params.title = escapeHtml(params.title);
        params.items.forEach(function (item) {
            item.title = escapeHtml(item.title);
            if (item.subtitle) item.subtitle = escapeHtml(item.subtitle);
        });
        L.Select.show(params);
    }
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
    // The server refused the request itself; sending it again changes nothing. 401/403/404 are not here:
    // a revoked key or a wrong address is fixed in settings, and the queue must survive until then.
    function rejected(error) { var status = error && error.status; return status === 400 || status === 413 || status === 422; }

    // ==== server ====
    function api(path, body, ok, fail, key, timeout) {
        var profile = activeProfile(), secret = key || (profile && profile.key);
        if (!server() || !secret) { if (fail) fail({status: 0, error: 'not_configured'}); return; }
        request(path, body, secret, ok, fail, timeout);
    }
    function request(path, body, secret, ok, fail, timeout) {
        var headers = {};
        if (secret) headers.Authorization = 'Bearer ' + secret;
        if (body) headers['Content-Type'] = 'application/json';
        var call = new L.Reguest();
        call.timeout(timeout || 15000);
        call.native(server() + path, function (data) {
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { if (fail) fail({status: 0, error: 'bad_json'}); return; }
            }
            if (ok) ok(data || {});
        }, function (error) { if (fail) fail(error || {status: 0}); }, body ? JSON.stringify(body) : false, {headers: headers});
    }
    function stateKey() { var profile = activeProfile(); return profile ? 'state_' + hash(profile.key) : null; }
    function emptyState() {
        return {cursor: '', items: {}, prefs: {}, conflicts: {}, playbacks: {}, outbox: [], deferred: [], synced: 0, ratings: {}, offered: {}};
    }
    // A sync passes its own key: the viewer may switch profiles while it waits for the server.
    function load(key) {
        key = key || stateKey();
        var state = key ? get(key, null) : null;
        if (!state || typeof state !== 'object' || !state.items) return emptyState();
        if (!Array.isArray(state.outbox)) state.outbox = [];
        if (!Array.isArray(state.deferred)) state.deferred = [];
        if (!state.ratings || typeof state.ratings !== 'object') state.ratings = {};
        if (!state.offered || typeof state.offered !== 'object') state.offered = {};
        return state;
    }
    function save(state, key) { key = key || stateKey(); latestCache = null; if (key) put(key, state); }
    function merge(state, data) {
        // A delete still waiting in the queue wins over an older copy from the feed.
        var removing = {}, rating = {};
        state.outbox.forEach(function (event) {
            if (event.type === 'delete') removing[event.item_key] = true;
            if (event.type === 'rating' || event.type === 'rating_delete') rating[event.content_id] = true;
        });
        (data.items || []).forEach(function (item) {
            if (!item || !item.item_key) return;
            state.items[item.item_key] = removing[item.item_key] ? extend({}, item, {deleted: true}) : item;
        });
        (data.prefs || []).forEach(function (pref) { if (pref && pref.content_id) state.prefs[pref.content_id] = pref.prefs; });
        (data.conflicts || []).forEach(function (conflict) {
            if (!conflict || !conflict.id) return;
            if (conflict.status === 'open') state.conflicts[conflict.id] = conflict; else delete state.conflicts[conflict.id];
        });
        // A rating change still waiting in the queue is newer than any copy the feed can bring.
        (data.ratings || []).forEach(function (record) {
            if (record && record.content_id && !rating[record.content_id]) state.ratings[record.content_id] = record;
        });
        (data.playbacks || []).forEach(function (playback) { if (playback && playback.playback_id) state.playbacks[playback.playback_id] = playback; });
        if (data.cursor) state.cursor = data.cursor;
        state.synced = now();
    }
    function enqueue(event, key) {
        var state = load(key);
        event.event_id = event.event_id || uid('ev');
        event.device_id = deviceId();
        event.client_ms = now();
        state.outbox.push(event);
        if (state.outbox.length > 500) state.outbox = state.outbox.slice(-500);
        save(state, key);
    }
    function flushOutbox(run, done, size) {
        var batch = load(run.key).outbox.slice(0, size || 100), sent = {};
        if (!batch.length) return done();
        batch.forEach(function (event) { sent[event.event_id] = true; });
        // By id: events queued meanwhile may have pushed the sent ones out of the queue already.
        var forget = function () {
            var fresh = load(run.key);
            fresh.outbox = fresh.outbox.filter(function (event) { return !sent[event.event_id]; });
            save(fresh, run.key);
        };
        api('/v1/events', {events: batch}, function () {
            forget();
            flushOutbox(run, done, size);
        }, function (error) {
            if (!rejected(error)) return done();
            // One malformed event must not take the rest of the batch with it: retry them one by one.
            if (batch.length > 1) return flushOutbox(run, done, 1);
            forget();
            flushOutbox(run, done);
        }, run.secret);
    }
    function flushDeferred(run, done) {
        var job = load(run.key).deferred[0];
        if (!job) return done();
        var forget = function () { var fresh = load(run.key); fresh.deferred.shift(); save(fresh, run.key); };
        var registered = function () {
            forget();
            if (job.progress) enqueue(job.progress, run.key);
            flushDeferred(run, done);
        };
        api('/v1/playbacks', job.body, registered, function (error) {
            // 409: the first attempt reached the server after all, only its answer was lost.
            if (error && error.status === 409) return registered();
            if (!rejected(error)) return done();
            forget();
            flushDeferred(run, done);
        }, run.secret);
    }
    function pull(run, round, done) {
        var cursor = load(run.key).cursor;
        api('/v1/changes' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), null, function (data) {
            var state = load(run.key);
            merge(state, data);
            save(state, run.key);
            if (data.more && round < 20) pull(run, round + 1, done); else done(state, null);
        }, function (error) {
            // A cursor the server no longer accepts (a restored database, say) would fail every sync: start over.
            if (error && error.status === 400 && cursor && round < 20) {
                var reset = load(run.key);
                reset.cursor = '';
                save(reset, run.key);
                return pull(run, round + 1, done);
            }
            done(load(run.key), error || {status: 0});
        }, run.secret);
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
        var profile = activeProfile();
        if (!profile || !server()) return finishSync(load(), {status: 0, error: 'not_configured'});
        syncing = true;
        var run = {key: stateKey(), secret: profile.key};
        flushDeferred(run, function () {
            flushOutbox(run, function () {
                pull(run, 0, function (state, error) {
                    finishSync(state, error);
                    if (stateKey() !== run.key) sync();
                });
            });
        });
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
    // Without these KADR cannot report the playback, so the plugin has to ask about the next episode itself.
    function reportable(token) {
        var address = server();
        return !!token && FRAGMENT_SAFE.test(token) && /^https?:\/\//.test(address) && FRAGMENT_SAFE.test(address);
    }
    function fragmentOf(record, token) {
        var body = record.body;
        var parts = ['kadr=1', 'mode=' + body.mode, 'pos=' + body.start_position_ms, 'next=' + (record.next ? 1 : 0)];
        if (reportable(token)) {
            parts.push('pid=' + body.playback_id, 'tok=' + token, 'srv=' + server(), 'dev=' + body.device_id);
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
        var playlist = captured, started = false;
        captured = null;
        // Another device may have moved the position meanwhile; a slow server must not hold the player for long.
        var go = function () {
            if (started) return;
            started = true;
            var conflict = conflictFor(content.item_key);
            if (conflict) return resolveConflict(conflict, function () { decide(data, content, component, playlist); });
            decide(data, content, component, playlist);
        };
        setTimeout(go, SYNC_BEFORE_LAUNCH_MS);
        sync(go);
    }
    function decide(data, content, component, playlist) {
        var item = load().items[content.item_key];
        var resumable = item && !item.deleted && item.status === 'in_progress' && item.position_ms >= RESUME_MIN_MS ? item : null;
        var info = {data: data, content: content, playlist: playlist, component: component,
            revision: item ? item.revision : 0, duration_ms: item ? item.duration_ms : null};
        var want = wanted(content);
        if (want === 'start' || !resumable) return launch(info, null);
        if (want === 'resume' || want === 'auto') return launch(info, resumable);
        show({
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
        }, function () { handOver(record, info.data, null); }, null, REGISTER_TIMEOUT_MS);
    }
    function handOver(record, data, token) {
        var fragment = fragmentOf(record, token);
        data.url = mark(data.url, fragment);
        if (data.quality && typeof data.quality === 'object') {
            Object.keys(data.quality).forEach(function (name) { data.quality[name] = mark(data.quality[name], fragment); });
        }
        data.__kadr = true;
        record.registered = !!token;
        record.linked = reportable(token);
        pending = record;
        put('pending', {playback_id: record.playback_id, hash: record.hash, item_key: record.item_key, body: record.body,
            registered: record.registered, linked: record.linked, duration_ms: record.duration_ms, started: record.started});
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
        sync(function (state, error) {
            guarded(offerRating)(record, road, error);
            afterReturn(record, completed, state, error, 0);
        });
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
        if (error || !record.linked) return askNext(record);
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
        show({title: 'Следующая серия?', items: [{title: 'Смотреть', play: true}, {title: 'Не сейчас', play: false}],
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
        openFull(card);
    }
    function openFull(card) {
        L.Activity.push({url: '', component: 'full', id: card.id, method: isTv(card) ? 'tv' : 'movie', card: card,
            source: card.source || 'tmdb'});
    }

    // ==== ui: model ====
    // Every entry point reads the local profile state, so the interface works offline and shows one history.
    var SHELF_LIMIT = 20, PAGE_SIZE = 20;
    function newer(a, b) { return (a.server_ms || 0) - (b.server_ms || 0) || (a.client_ms || 0) - (b.client_ms || 0); }
    function visibleItems(state) {
        return Object.keys(state.items).map(function (key) { return state.items[key]; })
            .filter(function (item) { return item && !item.deleted; })
            .sort(function (a, b) { return newer(b, a); });
    }
    function latestByContent(state) {
        var seen = {};
        return visibleItems(state).filter(function (item) {
            if (seen[item.content_id]) return false;
            seen[item.content_id] = true;
            return true;
        });
    }
    // Same rule as the server's queries._on_shelf: a finished episode stays to offer the next one.
    function shelf(state) {
        return latestByContent(state || load()).filter(function (item) {
            return item.status === 'in_progress' ? item.position_ms > 0 : !!item.episode_id;
        }).slice(0, SHELF_LIMIT).map(function (item) { return {item: item, upNext: item.status === 'watched'}; });
    }
    function historyPage(state, mode, page) {
        var entries = mode === 'continue' ? shelf(state) : visibleItems(state).map(function (item) { return {item: item, upNext: false}; });
        page = Math.max(1, page || 1);
        return {page: page, total_pages: Math.ceil(entries.length / PAGE_SIZE),
            results: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(function (entry) { return cardOf(entry.item); })};
    }
    function cardOf(item) {
        var parts = String(item.content_id).split(':'), meta = item.meta || {}, tv = parts[1] === 'tv';
        var card = {id: /^\d+$/.test(parts[2]) ? Number(parts[2]) : parts[2], source: parts[0]};
        card[tv ? 'name' : 'title'] = meta.title;
        // original_name also marks the card as a series for identify(), so a series always gets one.
        if (tv) card.original_name = meta.original_title || meta.title;
        else if (meta.original_title) card.original_title = meta.original_title;
        if (meta.year) card[tv ? 'first_air_date' : 'release_date'] = meta.year + '-01-01';
        if (/^\//.test(meta.poster || '')) card.poster_path = meta.poster;
        else if (/^https?:\/\//.test(meta.poster || '')) card.poster = meta.poster;
        card.sled = {item_key: item.item_key};
        return card;
    }
    function progressOf(item) {
        if (item.status === 'watched') return 100;
        if (!item.duration_ms) return 0;
        return Math.min(100, Math.round(item.position_ms / item.duration_ms * 100));
    }
    function episodeCode(season, episode) { return 'S' + season + 'E' + episode; }
    function labelOf(item, upNext) {
        if (upNext) return 'Следующая: ' + episodeCode(item.season, item.episode + 1);
        var where = item.episode_id ? episodeCode(item.season, item.episode) + ' · ' : '';
        if (item.status === 'watched') return where + 'Просмотрено';
        return where + clock(item.position_ms) + (item.duration_ms ? ' из ' + clock(item.duration_ms) : '');
    }
    function awaitingSync(state) { return !!(state.outbox.length || state.deferred.length); }
    var UI_NAMES = {shelf: 'полки', menu: 'меню', card: 'кнопки в карточке', marks: 'отметок на постерах', history: 'истории'};
    function uiSupport() {
        var map = L.Maker && L.Maker.map && L.Maker.map('Card');
        return {shelf: !!(L.ContentRows && L.ContentRows.add), menu: !!(L.Menu && L.Menu.addButton),
            card: !!(L.Listener && L.Listener.follow), marks: !!(map && map.Card),
            history: !!(L.Api && L.Api.sources && L.Activity)};
    }
    function uiReport() {
        var support = uiSupport(), missing = Object.keys(UI_NAMES).filter(function (name) { return !support[name]; });
        return 'интерфейс: ' + (missing.length ? 'нет ' + missing.map(function (name) { return UI_NAMES[name]; }).join(', ') : 'всё подключено');
    }

    // ==== ui: actions ====
    function choose(title, items) {
        show({title: title, items: items,
            onSelect: function (choice) { L.Controller.toggle('content'); choice.run(); },
            onBack: function () { L.Controller.toggle('content'); }});
    }
    function titleOf(item) {
        var meta = item.meta || {};
        return (meta.title || item.content_id) + (item.episode_id ? ' · ' + item.season + ' сезон, ' + item.episode + ' серия' : '');
    }
    function nextEpisodeOf(item) {
        var episode = item.episode + 1;
        return {item_key: item.content_id + '/s' + item.season + 'e' + episode, content_id: item.content_id,
            season: item.season, episode: episode, source: item.source};
    }
    function changeItem(item, change, event) {
        var state = load(), current = state.items[item.item_key] || item;
        state.items[item.item_key] = extend({}, current, change);
        save(state);
        enqueue(event);
        sync();
    }
    function setStatus(item, status) {
        changeItem(item, {status: status === 'watched' ? 'watched' : 'in_progress', manual: true},
            {type: 'status', item_key: item.item_key, status: status});
    }
    function remove(item) { changeItem(item, {deleted: true}, {type: 'delete', item_key: item.item_key}); }
    function conflictFor(itemKey) {
        var conflicts = load().conflicts;
        for (var id in conflicts) {
            if (conflicts[id] && conflicts[id].status === 'open' && conflicts[id].item_key === itemKey) return conflicts[id];
        }
        return null;
    }
    function two(value) { return (value < 10 ? '0' : '') + value; }
    function when(ms) {
        var date = new Date(ms);
        return two(date.getDate()) + '.' + two(date.getMonth() + 1) + ' ' + two(date.getHours()) + ':' + two(date.getMinutes());
    }
    function optionTitle(option) {
        var device = option.device_id === deviceId() ? 'это устройство' : 'другое устройство (…' + String(option.device_id).slice(-4) + ')';
        return (option.status === 'watched' ? 'Просмотрено' : clock(option.position_ms)) + ' · ' + device + ' · ' + when(option.client_ms);
    }
    function errorBody(error) {
        try { return typeof error.responseText === 'string' ? JSON.parse(error.responseText) : error.responseJSON || null; }
        catch (e) { return null; }
    }
    // Both positions with their device and time; the server applies the choice to the version that was shown.
    function resolveConflict(conflict, done) {
        var items = [];
        ['current', 'playback'].forEach(function (choice) {
            var option = conflict.options && conflict.options[choice];
            if (option) items.push({title: optionTitle(option), run: function () { submit(choice); }});
        });
        function submit(choice) {
            api('/v1/conflicts/' + encodeURIComponent(conflict.id) + '/resolve', {version: conflict.version, choice: choice}, function (answer) {
                var state = load();
                if (answer.item && answer.item.item_key) state.items[answer.item.item_key] = answer.item;
                delete state.conflicts[conflict.id];
                save(state);
                sync();
                done(answer.item || null);
            }, function (error) {
                var body = error && error.status === 409 ? errorBody(error) : null, changed = body && body.error === 'conflict_changed' && body.conflict;
                // Resolved elsewhere (or gone): showing it again would loop, the feed brings the chosen position.
                if ((changed && changed.status !== 'open') || (error && error.status === 404)) {
                    var stale = load();
                    delete stale.conflicts[conflict.id];
                    save(stale);
                    notify('Sled: позиции уже выбраны на другом устройстве');
                    return sync(function () { done(null); });
                }
                if (changed) {
                    var state = load();
                    state.conflicts[conflict.id] = changed;
                    save(state);
                    notify('Sled: варианты изменились, выберите ещё раз');
                    return resolveConflict(changed, done);
                }
                notify('Sled: сервер недоступен, выбор не сохранён');
                done(null);
            });
        }
        choose('Позиции разошлись · ' + titleOf(conflict.options.current || conflict.options.playback), items);
    }
    function itemMenu(item, card, upNext) {
        card = card || cardOf(item);
        var items = [], conflict = conflictFor(item.item_key);
        if (conflict) {
            items.push({title: 'Позиции разошлись — выбрать', run: function () {
                resolveConflict(conflict, function (chosen) { itemMenu(chosen || load().items[item.item_key] || item, card, upNext); });
            }});
        }
        if (item.status === 'in_progress' && item.position_ms >= RESUME_MIN_MS) {
            items.push({title: 'Продолжить с ' + clock(item.position_ms), run: function () { open(card, item, 'resume'); }});
        }
        if (upNext) {
            items.push({title: 'Следующая серия · ' + episodeCode(item.season, item.episode + 1),
                run: function () { open(card, nextEpisodeOf(item), 'start'); }});
        } else {
            items.push({title: 'Сначала', run: function () { open(card, item, 'start'); }});
        }
        items.push({title: 'Выбрать источник', run: function () { openFull(card); }});
        items.push(item.status === 'watched'
            ? {title: 'Снять отметку «просмотрено»', run: function () { setStatus(item, 'unwatched'); }}
            : {title: 'Отметить просмотренным', run: function () { setStatus(item, 'watched'); }});
        items.push({title: 'Удалить из истории', run: function () {
            var name = (item.meta && item.meta.title || item.content_id) + (item.episode_id ? ' · ' + episodeCode(item.season, item.episode) : '');
            choose('Удалить «' + name + '» из истории?', [
                {title: 'Удалить', run: function () { remove(item); }},
                {title: 'Отмена', run: function () {}}]);
        }});
        choose(titleOf(item), items);
    }

    // ==== ratings ====
    // One score 1-10 and optional impressions per movie or whole series, keyed by content_id.
    function ratingOf(state, id) { var record = state.ratings[id]; return record && !record.deleted ? record : null; }
    function contentOf(card) { return {content_id: contentId(card), meta: metaOf(card)}; }
    function changeRating(id, record, event) {
        var state = load();
        state.ratings[id] = record;
        save(state);
        enqueue(event);
        sync();
    }
    function setRating(content, score, comment) {
        comment = comment ? String(comment).replace(/^\s+|\s+$/g, '').slice(0, 2000) : '';
        changeRating(content.content_id, {content_id: content.content_id, score: score, comment: comment || null, meta: content.meta,
            rated_ms: now(), device_id: deviceId(), deleted: false},
            {type: 'rating', content_id: content.content_id, score: score, comment: comment || null, meta: content.meta});
    }
    function removeRating(id) {
        var current = load().ratings[id] || {content_id: id, meta: {}};
        changeRating(id, extend({}, current, {score: null, comment: null, rated_ms: now(), deleted: true}),
            {type: 'rating_delete', content_id: id});
    }
    function ratedList(state) {
        return Object.keys(state.ratings).map(function (id) { return state.ratings[id]; })
            .filter(function (record) { return record && !record.deleted; })
            .sort(function (a, b) { return (b.rated_ms || 0) - (a.rated_ms || 0); });
    }
    function ratingPage(state, page) {
        var list = ratedList(state);
        page = Math.max(1, page || 1);
        return {page: page, total_pages: Math.ceil(list.length / PAGE_SIZE),
            results: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(function (record) {
                var card = cardOf(record), name = card.name ? 'name' : 'title';
                card[name] = card[name] + ' · ★ ' + record.score;
                card.sled = {content_id: record.content_id};
                return card;
            })};
    }

    function ratingTitle(content) { return (content.meta && content.meta.title) || content.content_id; }
    function pickScore(content, done, title, extra) {
        var items = [];
        for (var score = 10; score >= 1; score--) {
            items.push({title: '★ ' + score, run: (function (value) {
                return function () {
                    var current = ratingOf(load(), content.content_id);
                    setRating(content, value, current && current.comment);
                    if (done) done(value);
                };
            }(score))});
        }
        choose(title || 'Оценка · ' + ratingTitle(content), items.concat(extra || []));
    }
    function canComment() { return !!(L.Input && L.Input.edit); }
    function editComment(content, done) {
        var current = ratingOf(load(), content.content_id);
        if (!current) return;
        L.Input.edit({title: 'Впечатления', value: current.comment || '', free: true, nosave: true}, function (text) {
            var fresh = ratingOf(load(), content.content_id);
            if (fresh) setRating(content, fresh.score, text);
            if (done) done();
        });
    }
    // After a finished movie (not an episode), once per movie, unless it already has a score.
    var RATE_PERCENT = 95;
    function offerRating(record, road, error) {
        var content = record.body && record.body.content, state = load();
        if (!content || content.episode_id || ratingOf(state, content.content_id) || state.offered[content.content_id]) return;
        // The server marks the movie watched by the profile's threshold; offline the timeline is all there is.
        var item = state.items[record.item_key];
        var finished = error ? (road.percent || 0) >= RATE_PERCENT : !!(item && !item.deleted && item.status === 'watched');
        if (!finished) return;
        state.offered[content.content_id] = true;
        save(state);
        var rated = {content_id: content.content_id, meta: content.meta};
        pickScore(rated, function (score) {
            var next = [{title: 'Готово', run: function () {}}];
            if (canComment()) next.unshift({title: 'Добавить впечатления', run: function () { editComment(rated); }});
            choose('Оценка сохранена · ★ ' + score, next);
        }, 'Оценить «' + ratingTitle(rated) + '»?', [{title: 'Не сейчас', run: function () {}}]);
    }
    // changed() lets the caller refresh what it shows (the card button) after any edit.
    function ratingMenu(content, card, extra, changed) {
        var current = ratingOf(load(), content.content_id), items = [];
        changed = changed || function () {};
        if (!current) {
            items.push({title: 'Поставить оценку', run: function () { pickScore(content, changed); }});
        } else {
            items.push({title: 'Изменить оценку (★ ' + current.score + ')', run: function () { pickScore(content, changed); }});
            if (canComment()) {
                items.push({title: current.comment ? 'Впечатления' : 'Добавить впечатления', run: function () { editComment(content, changed); }});
            }
            items.push({title: 'Удалить оценку', run: function () {
                choose('Удалить оценку «' + ratingTitle(content) + '»?', [
                    {title: 'Удалить', run: function () { removeRating(content.content_id); changed(); }},
                    {title: 'Отмена', run: function () {}}]);
            }});
        }
        choose('Оценка · ' + ratingTitle(content), items.concat(extra || []));
    }

    // ==== ui: lampa ====
    // Each entry point hooks into Lampa on its own; a failure in one never breaks Lampa or the others.
    function guarded(fn) {
        return function () {
            try { return fn.apply(this, arguments); } catch (e) { if (window.console) console.log('Sled', 'ui error', e && e.message); }
        };
    }
    function waitingSuffix(state) { return awaitingSync(state) ? ' · ждёт синхронизации' : ''; }
    function enterable(card, item, upNext) {
        card.params = {emit: {onlyEnter: guarded(function () { itemMenu(item, card, upNext); })}};
        return card;
    }
    function addShelf() {
        L.ContentRows.add({name: 'sled_continue', title: 'Продолжить просмотр (Sled)', index: 0, screen: ['main'],
            call: guarded(function () {
                var state = load(), entries = shelf(state);
                if (!entries.length) return;
                return function (call) {
                    call({title: 'Продолжить просмотр' + waitingSuffix(state), results: entries.map(function (entry) {
                        return enterable(cardOf(entry.item), entry.item, entry.upNext);
                    })});
                };
            })});
    }

    var HISTORY_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    var HISTORY_TITLES = {continue: 'Продолжить просмотр', all: 'Вся история', rated: 'Мои оценки'};
    function addHistory() {
        // category_full asks Api.sources[source].list for each page; the pages come from local state.
        L.Api.sources.sled = {list: guarded(function (params, oncomplite, onerror) {
            var state = load();
            if (params.url === 'rated') return ratedScreen(state, params, oncomplite, onerror);
            var mode = params.url === 'continue' ? 'continue' : 'all';
            var page = historyPage(state, mode, params.page);
            if (!page.results.length) return onerror();
            page.results.forEach(function (card) {
                var item = state.items[card.sled.item_key];
                if (mode === 'all' && item.episode_id) card.name = card.name + ' · ' + episodeCode(item.season, item.episode);
                enterable(card, item, mode === 'continue' && item.status === 'watched');
            });
            oncomplite(page);
        })};
        L.Menu.addButton(HISTORY_ICON, 'История', guarded(function () {
            var suffix = waitingSuffix(load());
            choose('История Sled', ['continue', 'all', 'rated'].map(function (mode) {
                return {title: HISTORY_TITLES[mode], run: function () {
                    L.Activity.push({url: mode, title: HISTORY_TITLES[mode] + suffix, component: 'category_full', source: 'sled', page: 1});
                }};
            }));
        }));
    }

    function ratedScreen(state, params, oncomplite, onerror) {
        var page = ratingPage(state, params.page);
        if (!page.results.length) return onerror();
        page.results.forEach(function (card) {
            var record = state.ratings[card.sled.content_id];
            card.params = {emit: {onlyEnter: guarded(function () {
                ratingMenu(record, card, [{title: 'Открыть карточку', run: function () { openFull(cardOf(record)); }}]);
            })}};
        });
        oncomplite(page);
    }

    var MARK_STYLE = '.sled-mark{position:absolute;left:0;right:0;bottom:0;height:.3em;background:rgba(0,0,0,.5);z-index:2}'
        + '.sled-mark__bar{height:100%;background:#ffc107}'
        + '.sled-mark--watched{left:auto;right:.4em;bottom:auto;top:.4em;width:1.6em;height:1.6em;border-radius:50%;'
        + 'background:#ffc107;color:#000;font-size:1em;line-height:1.6em;text-align:center}'
        // Same size as the catalog-ratings badge, which sits at the bottom right.
        + '.sled-score{position:absolute;left:.35em;top:.35em;z-index:5;font-size:1.17em;line-height:1.15;font-weight:700;'
        + 'border-radius:.25em;padding:.28em .42em;background:rgba(0,0,0,.6);color:#ffc107;pointer-events:none}';
    // Lampa passes jQuery in the full card event and native elements in card modules.
    function one(root, selector) {
        if (!root) return null;
        if (root.jquery) return root.find(selector)[0] || null;
        return root.querySelector ? root.querySelector(selector) : null;
    }
    function element(tag, className, text) {
        var node = document.createElement(tag);
        node.className = className;
        if (text) node.textContent = text;
        return node;
    }
    function onEnter(node, fn) {
        if (window.$) window.$(node).on('hover:enter', fn); else node.addEventListener('hover:enter', fn);
    }
    // Every poster asks for its record; reading and sorting the whole profile state per card is too slow on a TV.
    var latestCache = null;
    function latestFor(id) {
        var key = stateKey();
        if (!latestCache || latestCache.key !== key) {
            var index = {}, state = load(), scores = {};
            latestByContent(state).forEach(function (item) { index[item.content_id] = item; });
            ratedList(state).forEach(function (record) { scores[record.content_id] = record.score; });
            latestCache = {key: key, index: index, scores: scores};
        }
        return latestCache.index.hasOwnProperty(id) ? latestCache.index[id] : null;
    }
    function scoreFor(id) {
        latestFor(id);
        return latestCache.scores.hasOwnProperty(id) ? latestCache.scores[id] : null;
    }
    function entryFor(card) {
        if (!card || card.id === undefined || card.id === null || card.id === '') return null;
        var item = latestFor(contentId(card));
        return item ? {item: item, upNext: item.status === 'watched' && !!item.episode_id} : null;
    }
    function addCardButton() {
        L.Listener.follow('full', guarded(function (event) {
            if (!event || event.type !== 'complite') return;
            var movie = event.data && event.data.movie, entry = entryFor(movie);
            var box = one(event.body, '.full-start-new__buttons') || one(event.body, '.full-start__buttons');
            if (!box || !movie || movie.id === undefined || movie.id === null || movie.id === '') return;
            if (entry && !one(box, '.sled-button')) {
                var button = element('div', 'full-start__button selector sled-button', 'Sled · ' + labelOf(entry.item, entry.upNext));
                onEnter(button, guarded(function () { itemMenu(entry.item, movie, entry.upNext); }));
                box.appendChild(button);
            }
            if (!one(box, '.sled-rate')) addRateButton(box, movie);
        }));
    }
    // Any movie or series can be rated, with or without watch history.
    function addRateButton(box, movie) {
        var content = contentOf(movie), button = element('div', 'full-start__button selector sled-rate');
        var label = function () {
            var current = ratingOf(load(), content.content_id);
            button.textContent = current ? '★ ' + current.score : 'Оценить';
        };
        label();
        onEnter(button, guarded(function () { ratingMenu(content, movie, null, label); }));
        box.appendChild(button);
    }
    function paintMark(mark, item) {
        var watched = item.status === 'watched' && !item.episode_id;
        mark.className = 'sled-mark' + (watched ? ' sled-mark--watched' : '');
        mark.textContent = watched ? '✓' : '';
        if (!watched) {
            var bar = element('div', 'sled-mark__bar');
            bar.style.width = progressOf(item) + '%';
            mark.appendChild(bar);
        }
    }
    function scoreBadge(id, value) {
        var badge = element('div', 'sled-score', '★ ' + value);
        badge.setAttribute('data-sled-score', id);
        return badge;
    }
    function drawScore(card) {
        var data = card.data;
        if (!data || data.id === undefined || data.id === null || data.id === '') return;
        var id = contentId(data), value = scoreFor(id), view = value && one(card.html, '.card__view');
        if (view) view.appendChild(scoreBadge(id, value));
    }
    function drawMark(card) {
        var entry = entryFor(card.data), view = entry && one(card.html, '.card__view');
        if (!view) return;
        var mark = element('div', 'sled-mark');
        mark.setAttribute('data-sled', entry.item.content_id);
        paintMark(mark, entry.item);
        view.appendChild(mark);
    }
    function refreshMarks() {
        var marks = document.querySelectorAll('.sled-mark');
        for (var i = 0; i < marks.length; i++) {
            var mark = marks[i], item = latestFor(mark.getAttribute('data-sled'));
            if (!item) { mark.remove(); continue; }
            var fresh = element('div', 'sled-mark');
            fresh.setAttribute('data-sled', item.content_id);
            paintMark(fresh, item);
            mark.parentNode.appendChild(fresh);
            mark.remove();
        }
        var badges = document.querySelectorAll('.sled-score');
        for (var j = 0; j < badges.length; j++) {
            var badge = badges[j], id = badge.getAttribute('data-sled-score'), value = scoreFor(id);
            if (value) badge.parentNode.appendChild(scoreBadge(id, value));
            badge.remove();
        }
    }
    // Card modules are read from this map whenever Lampa creates a card, so wrapping it reaches every poster.
    function addPosterMarks() {
        var module = L.Maker.map('Card').Card, original = module.onCreate;
        if (original && original.__sled) return;
        var draw = guarded(drawMark), score = guarded(drawScore);
        var wrapped = function () {
            var result = original ? original.apply(this, arguments) : undefined;
            draw(this);
            score(this);
            return result;
        };
        wrapped.__sled = true;
        module.onCreate = wrapped;
        if (!document.getElementById('sled-style')) {
            var style = document.createElement('style');
            style.id = 'sled-style';
            style.textContent = MARK_STYLE;
            document.head.appendChild(style);
        }
        L.Listener.follow('sled', guarded(function (event) { if (event && event.type === 'synced') { latestCache = null; refreshMarks(); } }));
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
        show({title: 'Привязка Sled', items: [
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
        show({title: 'Профиль KADR', items: items, onSelect: function (choice) {
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
            notify('Sled: сервер доступен, профиль «' + profile.name + '», порог ' + threshold + '%, ' + uiReport());
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
        var support = uiSupport();
        if (support.shelf) guarded(addShelf)();
        if (support.history && support.menu) guarded(addHistory)();
        if (support.card) guarded(addCardButton)();
        if (support.marks) guarded(addPosterMarks)();
        sync();
    }
    KH.load = function () { return load(); };
    KH.sync = sync;
    KH.enqueue = enqueue;
    KH.clock = clock;
    KH.identify = identify;
    KH.open = open;
    KH.shelf = function () { return shelf(load()); };
    KH.historyPage = function (mode, page) { return historyPage(load(), mode, page); };
    KH.cardOf = cardOf;
    KH.progressOf = progressOf;
    KH.labelOf = labelOf;
    KH.pending = awaitingSync;
    KH.itemMenu = itemMenu;
    KH.ratings = function () { return ratedList(load()); };
    KH.ratingPage = function (page) { return ratingPage(load(), page); };
    KH.rate = setRating;
    KH.unrate = removeRating;
    if (window.appready) start();
    else if (window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
}());
