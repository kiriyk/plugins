const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE, RICK, MOVIE} = require('./harness.cjs');

const score = (id, value, title, at) => ({content_id: id, score: value, comment: null, meta: {title, poster: '/p.jpg'},
    rated_ms: at, server_ms: at, device_id: 'tvotherdevice', deleted: false});
const seeded = (ratings, items = {}) => ({storage: {[STATE]: {cursor: 'c1', items, prefs: {}, conflicts: {}, playbacks: {},
    outbox: [], deferred: [], synced: 1, offered: {}, ratings: Object.fromEntries(ratings.map(r => [r.content_id, r]))}}});
function poster(h, data) {
    const html = h.document.createElement('div'), view = h.document.createElement('div');
    view.className = 'card__view';
    html.appendChild(view);
    h.document.body.appendChild(html);
    h.cardMap.Card.onCreate.call({data, html});
    return html;
}
const list = (h, params) => new Promise(resolve => h.sources.sled.list(params, json => resolve({json}), () => resolve({error: true})));
const titles = h => h.selects.at(-1).items.map(item => item.title);

test('a rated poster gets a score badge at the top left', async () => {
    const progress = {item_key: 'tmdb:movie:1400940', content_id: 'tmdb:movie:1400940', episode_id: null, position_ms: 600000,
        duration_ms: 6128000, status: 'in_progress', deleted: false, server_ms: 1, client_ms: 1, meta: {title: 'Клэйфейс'}};
    const h = setup(seeded([score('tmdb:movie:1400940', 8, 'Клэйфейс', 5)], {[progress.item_key]: progress}));
    await tick();
    const movie = poster(h, MOVIE);
    const badge = movie.querySelector('.sled-score');
    assert.equal(badge.textContent, '★ 8');
    assert.equal(badge.getAttribute('data-sled-score'), 'tmdb:movie:1400940');
    assert.ok(movie.querySelector('.sled-mark'));
    assert.equal(poster(h, RICK).querySelector('.sled-score'), null);
    const style = h.document.getElementById('sled-style').textContent;
    assert.match(style, /\.sled-score\{[^}]*left:\.35em[^}]*top:\.35em/);
});

test('the badge follows sync', async () => {
    const h = setup(seeded([score('tmdb:movie:1400940', 8, 'Клэйфейс', 5)]));
    await tick();
    const movie = poster(h, MOVIE);
    const state = h.state();
    state.ratings['tmdb:movie:1400940'].score = 6;
    h.storage[STATE] = state;
    h.events.send('sled', {type: 'synced'});
    assert.equal(movie.querySelector('.sled-score').textContent, '★ 6');
    state.ratings['tmdb:movie:1400940'].deleted = true;
    h.events.send('sled', {type: 'synced'});
    assert.equal(movie.querySelector('.sled-score'), null);
});

test('my ratings lists rated titles newest first and opens the rating menu', async () => {
    const h = setup(seeded([score('tmdb:movie:1400940', 8, 'Клэйфейс', 5), score('tmdb:tv:60625', 9, 'Рик и Морти', 7)]));
    await tick();
    const button = h.buttons.find(entry => entry.title === 'История');
    button.action();
    assert.equal(titles(h).join('|'), 'Продолжить просмотр|Вся история|Мои оценки');
    h.selects.at(-1).onSelect(h.selects.at(-1).items[2]);
    const pushed = h.pushes.at(-1);
    assert.equal(JSON.stringify([pushed.component, pushed.source, pushed.url, pushed.title]),
        JSON.stringify(['category_full', 'sled', 'rated', 'Мои оценки']));
    const {json} = await list(h, {url: 'rated', page: 1});
    assert.equal(json.results.map(card => card.name || card.title).join('|'), 'Рик и Морти · ★ 9|Клэйфейс · ★ 8');
    json.results[1].params.emit.onlyEnter();
    assert.equal(h.selects.at(-1).title, 'Оценка · Клэйфейс');
    assert.equal(titles(h).at(-1), 'Открыть карточку');
    h.selects.at(-1).onSelect(h.selects.at(-1).items.at(-1));
    const opened = h.pushes.at(-1);
    assert.equal(JSON.stringify([opened.component, opened.id, opened.method, opened.card.title]),
        JSON.stringify(['full', 1400940, 'movie', 'Клэйфейс']));
});

test('no ratings gives an empty page error', async () => {
    const h = setup();
    await tick();
    assert.equal((await list(h, {url: 'rated', page: 1})).error, true);
});

test('poster drawing still reads the state once', async () => {
    const many = Array.from({length: 300}, (_, i) => score('tmdb:movie:' + (i + 1), 7, 'Фильм ' + i, i));
    const h = setup(seeded(many));
    await tick();
    const get = h.Lampa.Storage.get;
    let reads = 0;
    h.Lampa.Storage.get = (key, fallback) => { if (key === STATE) reads++; return get(key, fallback); };
    for (let i = 1; i <= 200; i++) poster(h, {id: i, title: 'Фильм', source: 'tmdb'});
    assert.ok(reads <= 1, 'state read ' + reads + ' times');
    assert.equal(h.document.querySelectorAll('.sled-score').length, 200);
});

test('a poster drawn before the rating gets its badge after the sync', async () => {
    const h = setup();
    await tick();
    const movie = poster(h, MOVIE);
    assert.equal(movie.querySelector('.sled-score'), null);
    h.KH.rate({content_id: 'tmdb:movie:1400940', meta: {title: 'Клэйфейс'}}, 8);
    await tick();
    assert.equal(movie.querySelectorAll('.sled-score').length, 1);
    assert.equal(movie.querySelector('.sled-score').textContent, '★ 8');
    h.events.send('sled', {type: 'synced'});
    assert.equal(movie.querySelectorAll('.sled-score').length, 1);
});
