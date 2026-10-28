const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE} = require('./harness.cjs');

const FILM = {content_id: 'tmdb:movie:7', meta: {title: 'Фильм'}};
const remote = (contentId, score, extra = {}) => ({content_id: contentId, score, comment: null, meta: {title: 'Рик и Морти'},
    rated_ms: 100, server_ms: 100, device_id: 'tvotherdevice', deleted: false, ...extra});
const feed = ratings => () => ({json: {cursor: 'c2', more: false, items: [], conflicts: [], prefs: [], playbacks: [], ratings}});
const syncNow = h => new Promise(resolve => h.KH.sync(resolve));

test('rating a movie applies locally at once and queues one event', async () => {
    const h = setup();
    await tick();
    h.routes['POST /v1/events'] = () => ({status: 503});
    h.KH.rate(FILM, 8, 'Сильный финал');
    const local = h.KH.ratings()[0];
    assert.equal(JSON.stringify([local.content_id, local.score, local.comment, local.deleted]),
        JSON.stringify(['tmdb:movie:7', 8, 'Сильный финал', false]));
    const queued = h.KH.load().outbox.filter(e => e.type === 'rating');
    assert.equal(queued.length, 1);
    assert.equal(JSON.stringify([queued[0].content_id, queued[0].score, queued[0].comment, queued[0].meta]),
        JSON.stringify(['tmdb:movie:7', 8, 'Сильный финал', {title: 'Фильм'}]));
    await tick();
    h.routes['POST /v1/events'] = req => ({json: {results: req.body.events.map(e => ({event_id: e.event_id, status: 'applied'}))}});
    await syncNow(h);
    assert.ok(h.sent.some(r => r.path === '/v1/events' && r.body.events.some(e => e.type === 'rating' && e.score === 8)));
    assert.equal(h.KH.load().outbox.length, 0);
});

test('ratings from the feed are merged; a deleted one disappears', async () => {
    const h = setup({routes: {'GET /v1/changes': feed([remote('tmdb:tv:60625', 9)])}});
    await tick();
    assert.equal(h.KH.ratings().length, 1);
    assert.equal(h.KH.ratings()[0].score, 9);
    h.routes['GET /v1/changes'] = feed([remote('tmdb:tv:60625', null, {deleted: true})]);
    await syncNow(h);
    assert.equal(h.KH.ratings().length, 0);
});

test('an unsent local rating is not overwritten by an older copy from the feed', async () => {
    const h = setup({routes: {'POST /v1/events': () => ({status: 503})}});
    await tick();
    h.KH.rate(FILM, 8);
    h.routes['GET /v1/changes'] = feed([remote('tmdb:movie:7', 5)]);
    await syncNow(h);
    assert.equal(h.KH.ratings()[0].score, 8);
    h.KH.unrate('tmdb:movie:7');
    await syncNow(h);
    assert.equal(h.KH.ratings().length, 0);
});

test('the rated list is newest first and pages by 20', async () => {
    const ratings = {};
    for (let i = 0; i < 45; i++) ratings['tmdb:movie:' + i] = remote('tmdb:movie:' + i, 7, {meta: {title: 'Фильм ' + i}, rated_ms: i + 1});
    const h = setup({storage: {[STATE]: {cursor: 'c1', items: {}, prefs: {}, conflicts: {}, playbacks: {}, outbox: [],
        deferred: [], synced: 1, ratings, offered: {}}}});
    await tick();
    const first = h.KH.ratingPage(1), last = h.KH.ratingPage(3);
    assert.equal(first.total_pages, 3);
    assert.equal(first.results.length, 20);
    assert.equal(first.results[0].title, 'Фильм 44 · ★ 7');
    assert.equal(first.results[0].sled.content_id, 'tmdb:movie:44');
    assert.equal(last.results.length, 5);
});

test('an old profile state without ratings loads', async () => {
    const h = setup({storage: {[STATE]: {cursor: 'c1', items: {}, prefs: {}, conflicts: {}, playbacks: {}, outbox: [],
        deferred: [], synced: 1}}});
    await tick();
    assert.equal(h.KH.ratings().length, 0);
    h.KH.rate(FILM, 6);
    assert.equal(h.KH.ratings()[0].score, 6);
});
