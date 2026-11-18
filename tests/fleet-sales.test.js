'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('vehicle sales for bosses, company isolation, leasing, routes and exactly-once credit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-server-'));fs.writeFileSync(path.join(dir,'data.json'),JSON.stringify({companies:[{id:'nowaczyk',name:'Nowaczyk Transport'},{id:'partner',name:'Partner'}],initialBudgets:{nowaczyk:{initialCents:100000},partner:{initialCents:50000}},fleet:[{id:'truck-a',companyId:'nowaczyk',plate:'WA 111'},{id:'truck-b',companyId:'partner',plate:'WB 222'},{id:'lease',companyId:'partner',financing:'lease'},{id:'active',companyId:'partner'}],routes:[{id:'trip',companyId:'partner',vehicleId:'active',driver:'driver1',acceptedAt:'2026-11-18T00:00:00Z',status:'W trasie',drivenKm:135}],maintenance:[{id:'service',companyId:'partner',vehicleId:'truck-b',status:'planned',due:'2026-11-20'}],fleetPolicies:[{id:'policy',companyId:'partner',vehicleId:'truck-b',due:'2099-01-01',end:'2099-12-31',premium:200,paid:false}]}));const port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;const start=()=>spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:path.join(dir,'data.json'),PORT:String(port),ADMIN_PASSWORD:'integration-password-only',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});
 let child;
 function launch(){
  child=start();
  let logs='';
  child.stderr.on('data',chunk=>logs+=chunk);
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error(logs)),8000);
   child.stdout.on('data',chunk=>{
    logs+=chunk;
    if(logs.includes('Online:')){clearTimeout(timer);resolve()}
   });
   child.once('exit',code=>{clearTimeout(timer);reject(Error('Server '+code+' '+logs))});
  });
 }
 async function stop(){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await exited;
 }
 async function req(url,data,cookie,headers={}){const r=await fetch(base+url,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie||'',...headers},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],setCookie:r.headers.get('set-cookie')}}
 try{
 await launch();
 const admin=await req('/api/accounts/login',{username:'admin',password:'integration-password-only'});
 await req('/api/accounts',{username:'driver1',password:'driver-password-only',role:'driver'},admin.cookie);
 await req('/api/accounts',{username:'partnerboss',password:'partner-password-only',role:'boss',companyId:'partner'},admin.cookie);
 await req('/api/accounts',{username:'subboss',password:'subcontractor-password',role:'subcontractor',companyId:'partner'},admin.cookie);
 const driver=await req('/api/accounts/login',{username:'driver1',password:'driver-password-only'});
 const partner=await req('/api/accounts/login',{username:'partnerboss',password:'partner-password-only'});
 const sub=await req('/api/accounts/login',{username:'subboss',password:'subcontractor-password'});
 const sale={id:'truck-b',amount:'12345.67',buyer:'Testowy nabywca'};
 assert.equal((await req('/api/fleet/sell',sale)).status,403);
 assert.equal((await req('/api/fleet/sell',sale,driver.cookie)).status,403);
 assert.equal((await req('/api/fleet/sales',null,driver.cookie)).status,403);
 assert.equal((await req('/api/fleet/sell',{...sale,id:'truck-a'},partner.cookie)).status,404);
 for(const amount of ['0','-1','1.001','NaN','1000000000',100])assert.equal((await req('/api/fleet/sell',{...sale,amount},partner.cookie)).status,400);
 assert.equal((await req('/api/fleet/sell',{...sale,id:'lease'},partner.cookie)).status,409);
 assert.equal((await req('/api/fleet/sell',{...sale,id:'active'},partner.cookie)).status,409);
 const before=(await req('/api/company/board',null,partner.cookie)).data.summary.cash;
 const results=await Promise.all([req('/api/fleet/sell',sale,partner.cookie),req('/api/fleet/sell',sale,sub.cookie)]);
 assert.ok(results.every(r=>r.status===200));assert.equal(results.filter(r=>r.data.duplicate).length,1);
 assert.equal(results[0].data.companyId,'partner');
 const board=(await req('/api/company/board',null,partner.cookie)).data;
 assert.equal(board.summary.cash,Math.round((before+12345.67)*100)/100);
 assert.equal(board.summary.revenue,0);
 assert.equal(board.maintenance.find(x=>x.id==='service').status,'cancelled');
 assert.ok(!board.dues.some(x=>x.id==='policy'));
 assert.equal((await req('/api/company/maintenance/complete',{id:'service',amount:100,invoiceNumber:'FV'},partner.cookie)).status,409);
 const fleet=(await req('/api/fleet',null,partner.cookie)).data.fleet;
 assert.ok(!fleet.some(v=>v.id==='truck-b'));
 const history=(await req('/api/fleet/sales',null,sub.cookie)).data.sales;assert.equal(history.length,1);assert.equal(history[0].buyer,'Testowy nabywca');
 const main=await req('/api/fleet/sell',{id:'truck-a',amount:'20000'},admin.cookie);assert.equal(main.status,200);assert.equal(main.data.companyId,'nowaczyk');
 assert.equal((await req('/api/fleet/sales',null,partner.cookie)).data.sales.length,1);
 assert.equal((await req('/api/fleet/sales',null,admin.cookie)).data.sales.length,2);
 assert.equal((await req('/api/routes?mine=1',null,partner.cookie)).data.length,0);
 await stop();await launch();
 assert.equal((await req('/api/fleet/sales',null,partner.cookie)).data.sales.length,1);
 assert.equal((await req('/api/fleet/sell',sale,partner.cookie)).data.duplicate,true);
 const persisted=JSON.parse(fs.readFileSync(path.join(dir,'data.json'),'utf8'));
 assert.equal(persisted.ledger.filter(e=>e.type==='sprzedaz_pojazdu'&&e.vehicleId==='truck-b').length,1);
 assert.equal(persisted.routes.find(r=>r.id==='trip').drivenKm,135);
 assert.ok(persisted.fleetPolicies[0].cancelledAt);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
