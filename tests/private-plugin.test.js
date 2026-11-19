'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {isolatedPlugin,MAPPING_NAME}=require('../telemetry-app/prepare-plugin');
test('private plugin changes only verified upstream memory name and rejects unexpected binaries',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../telemetry-app/plugins/scs-telemetry.dll'));
 const output=isolatedPlugin(source),old=Buffer.from('Local\\SCSTelemetry\0','utf16le'),name=Buffer.from(MAPPING_NAME+'\0','utf16le'),offset=source.indexOf(old);
 assert.equal(output.length,source.length);assert.deepEqual(output.subarray(0,offset),source.subarray(0,offset));assert.deepEqual(output.subarray(offset+old.length),source.subarray(offset+old.length));assert.deepEqual(output.subarray(offset,offset+name.length),name);
 const corrupted=Buffer.from(source);corrupted[0]^=1;assert.throws(()=>isolatedPlugin(corrupted),/unverified binary/);
});
