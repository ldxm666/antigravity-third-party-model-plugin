import test from 'node:test';
import assert from 'node:assert/strict';
import { create_request_progress } from '../core/request-progress.js';
const cascade='11111111-1111-1111-1111-111111111111';
test('progress associates the actual cascade and accumulates deltas without payloads',()=>{
 let time=1000;const store=create_request_progress({now:()=>time});
 const row=store.start({trace:'one',request_id:`agent/${cascade}/100/turn/1`,provider_name:'fixture',model:'model',effort:'high',api_key:'PRIVATE_KEY_SENTINEL'});
 row.note('upstream_headers');row.note('upstream_bytes',{bytes:100,body:'PRIVATE_BODY_SENTINEL'});row.note('upstream_bytes',{bytes:20});
 row.note('upstream_tool_fragment',{argument_chars:13,arguments:'PRIVATE_ARGUMENTS_SENTINEL'});row.note('upstream_tool_fragment',{argument_chars:7});time=2000;
 const result=store.snapshot()[0];assert.equal(result.cascade_id,cascade);assert.equal(result.bytes,120);assert.equal(result.argument_chars,20);assert.equal(result.elapsed_ms,1000);assert.equal(result.phase,'tool_arguments');assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
 row.finish('failed',502);time=3000;row.note('forward_text');row.finish('complete');
 assert.equal(store.snapshot()[0].status,'failed');assert.equal(store.snapshot()[0].elapsed_ms,1000);
});
test('progress ignores non-agent tasks, expires ended rows and bounds memory',()=>{
 let time=0;const store=create_request_progress({now:()=>time,limit:2,retention_ms:50});
 store.start({trace:'other',request_id:'checkpoint/fixture'}).finish('complete');assert.deepEqual(store.snapshot(),[]);
 const a=store.start({trace:'a',request_id:`agent/${cascade}/1`});store.start({trace:'b',request_id:`agent/${cascade}/2`});store.start({trace:'c',request_id:`agent/${cascade}/3`});
 assert.deepEqual(store.snapshot().map(x=>x.trace),['b','c']);a.finish('complete');
 const ended=store.start({trace:'d',request_id:`agent/${cascade}/4`});ended.finish('complete');time=50;
 assert.deepEqual(store.snapshot().map(x=>x.trace),['c']);
});
