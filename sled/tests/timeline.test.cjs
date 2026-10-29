const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, episodeHash} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const HASH = episodeHash(5, 10, 'Rick and Morty');
const episodeItem = (position, extra = {}) => ({item_key: 'tmdb:tv:60625/s5e10', content_id: 'tmdb:tv:60625',
    episode_id: 's5e10', season: 5, episode: 10, position_ms: position, duration_ms: 1323000,
    status: 'in_progress', deleted: false, server_ms: 1000000, client_ms: 1000000, revision: 1, meta: RM, ...extra});
const feed = items => () => ({json: {cursor: 'c1', more: false, items, conflicts: [], prefs: [], playbacks: []}});

test('a sync mirrors server episode positions into the Lampa timeline', async () => {
    const h = setup({routes: {'GET /v1/changes': feed([episodeItem(661500)])}});
    await tick();
    const road = h.roads[HASH];
    assert.equal(road.percent, 50);
    assert.equal(road.time, 662);
    assert.equal(road.duration, 1323);
    assert.equal(road.updated, 1000000);
});

test('a watched episode becomes a full bar', async () => {
    const h = setup({routes: {'GET /v1/changes': feed([episodeItem(1323000, {status: 'watched'})])}});
    await tick();
    assert.equal(h.roads[HASH].percent, 100);
    assert.equal(h.roads[HASH].time, 1323);
});

test('movie positions are mirrored under the original title hash', async () => {
    const movie = {item_key: 'tmdb:movie:7', content_id: 'tmdb:movie:7', episode_id: null, season: null, episode: null,
        position_ms: 600000, duration_ms: 3600000, status: 'in_progress', deleted: false,
        server_ms: 1000000, client_ms: 1000000, revision: 1, meta: {title: 'Клэйфейс', original_title: 'Clayface'}};
    const h = setup({routes: {'GET /v1/changes': feed([movie])}});
    await tick();
    assert.equal(h.roads[hash('Clayface')].percent, 17);
    assert.equal(h.roads[hash('Clayface')].time, 600);
});

test('a position this device wrote more recently is not overwritten by an older server one', async () => {
    const h = setup({routes: {'GET /v1/changes': feed([episodeItem(661500)])}});
    h.roads[HASH] = {percent: 90, time: 1190, duration: 1323, updated: Date.now()};
    await tick();
    assert.equal(h.roads[HASH].percent, 90);
});

test('deleted and untouched items leave the timeline alone', async () => {
    const h = setup({routes: {'GET /v1/changes': feed([episodeItem(661500, {deleted: true}), episodeItem(0)])}});
    await tick();
    assert.equal(Object.keys(h.roads).length, 0);
});

test('mirroring during playback is not mistaken for the player reporting back', async () => {
    const h = setup();
    await tick();
    h.Lampa.Player.play({url: 'http://cdn.test/rm-s5e10.m3u8', title: 'S5 / Серия 10', timeline: {hash: HASH, time: 0}});
    await tick();
    assert.ok(h.storage.sled_pending, 'playback is pending');
    h.routes['GET /v1/changes'] = feed([episodeItem(661500)]);
    h.KH.sync();
    await tick();
    assert.equal(h.roads[HASH].percent, 50, 'the position was mirrored');
    assert.ok(h.storage.sled_pending, 'the playback is still pending');
    assert.equal(h.state().outbox.filter(event => event.type === 'progress').length, 0);
});
