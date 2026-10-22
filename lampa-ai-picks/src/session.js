'use strict';
var clone = require('./domain').clone;
function createSession() {
    var intent = null, shown = [];
    return {
        reset:function (value) { intent = clone(value); shown = []; },
        getIntent:function () { return intent ? clone(intent) : null; },
        getShown:function () { return shown.slice(); },
        size:function () { return shown.length; },
        commit:function (items) {
            var accepted = [];
            items.forEach(function (item) {
                if (shown.length < 200 && shown.indexOf(item.candidate.key) < 0) { shown.push(item.candidate.key); accepted.push(item); }
            });
            return accepted;
        },
        setIntent:function (value) { intent = clone(value); }
    };
}
module.exports = {createSession:createSession};
