'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDOMHarness}=require('./helpers.cjs'),{registerSettings}=require('../src/settings');
function setup(options={}){const h=createDOMHarness(options),changes=[];let probes=0;
const api={listModels:(key,done)=>{done(null,[{id:'tools/model',name:'Text model',supportsTools:true},{id:'plain',name:'Plain',supportsTools:false}]);return ()=>{};},
probe:(args,done)=>{probes++;done(null,{ok:true});return ()=>{};}};
const settings=registerSettings({Lampa:h.Lampa,routerai:api,onChange:c=>changes.push(c)});
return {...h,settings,changes,probes:()=>probes};}
test('key input is masked and never appears in settings menus',()=>{
    const h=setup({storage:{aip_api_key:'test-key',aip_model:'tools/model'}});
    h.settings.open();assert.equal(JSON.stringify(h.selects).includes('test-key'),false);
    h.choose('Ключ RouterAI');assert.equal(h.inputs[0].params.password,true);assert.equal(h.inputs[0].params.nosave,true);
    h.inputs[0].done('changed-key');assert.equal(h.storage.aip_api_key,'changed-key');assert.equal(h.changes.length,1);
});
test('model chooser offers tools models and manual ID without automatic model switch',()=>{
    const h=setup({storage:{aip_api_key:'test-key'}});
    h.settings.open();h.choose('Модель');
    assert.ok(h.selects.at(-1).items.some(x=>x.value==='tools/model'));assert.equal(h.selects.at(-1).items.some(x=>x.value==='plain'),false);
    h.choose('tools/model');assert.equal(h.settings.getConfig().model,'tools/model');assert.equal(h.probes(),0);
});
test('connection probe is explicit and does not run when opening settings',()=>{
    const h=setup({storage:{aip_api_key:'test-key',aip_model:'tools/model'}});
    h.settings.open();h.settings.open();assert.equal(h.probes(),0);
    h.choose('Проверить подключение');assert.equal(h.probes(),1);assert.ok(h.notices.at(-1).includes('работает'));
});
test('failed Storage write leaves existing key intact and gives a recoverable message',()=>{
    const h=setup({storage:{aip_api_key:'old-key'},storageError:true});h.settings.open();h.choose('Ключ RouterAI');h.inputs[0].done('new-key');
    assert.equal(h.settings.getConfig().key,'old-key');assert.equal(h.changes.length,0);assert.ok(h.notices.at(-1).includes('сохранить'));
});
test('manual model input is available when model catalog fails',()=>{
    const h=createDOMHarness({storage:{aip_api_key:'test-key'}});
    const s=registerSettings({Lampa:h.Lampa,routerai:{listModels:(key,cb)=>{cb({code:'network'});return ()=>{};}},onChange(){}});
    s.open();h.choose('Модель');h.choose('Ввести ID модели');h.inputs.at(-1).done('custom/model');assert.equal(s.getConfig().model,'custom/model');
});
