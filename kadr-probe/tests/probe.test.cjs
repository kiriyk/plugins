const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../kadr-probe.js');
const code = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';

function listener() {
    const map = {};
    return {follow(name, fn) {(map[name] = map[name] || []).push(fn);},
            send(name, event) {(map[name] || []).forEach(fn => fn(event));}};
}

function setup(t, options = {}) {
    const storage = {...options.storage};
    const playlists = [], params = [], notices = [], sent = [];
    const Lampa = {
        Storage: {get: (key, fallback) => key in storage ? storage[key] : fallback,
                  set: (key, value) => {storage[key] = value;},
                  field: key => storage[key]},
        Player: {listener: listener(), playlist(list) {playlists.push(list);}},
        Timeline: {listener: listener()},
        Activity: {active: () => options.activity || {component: 'online_mod', movie: {
            id: 1399, source: 'tmdb', original_name: 'Game of Thrones', number_of_seasons: 8, overview: 'long text'}}},
        SettingsApi: {addComponent() {}, addParam(p) {params.push(p);}},
        Noty: {show: message => notices.push(message)},
        Platform: {is: name => name === 'android'},
        Listener: {follow() {}},
        Reguest: function () {
            this.timeout = () => {};
            this.native = (url, ok, fail, body) => {
                sent.push({url, body: JSON.parse(body)});
                if (options.sendError) fail({status: 0}); else ok({ok: true});
            };
        },
    };
    const window = {Lampa, appready: true};
    const context = vm.createContext({window, Lampa, console: {log() {}}, Date, JSON, Object, Array, String});
    vm.runInContext(code, context);
    const press = name => params.find(p => p.param.name === name).onChange();
    return {Lampa, storage, playlists, params, notices, sent, press, log: () => storage.kadr_probe_log};
}

test('create is logged with masked url, header values and trimmed card', t => {
    const h = setup(t, {storage: {player: 'android', player_timecode: 'continue'}});
    h.Lampa.Player.listener.send('create', {data: {
        url: 'https://cdn.example.com/hls/abc/index.m3u8?token=SECRET123', title: 'S1E1',
        headers: {Authorization: 'Bearer SECRET123'}, timeline: {hash: 12345, time: 30},
        quality: {'1080p': 'https://cdn.example.com/q?sig=SECRET123'}}});
    assert.ok(!JSON.stringify(h.log()).includes('SECRET123'));
    const record = h.log()[0];
    assert.equal(record.type, 'create');
    assert.equal(record.component, 'online_mod');
    assert.equal(record.player, 'android');
    assert.equal(record.timecode, 'continue');
    assert.match(record.data.url, /^https:\/\/cdn\.example\.com\/…\(\d+\)$/);
    assert.equal(record.data.headers.Authorization, '<16 chars>');
    assert.equal(record.data.timeline.hash, 12345);
    assert.equal(record.card.id, 1399);
    assert.equal(record.card.overview, undefined);
});

test('function urls and odd headers never throw', t => {
    const h = setup(t, {storage: {player: 'android', kadr_probe_header: true}});
    const data = {url: function () {}, headers: 'broken'};
    h.Lampa.Player.listener.send('create', {data});
    assert.equal(h.log()[0].data.url, '[function]');
    assert.equal(typeof data.headers, 'object');
    assert.match(data.headers['X-Kadr-Probe'], /^p[0-9a-z]+$/);
});

test('playlist wrapper records url kinds and still calls Lampa', t => {
    const h = setup(t);
    h.Lampa.Player.playlist([
        {title: 'E1', url: 'https://x.example/a?t=SECRET123', timeline: {hash: 1}},
        {title: 'E2', url: function () {}, timeline: {hash: 2}, season: 1, episode: 2, voice_name: 'LostFilm'}]);
    assert.equal(h.playlists.length, 1);
    const record = h.log()[0];
    assert.equal(record.type, 'playlist');
    assert.equal(record.count, 2);
    assert.deepEqual(record.items.map(item => item.url), ['string', 'function']);
    assert.equal(record.items[1].episode, 2);
    assert.equal(record.items[1].hash, 2);
    assert.ok(!JSON.stringify(h.log()).includes('SECRET123'));
});

