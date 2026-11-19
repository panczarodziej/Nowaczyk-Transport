'use strict';
// MIT RenCloud v1.12.1 Win64. Keep executable code and layout unchanged;
// replace only its fixed-width UTF-16 mapping name to isolate Nowaczyk clients.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ORIGINAL_SHA256='1d03dbc7a975e72203c60a7b9998021ceb8800b836bf28a131279979ad386cd4';
const MAPPING_NAME='Local\\NTTelemetry1';
function isolatedPlugin(original){
 if(crypto.createHash('sha256').update(original).digest('hex')!==ORIGINAL_SHA256)throw Error('Unexpected RenCloud DLL: refusing to modify unverified binary');
 const old=Buffer.from('Local\\SCSTelemetry\0','utf16le'),replacement=Buffer.from(MAPPING_NAME+'\0','utf16le');
 if(old.length!==replacement.length)throw Error('Memory name must retain binary string size');
 const offset=original.indexOf(old);
 if(offset<0||original.indexOf(old,offset+1)>=0)throw Error('Expected exactly one mapping name');
 const result=Buffer.from(original);replacement.copy(result,offset);return result;
}
if(require.main===module){
 const plugins=path.join(__dirname,'plugins');
 fs.writeFileSync(path.join(plugins,'nowaczyk-telemetry.dll'),isolatedPlugin(fs.readFileSync(path.join(plugins,'scs-telemetry.dll'))));
 console.log('Prepared isolated Nowaczyk RenCloud plugin');
}
module.exports={isolatedPlugin,MAPPING_NAME};
