const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick} = require('./harness.cjs');

test('saving a profile checks the key with the server and clears the input', async () => {
    const h = setup({noProfile: true});
    await tick();
    const key = 'kadr_' + 'c'.repeat(43);
    h.storage.kh_profile_key = key;
    h.press('kh_profile_save');
    await tick();
    const check = h.sent.find(r => r.path === '/v1/profile');
    assert.equal(check.headers.Authorization, 'Bearer ' + key);
    assert.equal(JSON.stringify(h.storage.kh_profiles), JSON.stringify([{name: 'A', key}]));
    assert.equal(h.storage.kh_active, 'A');
    assert.equal(h.storage.kh_profile_key, '');
    assert.ok(!h.notices.join(' ').includes(key));
    assert.ok(h.sent.some(r => r.path === '/v1/changes'));

    h.storage.kh_profile_key = 'kadr_' + 'd'.repeat(43);
    h.routes['GET /v1/profile'] = () => ({status: 401});
    h.press('kh_profile_save');
    await tick();
    assert.equal(h.storage.kh_profiles.length, 1);
    assert.equal(h.storage.kh_profile_key, '');
    assert.match(h.notices.at(-1), /не принял/);
});

test('a value that is not a profile key is not sent anywhere', async () => {
    const h = setup({noProfile: true});
    await tick();
    h.storage.kh_profile_key = 'https://kadr.test';
    h.press('kh_profile_save');
    await tick();
    assert.equal(h.sent.length, 0);
    assert.match(h.notices.at(-1), /kadr_/);
});

test('switching profiles changes the active one and can remove it from the device', async () => {
    const keyB = 'kadr_' + 'b'.repeat(43);
    const h = setup({storage: {kh_profiles: [{name: 'A', key: 'kadr_' + 'a'.repeat(43)}, {name: 'B', key: keyB}]}});
    await tick();
    h.press('kh_profile_switch');
    const menu = h.selects.at(-1);
    assert.equal(menu.items.map(i => i.title).join('|'), 'A ✓|B|Удалить профиль «A» с этого устройства');
    menu.onSelect(menu.items[1]);
    await tick();
    assert.equal(h.storage.kh_active, 'B');
    assert.equal(h.sent.at(-1).headers.Authorization, 'Bearer ' + keyB);
    h.press('kh_profile_switch');
    h.selects.at(-1).onSelect(h.selects.at(-1).items[2]);
    await tick();
    assert.equal(h.storage.kh_profiles.map(p => p.name).join(), 'A');
    assert.equal(h.storage.kh_active, 'A');
});

test('connection check reports the profile and threshold', async () => {
    const h = setup();
    await tick();
    h.press('kh_check');
    await tick();
    assert.equal(h.notices.at(-1), 'KADR: сервер доступен, профиль «A», порог 95%');
    h.routes['GET /v1/profile'] = () => ({status: 502});
    h.press('kh_check');
    await tick();
    assert.equal(h.notices.at(-1), 'KADR: сервер недоступен (код 502)');
});