test('probe header is injected only with the setting on and the external Android player', t => {
    const off = setup(t, {storage: {player: 'android'}});
    const d1 = {url: 'https://a.example/c'};
    off.Lampa.Player.listener.send('create', {data: d1});
    assert.equal(d1.headers, undefined);

    const inner = setup(t, {storage: {player: 'inner', kadr_probe_header: true}});
    const d2 = {url: 'https://a.example/c'};
    inner.Lampa.Player.listener.send('create', {data: d2});
    assert.equal(d2.headers, undefined);

    const on = setup(t, {storage: {player: 'android', kadr_probe_header: true}});
    const d3 = {url: 'https://a.example/c', headers: {Referer: 'https://a.example/'}};
    on.Lampa.Player.listener.send('create', {data: d3});
    const nonce = d3.headers['X-Kadr-Probe'];
    assert.match(nonce, /^p[0-9a-z]+$/);
    assert.equal(d3.headers.Referer, 'https://a.example/');
    assert.equal(on.log()[0].nonce, nonce);
    assert.equal(on.log()[0].data.headers['X-Kadr-Probe'], nonce);
    assert.equal(on.log()[0].data.headers.Referer, '<18 chars>');
});

test('log keeps the last 30 records and timeline only for the Android player', t => {
    const h = setup(t, {storage: {player: 'android'}});
    for (let i = 0; i < 35; i++) {
        h.Lampa.Timeline.listener.send('update', {data: {hash: i, road: {time: i, duration: 100, percent: i}}});
    }
    assert.equal(h.log().length, 30);
    assert.equal(h.log()[0].hash, 5);
    assert.equal(h.log()[29].percent, 34);

    const inner = setup(t, {storage: {player: 'inner'}});
    inner.Lampa.Timeline.listener.send('update', {data: {hash: 1, road: {}}});
    assert.equal(inner.log(), undefined);
});

test('clear button empties the log', t => {
    const h = setup(t, {storage: {player: 'android'}});
    h.Lampa.Timeline.listener.send('update', {data: {hash: 1, road: {}}});
    h.params.find(p => p.param.name === 'kadr_probe_clear').onChange();
    assert.equal(h.log().length, 0); // array from the vm realm: compare by length
});

test('send posts the masked log and label to the computer and keeps the log', t => {
    const h = setup(t, {storage: {player: 'android', kadr_probe_target: ' 192.168.1.10:8765 ', kadr_probe_label: 'C1 Online Mod'}});
    h.Lampa.Timeline.listener.send('update', {data: {hash: 7, road: {time: 1}}});
    h.press('kadr_probe_send');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].url, 'http://192.168.1.10:8765/kadr-probe');
    assert.equal(h.sent[0].body.label, 'C1 Online Mod');
    assert.equal(h.sent[0].body.records.length, 1);
    assert.equal(h.sent[0].body.records[0].hash, 7);
    assert.match(h.notices.at(-1), /отправлен/);
    assert.equal(h.log().length, 1);
});

test('send adds the default port and rejects anything but host[:port]', t => {
    const h = setup(t, {storage: {player: 'android', kadr_probe_target: '192.168.1.10'}});
    h.press('kadr_probe_send');
    assert.equal(h.sent[0].url, 'http://192.168.1.10:8765/kadr-probe');
    for (const bad of ['', 'http://evil.example/x', '1.2.3.4:8765/path', 'host:99999']) {
        const b = setup(t, {storage: {kadr_probe_target: bad}});
        b.press('kadr_probe_send');
        assert.equal(b.sent.length, 0, bad);
        assert.match(b.notices.at(-1), /адрес/i);
    }
});

test('send reports a network failure', t => {
    const h = setup(t, {storage: {kadr_probe_target: '192.168.1.10'}, sendError: true});
    h.press('kadr_probe_send');
    assert.match(h.notices.at(-1), /не удалось/i);
});
