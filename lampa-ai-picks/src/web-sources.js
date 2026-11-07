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
// Conservative word boundaries for expanding independently unverified mentions.
function word(character) { return !!character && /[0-9A-Za-z_\u00c0-\u02ff\u0300-\u052f\u0530-\u1fff\u2c00-\ud7ff\uf900-\ufdcf\ufdf0-\uffef]/.test(character); }
function mentionAt(text, value) {
    var at = text.indexOf(value);
    while (at >= 0) {
        if ((!word(value.charAt(0)) || !word(text.charAt(at - 1))) && (!word(value.charAt(value.length - 1)) || !word(text.charAt(at + value.length)))) return at;
        at = text.indexOf(value,at + 1);
    }
    return -1;
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
        var at = range === matches[0].range ? matches[0].start - range.start : mentionAt(doc.text.slice(range.start,range.end),value);
        if (at < 0) return;
        at += range.start;sourceIds.push(range.id);
        var left = Math.max(range.start,at - Math.floor((250 - value.length) / 2));
        evidence[range.id] = doc.text.slice(left,Math.min(range.end,left + 250));
    });
    return {sourceIds:sourceIds,evidenceBySource:evidence,start:matches[0].start};
}
module.exports = {buildSourceDocument:buildSourceDocument,resolveSpan:resolveSpan};
