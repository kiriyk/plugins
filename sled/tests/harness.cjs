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


// Just enough DOM for the plugin's card button and poster marks: class selectors (".a" or ".a .b"),
// attributes, events. "$" mimics the jQuery calls the plugin and Lampa's full card use.
class FakeElement {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.textContent = ''; this.style = {};
        this.children = []; this.attributes = {}; this.listeners = {}; this.parentNode = null; }
    get classList() {
        const el = this, names = () => el.className.split(/\s+/).filter(Boolean);
        return {contains: name => names().includes(name), add: (...add) => { el.className = [...new Set([...names(), ...add])].join(' '); },
            remove: (...gone) => { el.className = names().filter(n => !gone.includes(n)).join(' '); },
            toggle: (name, on) => { if (on) el.classList.add(name); else el.classList.remove(name); }};
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name) { (this.listeners[name] || []).forEach(fn => fn({type: name})); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll(selector) {
        const chain = selector.trim().split(/\s+/).map(part => part.replace(/^\./, ''));
        const matches = (el, i) => el.classList.contains(chain[i]);
        const walk = (roots, i) => {
            const found = roots.flatMap(root => root.descendants().filter(el => matches(el, i)));
            return i === chain.length - 1 ? found : walk(found, i + 1);
        };
        return [...new Set(walk([this], 0))];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function fakeDocument() {
    const body = new FakeElement('body'), head = new FakeElement('head');
    return {body, head, createElement: tag => new FakeElement(tag), getElementById: id => head.children.find(el => el.id === id) || null,
        querySelectorAll: selector => body.querySelectorAll(selector)};
}
function fakeJquery(target) {
    const list = Array.isArray(target) ? target : target ? [target] : [];
    const wrapped = {jquery: '3-fake', length: list.length,
        find: selector => fakeJquery(list.flatMap(el => el.querySelectorAll(selector))),
        on: (name, fn) => { list.forEach(el => el.addEventListener(name, fn)); return wrapped; },
        trigger: name => { list.forEach(el => el.dispatch(name)); return wrapped; },
        append: child => { list[0].appendChild(child.jquery ? child[0] : child); return wrapped; }};
    list.forEach((el, i) => { wrapped[i] = el; });
    return wrapped;
}

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
    const sent = [], played = [], playlists = [], selects = [], notices = [], params = [], pushes = [], inputs = [];
    let closed = 0, cardCreated = 0;
    const delay = ms => options.maxDelay === undefined ? ms : Math.min(ms || 0, options.maxDelay);
    const routes = Object.assign({
        'GET /v1/changes': () => ({json: {cursor: 'c0', more: false, items: [], conflicts: [], prefs: [], playbacks: []}}),
        'POST /v1/playbacks': req => ({json: {playback_id: req.body.playback_id, item_key: 'x', launch_token: 'kadrl_' + 't'.repeat(32),
            expires_ms: 1, item_revision: 0, replay: false}}),
        'POST /v1/events': req => ({json: {results: req.body.events.map(e => ({event_id: e.event_id, status: 'applied'}))}}),
        'GET /v1/profile': () => ({json: {name: 'A', settings: {watched_threshold: 95}}}),
    }, options.routes);
    const player = listener(), timeline = listener(), events = listener();
    const rows = [], buttons = [], cardMap = {Card: {onCreate() { cardCreated++; }}}, sources = {};
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
        Select: {show(params) { selects.push(params); }, close() { closed++; }},
        Controller: {toggle() {}},
        Noty: {show: message => notices.push(message)},
        Input: {edit(params, done) { inputs.push({params, done}); }},
        Platform: {is: name => name === 'android'},
        SettingsApi: {addComponent() {}, addParam(param) { params.push(param); }},
        Listener: events,
        ContentRows: {add(row) { rows.push(row); }},
        Menu: {addButton(icon, title, action) { buttons.push({icon, title, action}); }},
        Maker: {map: name => name === 'Card' ? cardMap : {}},
        Api: {sources},
        Component: {get: name => ['online_mod', 'showy_free'].includes(name) ? {} : undefined},
        Reguest: function () {
            let limit = null;
            this.timeout = ms => { limit = ms; };
            this.native = (url, ok, fail, body, settings) => {
                const parsed = new URL(url), method = body ? 'POST' : 'GET';
                // A server address may carry a path prefix (a reverse proxy); routes are relative to it.
                const prefix = new URL(storage.sled_server || 'https://kadr.test').pathname.replace(/\/+$/, '');
                const pathname = parsed.pathname.slice(prefix.length);
                const request = {method, path: pathname, query: parsed.search, body: body ? JSON.parse(body) : null,
                    headers: (settings && settings.headers) || {}, timeout: limit};
                sent.push(request);
                const handler = routes[method + ' ' + pathname];
                setTimeout(() => {
                    if (!handler) return fail({status: 0});
                    const answer = handler(request);
                    if (answer.hang) return;
                    if ((answer.status || 200) === 200) ok(answer.raw !== undefined ? answer.raw : answer.json);
                    // Lampa hands the error body over as text; the plugin parses it when it needs the details.
                    else fail({status: answer.status, responseText: answer.json ? JSON.stringify(answer.json) : ''});
                }, 0);
            };
        },
    };
    (options.missing || []).forEach(name => { delete Lampa[name]; });
    const document = fakeDocument();
    const window = {Lampa, appready: true, document, $: fakeJquery};
    vm.runInContext(code, vm.createContext({window, Lampa, console, setTimeout: (fn, ms) => setTimeout(fn, delay(ms)), clearTimeout, Date, JSON, Math, Object, Array,
        String, Number, encodeURIComponent, decodeURIComponent, parseInt, document, $: fakeJquery}));
    return {
        Lampa, KH: window.Sled, storage, sent, routes, played, playlists, selects, notices, params, pushes, KEY,
        rows, buttons, cardMap, sources, events, document, inputs, $: fakeJquery, FakeElement,
        get closed() { return closed; },
        get cardCreated() { return cardCreated; },
        launched: () => played.filter(call => !call.aborted).map(call => call.data),
        press: name => params.find(p => p.param.name === name).onChange(),
        returned: (value, road) => timeline.send('update', {data: {hash: value, road}}),
        state: () => { const key = Object.keys(storage).find(k => k.startsWith('sled_state_')); return key ? storage[key] : null; },
    };
}

// Profile state of the default profile, for seeding history: setup({storage: {[STATE]: {...}}}).
const STATE = 'sled_state_' + hash(KEY);

module.exports = {setup, tick, hash, episodeHash, RICK, MOVIE, KEY, STATE};
