'use strict';
function buildSourceDocument(pages) {
    var text = '', ranges = [];
    pages.slice(0,20).forEach(function (page, index) {
        text += 'Source ' + (index + 1) + '\n';
        var start = text.length;
        text += String(page.title || '').slice(0,500) + '\n' + String(page.content || '').slice(0,1500);
        ranges.push({id:page.id,start:start,end:text.length});text += '\n\n';
    });
    return {text:text,ranges:ranges};
}
function pointOffsets(text) {
    var offsets = [0], i = 0;
    while (i < text.length) {
        var first = text.charCodeAt(i++);
        if (first >= 55296 && first <= 56319 && i < text.length && text.charCodeAt(i) >= 56320 && text.charCodeAt(i) <= 57343) i++;
        offsets.push(i);
    }
    return offsets;
}
function resolveSpan(doc, entity) {
    var start = entity.start, end = entity.end, value = entity.text;
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || typeof start !== 'number' || typeof end !== 'number' || start < 0 || end <= start || Math.floor(start) !== start || Math.floor(end) !== end || end > doc.text.length) return null;
    var points = doc.points || (doc.points = pointOffsets(doc.text)), matches = [];
    [[start,end],[points[start],points[end]]].forEach(function (span) {
        if (span[0] === undefined || span[1] === undefined || doc.text.slice(span[0],span[1]) !== value) return;
        var range = doc.ranges.filter(function (r) { return span[0] >= r.start && span[1] <= r.end; })[0];
        if (range && !matches.some(function (m) { return m.start === span[0]; })) matches.push({start:span[0],range:range});
    });
    if (matches.length !== 1) return null;
    var sourceIds = [], evidence = Object.create(null);
    doc.ranges.forEach(function (range) {
        var at = doc.text.slice(range.start,range.end).indexOf(value);
        if (at < 0) return;
        at += range.start;sourceIds.push(range.id);
        var left = Math.max(range.start,at - Math.floor((250 - value.length) / 2));
        evidence[range.id] = doc.text.slice(left,Math.min(range.end,left + 250));
    });
    return {sourceIds:sourceIds,evidenceBySource:evidence};
}
module.exports = {buildSourceDocument:buildSourceDocument,resolveSpan:resolveSpan};
