const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
function item(key, extra = {}) {
    const [content, episode] = key.split('/');
    const match = episode ? /^s(\d+)e(\d+)$/.exec(episode) : null;
    return {item_key: key, content_id: content, episode_id: episode || null,
        season: match ? Number(match[1]) : null, episode: match ? Number(match[2]) : null,
        position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false, manual: false,
        server_ms: 100, client_ms: 100, device_id: 'tvaaaaaaaaaa', revision: 1, meta: RM, ...extra};
}
function seeded(items, extra = {}) {
    const map = {};
    items.forEach(entry => { map[entry.item_key] = entry; });
    return {storage: {[STATE]: {cursor: 'c1', items: map, prefs: {}, conflicts: {}, playbacks: {}, outbox: [], deferred: [],
        synced: 1, ...extra}}};
}
const keys = list => list.map(entry => entry.item.item_key).join(',');

test('shelf keeps the latest record per title by the server rule', async () => {
    const h = setup(seeded([
        item('tmdb:tv:60625/s6e6', {status: 'watched', server_ms: 50}),
        item('tmdb:tv:60625/s6e7', {server_ms: 90}),
        item('tmdb:tv:1399/s1e1', {status: 'watched', server_ms: 80, meta: {title: 'Игра престолов'}}),
        item('tmdb:movie:1', {status: 'watched', server_ms: 70, meta: {title: 'Фильм'}}),
        item('tmdb:movie:2', {position_ms: 0, server_ms: 60, meta: {title: 'Не начат'}}),
        item('tmdb:movie:3', {deleted: true, server_ms: 95, meta: {title: 'Удалён'}}),
    ]));
    await tick();
    const shelf = h.KH.shelf();
    assert.equal(keys(shelf), 'tmdb:tv:60625/s6e7,tmdb:tv:1399/s1e1');
    assert.equal(shelf[0].upNext, false);
    assert.equal(shelf[1].upNext, true);
});

test('shelf is limited to 20 titles, newest first', async () => {
    const many = Array.from({length: 25}, (_, i) => item('tmdb:movie:' + (i + 1), {server_ms: i + 1}));
    const h = setup(seeded(many));
    await tick();
    const shelf = h.KH.shelf();
    assert.equal(shelf.length, 20);
    assert.equal(shelf[0].item.item_key, 'tmdb:movie:25');
});

test('history lists every episode in pages of 20; continue is the shelf', async () => {
    const many = Array.from({length: 45}, (_, i) => item('tmdb:tv:60625/s1e' + (i + 1), {server_ms: i + 1}));
    const h = setup(seeded(many));
    await tick();
    const page3 = h.KH.historyPage('all', 3);
    assert.equal(page3.total_pages, 3);
    assert.equal(page3.page, 3);
    assert.equal(page3.results.length, 5);
    const first = h.KH.historyPage('all', 1);
    assert.equal(first.results[0].sled.item_key, 'tmdb:tv:60625/s1e45');
    assert.equal(h.KH.historyPage('continue', 1).results.length, 1);
});

test('cardOf builds a Lampa card for a series and for a movie', async () => {
    const h = setup();
    await tick();
    const tv = h.KH.cardOf(item('tmdb:tv:60625/s6e7'));
    assert.equal(JSON.stringify(tv), JSON.stringify({id: 60625, source: 'tmdb', name: 'Рик и Морти',
        original_name: 'Rick and Morty', first_air_date: '2013-01-01', poster_path: '/rm.jpg',
        sled: {item_key: 'tmdb:tv:60625/s6e7'}}));
    const movie = h.KH.cardOf(item('tmdb:movie:1400940', {meta: {title: 'Клэйфейс', original_title: 'Clayface'}}));
    assert.equal(JSON.stringify(movie), JSON.stringify({id: 1400940, source: 'tmdb', title: 'Клэйфейс',
        original_title: 'Clayface', sled: {item_key: 'tmdb:movie:1400940'}}));
    const web = h.KH.cardOf(item('tmdb:movie:5', {meta: {title: 'X', poster: 'https://img.test/x.jpg'}}));
    assert.equal(web.poster, 'https://img.test/x.jpg');
    assert.equal(web.poster_path, undefined);
});

test('progress and labels', async () => {
    const h = setup();
    await tick();
    assert.equal(h.KH.progressOf(item('tmdb:tv:60625/s6e7', {status: 'watched'})), 100);
    assert.equal(h.KH.progressOf(item('tmdb:tv:60625/s6e7', {duration_ms: null})), 0);
    assert.equal(h.KH.progressOf(item('tmdb:tv:60625/s6e7')), 59);
    assert.equal(h.KH.labelOf(item('tmdb:tv:60625/s6e7')), 'S6E7 · 12:30 из 21:18');
    assert.equal(h.KH.labelOf(item('tmdb:tv:60625/s6e7', {status: 'watched'}), true), 'Следующая: S6E8');
    assert.equal(h.KH.labelOf(item('tmdb:movie:1', {position_ms: 3600000, duration_ms: 6720000})), '1:00:00 из 1:52:00');
    assert.equal(h.KH.labelOf(item('tmdb:movie:1', {status: 'watched'})), 'Просмотрено');
    assert.equal(h.KH.labelOf(item('tmdb:movie:1', {duration_ms: null})), '12:30');
});

test('pending is true while events or registrations wait for the server', async () => {
    const h = setup({...seeded([], {outbox: [{type: 'status'}]}), routes: {'POST /v1/events': () => ({status: 503})}});
    await tick();
    assert.equal(h.KH.pending(h.KH.load()), true);
    assert.equal(h.KH.pending({outbox: [], deferred: []}), false);
});

test('connection check lists the Lampa entry points that are missing', async () => {
    const h = setup({missing: ['Maker', 'ContentRows']});
    await tick();
    h.press('sled_check');
    await tick();
    assert.equal(h.notices.at(-1), 'Sled: сервер доступен, профиль «A», порог 95%, интерфейс: нет полки, отметок на постерах');
    const full = setup();
    await tick();
    full.press('sled_check');
    await tick();
    assert.equal(full.notices.at(-1), 'Sled: сервер доступен, профиль «A», порог 95%, интерфейс: всё подключено');
});
