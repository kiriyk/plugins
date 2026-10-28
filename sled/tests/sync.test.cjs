const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, KEY, STATE} = require('./harness.cjs');

const ITEM = {item_key: 'tmdb:tv:60625/s5e10', content_id: 'tmdb:tv:60625', position_ms: 60000, status: 'in_progress',
    revision: 1, deleted: false};
const page = (cursor, more = false) => () => ({json: {cursor, more, items: [ITEM], conflicts: [], prefs: [], playbacks: []}});

test('sync keeps a cursor per profile and sends the profile key', async () => {
    const h = setup({routes: {'GET /v1/changes': page('c5')}});
    await tick();
    const first = h.sent.filter(r => r.path === '/v1/changes');
    assert.equal(first.length, 1);
    assert.equal(first[0].query, '');
    assert.equal(first[0].headers.Authorization, 'Bearer ' + h.KEY);
    h.KH.sync(); await tick();
    assert.equal(h.sent.at(-1).query, '?cursor=c5');
    assert.equal(h.KH.load().items['tmdb:tv:60625/s5e10'].position_ms, 60000);

    const keyB = 'kadr_' + 'b'.repeat(43);
    h.storage.sled_profiles = [...h.storage.sled_profiles, {name: 'B', key: keyB}];
    h.storage.sled_active = 'B';
    h.KH.sync(); await tick();
    assert.equal(h.sent.at(-1).query, '');
    assert.equal(h.sent.at(-1).headers.Authorization, 'Bearer ' + keyB);
    assert.equal(Object.keys(h.storage).filter(k => k.startsWith('sled_state_')).length, 2);
    assert.ok(!JSON.stringify(Object.keys(h.storage)).includes(keyB));
});

test('sync follows more pages until the feed is complete', async () => {
    let calls = 0;
    const h = setup({routes: {'GET /v1/changes': () => page('c' + (++calls), calls < 3)()}});
    await tick(20);
    assert.equal(h.sent.filter(r => r.path === '/v1/changes').length, 3);
    assert.equal(h.KH.load().cursor, 'c3');
});

test('queued events are kept on network errors and dropped when the server rejects them', async () => {
    const h = setup();
    await tick();
    h.KH.enqueue({type: 'status', item_key: 'tmdb:tv:60625/s5e10', status: 'watched'});
    const queued = h.KH.load().outbox[0];
    assert.match(queued.event_id, /^ev[a-z0-9]{20}$/);
    assert.match(queued.device_id, /^tv[a-z0-9]{20}$/);
    h.routes['POST /v1/events'] = () => ({status: 503});
    h.KH.sync(); await tick();
    assert.equal(h.KH.load().outbox.length, 1);
    h.routes['POST /v1/events'] = () => ({status: 422});
    h.KH.sync(); await tick();
    assert.equal(h.KH.load().outbox.length, 0);
    h.KH.enqueue({type: 'status', item_key: 'tmdb:tv:60625/s5e10', status: 'unwatched'});
    delete h.routes['POST /v1/events'];
    h.routes['POST /v1/events'] = req => ({json: {results: req.body.events.map(e => ({event_id: e.event_id, status: 'applied'}))}});
    h.KH.sync(); await tick();
    assert.equal(h.KH.load().outbox.length, 0);
    assert.equal(h.sent.filter(r => r.path === '/v1/events').at(-1).body.events[0].status, 'unwatched');
});

test('a non-JSON answer is an error, not an exception', async () => {
    const h = setup({routes: {'GET /v1/changes': () => ({raw: '<html>502 Bad Gateway</html>'})}});
    let result;
    h.KH.sync((state, error) => { result = error; });
    await tick();
    assert.equal(result.error, 'bad_json');
});

test('without a profile nothing is requested', async () => {
    const h = setup({noProfile: true});
    let result;
    h.KH.sync((state, error) => { result = error; });
    await tick();
    assert.equal(h.sent.length, 0);
    assert.equal(result.error, 'not_configured');
    assert.equal(h.KH.clock(1540000), '25:40');
    assert.equal(h.KH.clock(3723000), '1:02:03');
});

