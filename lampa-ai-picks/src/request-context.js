'use strict';
function buildExampleContext(store, keys) {
    return (keys || []).slice(0,3).map(function (key) { return store.get(key); }).filter(Boolean).map(function (c) {
        return {key:c.key,title:String(c.title || '').slice(0,200),type:c.type,year:c.year,overview:String(c.overview || '').slice(0,500)};
    });
}
module.exports = {buildExampleContext:buildExampleContext};
