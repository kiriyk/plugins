const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, episodeHash, RICK, MOVIE} = require('./harness.cjs');

const item = {item_key: 'tmdb:tv:60625/s5e10', content_id: 'tmdb:tv:60625', episode_id: 's5e10', position_ms: 1540000,
    duration_ms: 1323000, status: 'in_progress', revision: 4, deleted: false, source: {adapter: 'online_mod', balanser: 'rezka'}};
const changes = () => ({json: {cursor: 'c1', more: false, items: [item], conflicts: [], prefs: [], playbacks: []}});
const fragment = data => new URLSearchParams(data.url.split('#')[1] || '');

test('opening from history seeds the source and resumes without the menu', async () => {
    const h = setup({routes: {'GET /v1/changes': changes}});
    await tick();
    h.KH.open(RICK, item, 'resume');
    const pushed = h.pushes.at(-1);
    assert.equal(pushed.component, 'online_mod');
    assert.equal(pushed.movie.id, 60625);
    assert.equal(pushed.search_two, 'Rick and Morty');
    assert.equal(h.storage.online_mod_balanser, 'rezka');
    assert.equal(h.storage.online_mod_last_balanser['60625'], 'rezka');
    const data = {url: 'http://cdn.test/rm-s5e10.m3u8', timeline: {hash: episodeHash(5, 10, 'Rick and Morty')}};
    h.Lampa.Player.play(data);
    await tick();
    assert.equal(h.selects.length, 0);
    assert.equal(fragment(data).get('mode'), 'resume');
    assert.equal(fragment(data).get('pos'), '1530000');
});

test('"start over" from history begins at zero', async () => {
    const h = setup({routes: {'GET /v1/changes': changes}});
    await tick();
    h.KH.open(RICK, item, 'start');
    const data = {url: 'http://cdn.test/rm-s5e10.m3u8', timeline: {hash: episodeHash(5, 10, 'Rick and Morty')}};
    h.Lampa.Player.play(data);
    await tick();
    assert.equal(fragment(data).get('pos'), '0');
});

test('Showy keeps its balanser; unknown sources open the card', async () => {
    const h = setup();
    await tick();
    h.KH.open(RICK, {...item, source: {adapter: 'showy_free', balanser: 'collaps'}}, 'resume');
    assert.equal(h.pushes.at(-1).component, 'showy_free');
    assert.equal(h.pushes.at(-1).balanser, 'collaps');
    assert.equal(h.storage.online_balanser, 'collaps');
    assert.equal(h.storage.online_last_balanser['60625'], 'collaps');
    h.KH.open(MOVIE, {item_key: 'tmdb:movie:1400940', content_id: 'tmdb:movie:1400940', source: {adapter: 'modss'}}, 'resume');
    const card = h.pushes.at(-1);
    assert.equal(card.component, 'full');
    assert.equal(card.id, 1400940);
    assert.equal(card.method, 'movie');
});
