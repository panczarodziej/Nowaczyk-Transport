'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
test('main boss grants subcontractor funds exactly once, with company-scoped audit and persisted cash',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-funding-')),file=path.join(dir,'data.json'),port=22000+Math.floor(Math.random()*20000),base='http://127.0.0.1:'+port;
 fs.writeFileSync(file,JSON.stringify({companies:[{id:'nowaczyk',name:'Main'},{id:'partner',name:'Partner'},{id:'fresh',name:'Fresh'},{id:'archived',name:'Archived',archivedAt:'2026-01-01'}],initialBudgets:{partner:{initialCents:10000}}}));
 let child;
 async function start(){child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,DATABASE_URL:'',DATA_FILE:file,PORT:String(port),ADMIN_PASSWORD:'funding-test-password',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let logs='';const timer=setTimeout(()=>reject(Error(logs)),8000);child.stdout.on('data',b=>{logs+=b;if(logs.includes('Online:')){clearTimeout(timer);resolve()}});child.stderr.on('data',b=>logs+=b);child.once('exit',code=>{clearTimeout(timer);reject(Error('exit '+code+' '+logs))})})}
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended}}
 t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true})});
 async function req(url,data,cookie){const r=await fetch(base+url,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie||''},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
 await start();const admin=await req('/api/accounts/login',{username:'admin',password:'funding-test-password'});
 for(const [username,role] of [['sub','subcontractor'],['driver','driver'],['dispatch','dispatcher']])assert.equal((await req('/api/accounts',{username,role,companyId:'partner',password:'funding-test-password'},admin.cookie)).status,201);
 const payload={companyId:'partner',amount:'2500.25',description:'Dofinansowanie floty',operationId:'funding-test-operation-1'};
 assert.equal((await req('/api/company/funding',payload)).status,403);
 let sub;
 for(const username of ['sub','driver','dispatch']){const login=await req('/api/accounts/login',{username,password:'funding-test-password'});if(username==='sub')sub=login;assert.equal((await req('/api/company/funding',payload,login.cookie)).status,403)}
 for(const amount of ['-10','0','1.001','NaN'])assert.equal((await req('/api/company/funding',{...payload,amount},admin.cookie)).status,400);
 for(const companyId of ['nowaczyk','archived','missing'])assert.equal((await req('/api/company/funding',{...payload,companyId},admin.cookie)).status,400);
 assert.equal((await req('/api/company/funding',payload,admin.cookie)).status,201);
 const duplicate=await req('/api/company/funding',payload,admin.cookie);assert.equal(duplicate.data.duplicate,true);
 assert.equal((await req('/api/company/funding',{...payload,amount:'200'},admin.cookie)).status,409);
 const own=(await req('/api/company/funding',null,sub.cookie)).data;assert.equal(own.length,1);assert.equal(own[0].createdBy,'admin');
 assert.equal((await req('/api/company/funding?companyId=fresh',null,sub.cookie)).status,403);
 const budgets=(await req('/api/budgets',null,admin.cookie)).data;assert.equal(budgets.find(b=>b.companyId==='partner').balanceCents,260025);assert.equal(budgets.find(b=>b.companyId==='partner').initialCents,10000);
 assert.equal((await req('/api/company/funding',{...payload,companyId:'fresh',operationId:'fresh-funding-operation'},admin.cookie)).status,201);
 await stop();await start();const after=(await req('/api/budgets',null,admin.cookie)).data;assert.equal(after.find(b=>b.companyId==='fresh').balanceCents,250025);assert.equal(after.find(b=>b.companyId==='fresh').initialCents,0);
 const db=JSON.parse(fs.readFileSync(file));assert.equal(db.ledger.filter(x=>x.companyId==='partner').length,1);assert.equal(db.ledger.some(x=>x.companyId==='nowaczyk'),false);
});
