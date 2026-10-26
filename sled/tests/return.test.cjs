const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, episodeHash, MOVIE} = require('./harness.cjs');

function episode(season, number) {
    const url = `http://cdn.test/rm-s${season}e${number}.m3u8`;
    return {url, title: `S${season} / Серия ${number}`, timeline: {hash: episodeHash(season, number, 'Rick and Morty'), time: 0},
        quality: {'​1080p': url}};
}
function startEpisode(h, season, number) {
    const data = episode(season, number);
    const list = [episode(season, number - 1), data, episode(season, number + 1)];
    h.Lampa.Player.play(data);
    h.Lampa.Player.playlist(list);
    return {data, list};
}
const fragment = data => new URLSearchParams(data.url.split('#')[1] || '');
const H510 = episodeHash(5, 10, 'Rick and Morty');
const changes = (items, playbacks = []) => () => ({json: {cursor: 'c9', more: false, items, conflicts: [], prefs: [], playbacks}});
const saved11 = {item_key: 'tmdb:tv:60625/s5e11', content_id: 'tmdb:tv:60625', episode_id: 's5e11', position_ms: 600000,
    duration_ms: 1323000, status: 'in_progress', revision: 2, deleted: false};

test('after KADR asked for the next episode the plugin plays it without a menu', async () => {
    const h = setup({routes: {'GET /v1/changes': changes([saved11])}});
    await tick();
    const {data, list} = startEpisode(h, 5, 10);
    await tick();
    const pid = fragment(data).get('pid');
    h.routes['GET /v1/changes'] = changes([], [{playback_id: pid, next_requested: true}]);
    h.returned(H510, {time: 0, duration: 0, percent: 100});
    await tick(40);
    const next = h.launched().at(-1);
    assert.equal(next.url.split('#')[0], 'http://cdn.test/rm-s5e11.m3u8');
    assert.equal(next.url.split('#').length, 2);
    assert.equal(fragment(next).get('eid'), 's5e11');
    assert.equal(fragment(next).get('mode'), 'resume');
    assert.equal(fragment(next).get('pos'), '590000');
    assert.equal(h.selects.length, 0);
    assert.equal(list[2].url, 'http://cdn.test/rm-s5e11.m3u8');
});

test('a finished episode without a next request starts nothing', async () => {
    const h = setup();
    await tick();
    startEpisode(h, 5, 10);
    await tick();
    const launches = h.launched().length;
    h.returned(H510, {time: 0, duration: 0, percent: 100});
    await tick(40);
    assert.equal(h.launched().length, launches);
    assert.equal(h.selects.length, 0);
});

test('when the server cannot confirm, a finished episode asks about the next one', async () => {
    const h = setup();
    await tick();
    startEpisode(h, 5, 10);
    await tick();
    h.routes['GET /v1/changes'] = () => ({status: 503});
    h.returned(H510, {time: 0, duration: 0, percent: 100});
    await tick(20);
    const ask = h.selects.at(-1);
    assert.equal(ask.title, 'Следующая серия?');
    ask.onSelect(ask.items[0]);
    await tick(20);
    assert.equal(h.launched().at(-1).url.split('#')[0], 'http://cdn.test/rm-s5e11.m3u8');
});

test('the return reports the position Lampa received from KADR', async () => {
    const h = setup({activity: {component: 'online_mod', movie: MOVIE}});
    await tick();
    const data = {url: 'http://cdn.test/clayface.m3u8', title: 'Клэйфейс', timeline: {hash: hash('Clayface')}};
    h.Lampa.Player.play(data);
    await tick();
    const pid = fragment(data).get('pid');
    h.returned(hash('Clayface'), {time: 452, duration: 6128, percent: 7});
    await tick(20);
    const events = h.sent.filter(r => r.path === '/v1/events').flatMap(r => r.body.events);
    const progress = events.find(e => e.type === 'progress');
    assert.equal(progress.playback_id, pid);
    assert.equal(progress.sequence, null);
    assert.equal(progress.position_ms, 452000);
    assert.equal(progress.duration_ms, 6128000);
    assert.equal(progress.started, true);
    assert.equal(h.storage.sled_pending, null);
});

test('a launch that could not be registered is registered on return, then reported', async () => {
    const h = setup({activity: {component: 'online_mod', movie: MOVIE}, routes: {'POST /v1/playbacks': () => ({status: 503})}});
    await tick();
    const data = {url: 'http://cdn.test/clayface.m3u8', timeline: {hash: hash('Clayface')}};
    h.Lampa.Player.play(data);
    await tick();
    h.routes['POST /v1/playbacks'] = req => ({json: {playback_id: req.body.playback_id, launch_token: 'kadrl_' + 'x'.repeat(32)}});
    h.returned(hash('Clayface'), {time: 120, duration: 6128, percent: 1});
    await tick(30);
    const registrations = h.sent.filter(r => r.path === '/v1/playbacks');
    assert.equal(registrations.length, 2);
    assert.equal(registrations[0].body.playback_id, registrations[1].body.playback_id);
    const events = h.sent.filter(r => r.path === '/v1/events').flatMap(r => r.body.events);
    assert.equal(events.find(e => e.type === 'progress').playback_id, registrations[0].body.playback_id);
    assert.equal(h.KH.load().deferred.length, 0);
});

test('updates for other hashes or without a launch are ignored', async () => {
    const h = setup();
    await tick();
    h.returned(H510, {time: 10, duration: 100, percent: 10});
    await tick();
    assert.equal(h.sent.filter(r => r.path === '/v1/events').length, 0);
});
