const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const filename = path.join(__dirname, '../catalog-ratings.js');
const code = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
const tick = () => new Promise(resolve => setTimeout(resolve, 150));
const isImdb = r => r.url.includes('api.agregarr.org');
const isKp = r => r.url.includes('kinopoiskapiunofficial');
const ids = url => [...url.matchAll(/id=(tt\d+)/g)].map(m => m[1]);

// Lampa 3.3.8 contracts: Maker.map('Card').Card.onCreate, instance.use,
// onVisible/onDestroy, DOM card_data, Reguest.silent and SettingsApi.
// Kinopoisk options: error, response, respond(url). Agregarr options: imdbError, imdbRatings.
function setup(t, options = {}) {
    const {document} = parseHTML('<html><head></head><body></body></html>');
    const window = {};
    const storage = {...options.storage};
    const requests = [], external = [], notices = [], parameters = [];
    const timers = new Set(), callbacks = new Map();
    let now = Date.now();
    class Clock extends Date { static now() {return now;} }
    // Unref: retries scheduled after a test ends must not keep the runner alive.
    const later = (fn, ms) => {const id = setTimeout(() => {timers.delete(id); callbacks.delete(id); fn();}, ms); id.unref(); timers.add(id); callbacks.set(id, {fn, at: now + ms}); return id;};
    t.after(() => {for (const id of timers) clearTimeout(id);});
    const map = {Card: {onCreate() {
        this.html = document.createElement('div');
        this.html.className = 'card';
        this.html.innerHTML = '<div class="card__view"><span class="card__vote">6.2</span></div>';
        this.html.card_data = this.data;
        document.body.appendChild(this.html);
    }}};
    const imdbRatings = options.imdbRatings || {tt0111161: 9.3};
    function answer(request) {
        const {url, ok, fail} = request;
        if (url.includes('api.agregarr.org')) {
            if (options.imdbError) fail({status: options.imdbError});
            else ok(ids(url).map(imdbId => ({imdbId, rating: imdbRatings[imdbId] === undefined ? null : imdbRatings[imdbId]})));
        } else if (options.error) fail({status: options.error});
        else if (options.respond) ok(options.respond(url));
        else ok(options.response === undefined ? {items: [{imdbId: 'tt0111161', ratingKinopoisk: 9.1, ratingImdb: 9.3}]} : options.response);
    }
    const Lampa = {
        Manifest: {app_version: options.version || '3.3.8', app_digital: 338},
        Maker: {map: () => map},
        Storage: {get: (key, fallback) => key in storage ? storage[key] : fallback,
                  set: (key, value) => {storage[key] = value;}},
        SettingsApi: {addComponent() {}, addParam(p) {parameters.push(p);}},
        Noty: {show: message => notices.push(message)},
        Api: {sources: {tmdb: {external_ids(params, ok, fail) {
            external.push(params);
            if (options.tmdbError) fail();
            else ok({imdb_id: options.imdb === undefined ? 'tt0111161' : options.imdb});
        }}}},
        Reguest: function() {
            this.timeout = () => {};
            this.silent = (url, ok, fail, post, settings) => {
                const request = {url, ok, fail, settings};
                requests.push(request);
                if (!options.manual) later(() => answer(request), 0);
            };
        },
        Listener: {follow() {}},
    };
    window.Lampa = Lampa; window.appready = true;
    const context = vm.createContext({window, document, Lampa, console, setTimeout: later,
        clearTimeout: id => {clearTimeout(id);timers.delete(id);callbacks.delete(id);}, Date: Clock, JSON, Object,
        IntersectionObserver: undefined});
    vm.runInContext(code, context);
    function card(data = {}) {
        const instance = {data: {id: 278, source: 'tmdb', title: 'Test', ...data}, components: [],
            use(module) {this.components.push(module);},
            emit(event) {const name = 'on' + event[0].toUpperCase() + event.slice(1);
                for(const mod of this.components.slice()) if(mod[name]) mod[name].call(this);}};
        map.Card.onCreate.call(instance);
        return instance;
    }
    function change(name, value) {
        storage['cr_' + name] = value;
        const param = parameters.find(p => p.param.name === 'cr_' + name);
        assert.ok(param, 'settings entry ' + name);
        if(param.onChange) param.onChange(value);
    }
    function advance(ms) {
        now += ms;
        const due = [...callbacks.entries()].filter(([, c]) => c.at <= now).sort((a, b) => a[1].at - b[1].at);
        for(const [id,c] of due) {clearTimeout(id);timers.delete(id);callbacks.delete(id);c.fn();}
    }
    const kp = () => requests.filter(isKp), imdb = () => requests.filter(isImdb);
    // Manual mode: flush the Agregarr batch and answer it.
    function imdbFlush(ratings = imdbRatings) {
        advance(100);
        imdb().filter(r => !r.done).forEach(r => {r.done = true;
            r.ok(ids(r.url).map(imdbId => ({imdbId, rating: ratings[imdbId] === undefined ? null : ratings[imdbId]})));});
    }
    return {window, document, storage, requests, external, notices, parameters, card, change, advance, kp, imdb, imdbFlush};
}

