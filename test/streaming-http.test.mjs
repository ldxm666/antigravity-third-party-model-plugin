import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'agy-stream-forward-'));
process.env.AGY_BRIDGE_HOME=home;
const {start_server}=await import('../core/server.js');
test('native HTTP stream forwards first thought and text before completion and honors saved output',async()=>{
 let seen,bridge;
 const upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  seen=JSON.parse(raw);res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Real upstream thought.',content:'Real upstream first text.'}}]})+'\n\n');
  const timer=setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'),600);res.on('close',()=>clearTimeout(timer));
 });});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 try{
  bridge=await start_server({port:0,config:{log_level:'error',active_provider_id:'fixture',default_model:'gemini-fixture',providers:[{id:'fixture',name:'fixture',kind:'openai',base_url:`http://127.0.0.1:${upstream.address().port}`,api_key:'fixture',models:[{id:'gemini-fixture',ctx:1048576,max_out:131072,reasoning_efforts:['low'],reasoning_effort:'low'}]}]}});
  const begin=Date.now(),response=await fetch(`http://127.0.0.1:${bridge.port}/v1internal:streamGenerateContent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'agy-bridge:fixture:gemini-fixture:low',requestId:'agent/fixture/1',request:{contents:[{role:'user',parts:[{text:'fixture'}]}],generationConfig:{maxOutputTokens:8192,thinkingConfig:{includeThoughts:true}}}})});
  assert.equal(response.status,200);const reader=response.body.getReader();let all='',firstTextMs;
  for(;;){const {done,value}=await reader.read();if(done)break;all+=new TextDecoder().decode(value);if(firstTextMs===undefined&&all.includes('Real upstream first text.'))firstTextMs=Date.now()-begin;}
  assert.ok(firstTextMs<450,`first text delayed ${firstTextMs}ms`);assert.ok(Date.now()-begin>=550);
  assert.match(all,/Real upstream thought\./);assert.match(all,/"thought":true/);assert.match(all,/STOP/);
  assert.equal(seen.max_tokens,131072);assert.equal(seen.extra_body,undefined);assert.equal(seen.reasoning_effort,'low');
  assert.equal(response.headers.get('transfer-encoding'),'chunked');
 }finally{if(bridge)await bridge.close();await new Promise(r=>{upstream.close(r);upstream.closeAllConnections();});}
});

test('midstream provider failure is an aborted HTTP body, never successful EOF',async()=>{
 let bridge,requests=0;
 const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
  requests++;res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_text:'Actual partial thought.'}}]})+'\n\n');
  setTimeout(()=>res.end('data: '+JSON.stringify({error:{message:'fixture stream broke'}})+'\n\n'),100);
 });});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 try{
  bridge=await start_server({port:0,config:{log_level:'error',active_provider_id:'fixture',default_model:'model',providers:[{id:'fixture',name:'fixture',kind:'openai',base_url:`http://127.0.0.1:${upstream.address().port}`,models:[{id:'model'}]}]}});
  const response=await fetch(`http://127.0.0.1:${bridge.port}/v1internal:streamGenerateContent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'agy-bridge:fixture:model:inherit',requestId:'agent/11111111-1111-1111-1111-111111111111/1',request:{contents:[{role:'user',parts:[{text:'PRIVATE_PROMPT_SENTINEL'}]}]}})});
  const reader=response.body.getReader(),first=await reader.read();assert.match(new TextDecoder().decode(first.value),/Actual partial thought/);
  await assert.rejects(async()=>{for(;;){const next=await reader.read();if(next.done)break;}},/terminated|aborted|socket/i);
  assert.equal(requests,1);
  const status=await(await fetch(`http://127.0.0.1:${bridge.port}/api/providers/progress`)).json();
  assert.equal(status.requests[0].status,'failed');assert.equal(status.requests[0].error_code,502);assert.ok(!JSON.stringify(status).includes('PRIVATE_PROMPT_SENTINEL'));
 }finally{if(bridge)await bridge.close();await new Promise(r=>{upstream.close(r);upstream.closeAllConnections();});fs.rmSync(home,{recursive:true,force:true});}
});
