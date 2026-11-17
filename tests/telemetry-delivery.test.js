'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('repeated Polish routes remain visible and settle exactly once',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-server-'));fs.writeFileSync(path.join(dir,'data.json'),JSON.stringify({companies:[{id:'ks',name:'Nowaczyk Transport'}],initialBudgets:{ks:{initialCents:100,lockedAt:'2026-01-01'}}}));const port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;const start=()=>spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:path.join(dir,'data.json'),PORT:String(port),ADMIN_PASSWORD:'integration-password-only',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});
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
 await req('/api/accounts',{username:'dispatch1',password:'dispatch-password-only',role:'dispatcher'},admin.cookie);
 const dispatcher=await req('/api/accounts/login',{username:'dispatch1',password:'dispatch-password-only'});
 const desktop=await req('/api/desktop/login',{username:'driver1',password:'driver-password-only'},null,{'X-Nowaczyk-Client':'desktop'});
 const headers={'X-Nowaczyk-Desktop-Token':desktop.data.desktopToken};
 const route={from:'Piotrków Trybunalski',to:'Września',sourceCompany:'transinet',destinationCompany:'tradeaux',cargo:'milk',cargoTons:18,plannedKm:215,driver:'driver1'};
 const ids=[];
 for(let i=0;i<2;i++){
  const created=await req('/api/routes',route,dispatcher.cookie);assert.equal(created.status,201);ids.push(created.data.id);
  assert.equal((await req('/api/routes/accept',{routeId:created.data.id},desktop.cookie,headers)).status,200);
 }
 assert.equal((await req('/api/routes?mine=1',null,desktop.cookie)).data.length,2);
 const event={sourceCityId:'piotrkowt',destinationCityId:'wrzesnia',sourceCompanyId:'transinet',destinationCompanyId:'tradeaux',cargoId:'milk',cargoMassKg:18000,odometerKm:1000,type:'job-started',eventKey:'repeated-start-0001'};
 const start=await req('/api/telemetry/events',event,desktop.cookie);assert.ok(ids.includes(start.data.event.mileageRouteId));
 const active=start.data.event.mileageRouteId;
 const delivered={...event,type:'job-delivered',eventKey:'repeated-delivered-0001',jobDeliveredDistanceKm:233.2};
 const delivery=await req('/api/telemetry/events',delivered,desktop.cookie);assert.equal(delivery.data.event.mileageRouteId,active);assert.equal(delivery.data.event.distanceKm,233.2);
 assert.equal((await req('/api/telemetry/events',delivered,desktop.cookie)).data.duplicate,true);
 const routes=(await req('/api/routes?mine=1',null,desktop.cookie)).data;
 assert.equal(routes.filter(r=>r.deliveredAt).length,1);
 assert.equal(routes.find(r=>r.id!==active).status,'Przyjęta');
 await stop();await launch();
 assert.equal((await req('/api/routes?mine=1',null,desktop.cookie)).data.find(r=>r.id===active).drivenKm,233.2);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
