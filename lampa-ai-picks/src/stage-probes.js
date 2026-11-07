'use strict';
var appError = require('./transport').appError;
function createStageProbes(options) {
    function probe(args, done) {
        var active = true, tasks = [], cancels = [], checked = 0, stages = args.stages || {};
        function stop() { active = false;cancels.forEach(function (cancel) { if (cancel) cancel(); }); }
        function next(error) {
            if (!active) return;
            if (error || !tasks.length) { stop();done(error || null,{checked:checked});return; }
            var task = tasks.shift(), cancel = task(function (error) { if (!error) checked++;next(error); });
            if (active) cancels.push(cancel);else if (cancel) cancel();
        }
        if (stages.extraction === 'scaledown/extract') tasks.push(function (callback) {
            return require('./scaledown').createScaleDown(options).extract({key:args.key,pages:[{id:'probe',title:'',content:'😀 Прибытие (2016) — научно-фантастический фильм.'}],timeoutMs:15000},function (error, result) {
                callback(error || (!result.titles.some(function (t) { return t.title === 'Прибытие'; }) ? appError('invalid_response') : null));
            });
        });
        if (stages.ranking === '~typesafe/jev-latest') tasks.push(function (callback) {
            var batch = require('./candidate-ranking').prepareRanking({query:'Фантастика о первом контакте',intent:{preferences:[]},examples:[],candidates:[{key:'tmdb:movie:329865',type:'movie',title:'Прибытие',year:2016,overview:'Лингвист пытается установить контакт с прибывшими на Землю инопланетянами.'}]}).batches[0];
            return require('./jev').createJev(options).evaluate({key:args.key,state:batch.state,questions:batch.questions,timeoutMs:15000},function (error, result) {
                callback(error || (['match','strong_match'].indexOf(result.answers.movie_329865_fit.choice) < 0 ? appError('invalid_response') : null));
            });
        });
        next();return stop;
    }
    return {probe:probe};
}
module.exports = {createStageProbes:createStageProbes};
