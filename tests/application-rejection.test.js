'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
test('application rejection for main and subcontractor bosses is scoped, audited and persisted',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-server-'));fs.writeFileSync(path.join(dir,'data.json'),JSON.stringify({companies:[{id:'nowaczyk',name:'Nowaczyk Transport',open:true},{id:'partner',name:'Partner',open:true}],initialBudgets:{nowaczyk:{initialCents:100000},partner:{initialCents:50000}},fleet:[{id:'truck-a',companyId:'nowaczyk',plate:'WA 111'},{id:'truck-b',companyId:'partner',plate:'WB 222'}]}));const port=20000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;const start=()=>spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:path.join(dir,'data.json'),PORT:String(port),ADMIN_PASSWORD:'integration-password-only',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});
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
 for(const [username,role] of [['partnerboss','boss'],['subboss','subcontractor'],['applicant','driver']])assert.equal((await req('/api/accounts',{username,password:'application-password-only',role,companyId:'partner'},admin.cookie)).status,201);
 const partner=await req('/api/accounts/login',{username:'partnerboss',password:'application-password-only'});
 const sub=await req('/api/accounts/login',{username:'subboss',password:'application-password-only'});
 const applicant=await req('/api/accounts/login',{username:'applicant',password:'application-password-only'});
 const application={fullname:'Kandydat Testowy',discord:'test',age:20,hours:500};
 const own1=await req('/api/applications',{...application,companyId:'partner'},applicant.cookie);
 const own2=await req('/api/applications',{...application,companyId:'partner'},applicant.cookie);
 const foreign=await req('/api/applications',{...application,companyId:'nowaczyk'},applicant.cookie);
 const pending=await req('/api/applications',{...application,companyId:'partner'},applicant.cookie);
 for(const a of [own1,own2,foreign,pending])assert.equal(a.status,201);
 async function decide(id,status,cookie,extra={}){const r=await fetch(base+'/api/admin/applications',{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:cookie||''},body:JSON.stringify({id,status,...extra})});return {status:r.status,data:await r.json()}}
 assert.equal((await decide(own1.data.id,'Odrzucone',applicant.cookie)).status,401);
 assert.equal((await decide(foreign.data.id,'Odrzucone',partner.cookie)).status,404);
 assert.equal((await decide(pending.data.id,'Odrzucone',sub.cookie,{companyId:'nowaczyk'})).status,403);
 const notices=(await req('/api/notifications',null,partner.cookie)).data.items;
 assert.ok(notices.find(n=>n.review?.id===own1.data.id).review.acceptOnly===false);
 for(const [app,actor] of [[own1,partner],[own2,sub],[foreign,admin]]){
  const result=await decide(app.data.id,'Odrzucone',actor.cookie);assert.equal(result.status,200);assert.equal(result.data.status,'Odrzucone');assert.ok(result.data.decidedAt);assert.ok(result.data.decidedBy);
  const again=await decide(app.data.id,'Odrzucone',actor.cookie);assert.equal(again.status,200);assert.equal(again.data.decidedAt,result.data.decidedAt);
 }
 assert.equal((await decide(own1.data.id,'Przyjęte',partner.cookie)).status,403);
 const own=(await req('/api/admin/applications',null,sub.cookie)).data;
 assert.equal(own.filter(a=>a.status==='Odrzucone').length,2);assert.ok(!own.some(a=>a.companyId==='nowaczyk'));
 assert.ok((await req('/api/my-applications',null,applicant.cookie)).data.some(a=>a.id===own1.data.id&&a.status==='Odrzucone'));
 assert.ok(!(await req('/api/notifications',null,sub.cookie)).data.items.some(n=>n.review?.id===own1.data.id));
 await stop();await launch();
 assert.equal((await req('/api/admin/applications',null,sub.cookie)).data.find(a=>a.id===own1.data.id).status,'Odrzucone');
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
