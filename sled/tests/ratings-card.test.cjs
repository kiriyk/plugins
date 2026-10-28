const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, tick, STATE, RICK, MOVIE} = require('./harness.cjs');

const state = (ratings = {}, items = {}) => ({storage: {[STATE]: {cursor: 'c1', items, prefs: {}, conflicts: {}, playbacks: {},
    outbox: [], deferred: [], synced: 1, ratings, offered: {}}}});
const rated = (id, score, comment = null) => ({[id]: {content_id: id, score, comment, meta: {title: 'Клэйфейс'}, rated_ms: 5,
    server_ms: 5, device_id: 'tvotherdevice', deleted: false}});
function fullCard(h, movie) {
    const root = h.document.createElement('div'), buttons = h.document.createElement('div');
    buttons.className = 'full-start-new__buttons';
    root.appendChild(buttons);
    const event = {type: 'complite', body: h.$(root), data: {movie}};
    return {buttons, send: () => h.events.send('full', event)};
}
const titles = h => h.selects.at(-1).items.map(item => item.title).join('|');
const choose = (h, title) => { const select = h.selects.at(-1); select.onSelect(select.items.find(item => item.title === title)); };
const enter = (h, card) => h.$(card.buttons.querySelector('.sled-rate')).trigger('hover:enter');

test('a movie without history gets a rate button and can be rated', async () => {
    const h = setup();
    await tick();
    const card = fullCard(h, MOVIE);
    card.send();
    const buttons = card.buttons.querySelectorAll('.sled-rate');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, 'Оценить');
    assert.ok(buttons[0].classList.contains('selector'));
    enter(h, card);
    assert.equal(titles(h), 'Поставить оценку');
    choose(h, 'Поставить оценку');
    assert.equal(h.selects.at(-1).items.length, 10);
    assert.equal(titles(h), '★ 10|★ 9|★ 8|★ 7|★ 6|★ 5|★ 4|★ 3|★ 2|★ 1');
    choose(h, '★ 8');
    const record = h.KH.ratings()[0];
    assert.equal(JSON.stringify([record.content_id, record.score, record.meta.title]), JSON.stringify(['tmdb:movie:1400940', 8, 'Клэйфейс']));
    assert.equal(buttons[0].textContent, '★ 8');
});

test('a series is rated as a whole', async () => {
    const h = setup();
    await tick();
    const card = fullCard(h, RICK);
    card.send();
    enter(h, card);
    choose(h, 'Поставить оценку');
    choose(h, '★ 9');
    assert.equal(h.KH.ratings()[0].content_id, 'tmdb:tv:60625');
});

test('a rated card shows the score; the menu edits, comments and removes', async () => {
    const h = setup(state(rated('tmdb:movie:1400940', 8)));
    await tick();
    const card = fullCard(h, MOVIE);
    card.send();
    assert.equal(card.buttons.querySelector('.sled-rate').textContent, '★ 8');
    enter(h, card);
    assert.equal(h.selects.at(-1).title, 'Оценка · Клэйфейс');
    assert.equal(titles(h), 'Изменить оценку (★ 8)|Добавить впечатления|Удалить оценку');
    choose(h, 'Добавить впечатления');
    assert.equal(JSON.stringify(h.inputs.at(-1).params), JSON.stringify({title: 'Впечатления', value: '', free: true, nosave: true}));
    h.inputs.at(-1).done('  Сильный финал  ');
    assert.equal(JSON.stringify([h.KH.ratings()[0].comment, h.KH.ratings()[0].score]), JSON.stringify(['Сильный финал', 8]));
    enter(h, card);
    assert.equal(titles(h), 'Изменить оценку (★ 8)|Впечатления|Удалить оценку');
    choose(h, 'Впечатления');
    assert.equal(h.inputs.at(-1).params.value, 'Сильный финал');
    enter(h, card);
    choose(h, 'Удалить оценку');
    assert.equal(h.selects.at(-1).title, 'Удалить оценку «Клэйфейс»?');
    choose(h, 'Удалить');
    assert.equal(h.KH.ratings().length, 0);
    assert.equal(card.buttons.querySelector('.sled-rate').textContent, 'Оценить');
});

test('without Lampa.Input the menu has no comment items', async () => {
    const h = setup({...state(rated('tmdb:movie:1400940', 8)), missing: ['Input']});
    await tick();
    const card = fullCard(h, MOVIE);
    card.send();
    enter(h, card);
    assert.equal(titles(h), 'Изменить оценку (★ 8)|Удалить оценку');
});

test('the rate button is added once per card and coexists with the Sled button', async () => {
    const item = {item_key: 'tmdb:tv:60625/s6e7', content_id: 'tmdb:tv:60625', episode_id: 's6e7', season: 6, episode: 7,
        position_ms: 750000, duration_ms: 1278000, status: 'in_progress', deleted: false, server_ms: 1, client_ms: 1, meta: {title: 'Рик и Морти'}};
    const h = setup(state({}, {[item.item_key]: item}));
    await tick();
    const card = fullCard(h, RICK);
    card.send();
    card.send();
    assert.equal(card.buttons.querySelectorAll('.sled-rate').length, 1);
    assert.equal(card.buttons.querySelectorAll('.sled-button').length, 1);
});

test('without a paired profile the card has no rate button', async () => {
    const h = setup({noProfile: true});
    await tick();
    const card = fullCard(h, MOVIE);
    card.send();
    assert.equal(card.buttons.querySelectorAll('.sled-rate').length, 0);
    h.KH.rate({content_id: 'tmdb:movie:7', meta: {title: 'Фильм'}}, 8);
    assert.equal(h.KH.ratings().length, 0);
});
