const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE, RICK, MOVIE} = require('./harness.cjs');

const RM = {title: 'Рик и Морти', original_title: 'Rick and Morty', poster: '/rm.jpg', year: 2013};
const record = (key, extra = {}) => {
    const [content, episode] = key.split('/');
    const match = episode ? /^s(\d+)e(\d+)$/.exec(episode) : null;
    return {item_key: key, content_id: content, episode_id: episode || null, season: match ? +match[1] : null,
        episode: match ? +match[2] : null, position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false,
        manual: false, server_ms: 10, client_ms: 10, device_id: 'tvaaaaaaaaaa', revision: 1, meta: RM, ...extra};
};
const seeded = items => ({storage: {[STATE]: {cursor: 'c1', items: Object.fromEntries(items.map(i => [i.item_key, i])), prefs: {},
    conflicts: {}, playbacks: {}, outbox: [], deferred: [], synced: 1}}});
function fullCard(h, movie) {
    const root = h.document.createElement('div'), buttons = h.document.createElement('div');
    buttons.className = 'full-start-new__buttons';
    root.appendChild(buttons);
    const event = {type: 'complite', body: h.$(root), data: {movie}};
    return {root, buttons, send: () => h.events.send('full', event)};
}
function poster(h, data) {
    const html = h.document.createElement('div'), view = h.document.createElement('div');
    view.className = 'card__view';
    html.appendChild(view);
    h.document.body.appendChild(html);
    h.cardMap.Card.onCreate.call({data, html});
    return html;
}

test('the full card gets one Sled button for a title with history', async () => {
    const h = setup(seeded([record('tmdb:tv:60625/s6e7')]));
    await tick();
    const card = fullCard(h, RICK);
    card.send();
    card.send();
    const found = card.buttons.querySelectorAll('.sled-button');
    assert.equal(found.length, 1);
    assert.ok(found[0].classList.contains('selector'));
    assert.equal(found[0].textContent, 'Sled · S6E7 · 12:30 из 21:18');
    h.$(found[0]).trigger('hover:enter');
    assert.equal(h.selects.at(-1).items[0].title, 'Продолжить с 12:30');
});

test('no button for a title without history or for other full card events', async () => {
    const h = setup(seeded([record('tmdb:tv:60625/s6e7')]));
    await tick();
    const card = fullCard(h, MOVIE);
    card.send();
    assert.equal(card.buttons.querySelectorAll('.sled-button').length, 0);
    const other = fullCard(h, RICK);
    h.events.send('full', {type: 'start', body: h.$(other.root), data: {movie: RICK}});
    assert.equal(other.buttons.querySelectorAll('.sled-button').length, 0);
});

test('posters get a progress bar or a watched mark', async () => {
    const h = setup(seeded([record('tmdb:tv:60625/s6e7'), record('tmdb:movie:1400940', {status: 'watched', meta: {title: 'Клэйфейс'}})]));
    await tick();
    const series = poster(h, RICK);
    assert.equal(series.querySelector('.sled-mark').getAttribute('data-sled'), 'tmdb:tv:60625');
    assert.equal(series.querySelector('.sled-mark .sled-mark__bar').style.width, '59%');
    const movie = poster(h, MOVIE);
    assert.ok(movie.querySelector('.sled-mark').classList.contains('sled-mark--watched'));
    const person = poster(h, {name: 'Актёр', profile_path: '/p.jpg'});
    assert.equal(person.querySelector('.sled-mark'), null);
    const unknown = poster(h, {id: 1, title: 'Другой фильм', source: 'tmdb'});
    assert.equal(unknown.querySelector('.sled-mark'), null);
    assert.equal(h.cardCreated, 4);
});

test('marks follow the history after a sync', async () => {
    const h = setup(seeded([record('tmdb:tv:60625/s6e7')]));
    await tick();
    const series = poster(h, RICK);
    const state = h.state();
    state.items['tmdb:tv:60625/s6e7'].position_ms = 1278000 / 2;
    h.storage[STATE] = state;
    h.events.send('sled', {type: 'synced'});
    assert.equal(series.querySelector('.sled-mark .sled-mark__bar').style.width, '50%');
    state.items['tmdb:tv:60625/s6e7'].deleted = true;
    h.events.send('sled', {type: 'synced'});
    assert.equal(series.querySelector('.sled-mark'), null);
});

test('the card module is wrapped once and the style is added once', async () => {
    const h = setup();
    await tick();
    assert.equal(h.cardMap.Card.onCreate.__sled, true);
    assert.equal(h.document.head.children.filter(el => el.id === 'sled-style').length, 1);
});
