'use strict';
var d = require('./domain');
function createScreening(options) {
    var alive = true, generation = 0, cancels = [], attempted = {}, metadataErrors = {}, ratingRows = {};
    var current = [], filters = d.emptyFilters(), stats = {}, accepted = [];
    function missing(c, verdict) {
        return verdict.reason === 'unknown_genres' || verdict.reason === 'runtime' && !d.positive(c.runtimeMinutes) ||
            verdict.reason === 'country' && !c.countries || verdict.reason === 'year' && c.year === null;
    }
    function base(c) { var f = d.clone(filters);f.ratingMin = null;return d.validateCandidate(c,f); }
    function refresh() {
        var enabled = typeof filters.ratingMin === 'number', source = filters.ratingSource || 'imdb';
        stats = {candidates:current.length,checked:0,conditionsPassed:0,ratingChecked:0,ratingPassed:0,missingRatings:0,ratingErrors:0,metadataErrors:0,metadataMissing:0,unverified:0,selected:0,ratingEnabled:enabled,ratingSource:source,stopReason:null};accepted = [];
        current.forEach(function (old) {
            var c = options.store.get(old.key), verdict = base(c), row = ratingRows[source + ':' + c.key];
            if (missing(c,verdict)) {
                if (metadataErrors[c.key]) { stats.metadataErrors++;if (!stats.stopReason) stats.stopReason = metadataErrors[c.key]; }
                else if (attempted[c.key] === 'done') stats.metadataMissing++;
                return;
            }
            if (!verdict.ok) { stats.checked++;return; }
            stats.conditionsPassed++;
            if (!enabled) { stats.checked++;accepted.push(c);return; }
            if (!row) return;
            if (row.error) { stats.ratingErrors++;if (!stats.stopReason) stats.stopReason = row.error.code;return; }
            if (row.value === null) { stats.missingRatings++;return; }
            stats.checked++;stats.ratingChecked++;
            if (!c.ratings) c.ratings = {};c.ratings[source] = row.value;
            if (row.value >= filters.ratingMin) { stats.ratingPassed++;accepted.push(c); }
        });
        stats.unverified = stats.candidates - stats.checked;
        if (options.onProgress) options.onProgress(d.clone(stats));
    }
    function check(nextFilters, excluded, done) {
        if (!alive) return function () {};
        var id = ++generation;filters = d.clone(nextFilters);
        if (!filters.ratingSource) filters.ratingSource = 'imdb';
        current = options.store.all().filter(function (c) { return (excluded || []).indexOf(c.key) < 0; });
        function valid() { return alive && generation === id; }
        refresh();
        function ratings() {
            if (!valid()) return;
            refresh();
            if (typeof filters.ratingMin !== 'number') return done();
            var pending = current.map(function (c) { return options.store.get(c.key); }).filter(function (c) { return base(c).ok && !ratingRows[filters.ratingSource + ':' + c.key]; });
            if (!pending.length) return done();
            cancels.push(options.ratings.getMany(pending,filters.ratingSource || 'imdb',function (error, rows) {
                if (!valid()) return;
                pending.forEach(function (c) { ratingRows[filters.ratingSource + ':' + c.key] = rows && rows[c.key] || {value:null,error:error || {code:'invalid_response'}}; });
                refresh();done();
            },function (key,row) {
                if (!valid()) return;
                ratingRows[filters.ratingSource + ':' + key] = row;refresh();
            }));
        }
        var pending = current.filter(function (c) { return missing(c,base(c)) && !attempted[c.key]; }), chunks = [];
        for (var i = 0;i < pending.length;i += 10) chunks.push(pending.slice(i,i + 10).map(function (c) { attempted[c.key] = 'pending';return c.key; }));
        if (!chunks.length) ratings();
        else {
            var left = chunks.length;
            chunks.forEach(function (keys) {
                cancels.push(options.catalog.getTitleDetails({keys:keys},function (error, rows) {
                    if (!valid()) return;
                    keys.forEach(function (key) { attempted[key] = 'done'; });
                    if (error) keys.forEach(function (key) { metadataErrors[key] = error.code; });
                    else {
                        (rows || []).forEach(function (c) { options.store.add(c); });
                        (rows && rows.errors || []).forEach(function (row) { metadataErrors[row.key] = row.code; });
                    }
                    refresh();if (!--left) ratings();
                },function (error,c,key) {
                    if (!valid()) return;
                    attempted[key] = 'done';
                    if (error) metadataErrors[key] = error.code;
                    else if (c) options.store.add(c);
                    refresh();
                }));
            });
        }
        return function () { if (generation === id) generation++; };
    }
    function cancel() { alive = false;generation++;cancels.forEach(function (fn) { if (fn) fn(); }); }
    return {check:check,cancel:cancel,snapshot:function () { return d.clone(stats); },eligible:function () { return accepted.slice(); }};
}
module.exports = {createScreening:createScreening};