const badges = c => c.html.querySelector('.cr-ratings');
const none = c => assert.ok(badges(c) === null, 'no rating badges expected');
const hidden = c => c.html.classList.contains('cr-has-ratings');
const key = {storage: {cr_api_key: 'test-token'}};

test('embedded KP and IMDb replace TMDB without any requests', t => {
    const h = setup(t); const c = h.card({rating_kp: 8.2, rating_imdb: 7.9}); c.emit('visible');
    assert.ok(badges(c), 'ratings should appear');
    assert.match(badges(c).textContent, /КП8.2/); assert.match(badges(c).textContent, /IMDb7.9/);
    assert.equal(hidden(c), true); assert.equal(h.requests.length, 0);
});

test('zero, malformed and out of range ratings never become badges', t => {
    const h = setup(t); const c = h.card({rating_kp: 0, rating_imdb: '9.1 garbage', imdb_id: 'tt1'}); c.emit('visible');
    none(c); assert.equal(hidden(c), false);
    const d = h.card({id: 9, rating_kp: 11, rating_imdb: -1}); d.emit('visible');
    none(d);
});

test('KP comes from Kinopoisk with the key, IMDb from keyless Agregarr', async t => {
    const h = setup(t, key); const c = h.card();
    assert.equal(h.requests.length, 0); c.emit('visible'); await tick();
    assert.equal(h.external.length, 1); assert.match(h.kp()[0].url, /imdbId=tt0111161/);
    assert.equal(h.kp()[0].settings.headers['X-API-KEY'], 'test-token');
    assert.ok(!h.kp()[0].url.includes('test-token'));
    assert.equal(h.imdb().length, 1); assert.match(h.imdb()[0].url, /\?id=tt0111161$/);
    assert.equal(h.imdb()[0].settings.headers['X-API-KEY'], undefined);
    assert.match(badges(c).textContent, /КП9.1IMDb9.3/);
});

test('without a key IMDb is still shown and Kinopoisk is not called', async t => {
    const h = setup(t); const c = h.card(); c.emit('visible'); await tick();
    assert.equal(h.kp().length, 0); assert.equal(badges(c).textContent, 'IMDb9.3');
});

test('IMDb IDs of several cards share one Agregarr request', t => {
    const h = setup(t, {manual: true, imdb: null});
    [['tt1', 7.1], ['tt2', 6.4], ['tt3', 8]].forEach(([imdb_id], i) => h.card({id: i + 1, imdb_id}).emit('visible'));
    h.imdbFlush({tt1: 7.1, tt2: 6.4, tt3: 8});
    assert.equal(h.imdb().length, 1); assert.deepEqual(ids(h.imdb()[0].url), ['tt1', 'tt2', 'tt3']);
    assert.deepEqual([...h.document.querySelectorAll('.cr-ratings')].map(b => b.textContent), ['IMDb7.1', 'IMDb6.4', 'IMDb8.0']);
});

test('duplicates share an in-flight lookup and then persistent cache', t => {
    const h = setup(t, {...key, manual: true});
    const a = h.card(), b = h.card(); a.emit('visible'); b.emit('visible');
    assert.equal(h.kp().length, 1);
    h.kp()[0].ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 9.1, ratingImdb: 9.3}]}); h.imdbFlush();
    assert.ok(badges(a)); assert.ok(badges(b));
    const before = h.requests.length;
    const c = h.card(); c.emit('visible'); assert.ok(badges(c)); assert.equal(h.requests.length, before);
    const saved = JSON.parse(JSON.stringify(h.storage));
    const reboot = setup(t, {storage: saved}); const d = reboot.card(); d.emit('visible');
    assert.match(badges(d).textContent, /КП9.1IMDb9.3/); assert.equal(reboot.requests.length, 0);
});

test('movie and TV identifiers do not collide in cache', t => {
    const h = setup(t, {...key, manual: true});
    h.card({media_type: 'movie'}).emit('visible'); h.card({media_type: 'tv', name: 'Series'}).emit('visible');
    assert.deepEqual(h.external.map(p => p.type), ['movie', 'tv']); assert.equal(h.kp().length, 2);
});

