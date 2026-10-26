const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, episodeHash} = require('./harness.cjs');

function episode(season, number) {
    const url = `http://cdn.test/rm-s${season}e${number}.m3u8`;
    return {url, title: `S${season} / Серия ${number}`, timeline: {hash: episodeHash(season, number, 'Rick and Morty'), time: 0},
        quality: {'​1080p': url, '​720p': url.replace('.m3u8', '-720.m3u8')}};
}
function startEpisode(h, season, number) {
    const data = episode(season, number);
    h.Lampa.Player.play(data);
    h.Lampa.Player.playlist([episode(season, number - 1), data, episode(season, number + 1)]);
    return data;
}
const fragment = data => new URLSearchParams(data.url.split('#')[1] || '');
const saved = (position, extra = {}) => ({item_key: 'tmdb:tv:60625/s5e10', content_id: 'tmdb:tv:60625', episode_id: 's5e10',
    position_ms: position, duration_ms: 1323000, status: 'in_progress', revision: 4, deleted: false, ...extra});
const changes = items => () => ({json: {cursor: 'c9', more: false, items, conflicts: [], prefs: [], playbacks: []}});

test('a launch without progress registers the playback and hands KADR the fragment', async () => {
    const h = setup();
    await tick();
    const data = startEpisode(h, 5, 10);
    await tick();
    assert.equal(h.launched().length, 1);
    assert.equal(h.launched()[0], data);
    const f = fragment(data);
    assert.equal(f.get('kadr'), '1');
    assert.equal(f.get('mode'), 'start');
    assert.equal(f.get('pos'), '0');
    assert.equal(f.get('next'), '1');
    assert.match(f.get('pid'), /^pb[a-z0-9]{20}$/);
    assert.match(f.get('tok'), /^kadrl_/);
    assert.equal(f.get('srv'), 'https://kadr.test');
    assert.match(f.get('dev'), /^tv[a-z0-9]{20}$/);
    assert.equal(f.get('cid'), 'tmdb:tv:60625');
    assert.equal(f.get('eid'), 's5e10');
    assert.ok(!data.url.includes(h.KEY));
    const suffix = '#' + data.url.split('#')[1];
    assert.ok(Object.values(data.quality).every(url => url.endsWith(suffix)));
    const registration = h.sent.find(r => r.path === '/v1/playbacks').body;
    assert.equal(registration.playback_id, f.get('pid'));
    assert.equal(JSON.stringify([registration.content.content_id, registration.content.episode_id, registration.content.season,
        registration.content.episode]), '["tmdb:tv:60625","s5e10",5,10]');
    assert.equal(registration.mode, 'start');
    assert.equal(registration.has_next, true);
    assert.equal(registration.base_revision, 0);
    assert.equal(JSON.stringify(registration.source), '{"adapter":"online_mod","balanser":null,"voice":null,"quality":"1080p","ids":{}}');
    assert.equal(h.playlists.at(-1).length, 3);
    assert.equal(h.state().outbox[0].type, 'prefs');
    assert.equal(h.selects.length, 0);
    assert.equal(h.sent.filter(r => r.path === '/v1/playbacks').length, 1);
});

test('saved progress asks; continue rewinds 10 s, start begins at zero', async () => {
    const h = setup({routes: {'GET /v1/changes': changes([saved(1540000)])}});
    await tick();
    startEpisode(h, 5, 10);
    await tick();
    assert.equal(h.launched().length, 0);
    const menu = h.selects.at(-1);
    assert.equal(menu.items.map(i => i.title).join('|'), 'Продолжить с 25:40|Сначала');
    menu.onSelect(menu.items[0]);
    await tick();
    let data = h.launched().at(-1);
    assert.equal(fragment(data).get('mode'), 'resume');
    assert.equal(fragment(data).get('pos'), '1530000');
    assert.equal(h.sent.filter(r => r.path === '/v1/playbacks').at(-1).body.base_revision, 4);

    startEpisode(h, 5, 10);
    await tick();
    h.selects.at(-1).onSelect(h.selects.at(-1).items[1]);
    await tick();
    data = h.launched().at(-1);
    assert.equal(fragment(data).get('mode'), 'start');
    assert.equal(fragment(data).get('pos'), '0');
});

test('progress under 10 seconds starts from zero without asking', async () => {
    const h = setup({routes: {'GET /v1/changes': changes([saved(8000)])}});
    await tick();
    const data = startEpisode(h, 5, 10);
    await tick();
    assert.equal(h.selects.length, 0);
    assert.equal(fragment(data).get('pos'), '0');
});

test('inner player, disabled plugin and unknown episodes are not intercepted', async () => {
    for (const storage of [{player: 'inner'}, {kh_enabled: false}]) {
        const h = setup({storage});
        await tick();
        const data = startEpisode(h, 5, 10);
        await tick();
        assert.equal(h.launched()[0], data);
        assert.equal(data.url.includes('#'), false);
    }
    const h = setup();
    await tick();
    const odd = {url: 'http://cdn.test/x.m3u8', timeline: {hash: '42'}};
    h.Lampa.Player.play(odd);
    await tick();
    assert.equal(h.launched()[0], odd);
    assert.equal(odd.url, 'http://cdn.test/x.m3u8');
});

test('without the server KADR still gets the start position, without a token', async () => {
    const h = setup({routes: {'POST /v1/playbacks': () => ({status: 503})}});
    await tick();
    const data = startEpisode(h, 5, 10);
    await tick();
    const f = fragment(data);
    assert.equal(f.get('mode'), 'start');
    assert.equal(f.get('next'), '1');
    assert.equal(f.get('tok'), null);
    assert.equal(f.get('pid'), null);
    assert.equal(h.storage.kh_pending.registered, false);

    const none = setup({noProfile: true});
    await tick();
    const other = startEpisode(none, 5, 10);
    await tick();
    assert.equal(fragment(other).get('kadr'), '1');
    assert.equal(none.sent.length, 0);
});

test('an existing fragment from an earlier launch is replaced, not doubled', async () => {
    const h = setup();
    await tick();
    const data = episode(5, 10);
    data.url += '#kadr=1&mode=start&pos=0&next=0';
    h.Lampa.Player.play(data);
    await tick();
    assert.equal(data.url.split('#').length, 2);
    assert.equal(fragment(data).get('next'), '0');
    const foreign = episode(5, 10);
    foreign.url += '#t=10';
    h.Lampa.Player.play(foreign);
    await tick();
    assert.equal(foreign.url, 'http://cdn.test/rm-s5e10.m3u8#t=10');
});
