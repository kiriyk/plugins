'use strict';
var messages = {
    kp_key: 'Для фильтра КП задайте ключ Kinopoisk API Unofficial в настройках ИИ или плагина рейтингов.',
    kp_limit: 'Достигнут лимит запросов рейтинга КП за поиск.',
    auth: 'API отклонил ключ или доступ.',
    balance: 'Недостаточно средств на балансе RouterAI.',
    rate_limit: 'Слишком много запросов. Повторите позже.',
    server: 'Сервис временно недоступен.',
    network: 'Не удалось подключиться к API.',
    timeout: 'Время ожидания запроса истекло.',
    unsupported: 'В этой версии Lampa нет нужного сетевого API.',
    invalid_arguments: 'Некорректные параметры запроса.',
    invalid_response: 'API вернул некорректный ответ.'
};
function appError(code, status) {
    return {code: code, status: typeof status === 'number' ? status : null, message: messages[code] || 'Не удалось выполнить запрос.'};
}
function normalizeError(raw) {
    var status = raw && Number(raw.status) || 0;
    var code = status === 401 || status === 403 ? 'auth' : status === 402 ? 'balance' :
        status === 429 ? 'rate_limit' : status >= 500 ? 'server' : 'network';
    return appError(code, status || null);
}
function createTransport(Lampa, clock) {
    return function request(spec, done) {
        var settled = false, timer = null, network = null;
        function clear() {
            if (timer !== null) clock.clearTimeout(timer);
            if (network && network.clear) { try { network.clear(); } catch (ignore) {} }
        }
        function finish(error, value) {
            if (settled) return;
            settled = true; clear(); done(error, value);
        }
        function cancel() { if (!settled) { settled = true; clear(); } }
        try {
            var Constructor = Lampa.Reguest || Lampa.Request;
            if (!Constructor) { finish(appError('unsupported')); return cancel; }
            network = new Constructor();
            if (typeof network.native !== 'function') { finish(appError('unsupported')); return cancel; }
            if (!(spec.timeoutMs > 0)) { finish(appError('timeout')); return cancel; }
            var headers = {}, name, post = false;
            for (name in spec.headers) if (Object.prototype.hasOwnProperty.call(spec.headers, name)) headers[name] = spec.headers[name];
            if (spec.method === 'POST') { post = JSON.stringify(spec.json); headers['Content-Type'] = 'application/json'; }
            timer = clock.setTimeout(function () { finish(appError('timeout')); }, spec.timeoutMs);
            network.native(spec.url, function (body) { finish(null, body); }, function (raw) {
                finish(normalizeError(raw));
            }, post, {headers: headers, attempts: 0, cache: false, timeout: spec.timeoutMs});
        } catch (ignore) { finish(appError('network')); }
        return cancel;
    };
}
module.exports = {createTransport: createTransport, appError: appError, normalizeError: normalizeError};