test('only four lookups run at once and destroyed queued cards are skipped', t => {
    const h = setup(t, {...key, manual: true});
    const cards = [1,2,3,4,5,6].map(id => h.card({id})); cards.forEach(c => c.emit('visible'));
    assert.equal(h.kp().length, 4); cards[4].emit('destroy');
    h.kp()[0].ok({items: []}); h.imdbFlush();
    assert.deepEqual(h.external.map(p => p.id), [1,2,3,4,6]);
});

test('destroyed cards ignore late responses', t => {
    const h = setup(t, {...key, manual: true});
    const c = h.card(); c.emit('visible'); c.emit('destroy');
    h.kp()[0].ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 9}]}); h.imdbFlush();
    none(c);
});

test('missing ratings retain TMDB; hiding fallback is optional', async t => {
    const h = setup(t, {...key, response: {items: []}, imdbRatings: {}});
    const c = h.card(); c.emit('visible'); await tick(); assert.equal(hidden(c), false);
    h.change('fallback', 'false'); assert.equal(hidden(c), true); none(c);
});

test('a partial score stays visible if enrichment fails', async t => {
    const h = setup(t, {...key, error: 500, imdbError: 500});
    const c = h.card({rating_kp: 8.1}); c.emit('visible'); await tick();
    assert.equal(badges(c).textContent, 'КП8.1');
});

test('API keys can be added without restart; disabling restores TMDB', async t => {
    const h = setup(t, {response: {items: [{imdbId: 'tt0111161', ratingKinopoisk: 9.1}]}});
    const c = h.card(); c.emit('visible'); await tick(); assert.equal(h.kp().length, 0);
    h.change('api_key', 'test-token'); await tick(); assert.match(badges(c).textContent, /КП9.1/);
    h.change('enabled', 'false'); none(c); assert.equal(hidden(c), false);
});

test('unknown source IDs never get treated as TMDB IDs', t => {
    const h = setup(t, key);
    h.card({source: 'custom-source'}).emit('visible'); assert.equal(h.external.length, 0);
});

test('direct Kinopoisk IDs skip TMDB lookup', async t => {
    const h = setup(t, {...key, response: {kinopoiskId: 326, ratingKinopoisk: 9.1, ratingImdb: 9.3}});
    const c = h.card({source: 'kinopoisk', id: 326, kinopoisk_id: 326}); c.emit('visible'); await tick();
    assert.equal(h.external.length, 0); assert.match(h.kp()[0].url, /films\/326$/);
    assert.match(badges(c).textContent, /КП9.1IMDb9.3/);
});

test('an unrelated IMDb result is discarded', async t => {
    const h = setup(t, {...key, imdbRatings: {}, response: {items: [{imdbId: 'tt9999999', ratingKinopoisk: 9.9}]}});
    const c = h.card(); c.emit('visible'); await tick(); none(c);
});

test('401 stops Kinopoisk requests and reports key error once', async t => {
    const h = setup(t, {...key, error: 401});
    [1,2,3,4,5,6].forEach(id => h.card({id}).emit('visible')); await tick(); await tick();
    assert.equal(h.kp().length, 4); assert.equal(h.notices.length, 1);
    assert.equal(h.document.querySelectorAll('.cr-ratings').length, 6);
});

test('reloading the script does not double hook or duplicate settings', t => {
    const h = setup(t); const before = h.parameters.length;
    vm.runInNewContext(code, {window: h.window, document: h.document, console, setTimeout, clearTimeout});
    assert.equal(h.parameters.length, before);
    const c = h.card({rating_imdb: 8, rating_kp: 7}); c.emit('visible');
    assert.equal(c.html.querySelectorAll('.cr-ratings').length, 1);
});

test('plugin is valid ES5 JavaScript for TV engines', () => {
    assert.ok(code.length, 'plugin exists'); require('acorn').parse(code, {ecmaVersion: 5});
});

test('429 pauses only Kinopoisk; IMDb continues and KP is fetched after the pause', t => {
    const h = setup(t, {...key, manual: true});
    const a = h.card({id: 1}); a.emit('visible'); h.kp()[0].fail({status: 429}); h.imdbFlush();
    assert.equal(badges(a).textContent, 'IMDb9.3');
    const b = h.card({id: 2}); b.emit('visible'); h.imdbFlush();
    assert.equal(h.kp().length, 1); assert.equal(badges(b).textContent, 'IMDb9.3');
    h.advance(60000); assert.equal(h.kp().length, 3);
    h.kp().slice(1).forEach(r => r.ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 7.4}]}));
    assert.equal(badges(a).textContent, 'КП7.4IMDb9.3'); assert.equal(badges(b).textContent, 'КП7.4IMDb9.3');
});

