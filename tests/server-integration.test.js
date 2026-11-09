'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('login → dispatch → nested export → telemetry → driver panel and deduplication',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-server-'));const port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:path.join(dir,'data.json'),PORT:String(port),ADMIN_PASSWORD:'integration-password-only',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 async function req(url,data,cookie,headers={}){const r=await fetch(base+url,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie||'',...headers},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),8000);child.stdout.on('data',()=>{if(logs.includes('Online:')){clearTimeout(timer);resolve()}});child.on('exit',code=>{clearTimeout(timer);reject(Error('Server '+code+' '+logs))})});
 const admin=await req('/api/accounts/login',{username:'admin',password:'integration-password-only'});assert.equal(admin.status,200);
 const created=await req('/api/accounts',{username:'driver1',password:'driver-password-only',role:'driver'},admin.cookie);assert.equal(created.status,201);
 const login=await req('/api/accounts/login',{username:'driver1',password:'driver-password-only'});assert.equal(login.status,200);
 const route={from:'Krakow',to:'Berlin',sourceCompany:'transinet',destinationCompany:'tradeaux',cargo:'pallets',cargoTons:18,plannedKm:600,driver:'driver1'};
 const dispatcherAccount=await req('/api/accounts',{username:'dispatcher1',password:'dispatcher-password-only',role:'dispatcher'},admin.cookie);
 assert.equal(dispatcherAccount.status,201);
 const dispatcher=await req('/api/accounts/login',{username:'dispatcher1',password:'dispatcher-password-only'});
 assert.equal(dispatcher.status,200);
 assert.equal((await fetch(base+'/spedytor.html',{headers:{Cookie:dispatcher.cookie}})).status,200);
 assert.equal((await fetch(base+'/moj-panel.html',{headers:{Cookie:login.cookie}})).status,200);
 assert.equal((await fetch(base+'/spedytor.html',{headers:{Cookie:login.cookie}})).status,403);
 const assigned=await req('/api/routes',route,dispatcher.cookie);assert.equal(assigned.status,201);
 // Website sessions cannot accept, even when a client name header is supplied.
 assert.equal((await req('/api/routes/accept',{routeId:assigned.data.id},login.cookie,{'X-Nowaczyk-Client':'desktop'})).status,403);
 assert.equal((await req('/api/desktop/login',{username:'driver1',password:'driver-password-only'},null,{'X-Nowaczyk-Client':'desktop',Origin:base})).status,403);
 const desktop=await req('/api/desktop/login',{username:'driver1',password:'driver-password-only'},null,{'X-Nowaczyk-Client':'desktop'});assert.equal(desktop.status,200);assert.ok(desktop.data.desktopToken);
 const desktopHeaders={'X-Nowaczyk-Desktop-Token':desktop.data.desktopToken};
 assert.equal((await req('/api/routes/progress',{id:assigned.data.id,drivenKm:10,status:'W trasie'},admin.cookie)).status,409);
 const accepted=await req('/api/routes/accept',{routeId:assigned.data.id},desktop.cookie,desktopHeaders);assert.equal(accepted.status,200);assert.equal(accepted.data.route.status,'Przyjęta');assert.equal(accepted.data.route.acceptedVia,'desktop');
 assert.equal((await req('/api/routes/accept',{routeId:assigned.data.id},desktop.cookie,desktopHeaders)).data.duplicate,true);
 assert.equal((await req('/api/routes/accept',{routeId:assigned.data.id},login.cookie,desktopHeaders)).status,403);
 assert.equal((await req('/api/routes/accept',{routeId:assigned.data.id},desktop.cookie,{...desktopHeaders,Origin:base})).status,403);
 const otherRoute=await req('/api/routes',{...route,driver:'other-driver'},admin.cookie);assert.equal((await req('/api/routes/accept',{routeId:otherRoute.data.id},desktop.cookie,desktopHeaders)).status,403);
 const second=await req('/api/routes',{...route,to:'Poznan'},admin.cookie);assert.equal((await req('/api/routes/accept',{routeId:second.data.id},desktop.cookie,desktopHeaders)).status,200);
 const meDesktop=await req('/api/accounts/me',null,desktop.cookie);assert.equal(meDesktop.data.user.desktopToken,undefined);
 const panel=await fetch(base+'/system.html',{headers:{Cookie:admin.cookie}});assert.equal(panel.status,200);assert.match(await panel.text(),/fetch\('\/api\/accounts\/me'/);
 for(const mapProfile of ['promods','promods-pr']){
  assert.equal((await req('/api/driver/map-profile',{mapProfile},desktop.cookie)).status,200);
  assert.equal((await req('/api/driver/map-profile',null,desktop.cookie)).data.mapProfile,mapProfile);
  assert.equal((await req('/api/routes/export?id='+assigned.data.id,null,desktop.cookie)).data.mapProfile,mapProfile);
 }
 assert.equal((await req('/api/driver/map-profile',{mapProfile:'unsupported'},desktop.cookie)).status,400);
 const exported=await req('/api/routes/export?id='+assigned.data.id,null,login.cookie);assert.ok(exported.data.acceptedAt);
assert.equal(exported.data.cargo.tons,18);assert.equal(exported.data.from.company,'transinet');
 const packet={x:12,z:45,speedKmh:54,activity:'Jazda',cargo:'pallets',cargoMassKg:18000,onJob:true,cargoLoaded:true};assert.equal((await req('/api/fleet/position',packet,login.cookie)).status,200);
 const event={type:'job-started',eventKey:'test-event-123456',sourceCity:'Krakow',destinationCity:'Berlin',sourceCompany:'transinet',destinationCompany:'tradeaux',cargo:'pallets',cargoMassKg:18000};
 assert.equal((await req('/api/telemetry/events',event,login.cookie)).data.event.matchStatus,'matched');assert.equal((await req('/api/telemetry/events',event,login.cookie)).data.duplicate,true);
 assert.equal((await req('/api/telemetry/events',{...event,eventKey:'bad-mass-123456',cargoMassKg:12000},login.cookie)).data.event.matchStatus,'unmatched');
 const delivered={...event,type:'job-delivered',eventKey:'delivery-event-123456'};
 const delivery=await req('/api/telemetry/events',delivered,desktop.cookie);
 assert.equal(delivery.status,201);
 assert.equal(delivery.data.event.routeId,assigned.data.id);
 assert.equal(delivery.data.event.settlementAllowed,false);
 assert.equal((await req('/api/telemetry/events',delivered,desktop.cookie)).data.duplicate,true);
 const events=await req('/api/telemetry/events',null,dispatcher.cookie);
 assert.equal(events.data.at(-1).type,'job-delivered');
 const me=await req('/api/telemetry/me',null,login.cookie);assert.equal(me.data.position.cargoMassKg,18000);assert.equal(me.data.events.length,3);assert.equal((await req('/api/fleet/positions',null,login.cookie)).status,403);
 // Parallel writes must not overwrite each other in the single-process store.
 const writes=await Promise.all(Array.from({length:6},(_,i)=>req('/api/routes',{...route,to:'City'+i},admin.cookie)));assert.ok(writes.every(x=>x.status===201));assert.equal((await req('/api/routes',null,admin.cookie)).data.length,9);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(dir,{recursive:true,force:true})}
});
