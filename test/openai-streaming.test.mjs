import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {adapter_for}from '../core/providers/index.js';import {normalize_request,to_openai_request}from '../core/translate.js';
const gen=normalize_request({contents:[{role:'user',parts:[{text:'fixture'}]}]});
async function fixture(handler,check){const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>handler(req,res));});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await check({base_url:`http://127.0.0.1:${server.address().port}`,api_key:'fixture'});}finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});}}
const ctx={upstream_model:'fixture',timeouts:{request_ms:1000,stream_idle_ms:500}};
test('Gemini OpenAI compatibility preserves requested thought summaries and effort without conflicting fields',()=>{
 const input={...gen,reasoning_effort:'low',generation_config:{maxOutputTokens:1000000,thinkingConfig:{includeThoughts:true,thinkingBudget:0}}};
 const before=JSON.stringify(input),out=to_openai_request(input,{model:'gemini-4-argon-high',stream:true});
 assert.equal(out.reasoning_effort,'low');assert.equal(out.extra_body,undefined);assert.equal(out.max_tokens,1000000);assert.equal(JSON.stringify(input),before);
 const google=to_openai_request(input,{model:'gemini-4-argon-high',stream:true,google_thinking:true});
 assert.deepEqual(google.extra_body,{google:{thinking_config:{include_thoughts:true,thinking_level:'low'}}});assert.equal(google.reasoning_effort,undefined);
 const other=to_openai_request(input,{model:'gpt-fixture',stream:true});assert.equal(other.reasoning_effort,'low');assert.equal(other.extra_body,undefined);
 const hidden=to_openai_request({...input,generation_config:{thinkingConfig:{includeThoughts:false}}},{model:'gemini-3.8-flash',stream:true,google_thinking:true});assert.equal(hidden.extra_body.google.thinking_config.include_thoughts,false);
});
async function collect(p,c=ctx){const out=[];for await(const d of adapter_for('openai').stream(p,gen,c))out.push(d);return out;}
test('OpenAI DONE terminates without waiting for socket close and releases buffered calls',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'write_file',arguments:'{"path":"fixture.html"}'}}]}}]})+'\n\ndata: [DONE]\n\n');},async p=>{const out=await collect(p);assert.equal(out.find(d=>d.kind==='tool_call')?.args.path,'fixture.html');assert.equal(out.at(-1).reason,'STOP');});
});
test('OpenAI JSON fallback forwards text, reasoning, parallel tool calls and usage',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ready',reasoning_content:'checking',tool_calls:[{id:'a',type:'function',function:{name:'one',arguments:'{"a":1}'}},{id:'b',type:'function',function:{name:'two',arguments:'{"b":2}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));},async p=>{const out=await collect(p);assert.equal(out.find(d=>d.kind==='text').text,'ready');assert.equal(out.find(d=>d.kind==='thought').text,'checking');assert.deepEqual(out.filter(d=>d.kind==='tool_call').map(d=>d.name),['one','two']);assert.equal(out.find(d=>d.kind==='usage').total,15);});
});
test('OpenAI SSE complete-message variant is forwarded instead of silently dropped',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{message:{content:'snapshot'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');},async p=>{assert.equal((await collect(p)).find(d=>d.kind==='text')?.text,'snapshot');});
});
test('OpenAI exhausted budget with no answer is an explicit error, not an empty continuation',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:''},finish_reason:'length'}],usage:{completion_tokens:8192,completion_tokens_details:{reasoning_tokens:8192}}})+'\n\ndata: [DONE]\n\n');},async p=>{await assert.rejects(collect(p),e=>e.code===422&&/预算/.test(e.message));});
});
test('OpenAI incomplete tool JSON is never converted into an executable empty argument object',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{name:'write_file',arguments:'{"content":"truncated'}}]},finish_reason:'length'}]})+'\n\n');},async p=>{await assert.rejects(collect(p),e=>e.code===422&&/参数/.test(e.message));});
});
test('OpenAI text and thoughts are forwarded before generation finishes',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'first thought',content:'first text'}}]})+'\n\n');const timer=setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'),250);res.on('close',()=>clearTimeout(timer));},async p=>{const begin=Date.now(),times=[];for await(const d of adapter_for('openai').stream(p,gen,ctx))times.push({kind:d.kind,ms:Date.now()-begin});assert.ok(times.find(d=>d.kind==='text').ms<200);assert.ok(times.find(d=>d.kind==='thought').ms<200);assert.ok(times.find(d=>d.kind==='finish').ms>=220);});
});
test('OpenAI JSON stream fallback keeps the response-body deadline',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();},async p=>{await assert.rejects(collect(p,{...ctx,timeouts:{request_ms:1000,stream_idle_ms:70}}),e=>e.code===504);});
});
test('OpenAI SSE keepalive comments cannot extend an idle model indefinitely',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();const timer=setInterval(()=>res.write(': keepalive\n\n'),10);res.on('close',()=>clearInterval(timer));},async p=>{await assert.rejects(collect(p,{...ctx,timeouts:{request_ms:1000,stream_idle_ms:70}}),e=>e.code===504);});
});
test('latency telemetry reports phases and counts without response content',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'PRIVATE_FIXTURE_SENTINEL'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');},async p=>{const events=[];await collect(p,{...ctx,on_progress:(phase,extra)=>events.push({phase,...extra})});assert.ok(events.some(e=>e.phase==='upstream_headers'));assert.ok(events.some(e=>e.phase==='upstream_bytes'));assert.ok(!JSON.stringify(events).includes('PRIVATE_FIXTURE_SENTINEL'));});
});

test('DSH-compatible reasoning aliases stream immediately without duplicate or encrypted text',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});
  for(const delta of [{reasoning_text:'alias one'},{reasoning_details:[{type:'reasoning.text',text:'alias two'},{type:'reasoning.encrypted',data:'PRIVATE_SIGNATURE'}]},{reasoning:'one copy',reasoning_text:'one copy',reasoning_details:[{type:'reasoning.text',text:'one copy'}]},{content:'answer'}])res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');
  res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 },async p=>{const out=await collect(p);assert.deepEqual(out.filter(x=>x.kind==='thought').map(x=>x.text),['alias one','alias two','one copy']);assert.ok(!JSON.stringify(out).includes('PRIVATE_SIGNATURE'));});
});

test('premature EOF never commits even a complete tool JSON',async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{name:'write_file',arguments:'{"path":"must-not-execute"}'}}]}}]})+'\n\n');},async p=>{const yielded=[];await assert.rejects(async()=>{for await(const delta of adapter_for('openai').stream(p,gen,ctx))yielded.push(delta)},e=>e.code===502&&/提前断开/.test(e.message));assert.ok(!yielded.some(x=>x.kind==='tool_call'));});
});

test('thought-only terminal replies do not become successful empty completions',async()=>{
 for(const terminal of ['stop','done'])await fixture((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_text:'partial'}}]})+'\n\n');res.end(terminal==='stop'?'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n':'data: [DONE]\n\n');},async p=>{await assert.rejects(collect(p),e=>e.code===422);});
});
