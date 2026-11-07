'use strict';
function createSelectionReview(options) {
    var keys = options.eligibleKeys.slice(), allowed = Object.create(null), selected = Object.create(null), excluded = Object.create(null), order = [];
    var proposed = 0, answerRejected = 0;
    var limit = options.resultLimit === null ? 80 : options.resultLimit;
    var requested = Math.min(limit,options.remaining), target = Math.min(requested,keys.length);
    keys.forEach(function (key) { allowed[key] = true; });
    function pending() { return keys.filter(function (key) { return !selected[key] && !excluded[key]; }); }
    function stats() {
        var rejected = 0, insufficient = 0;
        keys.forEach(function (key) { if (excluded[key] === 'not_relevant') rejected++;else if (excluded[key] === 'insufficient_data') insufficient++; });
        return {aiAvailable:keys.length,aiTarget:target,aiProposed:proposed,aiRejected:rejected,aiInsufficient:insufficient,aiUndecided:pending().length,answerRejected:answerRejected};
    }
    return {
        accept:function (result) {
            var assessment = result.assessment || {proposed:result.items.length,answerRejected:0,excluded:[]};
            proposed += assessment.proposed;answerRejected += assessment.answerRejected;
            result.items.forEach(function (item) {
                var key = item.candidate.key;
                if (!allowed[key]) return;
                if (!selected[key] && order.length < requested) { order.push(key);selected[key] = item;delete excluded[key]; }
            });
            assessment.excluded.forEach(function (item) { if (allowed[item.key] && !selected[item.key] && !excluded[item.key]) excluded[item.key] = item.reasonCode; });
        },
        needsReview:function () { return order.length < target && pending().length > 0; },
        hint:function () { return {target:target,selectedKeys:order.slice(),pendingKeys:pending()}; },
        finish:function (warning) {
            var summary = stats(), notices = [], partial = options.resultLimit !== null && order.length < requested;
            if (partial) notices.push('Найдено меньше ' + requested + ' подходящих вариантов. Условия сохранены.');
            if (order.length < target && summary.aiUndecided) { partial = true;notices.push('ИИ оставил без решения ' + summary.aiUndecided + ' из ' + summary.aiAvailable + ' проверенных кандидатов.'); }
            if (summary.answerRejected) notices.push('Отклонено при проверке ответа ИИ: ' + summary.answerRejected + '.');
            if (warning) { partial = true;notices.push(warning); }
            return {items:order.map(function (key) { return selected[key]; }),partial:partial,notice:notices.join(' ') || null,selectionStats:summary};
        }
    };
}
module.exports = {createSelectionReview:createSelectionReview};
