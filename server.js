'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateJob}=require('./job-match');
const PORT=Number(process.env.PORT||3000),ROOT=path.join(__dirname,'public'),DB=process.env.DATA_FILE||path.join(__dirname,'data.json');
const password=process.env.ADMIN_PASSWORD;
if(!password || password.length<12){console.error('Ustaw ADMIN_PASSWORD (min. 12 znaków) przed startem.');process.exit(1)}
const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64);
const sessions=new Map();
// Osobna, losowa zdolność przyjmowania tras dla sesji natywnego klienta.
const desktopSessions=new Map();
const ROLES=['admin','dispatcher','driver','probation','mechanic','boss','subcontractor'];
const accounts=new Map();
function passwordHash(pass,s=crypto.randomBytes(16).toString('hex')){return {salt:s,hash:crypto.scryptSync(pass,s,64).toString('hex')}}
function safeAccount(a){return {id:a.id,username:a.username,role:a.role,companyId:a.companyId,active:a.active}}
const MAIN_COMPANY_ID='nowaczyk';
const LEGACY_COMPANY_ID='ks';
const initial={ledger:[],companies:[{id:MAIN_COMPANY_ID,name:'Nowaczyk Transport',bases:['Wadowice'],open:true,logo:''}],applications:[],routes:[],expenses:[],drivers:[]};
const DATABASE_URL=process.env.DATABASE_URL;
const {Pool}=DATABASE_URL?require('pg'):{Pool:null};
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false},max:5,connectionTimeoutMillis:10000}):null;
function migrateMainCompany(db){
 let changed=false;
 const legacy=db.companies.find(company=>company.id===LEGACY_COMPANY_ID);
 if(legacy){
  if(db.companies.some(company=>company.id===MAIN_COMPANY_ID))throw Error('Oba identyfikatory firmy istnieją. Migracja wymaga sprawdzenia danych.');
  legacy.id=MAIN_COMPANY_ID;
  changed=true;
 }
 function migrateReferences(value){
  if(!value||typeof value!=='object')return;
  for(const [key,entry] of Object.entries(value)){
   if((key==='companyId'||key==='ownerCompanyId')&&entry===LEGACY_COMPANY_ID){
    value[key]=MAIN_COMPANY_ID;
    changed=true;
   }else migrateReferences(entry);
  }
 }
 migrateReferences(db);
 if(db.initialBudgets&&Object.hasOwn(db.initialBudgets,LEGACY_COMPANY_ID)){
  if(Object.hasOwn(db.initialBudgets,MAIN_COMPANY_ID))throw Error('Oba identyfikatory mają zatwierdzony budżet.');
  db.initialBudgets[MAIN_COMPANY_ID]=db.initialBudgets[LEGACY_COMPANY_ID];
  delete db.initialBudgets[LEGACY_COMPANY_ID];
  changed=true;
 }
 return changed;
}
async function initStore(){
 let db;
 if(!pool){
  db=await load();
  if(migrateMainCompany(db))await save(db);
 }else{
  await pool.query('CREATE TABLE IF NOT EXISTS ks_group_state (id INTEGER PRIMARY KEY, payload JSONB NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS ks_company_budget (company_id TEXT PRIMARY KEY, initial_cents BIGINT NOT NULL CHECK (initial_cents >= 0), locked_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const connection=await pool.connect();
  try{
   await connection.query('BEGIN');
   await connection.query('INSERT INTO ks_group_state(id,payload) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING',[JSON.stringify(initial)]);
   const result=await connection.query('SELECT payload FROM ks_group_state WHERE id=1 FOR UPDATE');
   db={...structuredClone(initial),...result.rows[0].payload};
   if(migrateMainCompany(db))await connection.query('UPDATE ks_group_state SET payload=$1::jsonb WHERE id=1',[JSON.stringify(db)]);
   await connection.query('UPDATE ks_company_budget SET company_id=$1 WHERE company_id=$2',[MAIN_COMPANY_ID,LEGACY_COMPANY_ID]);
   await connection.query('COMMIT');
  }catch(error){
   await connection.query('ROLLBACK');
   throw error;
  }finally{connection.release()}
 }
 for(const account of db.accounts||[])accounts.set(account.username.toLowerCase(),account);
}
async function load(){
 if(pool){const r=await pool.query('SELECT payload FROM ks_group_state WHERE id=1');return {...structuredClone(initial),...(r.rows[0]?.payload||{})}}
 return fs.existsSync(DB)?{...structuredClone(initial),...JSON.parse(fs.readFileSync(DB,'utf8'))}:structuredClone(initial);
}
async function save(db){
 if(pool){await pool.query('UPDATE ks_group_state SET payload=$1::jsonb WHERE id=1',[JSON.stringify(db)]);return}
 const temp=DB+'.tmp';fs.writeFileSync(temp,JSON.stringify(db,null,2),{mode:0o600});fs.renameSync(temp,DB);
}
function send(res,code,obj,headers={}){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj))}
function who(req){const token=/ks_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1],v=token&&sessions.get(token);if(!v)return null;const account=accounts.get(v.username.toLowerCase());return v.expires>Date.now()&&account?.active?{...safeAccount(account),expires:v.expires}:null}
function auth(req){const me=who(req);return me?.role==='admin'||(me?.role==='boss'&&me.companyId===MAIN_COMPANY_ID)}
function canDispatch(req){return ['admin','dispatcher','boss'].includes(who(req)?.role)}
function canDrive(req){return auth(req)||['driver','probation'].includes(who(req)?.role)}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',b=>{s+=b;if(s.length>150000)req.destroy()});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Niepoprawny JSON'))}});req.on('error',reject)})}
function str(s,max=100){return typeof s==='string'?s.trim().slice(0,max):''}
function client(req){return req.socket.remoteAddress||'unknown'}
const limits=new Map();function rate(req,key,max=10){const k=client(req)+key,now=Date.now(),v=(limits.get(k)||[]).filter(t=>t>now-60000);v.push(now);limits.set(k,v);return v.length<=max}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.zip':'application/zip','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
let mutationTail=Promise.resolve();
const server=http.createServer(async(req,res)=>{let release; if(!['GET','HEAD'].includes(req.method)){const previous=mutationTail;mutationTail=new Promise(resolve=>{release=resolve});await previous}try{
 const u=new URL(req.url,'http://localhost');const method=req.method;const db=await load();
 // Centrum floty: dane pozycji z uwierzytelnionego konta; NIE jest to jeszcze integracja z ETS2.
 if(u.pathname==='/api/client-release'&&method==='GET'){let url='https://github.com/panczarodziej/Nowaczyk-Transport/releases/latest/download/Nowaczyk-Transport-Setup.exe';try{const candidate=new URL(process.env.TELEMETRY_DOWNLOAD_URL||'');if(candidate.protocol==='https:')url=candidate.href}catch{}return send(res,200,{version:'0.3.4',available:!!url,url})}
 if(u.pathname==='/api/telemetry/me'&&method==='GET'){const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});const p=db.fleetPositions?.[me.username.toLowerCase()]||null;return send(res,200,{position:p,online:!!p&&Date.now()-Date.parse(p.updatedAt)<45000,events:(db.telemetryEvents||[]).filter(e=>e.driver===me.username.toLowerCase()).slice(-30)})}
 if(u.pathname==='/api/fleet/positions'&&method==='GET'){
  if(!canDispatch(req))return send(res,403,{error:'Tylko administrator lub dyspozytor'});
  const now=Date.now();
  const deliveries=new Map();
  for(const event of db.telemetryEvents||[]){
   if(event.type==='job-delivered'&&event.telemetry?.destinationCity)deliveries.set(event.driver.toLowerCase(),event);
  }
  const reports={...db.fleetPositions};
  for(const account of accounts.values()){
   const key=account.username.toLowerCase();
   if(account.active&&['driver','probation'].includes(account.role)&&!Object.hasOwn(reports,key))reports[key]={driver:account.username,companyId:account.companyId};
  }
  const positions=Object.values(reports).map(p=>{
   const candidates=(db.routes||[]).filter(r=>r.driver?.toLowerCase()===p.driver.toLowerCase()&&r.companyId===p.companyId&&r.acceptedAt&&['Przyjęta','W trasie'].includes(r.status));
   const inProgress=candidates.filter(r=>r.status==='W trasie');
   const route=inProgress.length===1?inProgress[0]:candidates.length===1?candidates[0]:null;
   const delivery=deliveries.get(p.driver.toLowerCase());
   return {...p,online:now-Date.parse(p.updatedAt)<45000,dispatchRoute:route?{from:route.from,to:route.to}:null,lastDelivery:delivery?{city:delivery.telemetry.destinationCity,company:delivery.telemetry.destinationCompany}:null};

  });
  return send(res,200,{positions,source:'telemetry-client',gameMapReady:false});
 }
 if(u.pathname==='/api/fleet/position'&&method==='POST'){
  const me=who(req);if(!me||!canDrive(req))return send(res,403,{error:'Tylko zalogowany kierowca'});
  if(!rate(req,'fleet-position',120))return send(res,429,{error:'Zbyt wiele aktualizacji'});
  const a=await body(req),x=Number(a.x),z=Number(a.z),speed=Number(a.speedKmh||0);
  if(![x,z,speed].every(Number.isFinite)||Math.abs(x)>1e7||Math.abs(z)>1e7||speed<0||speed>200)return send(res,400,{error:'Nieprawidłowe współrzędne ETS2'});
  const route=(db.routes||[]).find(r=>r.driver.toLowerCase()===me.username.toLowerCase()&&r.companyId===(me.companyId||MAIN_COMPANY_ID)&&r.status!=='Zakończona');
  const key=me.username.toLowerCase(),previous=db.fleetPositions?.[key];
  const requested=str(a.activity,24);
  const activity=['Jazda','Pauza','Praca','Odpoczynek','Postój','Gra wstrzymana'].includes(requested)?requested:(speed>=3?'Jazda':'Postój');
  const country=str(a.country,80),city=str(a.city,100),place=str(a.place,120);
  const now=new Date().toISOString();
  const position={driver:me.username,companyId:me.companyId||MAIN_COMPANY_ID,x,z,speedKmh:speed,cargo:str(a.cargo,120),cargoMassKg:Number.isFinite(a.cargoMassKg)&&a.cargoMassKg>=0?a.cargoMassKg:null,odometerKm:Number.isFinite(a.odometerKm)&&a.odometerKm>=0?a.odometerKm:null,onJob:a.onJob===true,cargoLoaded:a.cargoLoaded===true,activity,country,city,place,activitySince:previous?.activity===activity?previous.activitySince:now,routeId:route?.id||null,updatedAt:now,verified:false};
  db.fleetPositions??={};db.fleetPositions[key]=position;
  if(previous?.activity!==activity){
   db.fleetActivityEvents??=[];
   const id=Math.max(Date.now(),(db.fleetActivityEvents.at(-1)?.id||0)+1);
   db.fleetActivityEvents.push({id,driver:me.username,activity,previousActivity:previous?.activity||'Offline',country,city,place,at:now,verified:false});
   db.fleetActivityEvents=db.fleetActivityEvents.slice(-500);
  }
  await save(db);
  return send(res,200,{ok:true,position});
 }
 // Historia aktywności kierowców — wyłącznie dane zgłoszone przez klienta, bez potwierdzenia z ETS2.
 if(u.pathname==='/api/fleet/activity-events'&&method==='GET'){
  if(!canDispatch(req))return send(res,403,{error:'Tylko administrator lub dyspozytor'});
  const since=Number(u.searchParams.get('since')||0);
  const events=(db.fleetActivityEvents||[]).filter(e=>e.id>since).slice(-100);
  return send(res,200,{events,source:'unverified-client',lastId:events.at(-1)?.id||since});
 }
 // Rejestr naczep: osobny zasób, możliwy przydział również podwykonawcy.
 if(u.pathname==='/api/trailers'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const list=db.trailers||[];
  if(['admin','dispatcher','boss'].includes(me.role))return send(res,200,{trailers:list,assignees:[...accounts.values()].filter(a=>a.active&&['driver','probation','subcontractor'].includes(a.role)).map(safeAccount)});
  return send(res,200,{trailers:list.filter(t=>t.assigneeId===me.id)});
 }
 if(u.pathname==='/api/trailers'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator może zmieniać naczepy'});
  const a=await body(req),id=str(a.id,80),plate=str(a.plate,30).toUpperCase(),model=str(a.model,100),type=str(a.type,60),assigneeId=str(a.assigneeId,80),ownerCompanyId=str(a.ownerCompanyId,80)||MAIN_COMPANY_ID;
  if(!plate||!model||!['firanka','chlodnia','platforma','kontener','inna'].includes(type))return send(res,400,{error:'Podaj rejestrację, model i rodzaj naczepy'});
  if(!db.companies.some(c=>c.id===ownerCompanyId))return send(res,400,{error:'Nieznana firma właściciela'});
  const assignee=assigneeId?[...accounts.values()].find(x=>x.id===assigneeId&&x.active&&['driver','probation','subcontractor'].includes(x.role)):null;
  if(assigneeId&&!assignee)return send(res,400,{error:'Wybierz aktywnego kierowcę lub podwykonawcę'});
  db.trailers??=[];
  if(db.trailers.some(t=>t.plate===plate&&t.id!==id))return send(res,409,{error:'Naczepa o tej rejestracji już istnieje'});
  let t=id?db.trailers.find(t=>t.id===id):null;
  if(id&&!t)return send(res,404,{error:'Nie znaleziono naczepy'});
  if(!t){t={id:crypto.randomUUID(),createdAt:new Date().toISOString()};db.trailers.push(t)}
  Object.assign(t,{plate,model,type,ownerCompanyId,assigneeId,assigneeUsername:assignee?.username||'',assigneeRole:assignee?.role||'',updatedAt:new Date().toISOString()});
  await save(db);return send(res,200,t);
 }
 // Budżet początkowy: niezmienny wpis, zabezpieczony unikalnym kluczem w PostgreSQL.
 if(u.pathname==='/api/budgets'&&method==='GET'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  let entries;
  if(pool){const q=await pool.query('SELECT company_id,initial_cents,locked_at FROM ks_company_budget');entries=q.rows.map(x=>({companyId:x.company_id,initialCents:Number(x.initial_cents),lockedAt:x.locked_at}))}
  else entries=Object.entries(db.initialBudgets||{}).map(([companyId,x])=>({companyId,...x}));
  const budgets=(db.companies||[]).map(c=>{
   const b=entries.find(x=>x.companyId===c.id),income=(db.ledger||[]).filter(x=>x.companyId===c.id).reduce((sum,x)=>sum+Math.round(Number(x.amount||0)*100),0),costs=(db.expenses||[]).filter(x=>{const r=(db.routes||[]).find(r=>r.id===x.routeId);return (x.companyId||r?.companyId||MAIN_COMPANY_ID)===c.id}).reduce((sum,x)=>sum+Math.round(Number(x.amount||0)*100),0);
   return {companyId:c.id,name:c.name,locked:!!b,initialCents:b?.initialCents??null,lockedAt:b?.lockedAt??null,incomeCents:income,costCents:costs,balanceCents:b?b.initialCents+income-costs:null};
  });return send(res,200,budgets);
 }
 if(u.pathname==='/api/budgets'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),companyId=str(a.companyId,80),amount=a.amount;
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Nie znaleziono firmy'});
  if(typeof amount!=='string'||! /^(0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount))return send(res,400,{error:'Wpisz poprawną kwotę w PLN (maks. 2 miejsca po przecinku)'});
  const [whole,frac='']=amount.split('.');const cents=Number(whole)*100+Number(frac.padEnd(2,'0'));
  if(!Number.isSafeInteger(cents)||a.confirm!==true)return send(res,400,{error:'Potwierdź nieodwracalne ustawienie kwoty'});
  if(pool){
   const result=await pool.query('INSERT INTO ks_company_budget(company_id,initial_cents) VALUES($1,$2) ON CONFLICT (company_id) DO NOTHING RETURNING company_id',[companyId,String(cents)]);
   if(!result.rowCount)return send(res,409,{error:'Budżet początkowy tej firmy został już zatwierdzony i nie może zostać zmieniony'});
  }else{
   // Lokalny tryb testowy; na Renderze należy korzystać z PostgreSQL.
   db.initialBudgets??={};if(Object.hasOwn(db.initialBudgets,companyId))return send(res,409,{error:'Budżet jest już zatwierdzony'});
   db.initialBudgets[companyId]={initialCents:cents,lockedAt:new Date().toISOString()};await save(db);
  }
  return send(res,201,{ok:true,companyId,initialCents:cents,locked:true});
 }
 // Ekonomia wirtualna: wypłaty ręczne, portfel i sklep z zatwierdzaniem.
 if(u.pathname==='/api/economy'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const admin=auth(req),name=me.username.toLowerCase();
  const wallets=db.wallets||{},orders=db.shopOrders||[],payments=db.payments||[],rates=db.driverRates||{};
  return send(res,200,{wallets:admin?wallets:{[name]:wallets[name]||0},orders:admin?orders:orders.filter(x=>x.driver===name),payments:admin?payments:payments.filter(x=>x.driver===name),rates:admin?rates:{[name]:rates[name]??0.7},items:db.shopItems||[],earnings:(db.routes||[]).filter(r=>r.settledAt&&(admin||r.driver.toLowerCase()===name)).map(r=>({id:r.id,driver:r.driver,km:r.drivenKm,rate:r.payRate??0.7,earned:Math.round(r.drivenKm*(r.payRate??0.7)*100)/100,settledAt:r.settledAt}))});
 }
 if(u.pathname==='/api/economy/rate'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),driver=str(a.driver,50).toLowerCase(),rate=Number(a.rate);
  if(!driver||!Number.isFinite(rate)||rate<0||rate>100)return send(res,400,{error:'Nieprawidłowa stawka'});
  db.driverRates??={};db.driverRates[driver]=rate;await save(db);return send(res,200,{ok:true});
 }
 if(u.pathname==='/api/economy/payment'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),driver=str(a.driver,50).toLowerCase(),month=str(a.month,7),bonus=Number(a.bonus||0),deduction=Number(a.deduction||0);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!driver||![bonus,deduction].every(v=>Number.isFinite(v)&&v>=0&&v<=1000000))return send(res,400,{error:'Nieprawidłowe dane wypłaty'});
  db.payments??=[];if(db.payments.some(x=>x.driver===driver&&x.month===month))return send(res,409,{error:'Ten miesiąc został już rozliczony'});
  const rows=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.settledAt&&r.settledAt.slice(0,7)===month);
  const base=rows.reduce((sum,r)=>sum+Math.round(r.drivenKm*(r.payRate??0.7)*100),0)/100;
  const amount=Math.round((base+bonus-deduction)*100)/100;if(amount<0)return send(res,400,{error:'Potrącenia przekraczają wynagrodzenie'});
  db.wallets??={};db.wallets[driver]=Math.round(((db.wallets[driver]||0)+amount)*100)/100;
  db.payments.push({id:crypto.randomUUID(),driver,month,base,bonus,deduction,amount,createdAt:new Date().toISOString()});
  db.ledger??=[];db.ledger.push({id:crypto.randomUUID(),companyId:MAIN_COMPANY_ID,type:'wyplata',amount:-amount,createdAt:new Date().toISOString()});
  await save(db);return send(res,201,{ok:true,amount});
 }
 if(u.pathname==='/api/economy/item'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),name=str(a.name,100),price=Number(a.price);
  if(!name||!Number.isFinite(price)||price<=0||price>1000000)return send(res,400,{error:'Nieprawidłowy produkt'});
  db.shopItems??=[];const item={id:crypto.randomUUID(),name,price:Math.round(price*100)/100};db.shopItems.push(item);await save(db);return send(res,201,item);
 }
 if(u.pathname==='/api/economy/order'&&method==='POST'){
  const me=who(req);if(!me||!['driver','probation','admin'].includes(me.role))return send(res,403,{error:'Tylko kierowca'});
  const a=await body(req),item=(db.shopItems||[]).find(x=>x.id===a.itemId);
  if(!item)return send(res,404,{error:'Nie znaleziono produktu'});
  db.shopOrders??=[];const order={id:crypto.randomUUID(),driver:me.username.toLowerCase(),itemId:item.id,name:item.name,price:item.price,status:'Oczekuje',createdAt:new Date().toISOString()};db.shopOrders.push(order);await save(db);return send(res,201,order);
 }
 if(u.pathname==='/api/economy/order/decide'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),order=(db.shopOrders||[]).find(x=>x.id===a.id);
  if(!order)return send(res,404,{error:'Nie znaleziono zamówienia'});
  if(order.status!=='Oczekuje')return send(res,409,{error:'Zamówienie już rozpatrzone'});
  if(!['Zatwierdzone','Odrzucone'].includes(a.status))return send(res,400,{error:'Nieprawidłowa decyzja'});
  if(a.status==='Zatwierdzone'){db.wallets??={};const balance=db.wallets[order.driver]||0;if(balance<order.price)return send(res,409,{error:'Za mało środków kierowcy'});db.wallets[order.driver]=Math.round((balance-order.price)*100)/100;}
  order.status=a.status;order.decidedAt=new Date().toISOString();await save(db);return send(res,200,order);
 }
 if(u.pathname==='/api/economy/fine'&&method==='POST'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const a=await body(req),driver=auth(req)?str(a.driver,50).toLowerCase():me.username.toLowerCase(),amount=Number(a.amount),reason=str(a.reason,150);
  if(!driver||!reason||!Number.isFinite(amount)||amount<=0||amount>1000000)return send(res,400,{error:'Nieprawidłowy mandat'});
  db.wallets??={};if((db.wallets[driver]||0)<amount)return send(res,409,{error:'Za mało środków'});
  db.wallets[driver]=Math.round((db.wallets[driver]-amount)*100)/100;db.fines??=[];db.fines.push({id:crypto.randomUUID(),driver,amount,reason,createdAt:new Date().toISOString()});await save(db);return send(res,201,{ok:true});
 }
 // Bezpieczny podgląd zgodności ładunku — NIE potwierdza dostawy ani nie wypłaca pieniędzy.
 if(u.pathname==='/api/routes/verify-preview'&&method==='POST'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  if(!rate(req,'verify-preview',30))return send(res,429,{error:'Zbyt wiele prób'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.routeId);
  if(!r)return send(res,404,{error:'Nie znaleziono zlecenia'});
  if(!canDispatch(req)&&r.driver.toLowerCase()!==me.username.toLowerCase())return send(res,403,{error:'Nie Twoje zlecenie'});
  return send(res,200,{routeId:r.id,...validateJob(r,a.telemetry),verified:false,source:'manual-preview',settlementAllowed:false});
 }
 // Zdarzenia RenCloud: rejestr załadunku/rozładunku do weryfikacji przez dyspozytora.
 if(u.pathname==='/api/telemetry/events'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const all=db.telemetryEvents||[];
  return send(res,200,canDispatch(req)?all:all.filter(e=>e.driver===me.username.toLowerCase()));
 }
 if(u.pathname==='/api/telemetry/events'&&method==='POST'){
  const me=who(req);if(!me||!canDrive(req))return send(res,403,{error:'Wymagane konto kierowcy'});
  if(!rate(req,'telemetry-events',40))return send(res,429,{error:'Zbyt wiele zdarzeń'});
  const a=await body(req),type=str(a.type,32);
  if(!['job-started','job-delivered'].includes(type))return send(res,400,{error:'Nieznane zdarzenie'});
  const eventKey=str(a.eventKey,100);
  if(!/^[a-zA-Z0-9:_-]{12,100}$/.test(eventKey))return send(res,400,{error:'Nieprawidłowy identyfikator zdarzenia'});
  const driver=me.username.toLowerCase();db.telemetryEvents??=[];
  const existing=db.telemetryEvents.find(e=>e.driver===driver&&e.eventKey===eventKey);
  if(existing)return send(res,200,{ok:true,duplicate:true,event:existing});
  const telemetry={cargoMassKg:Number.isFinite(a.cargoMassKg)&&a.cargoMassKg>0?a.cargoMassKg:null,odometerKm:Number.isFinite(a.odometerKm)?a.odometerKm:null,cargo:str(a.cargo,120),sourceCity:str(a.sourceCity,120),destinationCity:str(a.destinationCity,120),sourceCompany:str(a.sourceCompany,120),destinationCompany:str(a.destinationCompany,120)};
  const candidates=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.companyId===(me.companyId||MAIN_COMPANY_ID)&&r.status!=='Zakończona');
  const norm=x=>String(x||'').trim().toLocaleLowerCase('pl');
  const matches=candidates.filter(r=>r.acceptedAt&&validateJob(r,telemetry).match);
  const route=matches.length===1?matches[0]:null;
  const event={id:crypto.randomUUID(),eventKey,driver,companyId:me.companyId||MAIN_COMPANY_ID,type,telemetry,routeId:route?.id||null,matchStatus:route?'matched':'unmatched',checks:candidates.map(r=>({routeId:r.id,...validateJob(r,telemetry)})),verified:false,settlementAllowed:false,receivedAt:new Date().toISOString()};
  db.telemetryEvents.push(event);if(db.telemetryEvents.length>5000)db.telemetryEvents.splice(0,db.telemetryEvents.length-5000);
  await save(db);return send(res,201,{ok:true,event});
 }
 // Konfiguracja mapy przypisana do konta kierowcy (nie zmienia aktywnych modów ETS2).
 if(u.pathname==='/api/driver/map-profile'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const username=canDispatch(req)&&u.searchParams.get('driver')?str(u.searchParams.get('driver'),50).toLowerCase():me.username.toLowerCase();
  return send(res,200,{driver:username,mapProfile:(db.driverMapProfiles||{})[username]||'promods-pr',supported:['promods','promods-pr']});
 }
 if(u.pathname==='/api/driver/map-profile'&&method==='POST'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  if(!rate(req,'map-profile',12))return send(res,429,{error:'Zbyt wiele zmian'});
  const a=await body(req);if(!['promods','promods-pr'].includes(a.mapProfile))return send(res,400,{error:'Nieobsługiwany zestaw map'});
  const username=canDispatch(req)&&a.driver?str(a.driver,50).toLowerCase():me.username.toLowerCase();
  if(!username)return send(res,400,{error:'Brak kierowcy'});
  db.driverMapProfiles??={};db.driverMapProfiles[username]=a.mapProfile;await save(db);
  return send(res,200,{ok:true,driver:username,mapProfile:a.mapProfile});
 }
 // Trasy i koszty: wszystkie zapisy w tym samym magazynie PostgreSQL.
 // Eksport zlecenia kierowcy — bez wstrzykiwania do giełdy ETS2.
 if(u.pathname==='/api/routes/accept'&&method==='POST'){
  const me=who(req);if(!me||!canDrive(req))return send(res,403,{error:'Wymagane konto kierowcy'});
  const sessionToken=/ks_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
  const expected=desktopSessions.get(sessionToken),provided=req.headers['x-nowaczyk-desktop-token'];
  if(req.headers.origin||!expected||typeof provided!=='string'||provided.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return send(res,403,{error:'Trasę przyjmiesz wyłącznie po zalogowaniu w aplikacji Nowaczyk Transport.'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.routeId);
  if(!r)return send(res,404,{error:'Nie znaleziono trasy'});
  if(r.driver.toLowerCase()!==me.username.toLowerCase()||r.companyId!==(me.companyId||MAIN_COMPANY_ID))return send(res,403,{error:'To nie jest Twoja trasa'});
  if(r.acceptedAt)return send(res,200,{ok:true,duplicate:true,route:r});
  if(!['Przydzielona','W trasie'].includes(r.status))return send(res,409,{error:'Trasa nie oczekuje na przyjęcie'});
  r.acceptedAt=new Date().toISOString();r.acceptedBy=me.username;r.acceptedVia='desktop';r.status='Przyjęta';await save(db);return send(res,200,{ok:true,route:r});
 }
 if(u.pathname==='/api/routes/export'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const r=(db.routes||[]).find(x=>x.id===u.searchParams.get('id'));
  if(!r)return send(res,404,{error:'Nie znaleziono zlecenia'});
  if(!canDispatch(req)&&(r.driver.toLowerCase()!==me.username.toLowerCase()||r.companyId!==me.companyId))return send(res,403,{error:'Brak dostępu'});
  const job={mapProfile:(db.driverMapProfiles||{})[r.driver.toLowerCase()]||'promods-pr',schema:'ks-group-dispatch-v1',acceptedAt:r.acceptedAt||null,id:r.id,driver:r.driver,from:{country:r.fromCountry||'',city:r.from,company:r.sourceCompany||''},to:{country:r.toCountry||'',city:r.to,company:r.destinationCompany||''},cargo:{name:r.cargo||'',tons:r.cargoTons||0},plannedKm:r.plannedKm||0,freightPLN:r.freight||0,trailerId:r.trailerId||null,createdAt:r.createdAt||null,notice:'Manifest dyspozytorski. Nie tworzy zlecenia w ETS2.'};
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="ks-job-'+r.id+'.json"','Cache-Control':'no-store'});return res.end(JSON.stringify(job,null,2));
 }
 if(u.pathname==='/api/routes'&&method==='GET'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const me=who(req);return send(res,200,canDispatch(req)?(db.routes||[]):(db.routes||[]).filter(r=>r.driver.toLowerCase()===me.username.toLowerCase()&&r.companyId===me.companyId));
 }
 if(u.pathname==='/api/routes'&&method==='POST'){
  if(!canDispatch(req))return send(res,403,{error:'Brak uprawnień'});
  const a=await body(req),from=str(a.from,120),to=str(a.to,120),driver=str(a.driver,100);
  if(!from||!to||!driver)return send(res,400,{error:'Podaj kierowcę, początek i koniec trasy'});
  const plannedKm=Number(a.plannedKm);
  if(!Number.isFinite(plannedKm)||plannedKm<0||plannedKm>20000)return send(res,400,{error:'Nieprawidłowy dystans'});
  const freight=Number(a.freight||0);if(!Number.isFinite(freight)||freight<0||freight>10000000)return send(res,400,{error:'Nieprawidłowy fracht'});
  if(!Number.isFinite(Number(a.cargoTons||0))||Number(a.cargoTons||0)<0||Number(a.cargoTons||0)>100)return send(res,400,{error:'Nieprawidłowa masa ładunku'});
  const trailerId=str(a.trailerId,80),trailer=trailerId?(db.trailers||[]).find(t=>t.id===trailerId):null;
  if(trailerId&&!trailer)return send(res,400,{error:'Nie znaleziono przypisanej naczepy'});
  if(trailer&&trailer.assigneeUsername&&trailer.assigneeUsername.toLowerCase()!==driver.toLowerCase())return send(res,409,{error:'Naczepa jest przypisana do innego kierowcy lub podwykonawcy'});
  const sourceCompany=str(a.sourceCompany,120),destinationCompany=str(a.destinationCompany,120);
  const r={id:crypto.randomUUID(),trailerId:trailerId||null,freight,companyId:str(a.companyId,80)||MAIN_COMPANY_ID,driver,from,to,fromCountry:str(a.fromCountry,80),toCountry:str(a.toCountry,80),cargo:str(a.cargo,120),sourceCompany:str(a.sourceCompany,120),destinationCompany:str(a.destinationCompany,120),cargoTons:Number(a.cargoTons)||0,payRate:(db.driverRates||{})[driver.toLowerCase()]??0.7,plannedKm,drivenKm:0,status:'Przydzielona',createdAt:new Date().toISOString()};
  db.routes??=[];db.routes.push(r);await save(db);return send(res,201,r);
 }
 if(u.pathname==='/api/routes/progress'&&method==='POST'){
  if(!canDispatch(req))return send(res,403,{error:'Brak uprawnień'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.id);
  if(!r)return send(res,404,{error:'Nie znaleziono trasy'});
  const km=Number(a.drivenKm);if(!Number.isFinite(km)||km<0||km>100000)return send(res,400,{error:'Nieprawidłowy przebieg'});
  if(!r.acceptedAt&&(km>0||a.status&&a.status!=='Przydzielona'))return send(res,409,{error:'Kierowca musi najpierw przyjąć trasę w aplikacji'});
  if(km<r.drivenKm)return send(res,400,{error:'Przebieg nie może się zmniejszać'});
  r.drivenKm=km;
  if(a.status==='Zakończona')return send(res,409,{error:'Nie można ręcznie rozliczyć dostawy. Wymagane potwierdzenie telemetrii ETS2.'});
  if(r.acceptedAt&&a.status==='Przydzielona')return send(res,409,{error:'Nie można cofnąć przyjęcia trasy'});
  if(a.status&&['Przyjęta','W trasie'].includes(a.status))r.status=a.status;
  else if(km>0&&r.acceptedAt)r.status='W trasie';
  // Księgowanie dostawy jest wyłączone do czasu zweryfikowania pluginu i transakcyjnego zapisu w bazie.
  await save(db);return send(res,200,r);
 }
 if(u.pathname==='/api/finance'&&method==='GET'){
  if(!auth(req))return send(res,401,{error:'Wymagane logowanie administratora'});
  const ledger=db.ledger||[],expenses=db.expenses||[];return send(res,200,{ledger,expenses,revenue:ledger.reduce((a,x)=>a+Number(x.amount||0),0),costs:expenses.reduce((a,x)=>a+Number(x.amount||0),0)});
 }
 if(u.pathname==='/api/expenses'&&method==='GET'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const me=who(req);return send(res,200,canDispatch(req)?(db.expenses||[]):(db.expenses||[]).filter(e=>e.driver.toLowerCase()===me.username.toLowerCase()));
 }
 if(u.pathname==='/api/expenses'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.routeId);
  if(!r)return send(res,400,{error:'Wybierz istniejącą trasę'});
  if(!canDispatch(req)&&(r.driver.toLowerCase()!==who(req).username.toLowerCase()||r.companyId!==who(req).companyId))return send(res,403,{error:'To nie jest Twoja trasa'});
  if(!['Paliwo','Opłata drogowa','Parking','Inne'].includes(a.type))return send(res,400,{error:'Nieprawidłowy rodzaj kosztu'});
  const amount=Number(a.amount);if(!Number.isFinite(amount)||amount<=0||amount>1000000)return send(res,400,{error:'Nieprawidłowa kwota'});
  const e={id:crypto.randomUUID(),routeId:r.id,driver:r.driver,type:a.type,country:str(a.country,80),from:str(a.from,120),to:str(a.to,120),place:str(a.place,120),liters:Number(a.liters)||0,amount,currency:'PLN',createdAt:new Date().toISOString()};
  db.expenses??=[];db.expenses.push(e);await save(db);return send(res,201,e);
 }
 if(u.pathname==='/api/companies'&&method==='GET')return send(res,200,db.companies.map(({id,name,bases,open,logo})=>({id,name,bases,open,logo})));
 if(u.pathname==='/api/applications'&&method==='POST'){
  if(!rate(req,'apply',5))return send(res,429,{error:'Za dużo prób. Spróbuj później.'});
  const a=await body(req),c=db.companies.find(x=>x.id===a.companyId&&x.open);
  if(!c)return send(res,400,{error:'Ta firma nie prowadzi rekrutacji.'});
  const fullname=str(a.fullname,80),discord=str(a.discord,70),age=Number(a.age),hours=Number(a.hours);
  if(fullname.length<2||discord.length<2||!Number.isInteger(age)||age<13||age>99||!Number.isFinite(hours)||hours<0)return send(res,400,{error:'Uzupełnij wymagane pola.'});
  const x={id:crypto.randomUUID(),companyId:c.id,companyName:c.name,fullname,discord,age,hours,norm:str(a.norm),availability:str(a.availability,500),truck:str(a.truck,150),reason:str(a.reason,2000),date:new Date().toISOString(),status:'Nowe'};
  db.applications.push(x);await save(db);return send(res,201,{ok:true,id:x.id});
 }
 // Flota online: przypisania według ID konta, niezależne od lokalnych danych DEMO.
 if(u.pathname==='/api/fleet'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const fleet=db.fleet||[];
  if(auth(req))return send(res,200,{fleet,drivers:[...accounts.values()].filter(a=>a.active).map(safeAccount)});
  return send(res,200,{fleet:fleet.filter(v=>v.driverAccountId===me.id&&v.companyId===me.companyId)});
 }
 if(u.pathname==='/api/fleet'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),plate=str(a.plate,30).toUpperCase(),model=str(a.model,100),trailerPlate=str(a.trailerPlate,30).toUpperCase(),trailerModel=str(a.trailerModel,100),driverAccountId=str(a.driverAccountId,80),id=str(a.id,80);
  if(!plate||!model)return send(res,400,{error:'Podaj rejestrację i model ciągnika'});
  const acct=[...accounts.values()].find(x=>x.id===driverAccountId&&x.active);
  if(driverAccountId&&!acct)return send(res,400,{error:'Wybierz aktywne konto pracownika'});
  db.fleet??=[];
  if(db.fleet.some(x=>x.plate===plate&&x.id!==id))return send(res,409,{error:'Taka rejestracja już istnieje'});
  if(driverAccountId&&db.fleet.some(x=>x.driverAccountId===driverAccountId&&x.id!==id))return send(res,409,{error:'Ten kierowca ma już przypisany pojazd'});
  let v=id?db.fleet.find(x=>x.id===id):null;
  if(id&&!v)return send(res,404,{error:'Nie znaleziono pojazdu'});
  if(!v){v={id:crypto.randomUUID()};db.fleet.push(v)}
  Object.assign(v,{plate,model,trailerPlate,trailerModel,driverAccountId:driverAccountId||'',driverUsername:acct?.username||'',companyId:acct?.companyId||MAIN_COMPANY_ID});
  await save(db);return send(res,200,v);
 }
 if(['/api/accounts/login','/api/desktop/login'].includes(u.pathname)&&method==='POST'){
  const desktop=u.pathname==='/api/desktop/login';
  if(desktop&&(req.headers.origin||req.headers['x-nowaczyk-client']!=='desktop'))return send(res,403,{error:'Zaloguj się przez aplikację'});
  if(!rate(req,'accounts-login',8))return send(res,429,{error:'Za dużo prób'});
  const a=await body(req),name=str(a.username,50).toLowerCase(),acct=accounts.get(name);
  const dummy=crypto.scryptSync(str(a.password,300),salt,64);
  const candidate=acct?crypto.scryptSync(str(a.password,300),acct.salt,64):dummy;
  const expected=acct?Buffer.from(acct.hash,'hex'):hash;
  if(!acct||!acct.active||!crypto.timingSafeEqual(candidate,expected))return send(res,401,{error:'Nieprawidłowy login lub hasło'});
  const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{...safeAccount(acct),expires:Date.now()+12*3600000});
  const desktopToken=desktop?crypto.randomBytes(32).toString('hex'):undefined;if(desktop)desktopSessions.set(token,desktopToken);
  return send(res,200,{ok:true,user:safeAccount(acct),desktopToken},{'Set-Cookie':`ks_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE==='1'?'; Secure':''}`});
 }
 if(u.pathname==='/api/logout'&&method==='POST'){const token=/ks_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];if(token){sessions.delete(token);desktopSessions.delete(token)}return send(res,200,{ok:true},{'Set-Cookie':'ks_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
 if(u.pathname==='/api/accounts/password'&&method==='POST'){
  const me=who(req),account=me?.id&&accounts.get(me.username.toLowerCase());
  if(!account)return send(res,401,{error:'Zaloguj się na swoje konto'});
  if(!canDrive(req))return send(res,403,{error:'Brak dostępu do ustawień konta.'});
  if(!rate(req,'change-password:'+account.id,6))return send(res,429,{error:'Za dużo prób. Spróbuj za minutę.'});
  const a=await body(req),current=str(a.currentPassword,300),next=a.newPassword;
  if(typeof next!=='string'||next.length<12||next.length>300||next!==next.trim())return send(res,400,{error:'Nowe hasło musi mieć od 12 do 300 znaków, bez spacji na początku i końcu.'});
  const candidate=crypto.scryptSync(current,account.salt,64);
  if(!crypto.timingSafeEqual(candidate,Buffer.from(account.hash,'hex')))return send(res,403,{error:'Obecne hasło jest nieprawidłowe.'});
  const updated={...account,...passwordHash(next)};
  db.accounts=[...accounts.values()].map(x=>x.id===account.id?updated:x);
  await save(db);
  accounts.set(account.username.toLowerCase(),updated);
  for(const [token,session] of sessions){
   if(session.id===account.id){sessions.delete(token);desktopSessions.delete(token)}
  }
  return send(res,200,{ok:true},{'Set-Cookie':'ks_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.COOKIE_SECURE==='1'?'; Secure':'')});
 }
 if(u.pathname==='/api/accounts/me'&&method==='GET')return send(res,200,{user:who(req)});
 if(u.pathname==='/api/accounts'&&method==='GET'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  return send(res,200,[...accounts.values()].map(safeAccount));
 }
 if(u.pathname==='/api/accounts'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),username=str(a.username,50),pass=str(a.password,300),role=str(a.role,40),companyId=str(a.companyId,80)||MAIN_COMPANY_ID;
  if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||pass.length<12||!ROLES.includes(role))return send(res,400,{error:'Login: 3–50 znaków, hasło min. 12 znaków, poprawna rola'});
  if(role==='admin'&&who(req).role!=='admin')return send(res,403,{error:'Tylko administrator może utworzyć konto administratora'});
  if(accounts.has(username.toLowerCase()))return send(res,409,{error:'Login zajęty'});
  const acct={id:crypto.randomUUID(),username,role,companyId,active:true,...passwordHash(pass)};
  accounts.set(username.toLowerCase(),acct);db.accounts=[...accounts.values()];await save(db);return send(res,201,safeAccount(acct));
 }
 if(u.pathname==='/api/accounts/update'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),acct=accounts.get(str(a.username,50).toLowerCase());
  if(!acct)return send(res,404,{error:'Nie znaleziono konta'});
  if(who(req).role!=='admin'&&(acct.role==='admin'||a.role==='admin'))return send(res,403,{error:'Tylko administrator może zarządzać kontami administratorów'});
  if(acct.role==='admin'&&a.active===false)return send(res,400,{error:'Nie można zablokować administratora'});
  if(typeof a.active==='boolean')acct.active=a.active;
  if(a.password!==undefined){if(typeof a.password!=='string'||a.password.length<12||a.password.length>300)return send(res,400,{error:'Hasło min. 12 znaków'});Object.assign(acct,passwordHash(a.password))}
  if(a.role!==undefined&&ROLES.includes(a.role)&&acct.role!=='admin')acct.role=a.role;
  db.accounts=[...accounts.values()];await save(db);return send(res,200,safeAccount(acct));
 }
 if(u.pathname==='/api/me')return send(res,200,{admin:auth(req)});
 if(u.pathname.startsWith('/api/admin/')){
  if(!auth(req))return send(res,401,{error:'Zaloguj się jako administrator.'});
  if(u.pathname==='/api/admin/applications'&&method==='GET')return send(res,200,db.applications);
  if(u.pathname==='/api/admin/companies'&&method==='GET')return send(res,200,db.companies);
  if(u.pathname==='/api/admin/applications'&&method==='PATCH'){
   const a=await body(req),x=db.applications.find(x=>x.id===a.id);
   if(!x)return send(res,404,{error:'Nie znaleziono podania'});
   if(a.status&&!['Nowe','Przyjęte','Odrzucone'].includes(a.status))return send(res,400,{error:'Niepoprawny status'});
   if(a.companyId&&!db.companies.some(c=>c.id===a.companyId))return send(res,400,{error:'Nieznana firma'});
   if(a.status)x.status=a.status;if(a.companyId){x.companyId=a.companyId;x.companyName=db.companies.find(c=>c.id===a.companyId).name}await save(db);return send(res,200,x);
  }
  if(u.pathname==='/api/admin/companies'&&method==='POST'){
   const a=await body(req),name=str(a.name,90);if(name.length<2)return send(res,400,{error:'Podaj nazwę firmy'});
   const x={id:crypto.randomUUID(),name,bases:[str(a.city,90)||'Nie podano'],open:true,logo:''};db.companies.push(x);await save(db);return send(res,201,x);
  }
  if(u.pathname==='/api/admin/companies'&&method==='PATCH'){
   const a=await body(req),x=db.companies.find(c=>c.id===a.id);if(!x)return send(res,404,{error:'Brak firmy'});
   if(typeof a.open==='boolean')x.open=a.open;
   if(Array.isArray(a.bases))x.bases=a.bases.map(y=>str(y,90)).filter(Boolean).slice(0,12);
   if(typeof a.logo==='string'&&(/^data:image\/(png|jpeg|webp);base64,[\w+/=]+$/.test(a.logo)&&a.logo.length<120000||a.logo===''))x.logo=a.logo;
   await save(db);return send(res,200,x);
  }
  return send(res,404,{error:'Nie znaleziono'});
 }
 if(method!=='GET')return send(res,405,{error:'Metoda niedozwolona'});
 if(u.pathname==='/' || u.pathname==='/system' || u.pathname==='/index.html' || u.pathname==='/login.html') {res.writeHead(302,{Location:'/system-login.html'});return res.end()}
 if(u.pathname==='/admin.html'&&!auth(req)){
  if(who(req))return send(res,403,{error:'Panel rekrutacji jest dostępny dla kierownictwa.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/centrum-floty.html'&&!canDispatch(req)){
  if(who(req))return send(res,403,{error:'Mapa floty jest dostępna dla dyspozytorni.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/system.html' && !auth(req)){res.writeHead(302,{Location:who(req)?'/moj-panel.html':'/system-login.html'});return res.end()}
 if(['/driver.html','/moj-panel.html','/spedytor.html','/uzytkownicy.html','/trasy.html','/flota-online.html','/budzety.html','/ekonomia.html'].includes(u.pathname)){const me=who(req);if(!me){res.writeHead(302,{Location:'/system-login.html'});return res.end()}if(u.pathname==='/budzety.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/flota-online.html'&&!canDispatch(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/uzytkownicy.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/spedytor.html'&&!canDispatch(req))return send(res,403,{error:'Tylko spedytor'});if(u.pathname==='/trasy.html'&&!canDispatch(req)){if(!canDrive(req))return send(res,403,{error:'Brak dostępu do zleceń'});res.writeHead(302,{Location:'/moj-panel.html#routes'});return res.end()}if(['/driver.html','/moj-panel.html'].includes(u.pathname)&&!canDrive(req))return send(res,403,{error:'Tylko kierowca'});}
 let file=u.pathname==='/system.html'?'index.html':u.pathname==='/driver.html'?'moj-panel.html':u.pathname.slice(1);
 if(file==='stanowisko.html'){res.writeHead(302,{Location:canDispatch(req)?'/spedytor.html':'/system-login.html'});return res.end()}
 if(file==='pracownik.html'){res.writeHead(302,{Location:'/driver.html'});return res.end()}
 if(file==='index.html'&&u.pathname!=='/system.html')return send(res,403,{error:'Panel administratora wymaga logowania.'});
 if(file==='data.json'||file.includes('..')||file.includes('\\'))return send(res,403,{error:'Brak dostępu'});
 const full=path.resolve(ROOT,file);if(!full.startsWith(ROOT+path.sep))return send(res,403,{error:'Brak dostępu'});
 if(!fs.existsSync(full)||!fs.statSync(full).isFile())return send(res,404,{error:'Nie znaleziono'});
 res.writeHead(200,{'Content-Type':mime[path.extname(full)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self' 'unsafe-inline' data:; connect-src 'self'"});fs.createReadStream(full).pipe(res);
}catch(e){console.error(e);if(!res.headersSent)send(res,500,{error:'Błąd serwera'})}finally{release?.()}});
initStore().then(async()=>{if(accounts.size===0){const acct={id:crypto.randomUUID(),username:process.env.ADMIN_LOGIN||'admin',role:'admin',companyId:MAIN_COMPANY_ID,active:true,...passwordHash(password)};accounts.set(acct.username.toLowerCase(),acct);const d=await load();d.accounts=[acct];await save(d)}return true}).then(()=>server.listen(PORT,()=>console.log('Nowaczyk Transport Online: http://localhost:'+PORT))).catch(e=>{console.error('Błąd połączenia z bazą:',e.message);process.exit(1)});
