import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../patch/native-page.js',import.meta.url),'utf8');
const progress=source.slice(source.indexOf('  let progressTimer,'),source.indexOf('  function installRequestPolicy()'));
const cascade='11111111-1111-1111-1111-111111111111';
function renderer(api){
 const card={node:null,prepend(node){node.isConnected=true;this.node=node;}};
 const location={pathname:'/c/'+cascade};let busy=true;
 const document={querySelector(selector){return selector.includes('停止执行')?busy?{}:null:selector==='[contenteditable=true]'?{closest(){return card}}:null;},createElement(){return{dataset:{},textContent:'',isConnected:false,remove(){this.isConnected=false;if(card.node===this)card.node=null;}};}};
 const context={api,document,location,setInterval(){return 0;},clearInterval(){}};vm.createContext(context);
 vm.runInContext(progress+';globalThis.progressCheck={updateProgress,stop(){progressStopped=true;clearProgress();}}',context);
 return{card,location,update:context.progressCheck.updateProgress,stop:context.progressCheck.stop,idle(){busy=false;}};
}
test('native progress shows actual provider and incremental tool counts only for the current cascade',async()=>{
 const view=renderer(async()=>({requests:[{cascade_id:'another-chat',started_at:200,status:'running',provider_name:'WRONG_PROVIDER'},
  {cascade_id:cascade,started_at:100,status:'running',phase:'tool_arguments',argument_chars:12000,bytes:14000,events:7,elapsed_ms:3200,provider_name:'TNT',model:'fixture-model'}]}));
 await view.update();assert.match(view.card.node.textContent,/TNT.*正在接收工具参数.*12[,.]?000.*3 秒/);assert.ok(!view.card.node.textContent.includes('WRONG_PROVIDER'));assert.match(view.card.node.title,/不是模型回复/);
 view.idle();await view.update();assert.equal(view.card.node,null);
});
test('a delayed progress response cannot be inserted after navigation or disposal',async()=>{
 let resolve;const view=renderer(()=>new Promise(r=>resolve=r));const pending=view.update();view.location.pathname='/c/22222222-2222-2222-2222-222222222222';
 resolve({requests:[{cascade_id:cascade,started_at:100,provider_name:'old'}]});await pending;assert.equal(view.card.node,null);
 view.stop();await view.update();assert.equal(view.card.node,null);
});
