const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, episodeHash, STATE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const S6E7 = {item_key: 'tmdb:tv:60625/s6e7', content_id: 'tmdb:tv:60625', episode_id: 's6e7', season: 6, episode: 7,
    position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false, manual: false, server_ms: 100,
    client_ms: 100, device_id: 'tvaaaaaaaaaa', revision: 3, meta: RM};
const PREFS = {'tmdb:tv:60625': {adapter: 'online_mod', balanser: 'rezka', voice: null, quality: null, ids: {}}};
function seeded(entry, extra = {}) {
    return {storage: {[STATE]: {cursor: 'c1', items: {[entry.item_key]: entry}, prefs: PREFS, conflicts: {}, playbacks: {},
        outbox: [], deferred: [], synced: 1}}, ...extra};
}
const titles = select => select.items.map(entry => entry.title);
const choose = (h, title) => { const select = h.selects.at(-1); select.onSelect(select.items.find(entry => entry.title === title)); };
const fragment = data => new URLSearchParams(data.url.split('#')[1] || '');

test('menu for an episode in progress resumes through the saved source', async () => {
    const h = setup(seeded(S6E7));
    await tick();
    h.KH.itemMenu(S6E7);
    assert.equal(h.selects.at(-1).title, 'Рик и Морти · 6 сезон, 7 серия');
    assert.equal(titles(h.selects.at(-1)).join('|'),
        'Продолжить с 12:30|Сначала|Выбрать источник|Отметить просмотренным|Удалить из истории');
    choose(h, 'Продолжить с 12:30');
    assert.equal(h.pushes.at(-1).component, 'online_mod');
    const menus = h.selects.length;
    const data = {url: 'http://cdn.test/s6e7.m3u8', timeline: {hash: episodeHash(6, 7, 'Rick and Morty')}};
    h.Lampa.Player.play(data);
    await tick();
    assert.equal(h.selects.length, menus);
    assert.equal(fragment(data).get('mode'), 'resume');
    assert.equal(fragment(data).get('pos'), '740000');
});

test('menu for a finished episode offers the next one and starts it without asking', async () => {
    const watched = {...S6E7, status: 'watched'};
    const h = setup(seeded(watched));
    await tick();
    h.KH.itemMenu(watched, undefined, true);
    assert.equal(titles(h.selects.at(-1)).join('|'),
        'Следующая серия · S6E8|Выбрать источник|Снять отметку «просмотрено»|Удалить из истории');
    choose(h, 'Следующая серия · S6E8');
    assert.equal(h.pushes.at(-1).component, 'online_mod');
    const menus = h.selects.length;
    const data = {url: 'http://cdn.test/s6e8.m3u8', timeline: {hash: episodeHash(6, 8, 'Rick and Morty')}};
    h.Lampa.Player.play(data);
    await tick();
    assert.equal(h.launched().length, 1);
    assert.equal(h.selects.length, menus);
    assert.equal(fragment(data).get('mode'), 'start');
    assert.equal(fragment(data).get('eid'), 's6e8');
});

test('marking watched applies locally, queues a status event and syncs', async () => {
    const h = setup(seeded(S6E7));
    await tick();
    h.KH.itemMenu(S6E7);
    choose(h, 'Отметить просмотренным');
    assert.equal(h.state().items[S6E7.item_key].status, 'watched');
    assert.equal(h.state().items[S6E7.item_key].manual, true);
    await tick();
    const sent = h.sent.filter(r => r.path === '/v1/events').flatMap(r => r.body.events);
    const status = sent.find(e => e.type === 'status');
    assert.equal(JSON.stringify([status.item_key, status.status]), JSON.stringify([S6E7.item_key, 'watched']));
});

test('unmarking returns the record to in progress', async () => {
    const watched = {...S6E7, status: 'watched'};
    const h = setup(seeded(watched));
    await tick();
    h.KH.itemMenu(watched);
    choose(h, 'Снять отметку «просмотрено»');
    assert.equal(h.state().items[S6E7.item_key].status, 'in_progress');
    assert.equal(h.state().outbox.at(-1).status, 'unwatched');
});

test('removing asks first and hides the record even from an older change feed', async () => {
    const h = setup(seeded(S6E7, {routes: {'POST /v1/events': () => ({status: 503})}}));
    await tick();
    h.KH.itemMenu(S6E7);
    choose(h, 'Удалить из истории');
    assert.equal(h.selects.at(-1).title, 'Удалить «Рик и Морти · S6E7» из истории?');
    assert.equal(titles(h.selects.at(-1)).join('|'), 'Удалить|Отмена');
    choose(h, 'Отмена');
    assert.equal(h.state().items[S6E7.item_key].deleted, false);
    h.KH.itemMenu(S6E7);
    choose(h, 'Удалить из истории');
    choose(h, 'Удалить');
    assert.equal(h.state().items[S6E7.item_key].deleted, true);
    assert.equal(h.state().outbox.at(-1).type, 'delete');
    assert.equal(h.KH.shelf().length, 0);
    h.routes['GET /v1/changes'] = () => ({json: {cursor: 'c2', more: false, items: [S6E7], conflicts: [], prefs: [], playbacks: []}});
    await new Promise(resolve => h.KH.sync(resolve));
    assert.equal(h.state().items[S6E7.item_key].deleted, true);
    assert.equal(h.KH.shelf().length, 0);
});

test('choose source opens the full card', async () => {
    const h = setup(seeded(S6E7));
    await tick();
    h.KH.itemMenu(S6E7);
    choose(h, 'Выбрать источник');
    const pushed = h.pushes.at(-1);
    assert.equal(JSON.stringify([pushed.component, pushed.id, pushed.method]), JSON.stringify(['full', 60625, 'tv']));
});
