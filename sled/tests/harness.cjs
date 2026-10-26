// Lampa 3.x contracts used by the plugin: Player.listener 'create' with abort(), Player.play/playlist,
// Timeline.listener 'update' {data: {hash, road}}, Activity.active/push, Select.show, SettingsApi,
// Reguest().native(url, ok, fail, body, {headers}), Utils.hash, Component.get.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '../sled.js');
const KEY = 'kadr_' + 'a'.repeat(43);
const RICK = {id: 60625, source: 'tmdb', title: 'Рик и Морти', name: 'Рик и Морти', original_name: 'Rick and Morty',
    number_of_seasons: 9, poster_path: '/rm.jpg', first_air_date: '2013-12-02'};
const MOVIE = {id: 1400940, source: 'tmdb', title: 'Клэйфейс', original_title: 'Clayface', poster_path: '/c.jpg',
    release_date: '2026-09-11'};

function hash(input) {
    const text = String(input);
    let value = 0;
    for (let i = 0; i < text.length; i++) {
        value = (value << 5) - value + text.charCodeAt(i);
        value = value & value;
    }
    return String(Math.abs(value));
}
const episodeHash = (season, episode, title) => hash([season, season > 10 ? ':' : '', episode, title].join(''));
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms + 5));

function listener() {
    const map = {};
    return {follow(name, fn) { (map[name] = map[name] || []).push(fn); },
            send(name, event) { (map[name] || []).forEach(fn => fn(event)); }};
}

function setup(options = {}) {
    const code = fs.readFileSync(FILE, 'utf8');
    const storage = {player: 'android', sled_server: 'https://kadr.test', sled_profiles: [{name: 'A', key: KEY}], sled_active: 'A',
        ...options.storage};
    if (options.noProfile) { delete storage.sled_profiles; delete storage.sled_active; }
    const sent = [], played = [], playlists = [], selects = [], notices = [], params = [], pushes = [];
    const routes = Object.assign({
        'GET /v1/changes': () => ({json: {cursor: 'c0', more: false, items: [], conflicts: [], prefs: [], playbacks: []}}),
        'POST /v1/playbacks': req => ({json: {playback_id: req.body.playback_id, item_key: 'x', launch_token: 'kadrl_' + 't'.repeat(32),
            expires_ms: 1, item_revision: 0, replay: false}}),
        'POST /v1/events': req => ({json: {results: req.body.events.map(e => ({event_id: e.event_id, status: 'applied'}))}}),
        'GET /v1/profile': () => ({json: {name: 'A', settings: {watched_threshold: 95}}}),
    }, options.routes);
    const player = listener(), timeline = listener();
    const activity = options.activity === undefined ? {component: 'online_mod', movie: RICK} : options.activity;
    const Lampa = {
        Storage: {get: (key, fallback) => key in storage ? storage[key] : fallback,
                  set: (key, value) => { storage[key] = value === undefined ? value : JSON.parse(JSON.stringify(value)); },
                  field: key => storage[key]},
        Utils: {hash},
        Player: {listener: player,
                 play(data) { const call = {data, aborted: false}; played.push(call);
                              player.send('create', {data, abort() { call.aborted = true; }}); },
                 playlist(list) { playlists.push(list); }},
        Timeline: {listener: timeline},
        Activity: {active: () => activity, push(params) { pushes.push(params); }},
        Select: {show(params) { selects.push(params); }},
        Controller: {toggle() {}},
        Noty: {show: message => notices.push(message)},
        Platform: {is: name => name === 'android'},
        SettingsApi: {addComponent() {}, addParam(param) { params.push(param); }},
        Listener: {follow() {}, send() {}},
        Component: {get: name => ['online_mod', 'showy_free'].includes(name) ? {} : undefined},
        Reguest: function () {
            this.timeout = () => {};
            this.native = (url, ok, fail, body, settings) => {
                const parsed = new URL(url), method = body ? 'POST' : 'GET';
                const request = {method, path: parsed.pathname, query: parsed.search, body: body ? JSON.parse(body) : null,
                    headers: (settings && settings.headers) || {}};
                sent.push(request);
                const handler = routes[method + ' ' + parsed.pathname];
                setTimeout(() => {
                    if (!handler) return fail({status: 0});
                    const answer = handler(request);
                    if ((answer.status || 200) === 200) ok(answer.raw !== undefined ? answer.raw : answer.json);
                    else fail({status: answer.status});
                }, 0);
            };
        },
    };
    const window = {Lampa, appready: true};
    vm.runInContext(code, vm.createContext({window, Lampa, console, setTimeout, clearTimeout, Date, JSON, Math, Object, Array,
        String, Number, encodeURIComponent, decodeURIComponent, parseInt}));
    return {
        Lampa, KH: window.Sled, storage, sent, routes, played, playlists, selects, notices, params, pushes, KEY,
        launched: () => played.filter(call => !call.aborted).map(call => call.data),
        press: name => params.find(p => p.param.name === name).onChange(),
        returned: (value, road) => timeline.send('update', {data: {hash: value, road}}),
        state: () => { const key = Object.keys(storage).find(k => k.startsWith('sled_state_')); return key ? storage[key] : null; },
    };
}

module.exports = {setup, tick, hash, episodeHash, RICK, MOVIE, KEY};
