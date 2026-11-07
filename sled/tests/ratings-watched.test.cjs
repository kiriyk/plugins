const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE} = require('./harness.cjs');

const contentId = 'tmdb:movie:1400940';
const item = status => ({item_key: contentId, content_id: contentId, episode_id: null, season: null, episode: null,
    position_ms: 6128000, duration_ms: 6128000, status, revision: 3, deleted: false, server_ms: 10, client_ms: 10,
    meta: {title: 'Клэйфейс'}, playback_id: 'pbwatch'});
const inProgress = {item_key: contentId, content_id: contentId, episode_id: null, position_ms: 3000000,
    duration_ms: 6128000, status: 'in_progress', deleted: false, meta: {title: 'Клэйфейс'}};
const seed = (items, extra = {}) => ({cursor: 'c1', items, prefs: {}, conflicts: {}, playbacks: {}, outbox: [],
    deferred: [], synced: 1, offered: {}, ratings: {}, ...extra});
const feed = (entries, ratings = []) => () => ({json: {cursor: 'c9', more: false, items: entries, conflicts: [],
    prefs: [], playbacks: [], ratings}});
const asks = h => h.selects.filter(s => s.title.startsWith('Оценить'));
const choose = (h, title) => { const select = h.selects.at(-1); select.onSelect(select.items.find(i => i.title === title)); };

test('an item turning watched in a sync offers a rating', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: inProgress})}});
    await tick();
    h.routes['GET /v1/changes'] = feed([item('watched')]);
    h.KH.sync();
    await tick(30);
    assert.equal(asks(h).length, 1);
    assert.equal(asks(h)[0].title, 'Оценить «Клэйфейс»?');
    choose(h, '★ 8');
    assert.equal(h.KH.ratings()[0].score, 8);
});

test('no prompt for a rated, offered, episode or historical watched item', async () => {
    const rated = setup({storage: {[STATE]: seed({[contentId]: inProgress}, {ratings: {[contentId]:
        {content_id: contentId, score: 7, comment: null, meta: {title: 'Клэйфейс'}, rated_ms: 1, server_ms: 1,
            device_id: 'tvx', deleted: false}}})}});
    await tick();
    rated.routes['GET /v1/changes'] = feed([item('watched')]);
    rated.KH.sync();
    await tick(30);
    assert.equal(asks(rated).length, 0);

    const offered = setup({storage: {[STATE]: seed({[contentId]: inProgress}, {offered: {[contentId]: true}})}});
    await tick();
    offered.routes['GET /v1/changes'] = feed([item('watched')]);
    offered.KH.sync();
    await tick(30);
    assert.equal(asks(offered).length, 0);

    // First sync of an item that is already watched: history must not prompt.
    const historical = setup({storage: {[STATE]: seed({})}});
    await tick();
    historical.routes['GET /v1/changes'] = feed([item('watched')]);
    historical.KH.sync();
    await tick(30);
    assert.equal(asks(historical).length, 0);

    const episode = Object.assign({}, inProgress, {item_key: 'tmdb:tv:60625/s1e1', content_id: 'tmdb:tv:60625',
        episode_id: 's1e1'});
    const series = setup({storage: {[STATE]: seed({'tmdb:tv:60625/s1e1': episode})}});
    await tick();
    series.routes['GET /v1/changes'] = feed([Object.assign({}, item('watched'), episode, {status: 'watched'})]);
    series.KH.sync();
    await tick(30);
    assert.equal(asks(series).length, 0);

    // A prompt never pops while a playback is still open.
    const busy = setup({storage: {[STATE]: seed({[contentId]: inProgress})}});
    await tick();
    busy.storage['sled_pending'] = {playback_id: 'pbopen', hash: 'somehash', item_key: contentId, started: Date.now()};
    busy.routes['GET /v1/changes'] = feed([item('watched')]);
    busy.KH.sync();
    await tick(30);
    assert.equal(asks(busy).length, 0);
});

test('an item already watched locally does not prompt again', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: item('watched')})}});
    await tick();
    h.routes['GET /v1/changes'] = feed([Object.assign({}, item('watched'), {revision: 4})]);
    h.KH.sync();
    await tick(30);
    assert.equal(asks(h).length, 0);
});

test('marking watched from the item menu offers a rating', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: inProgress})}});
    await tick();
    h.KH.itemMenu(inProgress, null, false);
    const menu = h.selects.at(-1);
    menu.onSelect(menu.items.find(i => i.title === 'Отметить просмотренным'));
    await tick(30);
    assert.equal(asks(h).length, 1);
    // The status itself is set regardless of the rating answer.
    assert.equal(h.KH.load().items[contentId].status, 'watched');
});

test('rating arriving with a watched transition suppresses the prompt', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: inProgress})}});
    await tick();
    h.routes['GET /v1/changes'] = feed([item('watched')], [{content_id: contentId, score: 9, deleted: false, meta: {title: 'Клэйфейс'}}]);
    h.KH.sync();
    await tick(30);
    assert.equal(asks(h).length, 0);
    assert.equal(h.KH.ratings()[0].score, 9);
});

test('a queued deletion suppresses prompts from an older watched server copy', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: {...inProgress, deleted: true}})}});
    await tick();
    h.KH.enqueue({type: 'delete', item_key: contentId});
    h.routes['POST /v1/events'] = () => ({status: 503});
    h.routes['GET /v1/changes'] = feed([item('watched')]);
    h.KH.sync();
    await tick(30);
    assert.equal(asks(h).length, 0);
    assert.equal(h.KH.load().items[contentId].deleted, true);
    assert.equal(h.KH.load().outbox.some(e => e.type === 'delete'), true);
});

test('a late watched transition from another profile cannot open a rating dialog', async () => {
    const {KEY} = require('./harness.cjs');
    const keyB = 'kadr_' + 'b'.repeat(43);
    const h = setup({storage: {[STATE]: seed({[contentId]: inProgress}), sled_profiles: [{name: 'A', key: KEY}, {name: 'B', key: keyB}]}});
    await tick();
    h.routes['GET /v1/changes'] = req => {
        if (req.headers.Authorization === 'Bearer ' + KEY) {
            h.storage.sled_active = 'B';
            return feed([item('watched')])();
        }
        return feed([])();
    };
    h.KH.sync();
    await tick(30);
    assert.equal(asks(h).length, 0);
    assert.equal(h.storage.sled_active, 'B');
    assert.equal(h.KH.ratings().length, 0);
});

test('rating on a later changes page suppresses the watched prompt for the whole sync', async () => {
    const h = setup({storage: {[STATE]: seed({[contentId]: inProgress})}});
    await tick();
    let calls = 0;
    h.routes['GET /v1/changes'] = () => {
        if (++calls === 1) {
            const response = feed([item('watched')])();
            response.json.more = true;
            return response;
        }
        return feed([], [{content_id: contentId, score: 9, deleted: false}])();
    };
    h.KH.sync();
    await tick(30);
    assert.equal(calls, 2);
    assert.equal(asks(h).length, 0);
    assert.equal(h.KH.ratings()[0].score, 9);
});
