import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
if(process.platform!=='win32'){console.log('Installer fixture: Windows only; skipped.');process.exit(0);}
const root=path.resolve(import.meta.dirname,'..');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'agy-installer-fixture-'));
const source=path.join(work,'fixture'),archive=path.join(work,'app.asar'),installed=path.join(work,'installed');
const npx=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npx-cli.js');
const ps=(args)=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass',...args],{encoding:'utf8',windowsHide:true,maxBuffer:2**22});
try{
  fs.mkdirSync(path.join(source,'dist'),{recursive:true});
  fs.writeFileSync(path.join(source,'dist/main.js'),`const electron_1={},utils_1={};\nconst menu=[\n            {\n                label: 'Quit',\n                click:()=>{}\n            },\n];\n`);
  fs.writeFileSync(path.join(source,'dist/preload.js'),`globalThis.fixtureLocalisation='preserve original';\n`);
  fs.writeFileSync(path.join(source,'dist/languageServer.js'),`const args=['--api_server_url', 'https://generativelanguage.googleapis.com','--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com'];\n`);
  execFileSync(process.execPath,[npx,'--yes','@electron/asar@3.4.1','pack',source,archive],{windowsHide:true,stdio:'pipe'});
  const original=fs.readFileSync(archive),sum=b=>crypto.createHash('sha256').update(b).digest('hex');
  const userConfig=path.join(process.env.LOCALAPPDATA,'agy-bridge/config.json');
  const beforeConfig=fs.existsSync(userConfig)?sum(fs.readFileSync(userConfig)):null;
  const args=['-File',path.join(root,'install/oneclick.ps1'),'-InstallDir',installed,'-AsarPath',archive,'-NodePath',process.execPath,'-NoIntegrations','-SkipStart'];
  const plan=JSON.parse(ps([...args,'-DryRun']));assert.equal(plan.dryRun,true);assert.equal(fs.existsSync(installed),false);
  ps(args);
  assert.notEqual(sum(fs.readFileSync(archive)),sum(original));assert.deepEqual(fs.readFileSync(archive+'.agybridge.bak'),original);
  const pin=fs.readFileSync(path.join(installed,'install/node-path.txt'));assert.equal(pin.readUInt16LE(0),0xfeff);assert.equal(pin.subarray(2).toString('utf16le'),process.execPath);
  assert.ok(fs.existsSync(path.join(installed,'core/model-capabilities.js')));
  assert.equal(fs.existsSync(path.join(installed,'config.json')),false);
  ps(args);assert.deepEqual(fs.readFileSync(archive+'.agybridge.bak'),original,'upgrade must keep the original backup');
  execFileSync(process.execPath,[path.join(installed,'patch/restore.mjs'),'--asar',archive],{windowsHide:true,stdio:'pipe'});
  assert.deepEqual(fs.readFileSync(archive),original,'rollback must restore exact original bytes');
  const afterConfig=fs.existsSync(userConfig)?sum(fs.readFileSync(userConfig)):null;assert.equal(afterConfig,beforeConfig,'fixture install must not alter user configuration');
  console.log('Installer fixture passed: dry-run, install, upgrade, Unicode node pin, unchanged profile, byte-exact rollback. No processes, shortcuts or user settings were changed.');
}finally{fs.rmSync(work,{recursive:true,force:true});}
