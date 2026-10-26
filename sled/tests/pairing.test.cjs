const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick} = require('./harness.cjs');

const DEVICE_KEY = 'kadr_' + 'd'.repeat(43);
const TOKEN = 'p'.repeat(43);
const started = () => ({json: {code: 'K7M-4QX', poll_token: TOKEN, expires_ms: 1}});

test('pairing shows the code, polls without a key and saves the approved profile', async () => {
    const polls = [];
    const h = setup({noProfile: true, maxDelay: 0, routes: {
        'POST /v1/pair/start': started,
        'POST /v1/pair/poll': req => {
            polls.push(req);
            return polls.length < 3 ? {json: {status: 'pending'}} : {json: {status: 'approved', name: 'Дом', key: DEVICE_KEY}};
        }}});
    await tick();
    h.press('sled_pair');
    await tick(30);
    assert.equal(h.sent.find(r => r.path === '/v1/pair/start').headers.Authorization, undefined);
    const shown = h.selects[0];
    assert.equal(shown.items[0].title, 'K7M-4QX');
    assert.match(shown.items[0].subtitle, /kadr_sync\.cli pair K7M-4QX/);
    assert.equal(polls.length, 3);
    assert.equal(polls[0].body.poll_token, TOKEN);
    assert.equal(polls[0].headers.Authorization, undefined);
    assert.equal(JSON.stringify(h.storage.sled_profiles), JSON.stringify([{name: 'Дом', key: DEVICE_KEY}]));
    assert.equal(h.storage.sled_active, 'Дом');
    assert.equal(h.closed, 1);
    assert.match(h.notices.at(-1), /привязано к профилю «Дом»/);
    assert.ok(!h.notices.join(' ').includes(DEVICE_KEY));
    assert.equal(h.sent.at(-1).path, '/v1/changes');
    assert.equal(h.sent.at(-1).headers.Authorization, 'Bearer ' + DEVICE_KEY);
});

test('an expired code stops polling and says so', async () => {
    let polls = 0;
    const h = setup({noProfile: true, maxDelay: 0, routes: {
        'POST /v1/pair/start': started,
        'POST /v1/pair/poll': () => { polls++; return {status: 404}; }}});
    await tick();
    h.press('sled_pair');
    await tick(30);
    assert.equal(polls, 1);
    assert.match(h.notices.at(-1), /истёк/);
    assert.equal(h.storage.sled_profiles, undefined);
});

test('cancelling stops polling', async () => {
    let polls = 0;
    const h = setup({noProfile: true, maxDelay: 5, routes: {
        'POST /v1/pair/start': started,
        'POST /v1/pair/poll': () => { polls++; return {json: {status: 'pending'}}; }}});
    await tick();
    h.press('sled_pair');
    await tick();
    const menu = h.selects.at(-1);
    menu.onSelect(menu.items[1]);
    const after = polls;
    await tick(40);
    assert.equal(polls, after);
});

test('pairing needs the server address first', async () => {
    const h = setup({noProfile: true, storage: {sled_server: ''}});
    await tick();
    h.press('sled_pair');
    await tick();
    assert.equal(h.sent.length, 0);
    assert.match(h.notices.at(-1), /адрес сервера/);
});
