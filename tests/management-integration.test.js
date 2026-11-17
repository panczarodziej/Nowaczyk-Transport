'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('board access, service costs, duplicate completion and company isolation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-server-'));fs.writeFileSync(path.join(dir,'data.json'),JSON.stringify({companies:[{id:'nowaczyk',name:'Nowaczyk Transport'},{id:'partner',name:'Partner'}],initialBudgets:{nowaczyk:{initialCents:100000},partner:{initialCents:50000}},fleet:[{id:'truck-a',companyId:'nowaczyk',plate:'WA 111'},{id:'truck-b',companyId:'partner',plate:'WB 222'}]}));const port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;const start=()=>spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:path.join(dir,'data.json'),PORT:String(port),ADMIN_PASSWORD:'integration-password-only',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});
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
 const driver=await req('/api/accounts/login',{username:'driver1',password:'driver-password-only'});
 const partner=await req('/api/accounts/login',{username:'partnerboss',password:'partner-password-only'});
 assert.equal((await req('/api/company/board')).status,403);
 assert.equal((await req('/api/company/board',null,driver.cookie)).status,403);
 assert.equal((await fetch(base+'/biuro-zarzadu.html',{headers:{Cookie:driver.cookie}})).status,403);
 assert.equal((await fetch(base+'/biuro-zarzadu.html',{headers:{Cookie:partner.cookie}})).status,200);
 assert.equal((await req('/api/company/board?companyId=nowaczyk',null,partner.cookie)).status,403);
 const own=await req('/api/company/board',null,partner.cookie);assert.equal(own.status,200);assert.equal(own.data.fleet.length,1);assert.equal(own.data.fleet[0].plate,'WB 222');
 assert.equal((await req('/api/company/board?month=2026-13',null,admin.cookie)).status,400);
 const plan={vehicleId:'truck-a',description:'Wymiana oleju',due:'2026-11-20',estimate:150};
 assert.equal((await req('/api/company/maintenance',plan,driver.cookie)).status,403);
 assert.equal((await req('/api/company/maintenance',plan,partner.cookie)).status,400);
 assert.equal((await req('/api/company/maintenance',{...plan,due:'2026-02-30'},admin.cookie)).status,400);
 const planned=await req('/api/company/maintenance',plan,admin.cookie);assert.equal(planned.status,201);
 assert.equal((await req('/api/company/board',null,admin.cookie)).data.summary.cash,1000);
 const completion={id:planned.data.id,amount:125,invoiceNumber:'FV/2026/11'};
 assert.equal((await req('/api/company/maintenance/complete',completion,partner.cookie)).status,404);
 assert.equal((await req('/api/company/maintenance/complete',{...completion,invoiceNumber:''},admin.cookie)).status,400);
 const results=await Promise.all([req('/api/company/maintenance/complete',completion,admin.cookie),req('/api/company/maintenance/complete',completion,admin.cookie)]);
 assert.equal(results.filter(r=>r.data.duplicate).length,1);
 const board=await req('/api/company/board',null,admin.cookie);assert.equal(board.data.summary.cash,875);assert.equal(board.data.maintenance[0].status,'completed');
 assert.equal((await req('/api/company/board',null,partner.cookie)).data.maintenance.length,0);
 const expensive=await req('/api/company/maintenance',plan,admin.cookie);
 assert.equal((await req('/api/company/maintenance/complete',{...completion,id:expensive.data.id,amount:2000},admin.cookie)).status,409);
 assert.equal((await req('/api/company/board',null,admin.cookie)).data.summary.cash,875);
 await stop();await launch();
 assert.equal((await req('/api/company/board',null,admin.cookie)).data.maintenance.filter(x=>x.status==='completed').length,1);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
