'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createDOMHarness}=require('./helpers.cjs');
test('bundle runs in ES5 environment and repeated loads do not duplicate plugin registration',()=>{
    const h=createDOMHarness(),code=fs.readFileSync(path.join(__dirname,'../ai-picks.js'),'utf8');
    const context=vm.createContext({window:h.window,document:h.document,console,setTimeout,clearTimeout,Promise:undefined,fetch:undefined,Map:undefined,Set:undefined,AbortController:undefined});
    vm.runInContext(code,context);vm.runInContext(code,context);
    assert.equal(h.document.querySelectorAll('.aip-menu').length,1);
    assert.equal(h.registrations.filter(x=>x.name==='aip_picks').length,1);
    assert.equal(h.document.querySelectorAll('#aip-style').length,1);
});
