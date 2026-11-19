'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ensurePlugin}=require('../telemetry-app/plugin-install');
test('automatic plugin installation waits for game exit, verifies copied contents and is idempotent',async t=>{
 const game=fs.mkdtempSync(path.join(os.tmpdir(),'nowaczyk-plugin-'));t.after(()=>fs.rmSync(game,{recursive:true,force:true}));
 const bin=path.join(game,'bin','win_x64');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'eurotrucks2.exe'),'test');
 const source=path.join(game,'bundled.dll');fs.writeFileSync(source,'plugin-v1');
 for(const running of [true,null]){const result=await ensurePlugin({game,source,running});assert.equal(result.pending,true);assert.equal(fs.existsSync(result.target),false)}
 const result=await ensurePlugin({game,source,running:false});assert.equal(result.installed,true);assert.equal(fs.readFileSync(result.target,'utf8'),'plugin-v1');
 assert.equal((await ensurePlugin({game,source,running:true})).changed,false);
 fs.writeFileSync(source,'plugin-v2');await ensurePlugin({game,source,running:false});assert.equal(fs.readFileSync(result.target,'utf8'),'plugin-v2');assert.equal(fs.readdirSync(path.dirname(result.target)).filter(x=>x.includes('.backup-')).length,1);
 await assert.rejects(ensurePlugin({game,source:source+'missing',running:false}),/Brak wtyczki/);
});
