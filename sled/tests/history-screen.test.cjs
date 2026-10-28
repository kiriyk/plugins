const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const record = (key, server, extra = {}) => {
    const [content, episode] = key.split('/');
    const match = episode ? /^s(\d+)e(\d+)$/.exec(episode) : null;
    return {item_key: key, content_id: content, episode_id: episode || null, season: match ? +match[1] : null,
        episode: match ? +match[2] : null, position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false,
        manual: false, server_ms: server, client_ms: server, device_id: 'tvaaaaaaaaaa', revision: 1, meta: RM, ...extra};
};
const seeded = items => ({storage: {[STATE]: {cursor: 'c1', items: Object.fromEntries(items.map(i => [i.item_key, i])), prefs: {},
    conflicts: {}, playbacks: {}, outbox: [], deferred: [], synced: 1}}});
const list = (h, params) => new Promise(resolve => h.sources.sled.list(params, json => resolve({json}), () => resolve({error: true})));

test('the menu button opens continue watching or the full history', async () => {
    const h = setup();
    await tick();
    const button = h.buttons.find(entry => entry.title === 'История');
    assert.match(button.icon, /^<svg/);
    button.action();
    const select = h.selects.at(-1);
    assert.equal(select.title, 'История Sled');
    assert.equal(select.items.map(entry => entry.title).join('|'), 'Продолжить просмотр|Вся история|Мои оценки');
    select.onSelect(select.items[1]);
    const pushed = h.pushes.at(-1);
    assert.equal(JSON.stringify([pushed.component, pushed.source, pushed.url, pushed.page, pushed.title]),
        JSON.stringify(['category_full', 'sled', 'all', 1, 'Вся история']));
});

test('the sled source pages the local history and opens the actions menu', async () => {
    const many = Array.from({length: 45}, (_, i) => record('tmdb:tv:60625/s1e' + (i + 1), i + 1));
    const h = setup(seeded([...many, record('tmdb:movie:7', 0.5, {meta: {title: 'Фильм'}})]));
    await tick();
    const {json} = await list(h, {url: 'all', page: 2});
    assert.equal(json.results.length, 20);
    assert.equal(json.total_pages, 3);
    assert.equal(json.page, 2);
    assert.equal(json.results[0].name, 'Рик и Морти · S1E25');
    json.results[0].params.emit.onlyEnter();
    assert.equal(h.selects.at(-1).title, 'Рик и Морти · 1 сезон, 25 серия');
    const last = (await list(h, {url: 'all', page: 3})).json.results;
    assert.equal(last.at(-1).title, 'Фильм');
});

test('continue watching keeps the next-episode offer', async () => {
    const h = setup(seeded([record('tmdb:tv:60625/s6e6', 5, {status: 'watched'})]));
    await tick();
    const {json} = await list(h, {url: 'continue', page: 1});
    assert.equal(json.results[0].name, 'Рик и Морти');
    json.results[0].params.emit.onlyEnter();
    assert.equal(h.selects.at(-1).items[0].title, 'Следующая серия · S6E7');
});

test('an empty history reports an error page', async () => {
    const h = setup();
    await tick();
    assert.equal((await list(h, {url: 'all', page: 1})).error, true);
});
