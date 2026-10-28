const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, episodeHash, STATE, MOVIE, RICK} = require('./harness.cjs');

const HASH = hash('Clayface');
const film = status => ({item_key: 'tmdb:movie:1400940', content_id: 'tmdb:movie:1400940', episode_id: null, position_ms: 6000000,
    duration_ms: 6128000, status, revision: 2, deleted: false, server_ms: 9, client_ms: 9, meta: {title: 'Клэйфейс'}});
const changes = items => () => ({json: {cursor: 'c9', more: false, items, conflicts: [], prefs: [], playbacks: [], ratings: []}});
const asks = h => h.selects.filter(s => s.title.startsWith('Оценить'));
const choose = (h, title) => { const select = h.selects.at(-1); select.onSelect(select.items.find(item => item.title === title)); };
async function watch(h, road, feed) {
    h.Lampa.Player.play({url: 'http://cdn.test/clayface.m3u8', timeline: {hash: HASH}});
    await tick(20);
    if (feed) h.routes['GET /v1/changes'] = feed;
    h.returned(HASH, road);
    await tick(30);
}
const movieSetup = (extra = {}) => setup({activity: {component: 'online_mod', movie: MOVIE}, ...extra});

test('a finished movie offers a rating once', async () => {
    const h = movieSetup();
    await tick();
    await watch(h, {time: 6000, duration: 6128, percent: 97}, changes([film('watched')]));
    const ask = h.selects.at(-1);
    assert.equal(ask.title, 'Оценить «Клэйфейс»?');
    assert.equal(ask.items.map(i => i.title).join('|'), '★ 10|★ 9|★ 8|★ 7|★ 6|★ 5|★ 4|★ 3|★ 2|★ 1|Не сейчас');
    choose(h, '★ 9');
    assert.equal(h.KH.ratings()[0].score, 9);
    assert.equal(h.KH.ratings()[0].content_id, 'tmdb:movie:1400940');
    assert.equal(h.selects.at(-1).title, 'Оценка сохранена · ★ 9');
    assert.equal(h.selects.at(-1).items.map(i => i.title).join('|'), 'Добавить впечатления|Готово');
    choose(h, 'Добавить впечатления');
    assert.equal(h.inputs.at(-1).params.title, 'Впечатления');
});

test('not now means never again for this movie', async () => {
    const h = movieSetup();
    await tick();
    await watch(h, {time: 6000, duration: 6128, percent: 97}, changes([film('watched')]));
    choose(h, 'Не сейчас');
    assert.equal(h.KH.ratings().length, 0);
    await watch(h, {time: 6000, duration: 6128, percent: 97});
    assert.equal(asks(h).length, 1);
});

test('back closes the window like not now', async () => {
    const h = movieSetup();
    await tick();
    await watch(h, {time: 6000, duration: 6128, percent: 97}, changes([film('watched')]));
    h.selects.at(-1).onBack();
    assert.equal(h.KH.ratings().length, 0);
    await watch(h, {time: 6000, duration: 6128, percent: 97});
    assert.equal(asks(h).length, 1);
});

test('no window for an unfinished movie, an episode or a rated movie', async () => {
    const h = movieSetup();
    await tick();
    await watch(h, {time: 3000, duration: 6128, percent: 49}, changes([film('in_progress')]));
    assert.equal(asks(h).length, 0);

    const rated = movieSetup({storage: {[STATE]: {cursor: 'c1', items: {}, prefs: {}, conflicts: {}, playbacks: {}, outbox: [],
        deferred: [], synced: 1, offered: {}, ratings: {'tmdb:movie:1400940': {content_id: 'tmdb:movie:1400940', score: 7,
            comment: null, meta: {title: 'Клэйфейс'}, rated_ms: 1, server_ms: 1, device_id: 'tvx', deleted: false}}}}});
    await tick();
    await watch(rated, {time: 6000, duration: 6128, percent: 97}, changes([film('watched')]));
    assert.equal(asks(rated).length, 0);

    const series = setup();
    await tick();
    const H = episodeHash(5, 10, 'Rick and Morty');
    series.Lampa.Player.play({url: 'http://cdn.test/rm.m3u8', timeline: {hash: H}});
    await tick(20);
    series.routes['GET /v1/changes'] = changes([{...film('watched'), item_key: 'tmdb:tv:60625/s5e10', content_id: 'tmdb:tv:60625',
        episode_id: 's5e10'}]);
    series.returned(H, {time: 1300, duration: 1323, percent: 98});
    await tick(30);
    assert.equal(asks(series).length, 0);
});

test('offline, the timeline percent decides', async () => {
    const h = movieSetup();
    await tick();
    await watch(h, {time: 5000, duration: 6128, percent: 80}, () => ({status: 503}));
    assert.equal(asks(h).length, 0);
    await watch(h, {time: 5900, duration: 6128, percent: 96});
    assert.equal(asks(h).length, 1);
});