const applied = req => ({json: {results: req.body.events.map(e => ({event_id: e.event_id, status: 'applied'}))}});

test('an unauthorized or missing endpoint keeps the queue; a rejected batch drops only the bad event', async () => {
    const h = setup();
    await tick();
    ['watched', 'bad', 'unwatched'].forEach(status => h.KH.enqueue({type: 'status', item_key: 'tmdb:movie:7', status}));
    for (const status of [401, 403, 404]) {
        h.routes['POST /v1/events'] = () => ({status});
        h.KH.sync(); await tick();
        assert.equal(h.KH.load().outbox.length, 3, 'kept after ' + status);
    }
    const accepted = [];
    h.routes['POST /v1/events'] = req => {
        if (req.body.events.some(e => e.status === 'bad')) return {status: 422};
        accepted.push(...req.body.events.map(e => e.status));
        return applied(req);
    };
    h.KH.sync(); await tick(30);
    assert.equal(h.KH.load().outbox.length, 0);
    assert.equal(accepted.join(), 'watched,unwatched');
});

test('events queued while a batch is on its way survive the queue limit', async () => {
    const h = setup();
    await tick();
    h.KH.enqueue({type: 'status', item_key: 'tmdb:movie:1', status: 'watched'});
    let calls = 0;
    h.routes['POST /v1/events'] = req => {
        if (++calls > 1) return {status: 503};
        for (let i = 0; i < 500; i++) h.KH.enqueue({type: 'status', item_key: 'tmdb:movie:' + (i + 2), status: 'watched'});
        return applied(req);
    };
    h.KH.sync(); await tick(20);
    const outbox = h.KH.load().outbox;
    assert.equal(outbox.length, 500);
    assert.equal(outbox[0].item_key, 'tmdb:movie:2');
});

test('an event queued while the feed is loading is not lost', async () => {
    const h = setup();
    await tick();
    h.routes['GET /v1/changes'] = () => {
        h.KH.enqueue({type: 'status', item_key: 'tmdb:movie:7', status: 'watched'});
        return page('c7')();
    };
    h.routes['POST /v1/events'] = () => ({status: 503});
    h.KH.sync(); await tick(20);
    assert.equal(h.KH.load().outbox.length, 1);
    assert.equal(h.KH.load().cursor, 'c7');
});

test('a stale cursor starts the feed over instead of failing forever', async () => {
    const h = setup({storage: {[STATE]: {cursor: 'gone', items: {}, prefs: {}, conflicts: {}, playbacks: {},
        outbox: [], deferred: [], synced: 1}}, routes: {'GET /v1/changes': req => req.query ? {status: 400, json: {detail: 'bad_cursor'}} : page('c1')()}});
    let result = 'none';
    h.KH.sync((state, error) => { result = error; });
    await tick(20);
    assert.equal(result, null);
    assert.equal(h.KH.load().cursor, 'c1');
    assert.equal(h.KH.load().items['tmdb:tv:60625/s5e10'].position_ms, 60000);
});

test('switching the profile while a sync runs keeps the histories apart', async () => {
    const keyB = 'kadr_' + 'b'.repeat(43);
    const h = setup({storage: {sled_profiles: [{name: 'A', key: KEY}, {name: 'B', key: keyB}]},
        routes: {'GET /v1/changes': req => {
            // The viewer switches to B while A's page is on its way.
            if (req.headers.Authorization === 'Bearer ' + KEY) { h.storage.sled_active = 'B'; return page('cA')(); }
            return {json: {cursor: 'cB', more: false, items: [], conflicts: [], prefs: [], playbacks: []}};
        }}});
    await tick(30);
    const stateA = h.storage['sled_state_' + hash(h.KEY)], stateB = h.storage['sled_state_' + hash(keyB)];
    assert.equal(stateA.cursor, 'cA');
    assert.ok(stateA.items['tmdb:tv:60625/s5e10']);
    assert.equal(stateB.cursor, 'cB');
    assert.equal(Object.keys(stateB.items).length, 0);
});
