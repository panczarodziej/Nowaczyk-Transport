'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('main boss and dispatcher assign to every active role across companies; each recipient accepts and delivers',async()=>{
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
 const password='assignment-password-only';
 const people=[['dispatch1','dispatcher','nowaczyk'],['mainboss','boss','nowaczyk'],['partnerboss','boss','partner'],['subboss','subcontractor','partner'],['mechanic1','mechanic','partner'],['driver1','driver','nowaczyk'],['probation1','probation','partner']];
 for(const [username,role,companyId] of people)assert.equal((await req('/api/accounts',{username,password,role,companyId},admin.cookie)).status,201);
 await req('/api/accounts',{username:'blocked',password,role:'driver'},admin.cookie);
 assert.equal((await req('/api/accounts/update',{username:'blocked',active:false},admin.cookie)).status,200);
 const dispatcher=await req('/api/accounts/login',{username:'dispatch1',password});assert.equal(dispatcher.status,200);
 const targets=[['admin','admin','nowaczyk'],...people];
 for(const actor of [admin,dispatcher]){
  const list=await req('/api/routes/assignees',null,actor.cookie);assert.equal(list.status,200);
  for(const [username] of targets)assert.ok(list.data.includes(username),username+' missing');
  assert.ok(!list.data.includes('blocked'));
 }
 const mapBefore=await req('/api/fleet/positions',null,admin.cookie);assert.equal(mapBefore.status,200);
 for(const [username] of targets){const row=mapBefore.data.positions.find(p=>p.driver===username);assert.ok(row,username+' is listed before first position');assert.equal(row.online,false);assert.equal(row.x,undefined)}
 assert.ok(!mapBefore.data.positions.some(p=>p.driver==='blocked'));
 const payload={from:'Krakow',to:'Berlin',sourceCompany:'transinet',destinationCompany:'tradeaux',cargo:'milk',cargoTons:18,plannedKm:600};
 assert.equal((await req('/api/routes',{...payload,driver:'blocked'},admin.cookie)).status,400);
 const jobs=new Map();
 for(const [username,,companyId] of targets){
  const created=await req('/api/routes',{...payload,driver:username},admin.cookie);assert.equal(created.status,201);assert.equal(created.data.companyId,companyId);jobs.set(username,created.data.id);
  assert.equal((await req('/api/routes',{...payload,driver:username},dispatcher.cookie)).status,201);
 }
 // Restart clears only the login rate limiter. Persisted sessions and routes survive.
 await stop();await launch();
 const logged=new Map();
 for(const [username,role,companyId] of targets){
  const desktop=await req('/api/desktop/login',{username,password:username==='admin'?'integration-password-only':password},null,{'X-Nowaczyk-Client':'desktop'});assert.equal(desktop.status,200,username);logged.set(username,desktop);
  const own=await req('/api/routes?mine=1',null,desktop.cookie);assert.equal(own.status,200);assert.equal(own.data.length,2);assert.ok(own.data.every(r=>r.driver===username&&r.companyId===companyId));
  assert.equal((await fetch(base+'/moj-panel.html',{headers:{Cookie:desktop.cookie},redirect:'manual'})).status,200,role);
  const accepted=await req('/api/routes/accept',{routeId:jobs.get(username)},desktop.cookie,{'X-Nowaczyk-Desktop-Token':desktop.data.desktopToken});assert.equal(accepted.status,200,username+' accepts');
  const delivered=await req('/api/telemetry/events',{type:'job-delivered',eventKey:'assignment-delivery-'+username,sourceCity:'Krakow',destinationCity:'Berlin',sourceCompany:'transinet',destinationCompany:'tradeaux',cargo:'milk',cargoMassKg:18000,jobDeliveredDistanceKm:123.4},desktop.cookie);
  assert.equal(delivered.status,201);assert.equal(delivered.data.event.mileageRouteId,jobs.get(username),role+' delivers');
  const done=(await req('/api/routes?mine=1',null,desktop.cookie)).data.find(r=>r.id===jobs.get(username));assert.equal(done.status,'Zakończona');assert.equal(done.drivenKm,123.4);

  const fuel={routeId:jobs.get(username),type:'Paliwo',amount:600,liters:100,country:'Polska',odometerKm:123456};
  const fueled=await req('/api/expenses',fuel,desktop.cookie);assert.equal(fueled.status,201);assert.equal(fueled.data.liters,100);assert.equal(fueled.data.odometerKm,123456);
  assert.equal((await req('/api/expenses',{...fuel,liters:0},desktop.cookie)).status,400);
  const toll=await req('/api/expenses',{routeId:jobs.get(username),type:'Opłata drogowa',from:'Polska',to:'Niemcy',odometerKm:123500,amount:999},desktop.cookie);assert.equal(toll.status,201);assert.equal(toll.data.amount,0);assert.equal(toll.data.recordOnly,true);assert.equal(toll.data.odometerKm,123500);
  const manual=own.data.find(r=>r.id!==jobs.get(username));
  const report={routeId:manual.id,distanceKm:321.7,note:'Rozładunek zablokowany przez naczepę w grze; przewóz wykonany.',confirm:true};
  assert.equal((await req('/api/routes/deliver',report,desktop.cookie)).status,409);
  assert.equal((await req('/api/routes/accept',{routeId:manual.id},desktop.cookie,{'X-Nowaczyk-Desktop-Token':desktop.data.desktopToken})).status,200);
  assert.equal((await req('/api/routes/deliver',{...report,distanceKm:0},desktop.cookie)).status,400);
  const reported=await req('/api/routes/deliver',report,desktop.cookie);assert.equal(reported.status,201,role+' manual delivery');assert.equal(reported.data.route.drivenKm,321.7);assert.equal(reported.data.route.deliveryMethod,'driver-report');
  const repeated=await req('/api/routes/deliver',report,desktop.cookie);assert.equal(repeated.data.duplicate,true);assert.equal(repeated.data.route.drivenKm,321.7);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'data.json'),'utf8'));assert.equal(saved.ledger.filter(e=>e.routeId===manual.id).length,1);assert.equal(saved.deliveryReports.filter(e=>e.routeId===manual.id).length,1);

 }
 const sub=logged.get('subboss');
 const ownList=(await req('/api/routes/assignees',null,sub.cookie)).data;
 assert.ok(ownList.includes('mechanic1'));assert.ok(ownList.includes('partnerboss'));assert.ok(!ownList.includes('admin'));
 assert.equal((await req('/api/routes',{...payload,driver:'admin'},sub.cookie)).status,400);
 assert.equal((await req('/api/routes',{...payload,driver:'mechanic1'},sub.cookie)).status,201);
 const mechanic=logged.get('mechanic1');
 assert.equal((await req('/api/routes/assignees',null,mechanic.cookie)).status,403);
 assert.equal((await req('/api/routes',{...payload,driver:'admin'},mechanic.cookie)).status,403);
 assert.equal((await req('/api/accounts',null,mechanic.cookie)).status,403);
 const wrong=await req('/api/routes/accept',{routeId:jobs.get('driver1')},mechanic.cookie,{'X-Nowaczyk-Desktop-Token':mechanic.data.desktopToken});assert.equal(wrong.status,403);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
