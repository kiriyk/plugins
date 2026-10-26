const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, hash, episodeHash, RICK, MOVIE} = require('./harness.cjs');

test('an Online Mod episode is found by the timeline hash alone', async () => {
    const h = setup();
    await tick();
    const found = h.KH.identify(RICK, {title: 'S5 / Серия 10', timeline: {hash: episodeHash(5, 10, 'Rick and Morty')}});
    assert.equal(found.item_key, 'tmdb:tv:60625/s5e10');
    assert.equal(found.episode_id, 's5e10');
    assert.equal(found.season, 5);
    assert.equal(found.episode, 10);
    assert.equal(found.meta.title, 'Рик и Морти');
    assert.equal(found.meta.original_title, 'Rick and Morty');
    assert.equal(found.meta.year, 2013);
    assert.equal(found.meta.poster, '/rm.jpg');
});

test('Showy season and episode are used when they match the hash', async () => {
    const h = setup();
    await tick();
    assert.equal(h.KH.identify(RICK, {season: 6, episode: 5, timeline: {hash: '803427190'}}).episode_id, 's6e5');
    assert.equal(h.KH.identify(RICK, {season: 1, episode: 1, timeline: {hash: '803427190'}}).episode_id, 's6e5');
});

test('movies, CUB cards and unknown episodes', async () => {
    const h = setup();
    await tick();
    const movie = h.KH.identify(MOVIE, {timeline: {hash: hash('Clayface')}});
    assert.equal(movie.item_key, 'tmdb:movie:1400940');
    assert.equal(movie.episode_id, null);
    assert.equal(movie.meta.year, 2026);
    assert.equal(h.KH.identify({...MOVIE, source: 'cub'}, {}).content_id, 'tmdb:movie:1400940');
    assert.equal(h.KH.identify(RICK, {timeline: {hash: '1'}}), null);
    assert.equal(h.KH.identify(RICK, {}), null);
    assert.equal(h.KH.identify(null, {}), null);
});

test('a series card without the season count is still searched quickly', async () => {
    const h = setup();
    await tick();
    const card = {...RICK};
    delete card.number_of_seasons;
    const started = Date.now();
    assert.equal(h.KH.identify(card, {timeline: {hash: '1'}}), null);
    assert.equal(h.KH.identify(card, {timeline: {hash: episodeHash(12, 3, 'Rick and Morty')}}).episode_id, 's12e3');
    assert.ok(Date.now() - started < 1000);
});
