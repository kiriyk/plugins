'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./helpers.cjs');const {assistant}=require('./fixtures.cjs');
const {createRouterAI}=require('../src/routerai');
function setup(){const h=createHarness();return {...h,api:createRouterAI({request:h.request})};}
const input={key:'test-key',model:'test/model',messages:[{role:'user',content:'Кино'}],tools:[],toolChoice:'none',timeoutMs:25000};
test('chat sends OpenAI-compatible JSON and normalizes tool calls',()=>{
    const h=setup();let result;
    h.api.chat({...input,tools:[{type:'function',function:{name:'search_titles'}}],toolChoice:'auto'},(e,r)=>{assert.equal(e,null);result=r;});
    assert.equal(h.requests[0].url,'https://routerai.ru/api/v1/chat/completions');
    assert.equal(h.requests[0].json.max_tokens,2048);assert.equal(h.requests[0].json.stream,false);
    assert.equal(h.requests[0].headers.Authorization,'Bearer test-key');assert.equal(h.requests[0].json.response_format,undefined);
    h.reply(0,assistant([{name:'search_titles',arguments:{query:'Остров'}}]));
    assert.equal(result.tool_calls[0].name,'search_titles');assert.equal(result.role,'assistant');
});
test('probe accepts only the requested function with valid arguments',()=>{
    const h=setup();let good,error;
    h.api.probe(input,(e,r)=>{error=e;good=r;});
    assert.equal(h.requests[0].json.tool_choice.function.name,'connection_check');
    h.reply(0,assistant([{name:'connection_check',arguments:{ok:true}}]));
    assert.equal(error,null);assert.equal(good.ok,true);assert.equal(h.requests.length,1);
    h.api.probe(input,e=>error=e);h.reply(1,assistant([], 'hello'));assert.equal(error.code,'incompatible_model');
    h.api.probe(input,e=>error=e);h.reply(2,assistant([{name:'connection_check',arguments:'{bad'}]));assert.equal(error.code,'incompatible_model');
});
test('model list filters image-only models and marks tools without inventing support',()=>{
    const h=setup();let models;
    h.api.listModels('test-key',(e,r)=>models=r);
    h.reply(0,{data:[
        {id:'a',name:'Text',architecture:{output_modalities:['text']},supported_parameters:['tools']},
        {id:'b',architecture:{output_modalities:['image']},supported_parameters:['tools']},
        {id:'c',architecture:{output_modalities:['text']}},
    ]});
    assert.deepEqual(models,[{id:'a',name:'Text',supportsTools:true},{id:'c',name:'c',supportsTools:false}]);
});
for(const [status,code] of [[401,'auth'],[402,'balance'],[403,'auth'],[429,'rate_limit'],[503,'server']]){
    test('HTTP '+status+' returns a safe error without paid retry',()=>{
        const h=setup();let error;h.api.chat(input,e=>error=e);
        h.reject(0,{status,responseText:'test-key'});assert.equal(error.code,code);
        assert.equal(h.requests.length,1);assert.equal(JSON.stringify(error).includes('test-key'),false);
    });
}
test('malformed envelopes and duplicate or malformed tool call IDs are rejected',()=>{
    const h=setup();let error;
    for(const body of [{choices:[]},{choices:[{message:null}]},assistant([{id:'same',name:'x'},{id:'same',name:'x'}]),assistant([{name:'x',arguments:{}}])]){
        const i=h.requests.length;h.api.chat(input,e=>error=e);
        if(i===3)body.choices[0].message.tool_calls[0].function.arguments={};h.reply(i,body);
        assert.equal(error.code,'invalid_response');
    }
});
test('empty key or model fails locally without a request',()=>{
    const h=setup();let error;
    h.api.chat({...input,key:''},e=>error=e);assert.equal(error.code,'invalid_arguments');assert.equal(h.requests.length,0);
});
