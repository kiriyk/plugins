const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, KEY, STATE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const record = (key, server, extra = {}) => {
    const [content, episode] = key.split('/');
    const match = episode ? /^s(\d+)e(\d+)$/.exec(episode) : null;
    return {item_key: key, content_id: content, episode_id: episode || null, season: match ? +match[1] : null,
        episode: match ? +match[2] : null, position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false,
        manual: false, server_ms: server, client_ms: server, device_id: 'tvaaaaaaaaaa', revision: 1, meta: RM, ...extra};
};
const state = (items, extra = {}) => ({cursor: 'c1', items: Object.fromEntries(items.map(i => [i.item_key, i])), prefs: {},
    conflicts: {}, playbacks: {}, outbox: [], deferred: [], synced: 1, ...extra});
const shelfRow = h => h.rows.find(row => row.name === 'sled_continue');
function render(h) {
    const draw = shelfRow(h).call({}, 'main');
    if (!draw) return null;
    let shown = null;
    draw(json => { shown = json; });
    return shown;
}

test('the shelf row is registered for the main screen and stays hidden without history', async () => {
    const h = setup();
    await tick();
    assert.equal(h.rows.filter(row => row.name === 'sled_continue').length, 1);
    const row = shelfRow(h);
    assert.equal(JSON.stringify([row.title, row.index, row.screen]), JSON.stringify(['Продолжить просмотр (Sled)', 0, ['main']]));
    assert.equal(row.call({}, 'main'), undefined);
});

test('the shelf shows one card per title and opens the actions menu', async () => {
    const h = setup({storage: {[STATE]: state([record('tmdb:tv:60625/s6e6', 50, {status: 'watched'}),
        record('tmdb:tv:60625/s6e7', 90), record('tmdb:movie:7', 70, {meta: {title: 'Фильм'}})])}});
    await tick();
    const shown = render(h);
    assert.equal(shown.title, 'Продолжить просмотр');
    assert.equal(shown.results.map(card => card.sled.item_key).join(','), 'tmdb:tv:60625/s6e7,tmdb:movie:7');
    shown.results[0].params.emit.onlyEnter();
    assert.equal(h.selects.at(-1).items[0].title, 'Продолжить с 12:30');
});

test('a finished episode on the shelf opens the menu with the next one', async () => {
    const h = setup({storage: {[STATE]: state([record('tmdb:tv:60625/s6e6', 50, {status: 'watched'})])}});
    await tick();
    render(h).results[0].params.emit.onlyEnter();
    assert.equal(h.selects.at(-1).items[0].title, 'Следующая серия · S6E7');
});

test('waiting events mark the shelf title', async () => {
    const h = setup({storage: {[STATE]: state([record('tmdb:movie:7', 70)], {outbox: [{type: 'status'}]})},
        routes: {'POST /v1/events': () => ({status: 503})}});
    await tick();
    assert.equal(render(h).title, 'Продолжить просмотр · ждёт синхронизации');
});

test('the shelf uses the active profile only', async () => {
    const other = 'kadr_' + 'b'.repeat(43);
    const h = setup({storage: {sled_profiles: [{name: 'A', key: KEY}, {name: 'B', key: other}], sled_active: 'B',
        [STATE]: state([record('tmdb:movie:1', 10)]), ['sled_state_' + hash(other)]: state([record('tmdb:movie:2', 20)])}});
    await tick();
    assert.equal(render(h).results.map(card => card.id).join(','), '2');
});
