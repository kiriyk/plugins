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

test('diagnostics can be enabled viewed and cleared from plugin settings without exposing the key',()=>{
 const h=createDOMHarness({storage:{aip_api_key:'PRIVATE-KEY'}}),{createDiagnostics}=require('../src/diagnostics');
 const journal=createDiagnostics({Storage:h.Lampa.Storage,clock:h.clock});
 const s=registerSettings({Lampa:h.Lampa,routerai:{},diagnostics:journal,window:h.window,document:h.document,$:h.$});
 s.open();h.choose('Диагностика');h.choose('toggle');assert.equal(journal.isEnabled(),true);
 journal.record('stage',{stage:'searching'});
 s.open();h.choose('Диагностика');h.choose('view');
 assert.equal(h.modals.at(-1).buttons.length,0,'journal arrows must scroll text rather than focus a footer button');
 assert.ok(h.modals.at(-1).html[0].textContent.includes('"records"'));assert.equal(h.modals.at(-1).html[0].textContent.includes('PRIVATE-KEY'),false);
 h.modals.at(-1).onBack();
 s.open();h.choose('Диагностика');h.choose('clear');assert.equal(JSON.parse(journal.exportText()).records.length,0);
 assert.ok(h.params.some(p=>p.field.name==='Диагностика и журнал'));
});
test('download and copy export only sanitized journal data and remain user actions',()=>{
 const h=createDOMHarness({storage:{aip_api_key:'PRIVATE-KEY'}}),{createDiagnostics}=require('../src/diagnostics');
 const journal=createDiagnostics({Storage:h.Lampa.Storage,clock:h.clock});journal.setEnabled(true);journal.record('stage',{stage:'searching',message:'PRIVATE-KEY'});
 let file='',clicked=0,copied='',revoked=0;
 h.window.Blob=class{constructor(parts){file=parts.join('');}};
 h.window.URL={createObjectURL:()=> 'blob:test',revokeObjectURL:()=>revoked++};
 h.window.setTimeout=h.clock.setTimeout;
 const original=h.document.createElement.bind(h.document);
 h.document.createElement=name=>{const node=original(name);if(name==='a')node.click=()=>clicked++;return node;};
 h.document.execCommand=()=>{copied=h.document.querySelector('textarea').value;return true;};
 const s=registerSettings({Lampa:h.Lampa,routerai:{},diagnostics:journal,window:h.window,document:h.document,$:h.$});
 assert.equal(clicked,0);
 s.open();h.choose('Диагностика');h.choose('download');assert.equal(clicked,1);assert.ok(file.includes('"records"'));assert.equal(file.includes('PRIVATE-KEY'),false);
 h.advance(1000);assert.equal(revoked,1);
 s.open();h.choose('Диагностика');h.choose('copy');assert.equal(copied,journal.exportText());
 assert.equal(h.document.querySelector('textarea'),null);
});