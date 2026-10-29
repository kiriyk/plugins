const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick} = require('./harness.cjs');

const pulled = h => h.sent.filter(r => r.path === '/v1/changes').length;

test('returning to the app pulls fresh changes', async () => {
    const h = setup();
    await tick();
    assert.equal(pulled(h), 1);
    h.document.hidden = true;
    h.document.dispatch('visibilitychange');
    await tick();
    assert.equal(pulled(h), 1, 'going to the background is not a sync trigger');
    h.document.hidden = false;
    h.document.dispatch('visibilitychange');
    await tick();
    assert.equal(pulled(h), 2);
});

test('the main screen shelf asks for fresh data at most once a minute', async () => {
    const h = setup();
    await tick();
    const row = h.rows.find(r => r.name === 'sled_continue');
    row.call({}, 'main');
    await tick();
    assert.equal(pulled(h), 2, 'the first shelf render syncs');
    row.call({}, 'main');
    await tick();
    assert.equal(pulled(h), 2, 'a minute has not passed: throttled');
});

test('auto sync does not run without a profile', async () => {
    const h = setup({noProfile: true});
    await tick();
    h.document.dispatch('visibilitychange');
    await tick();
    assert.equal(h.sent.length, 0);
});
