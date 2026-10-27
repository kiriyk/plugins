const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, episodeHash, STATE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const at = (position, device, extra = {}) => ({item_key: 'tmdb:tv:60625/s6e7', content_id: 'tmdb:tv:60625', episode_id: 's6e7',
    season: 6, episode: 7, position_ms: position, duration_ms: 1278000, status: 'in_progress', deleted: false, manual: false,
    server_ms: 100, client_ms: Date.UTC(2026, 9, 27, 15, 41), device_id: device, revision: 3, meta: RM, ...extra});
const conflict = (version, current, playback) => ({id: 'cf1', item_key: 'tmdb:tv:60625/s6e7', version, status: 'open',
    created_ms: 1, options: {current, playback}});
function seeded(routes = {}) {
    // The plugin's own device id is fixed so "this device" can be told apart.
    const state = {cursor: 'c1', items: {'tmdb:tv:60625/s6e7': at(600000, 'tvthisdevice00')}, prefs: {}, playbacks: {},
        conflicts: {cf1: conflict(1, at(600000, 'tvthisdevice00'), at(900000, 'tvotherk3f9'))}, outbox: [], deferred: [], synced: 1};
    return {storage: {sled_device: 'tvthisdevice00', [STATE]: state}, routes};
}
const titles = select => select.items.map(entry => entry.title);
const choose = (h, index) => { const select = h.selects.at(-1); select.onSelect(select.items[index]); };
const play = h => h.Lampa.Player.play({url: 'http://cdn.test/s6e7.m3u8', timeline: {hash: episodeHash(6, 7, 'Rick and Morty')}});
const DATE = /^\d\d\.\d\d \d\d:\d\d$/;

test('launching an episode with an open conflict asks which position to keep first', async () => {
    const h = setup(seeded({'POST /v1/conflicts/cf1/resolve': () => ({json: {revision: 5, item: at(900000, 'tvotherk3f9', {revision: 5})}})}));
    await tick();
    play(h);
    await tick();
    const dialog = h.selects.at(-1);
    assert.equal(dialog.title, 'Позиции разошлись · Рик и Морти · 6 сезон, 7 серия');
    const [mine, other] = titles(dialog).map(title => title.split(' · '));
    assert.equal(JSON.stringify(mine.slice(0, 2)), JSON.stringify(['10:00', 'это устройство']));
    assert.equal(JSON.stringify(other.slice(0, 2)), JSON.stringify(['15:00', 'другое устройство (…k3f9)']));
    assert.match(other[2], DATE);
    choose(h, 1);
    await tick();
    const posted = h.sent.find(r => r.path === '/v1/conflicts/cf1/resolve');
    assert.equal(JSON.stringify(posted.body), JSON.stringify({version: 1, choice: 'playback'}));
    assert.equal(h.state().conflicts.cf1, undefined);
    assert.equal(h.state().items['tmdb:tv:60625/s6e7'].position_ms, 900000);
    assert.equal(titles(h.selects.at(-1))[0], 'Продолжить с 15:00');
});

test('a conflict that changed meanwhile is shown again with the new options', async () => {
    const changed = conflict(2, at(600000, 'tvthisdevice00'), at(1200000, 'tvotherk3f9'));
    const h = setup(seeded({'POST /v1/conflicts/cf1/resolve': () => ({status: 409, json: {error: 'conflict_changed', conflict: changed}})}));
    await tick();
    play(h);
    await tick();
    choose(h, 1);
    await tick();
    assert.equal(h.notices.at(-1), 'Sled: варианты изменились, выберите ещё раз');
    assert.equal(titles(h.selects.at(-1))[1].split(' · ')[0], '20:00');
    assert.equal(h.state().conflicts.cf1.version, 2);
});

test('without the server the choice is not applied and playback goes on', async () => {
    const h = setup(seeded({'POST /v1/conflicts/cf1/resolve': () => ({status: 502})}));
    await tick();
    play(h);
    await tick();
    choose(h, 1);
    await tick();
    assert.equal(h.notices.at(-1), 'Sled: сервер недоступен, выбор не сохранён');
    assert.equal(h.state().conflicts.cf1.version, 1);
    assert.equal(titles(h.selects.at(-1))[0], 'Продолжить с 10:00');
});

test('the actions menu offers the conflict first and returns to the menu after the choice', async () => {
    const h = setup(seeded({'POST /v1/conflicts/cf1/resolve': () => ({json: {revision: 5, item: at(900000, 'tvotherk3f9', {revision: 5})}})}));
    await tick();
    h.KH.itemMenu(at(600000, 'tvthisdevice00'));
    assert.equal(titles(h.selects.at(-1))[0], 'Позиции разошлись — выбрать');
    choose(h, 0);
    choose(h, 1);
    await tick();
    assert.equal(titles(h.selects.at(-1))[0], 'Продолжить с 15:00');
});
