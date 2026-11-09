'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {plan,importFile}=require('../telemetry-app/save-importer');
const text=`SiiNunit
{
economy : _economy {
 game_time: 1000
}
company : company.volatile.transinet.krakow {
 job_offer: 1
 job_offer[0]: _job
}
company : company.volatile.tradeaux.berlin {
 job_offer: 0
}
job_offer_data : _job {
 target: "transinet.warszawa"
 expiration_time: 2000
 shortest_distance_km: 300
 cargo: cargo.pallets
 trailer_definition: trailer_def.scs.box
 units_count: 33
}
}
`;
const job={from:{city:'Krakow',company:'transinet'},to:{city:'Berlin',company:'tradeaux'},cargo:{name:'pallets',tons:18},plannedKm:600};
test('import changes referenced source offer and preserves cargo/trailer/units',()=>{const r=plan(text,job);assert.match(r.text,/target: "tradeaux.berlin"/);assert.match(r.text,/shortest_distance_km: 600/);assert.match(r.text,/units_count: 33/);assert.match(r.text,/expiration_time: 11080/);assert.equal(r.source,'company.volatile.transinet.krakow')});
test('reject unknown company, absent cargo and binary saves',()=>{assert.throws(()=>plan(text,{...job,to:{city:'X',company:'Y'}}));assert.throws(()=>plan(text,{...job,cargo:{name:'unknown'}}));assert.throws(()=>plan('ScsCbinary',job))});
test('backup is exact original and failed import never modifies save',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-'));try{const file=path.join(dir,'game.sii');fs.writeFileSync(file,text);const result=importFile(file,job);assert.equal(fs.readFileSync(result.backup,'utf8'),text);assert.match(fs.readFileSync(file,'utf8'),/tradeaux.berlin/);const before=fs.readFileSync(file);assert.throws(()=>importFile(file,{...job,cargo:{name:'unknown'}}));assert.deepEqual(fs.readFileSync(file),before)}finally{fs.rmSync(dir,{recursive:true,force:true})}});
test('nested API export retains cities, companies and mass',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-manifest-'));try{const r=require('../telemetry-app/speditor-bridge').prepare(job,dir);assert.equal(r.fields.massKg,18000);assert.equal(r.fields.from,'Krakow');assert.equal(r.fields.sourceCompany,'transinet')}finally{fs.rmSync(dir,{recursive:true,force:true})}});
