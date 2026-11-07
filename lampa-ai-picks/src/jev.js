'use strict';
var net = require('./transport'), own = require('./domain').own;
function probability(value) { return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1; }
function validAnswers(questions, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== Object.keys(questions).length) return false;
    return Object.keys(questions).every(function (key) {
        var a = own(answers,key) && answers[key], criteria = questions[key].criteria, names = Object.keys(criteria), total = 0;
        if (!a || a.type !== 'choice' || typeof a.choice !== 'string' || !own(criteria,a.choice) || !probability(a.confidence) || !a.probabilities || Array.isArray(a.probabilities) || Object.keys(a.probabilities).length !== names.length) return false;
        if (!names.every(function (name) { if (!own(a.probabilities,name) || !probability(a.probabilities[name])) return false;total += a.probabilities[name];return true; })) return false;
        return Math.abs(1 - total) <= 0.01;
    });
}
function createJev(options) {
    function evaluate(args, done) {
        var active = true, timer = null, cancelNetwork = null;
        function stop() { active = false;if (timer !== null) options.clock.clearTimeout(timer);if (cancelNetwork) cancelNetwork(); }
        function finish(error, result) { if (!active) return;stop();done(error,result); }
        if (!args.key || !args.questions || !Object.keys(args.questions).length) { finish(net.appError('invalid_arguments'));return stop; }
        var timeout = Math.min(args.timeoutMs === undefined ? 15000 : args.timeoutMs,15000);
        if (!(timeout > 0)) { finish(net.appError('timeout'));return stop; }
        timer = options.clock.setTimeout(function () { finish(net.appError('timeout')); },timeout);
        try {
            cancelNetwork = options.request({url:'https://routerai.ru/api/v1/decisions',method:'POST',headers:{Authorization:'Bearer ' + args.key.trim()},traceId:args.traceId,timeoutMs:timeout,
                json:{model:'~typesafe/jev-latest',state:args.state,questions:args.questions}},function (error, body) {
                if (!active) return;
                if (error) { finish(error.code ? net.appError(error.code,error.status) : net.normalizeError(error));return; }
                if (!body || !validAnswers(args.questions,body.answers)) { finish(net.appError('invalid_response'));return; }
                finish(null,{answers:body.answers,modelVersion:typeof body.model === 'string' ? body.model : null,usage:body.usage});
            });
            if (!active && cancelNetwork) cancelNetwork();
        } catch (ignore) { finish(net.appError('network')); }
        return stop;
    }
    return {evaluate:evaluate};
}
module.exports = {createJev:createJev};
