const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick} = require('./harness.cjs');

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
    h.storage.kh_profiles = [...h.storage.kh_profiles, {name: 'B', key: keyB}];
    h.storage.kh_active = 'B';
    h.KH.sync(); await tick();
    assert.equal(h.sent.at(-1).query, '');
    assert.equal(h.sent.at(-1).headers.Authorization, 'Bearer ' + keyB);
    assert.equal(Object.keys(h.storage).filter(k => k.startsWith('kh_state_')).length, 2);
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