test('network errors retry by themselves, at most three times', t => {
    const h = setup(t, {...key, manual: true});
    const c = h.card(); c.emit('visible');
    h.kp()[0].fail({status: 500}); h.imdbFlush(); h.advance(60000); assert.equal(h.kp().length, 2);
    h.kp()[1].fail({status: 500}); h.advance(60000); assert.equal(h.kp().length, 3);
    h.kp()[2].fail({status: 500}); h.advance(60000); assert.equal(h.kp().length, 3);
});

test('exhausted KP quota pauses Kinopoisk for an hour, notifies once, IMDb keeps working', t => {
    const h = setup(t, {...key, manual: true});
    [1, 2].forEach(id => h.card({id}).emit('visible'));
    h.kp()[0].fail({status: 402}); h.kp()[1].fail({status: 402}); h.imdbFlush();
    assert.equal(h.notices.length, 1);
    const c = h.card({id: 3}); c.emit('visible'); h.imdbFlush();
    assert.equal(h.kp().length, 2); assert.equal(badges(c).textContent, 'IMDb9.3');
    h.advance(3600000); assert.equal(h.kp().length, 5);
});

test('a hung network request releases its queue slot at the watchdog timeout', t => {
    const h = setup(t, {...key, manual: true});
    [1,2,3,4,5].forEach(id => h.card({id}).emit('visible'));
    assert.equal(h.kp().length, 4); h.imdbFlush(); h.advance(10000); assert.equal(h.kp().length, 5);
    // A network callback after its watchdog fired is ignored.
    h.kp()[0].ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 9}]});
    assert.doesNotMatch(h.document.body.textContent, /КП/);
});

test('responses made with an old key cannot overwrite the refreshed catalog', t => {
    const h = setup(t, {storage: {cr_api_key: 'old-token'}, manual: true});
    const c = h.card(); c.emit('visible'); h.change('api_key', 'new-token');
    h.kp()[0].ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 9.9}]}); h.imdbFlush();
    assert.equal(h.kp()[1].settings.headers['X-API-KEY'], 'new-token');
    h.kp()[1].ok({items: [{imdbId: 'tt0111161', ratingKinopoisk: 8.1}]});
    assert.equal(badges(c).textContent, 'КП8.1IMDb9.3');
});

test('Kinopoisk IMDb score is a fallback when Agregarr has none', async t => {
    const h = setup(t, {...key, imdbRatings: {}, response: {items: [{imdbId: 'tt0111161', ratingKinopoisk: null, ratingImdb: 6.8}]}});
    const c = h.card(); c.emit('visible'); await tick();
    assert.equal(badges(c).textContent, 'IMDb6.8'); assert.equal(hidden(c), true);
});

test('film without IMDb ID is matched by exact title, year and type', async t => {
    const h = setup(t, {...key, imdb: null, respond: url => ({items: [
        {kinopoiskId: 1, nameRu: 'Слово пацана. Кровь на асфальте', year: 2023, type: 'TV_SERIES', ratingKinopoisk: 8.3},
        {kinopoiskId: 2, nameRu: 'Слово пацана', year: 2023, type: 'FILM', ratingKinopoisk: 5}]})});
    const c = h.card({id: 5, name: 'Слово пацана. Кровь на асфальте', first_air_date: '2023-11-09'});
    c.emit('visible'); await tick();
    assert.match(h.kp()[0].url, /keyword=.+&yearFrom=2022&yearTo=2024/); assert.equal(h.imdb().length, 0);
    assert.equal(badges(c).textContent, 'КП8.3');
});

test('title search is rejected when ambiguous', async t => {
    const h = setup(t, {...key, imdb: null, respond: () => ({items: [
        {kinopoiskId: 1, nameRu: 'Дом', year: 2011, type: 'FILM', ratingKinopoisk: 7},
        {kinopoiskId: 2, nameRu: 'Дом', year: 2012, type: 'FILM', ratingKinopoisk: 6}]})});
    const c = h.card({id: 6, title: 'Дом', release_date: '2011-03-01'}); c.emit('visible'); await tick();
    none(c); assert.equal(hidden(c), false);
});

test('KP is cached for 30 days, IMDb for 7', async t => {
    const h = setup(t, key); h.card().emit('visible'); await tick();
    const entry = Object.values(h.storage.cr_cache_v3)[0], day = 86400000;
    assert.equal(Math.round((entry.kpUntil - Date.now()) / day), 30);
    assert.equal(Math.round((entry.imdbUntil - Date.now()) / day), 7);
});

test('rating text is 1.5x larger than before', t => {
    const h = setup(t);
    assert.match(h.document.getElementById('catalog-ratings-style').textContent, /\.cr-ratings\{[^}]*font-size:1\.17em/);
});
