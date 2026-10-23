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


test('model search matches names and IDs locally without reloading the catalog',()=>{
    const h=createDOMHarness({storage:{aip_api_key:'test-key'}});let requests=0;
    const s=registerSettings({Lampa:h.Lampa,routerai:{listModels:(key,cb)=>{requests++;cb(null,[
      {id:'vendor/alpha',name:'Fast Thinker',supportsTools:true},{id:'vendor/beta',name:'Deep Reader',supportsTools:true},{id:'vendor/plain',name:'Alpha plain',supportsTools:false}
    ]);return ()=>{};}}});
    s.open();h.choose('Модель');h.choose('Найти модель');h.inputs.at(-1).done('THINK');
    assert.deepEqual(h.selects.at(-1).items.filter(x=>x.value.startsWith('vendor/')).map(x=>x.value),['vendor/alpha']);
    h.choose('search');h.inputs.at(-1).done('BETA');
    assert.deepEqual(h.selects.at(-1).items.filter(x=>x.value.startsWith('vendor/')).map(x=>x.value),['vendor/beta']);
    h.choose('search');h.inputs.at(-1).done('нет такой модели');
    assert.ok(h.selects.at(-1).items.some(x=>x.value==='manual'));assert.equal(requests,1);
    h.choose('manual');h.inputs.at(-1).done('custom/model');assert.equal(s.getConfig().model,'custom/model');
});
test('app settings validate numeric changes and corrupt stored limits fall back safely',()=>{
    const h=setup({storage:{aip_model_steps:'99999',aip_model_timeout_seconds:'60',aip_result_count:'-3'}});
    assert.equal(h.settings.getConfig().limits.modelCalls,5);
    assert.equal(h.settings.getConfig().limits.modelTimeoutMs,60000);
    assert.equal(h.settings.getConfig().limits.resultCount,10);
    const param=h.params.find(p=>p.field.name==='Шагов ИИ (включая итог)');assert.ok(param);
    let enter;param.onRender({on:(name,fn)=>enter=fn});enter();h.inputs.at(-1).done('8');
    assert.equal(h.settings.getConfig().limits.modelCalls,8);
    enter();h.inputs.at(-1).done('0');assert.equal(h.settings.getConfig().limits.modelCalls,8);
    assert.ok(h.notices.at(-1).includes('3'));assert.equal(h.changes.length,1);
});
