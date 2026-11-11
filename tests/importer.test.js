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
test('unwraps ScsC text and preserves the encrypted original in the backup',()=>{
 const crypto=require('node:crypto'),{deflateSync}=require('node:zlib');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-scsc-'));
 try{
  const file=path.join(dir,'game.sii'),header=Buffer.alloc(56);
  header.write('ScsC');header.writeUInt32LE(Buffer.byteLength(text),52);
  const cipher=crypto.createCipheriv('aes-256-cbc',Buffer.from('2a5fcb1791d22fb60245b3d8369ed0b2c27371563fbf1f3c9edf6b11825a5d0a','hex'),header.subarray(36,52));
  const raw=Buffer.concat([header,cipher.update(deflateSync(text)),cipher.final()]);
  fs.writeFileSync(file,raw);
  const result=importFile(file,job);
  assert.deepEqual(fs.readFileSync(result.backup),raw);
  assert.match(fs.readFileSync(file,'utf8'),/target: "tradeaux.berlin"/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('uses a matching trailer type and refuses incompatible offers',()=>{
 const refrigerated=text.replace('trailer_def.scs.box','trailer_def.scs.box.single_3.reefer');
 assert.match(plan(refrigerated,{...job,trailerType:'chlodnia'}).text,/tradeaux.berlin/);
 assert.throws(()=>plan(refrigerated,{...job,trailerType:'firanka'}),/plandeka/);
});
test('reads the loading point only from a matching active cargo-market job',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-loading-'));
 try{
  const file=path.join(dir,'game.sii');
  const point='(10, 20, 30) (1; 0, 0, 0)';
  fs.writeFileSync(file,`SiiNunit
{
player : _player {
 current_job: _active
}
player_job : _active {
 source_company: company.volatile.transinet.krakow
 source_placement: ${point}
 is_cargo_market_job: true
}
}`);
  const {readLoadingPoint}=require('../telemetry-app/save-importer');
  assert.equal(readLoadingPoint(file,{city:'krakow',company:'transinet'}),point);
  assert.throws(()=>readLoadingPoint(file,{city:'berlin',company:'transinet'}),/tej samej firmy/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('owned trailer import supports modern player_vehicles and legacy fields',()=>{
 const fixture=text.replace(/\n}\s*$/, `
player : _player {
 current_job: null
 selected_job: null
 assigned_vehicles: _vehicles
}
player_vehicles : _vehicles {
 vehicle: _truck
 trailer: _trailer
}
trailer : _trailer {
 trailer_definition: _owned
 slave_trailer: null
}
trailer_def : _owned {
 body_type: curtainside
}
trailer_def : trailer_def.scs.box {
 body_type: curtainside
}
}`);
 const point='(1, 2, 3)(1; 0, 0, 0)';
 const ownedJob={...job,trailerType:'firanka',to:{...job.to,deliveryPlacements:{easy:[point]}}};
 const modern=plan(fixture,ownedJob,{source:point});
 assert.match(modern.text,/is_cargo_market_job: true/);
 assert.match(modern.text,/is_trailer_loaded: false/);
 const legacy=fixture.replace(' assigned_vehicles: _vehicles',' assigned_trailer: _trailer\n my_trailer: _trailer\n my_trailer_attached: true');
 assert.match(plan(legacy,ownedJob,{source:point}).text,/is_cargo_market_job: true/);
 assert.throws(()=>plan(fixture.replace(' trailer: _trailer',' trailer: null'),ownedJob,{source:point}),/nie ma aktywnej/);
});

test('owned trailer accepts matching cargo template from another company',()=>{
 const fixture=text.replace(/\n}\s*$/, `
company : company.volatile.transinet.warszawa {
 job_offer: 1
 job_offer[0]: _tomato
}
job_offer_data : _tomato {
 target: "transinet.krakow"
 expiration_time: 2000
 shortest_distance_km: 300
 cargo: cargo.tomatoes
 trailer_definition: trailer_def.scs.box.single_3.reefer
 units_count: 24
}
player : _player {
 current_job: null
 selected_job: null
 assigned_vehicles: _vehicles
}
player_vehicles : _vehicles {
 vehicle: _truck
 trailer: _trailer
}
trailer : _trailer {
 trailer_definition: _owned
 slave_trailer: null
}
trailer_def : _owned {
 body_type: refrigerated
}
`);
 const point='(1, 2, 3)(1; 0, 0, 0)';
 const route={...job,cargo:{name:'tomatoes'},trailerType:'chlodnia',to:{...job.to,deliveryPlacements:{easy:[point]}}};
 assert.match(plan(fixture,route,{source:point}).text,/cargo: cargo.tomatoes/);
 assert.throws(()=>plan(fixture,route),/brak zgodnego szablonu/);
});
