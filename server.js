'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateJob,jobIdentityReasons}=require('./job-match');
const PORT=Number(process.env.PORT||3000),ROOT=path.join(__dirname,'public'),DB=process.env.DATA_FILE||path.join(__dirname,'data.json');
const password=process.env.ADMIN_PASSWORD;
if(!password || password.length<12){console.error('Ustaw ADMIN_PASSWORD (min. 12 znaków) przed startem.');process.exit(1)}
const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64);
// Osobna, losowa zdolność przyjmowania tras dla sesji natywnego klienta.
const ROLES=['admin','dispatcher','driver','probation','mechanic','boss','subcontractor'];
const accounts=new Map();
const {europe,poland,middleEast}=require('./public/ets2-catalog.json');
const normalize=value=>String(value).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/ł/g,'l').trim();
const polishNames=require('./public/ets2-polish-names.json');
function alias(entries,value){
 return Object.entries(entries).find(([label])=>normalize(label)===normalize(value))?.[1];
}
function cityId(name,cities){
 const key=normalize(name);
 if(Object.hasOwn(cities,key))return key;
 const translated=alias(polishNames.cities,name);
 if(translated&&Object.hasOwn(cities,translated))return translated;
 const matches=Object.entries(cities).filter(([,city])=>normalize(city[0])===key);
 return matches.length===1?matches[0][0]:name;
}
const nowaczykMap=Object.assign({},...Array.from({length:24},(_,i)=>require('./public/ets2-mapset-nowaczyk-'+i+'.json')));
const nowaczykCities=Object.fromEntries(Object.keys(nowaczykMap).map(id=>[id,poland[id]||middleEast[id]||europe[id]||[id]]));
function mapSetCompany(city,company){
 return Object.hasOwn(nowaczykMap,city)&&Object.hasOwn(nowaczykMap[city],company);
}

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
const desktopSessionLifetimeSeconds=12*60*60;
const webSessionLifetimeSeconds=7*24*60*60;
const requestSession=Symbol('requestSession');
const digestToken=token=>crypto.createHash('sha256').update(token).digest('hex');
function sessionKey(req){
 const token=/(?:^|;\s*)ks_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
 return token?digestToken(token):null;
}
function who(req){
 const session=req[requestSession];
 if(!session||session.expires<=Date.now())return null;
 const account=accounts.get(session.username.toLowerCase());
 return account?.active&&account.id===session.id?{...safeAccount(account),expires:session.expires}:null;
}
function revokeAccountSessions(db,id){
 for(const [key,session] of Object.entries(db.authSessions||{})){
  if(session.id===id)delete db.authSessions[key];
 }
}
function auth(req){const me=who(req);return me?.role==='admin'||(me?.role==='boss'&&me.companyId===MAIN_COMPANY_ID)}
function canDispatch(req){return ['admin','dispatcher','boss'].includes(who(req)?.role)}
function canDrive(req){return auth(req)||['driver','probation'].includes(who(req)?.role)}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',b=>{s+=b;if(s.length>150000)req.destroy()});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Niepoprawny JSON'))}});req.on('error',reject)})}
// Orientacyjne stawki wirtualnej spedycji PLN/km, bez podatku VAT.
const roundPLN=n=>Math.round(n*100)/100;
function quoteFreight(km,cargo,tons,trailerType){
 const id=normalize(cargo);
 const chilled=trailerType==='chlodnia'||/frozen|fresh|fish|meat|milk|cheese|yogurt|icecream|chlod|mroz|ryb|mies|nabial/.test(id);
 const premium=/medical|medicine|pharma|electronic|computer|valuable|lek|elektronik/.test(id);
 const base=chilled?5.7:4.6;
 const rate=base+(premium?1.2:0)+Math.min(1.1,Math.max(0,Number(tons)||0)*0.035);
 return roundPLN(Math.max(0,Number(km)||0)*rate);
}
function str(s,max=100){return typeof s==='string'?s.trim().slice(0,max):''}
function client(req){return req.socket.remoteAddress||'unknown'}
const limits=new Map();function rate(req,key,max=10){const k=client(req)+key,now=Date.now(),v=(limits.get(k)||[]).filter(t=>t>now-60000);v.push(now);limits.set(k,v);return v.length<=max}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.zip':'application/zip','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
let mutationTail=Promise.resolve();
const server=http.createServer(async(req,res)=>{let release; if(!['GET','HEAD'].includes(req.method)){const previous=mutationTail;mutationTail=new Promise(resolve=>{release=resolve});await previous}try{
 const u=new URL(req.url,'http://localhost');const method=req.method;const db=await load();
 const key=sessionKey(req);
 req[requestSession]=key?db.authSessions?.[key]:null;
 // Centrum floty: dane pozycji z uwierzytelnionego konta; NIE jest to jeszcze integracja z ETS2.
 if(u.pathname==='/api/client-release'&&method==='GET'){let url='https://github.com/panczarodziej/Nowaczyk-Transport/releases/latest/download/Nowaczyk-Transport-Setup.exe';try{const candidate=new URL(process.env.TELEMETRY_DOWNLOAD_URL||'');if(candidate.protocol==='https:')url=candidate.href}catch{}return send(res,200,{version:'0.3.4',available:!!url,url})}
 if(u.pathname==='/api/tachograph'&&['GET','POST'].includes(method)){
  const me=who(req);
  if(!me||!canDrive(req))return send(res,403,{error:'Wymagane konto kierowcy'});
  const key=me.id;
  const previous=db.tachographs?.[key];
  if(method==='GET')return send(res,200,previous||null);
  const a=await body(req);
  const now=new Date().toISOString();
  const active=previous?.active===true;
  let state;
  if(a.action==='stop'){
   const endCountry=str(a.country,60);
   if(!active)return send(res,409,{error:'Tachograf nie jest uruchomiony.'});
   if(!endCountry)return send(res,400,{error:'Podaj kraj zakończenia.'});
   state={...previous,active:false,endCountry,endedAt:now};
  }else{
   const starting=a.action==='start';
   if(!starting&&a.action!=='update')return send(res,400,{error:'Wybierz Start, Stop albo zapisz aktywność.'});
   if(starting===active)return send(res,409,{error:active?'Tachograf jest już uruchomiony.':'Najpierw uruchom tachograf.'});
   const startCountry=starting?str(a.country,60):previous.startCountry;
   if(!startCountry)return send(res,400,{error:'Podaj kraj rozpoczęcia.'});
   const modes=['driving','work','available','rest'];
   if(!modes.includes(a.mode)||!Number.isInteger(a.minutes)||a.minutes<0||a.minutes>1440||typeof a.out!=='boolean'||typeof a.ferry!=='boolean'){
    return send(res,400,{error:'Sprawdź aktywność, przełączniki i czas w minutach (0–1440).'});
   }
   state={mode:a.mode,minutes:a.minutes,out:a.out,ferry:a.ferry,startCountry,endCountry:'',active:true,startedAt:starting?now:previous.startedAt,endedAt:null};
  }
  db.tachographs??={};
  db.tachographs[key]=state;
  await save(db);
  return send(res,200,state);
 }
 if(u.pathname==='/api/telemetry/me'&&method==='GET'){const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});const p=db.fleetPositions?.[me.username.toLowerCase()]||null;return send(res,200,{position:p,online:!!p&&Date.now()-Date.parse(p.updatedAt)<45000,events:(db.telemetryEvents||[]).filter(e=>e.driver===me.username.toLowerCase()).slice(-30)})}
 if(u.pathname==='/api/driver/mileage'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const driver=me.username.toLowerCase(),companyId=me.companyId||MAIN_COMPANY_ID;
  const routes=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.companyId===companyId);
  const completed=routes.filter(r=>r.deliveredAt||r.status==='Zakończona');
  return send(res,200,{driver:me.username,companyId,km:Math.round(routes.reduce((n,r)=>n+(Number(r.drivenKm)||0),0)*10)/10,completedKm:Math.round(completed.reduce((n,r)=>n+(Number(r.drivenKm)||0),0)*10)/10,completedRoutes:completed.length,allRoutes:routes.length,source:'server',updatedAt:new Date().toISOString()});
 }
 if(u.pathname==='/api/company/summary'&&method==='GET'){
  if(!canDispatch(req))return send(res,403,{error:'Tylko kierownictwo i dyspozytorzy'});
  const companyId=who(req).companyId||MAIN_COMPANY_ID;
  const routes=(db.routes||[]).filter(route=>route.companyId===companyId);
  const completed=routes.filter(route=>route.settledAt||route.deliveredAt||route.status==='Zakończona');
  const earned=roundPLN(routes.filter(route=>route.settledAt).reduce((sum,route)=>sum+Number(route.freight||0),0));
  const paid=roundPLN((db.payments||[]).filter(p=>routes.some(r=>r.driver.toLowerCase()===p.driver)).reduce((sum,p)=>sum+Number(p.amount||0),0));
  const drivers=[...accounts.values()].filter(account=>account.active&&account.companyId===companyId&&['driver','probation'].includes(account.role));
  const now=Date.now();
  return send(res,200,{
   km:Math.round(routes.reduce((sum,route)=>sum+(Number(route.drivenKm)||0),0)*10)/10,
   deliveries:completed.length,
   completedRoutes:completed.length,
   revenue:earned,
   driverPayments:paid,
   pendingDriverPay:roundPLN(routes.filter(r=>r.settledAt).reduce((sum,r)=>sum+Number(r.drivenKm||0)*Number(r.payRate??0.7),0)- (db.payments||[]).filter(p=>routes.some(r=>r.driver.toLowerCase()===p.driver)).reduce((sum,p)=>sum+Number(p.base||0),0)),
   openRoutes:routes.filter(route=>!route.deliveredAt&&route.status!=='Zakończona').length,
   drivers:drivers.length,
   online:drivers.filter(account=>now-Date.parse(db.fleetPositions?.[account.username.toLowerCase()]?.updatedAt)<45000).length,
   vehicles:(db.fleet||[]).filter(vehicle=>vehicle.companyId===companyId).length
  });
 }
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
   const candidates=(db.routes||[]).filter(r=>r.driver?.toLowerCase()===p.driver.toLowerCase()&&r.companyId===p.companyId&&r.acceptedAt&&!r.deliveredAt&&['Przyjęta','W trasie'].includes(r.status));
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
  if(['admin','dispatcher','boss'].includes(me.role))return send(res,200,{trailers:list,assignees:[...accounts.values()].filter(a=>a.active).map(safeAccount)});
  return send(res,200,{trailers:list.filter(t=>t.assigneeId===me.id)});
 }
 if(u.pathname==='/api/trailers'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator może zmieniać naczepy'});
  const a=await body(req),id=str(a.id,80),plate=str(a.plate,30).toUpperCase(),model=str(a.model,100),type=str(a.type,60),assigneeId=str(a.assigneeId,80),ownerCompanyId=str(a.ownerCompanyId,80)||MAIN_COMPANY_ID;
  if(!plate||!model||!['firanka','chlodnia','platforma','kontener','inna'].includes(type))return send(res,400,{error:'Podaj rejestrację, model i rodzaj naczepy'});
  if(!db.companies.some(c=>c.id===ownerCompanyId))return send(res,400,{error:'Nieznana firma właściciela'});
  const assignee=assigneeId?[...accounts.values()].find(x=>x.id===assigneeId&&x.active):null;
  if(assigneeId&&!assignee)return send(res,400,{error:'Wybierz aktywne konto pracownika'});
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
  const admin=auth(req)&&u.searchParams.get('mine')!=='1',name=me.username.toLowerCase();
  const wallets=db.wallets||{},orders=db.shopOrders||[],payments=db.payments||[],rates=db.driverRates||{};
  const history=[...payments.map(p=>({id:p.id,driver:p.driver,type:'wypłata',description:'Wypłata za '+p.month,amount:Number(p.amount),createdAt:p.createdAt,bonus:Number(p.bonus||0),deduction:Number(p.deduction||0)})),...orders.filter(o=>o.status==='Zatwierdzone').map(o=>({id:o.id,driver:o.driver,type:'zakup',description:o.name,amount:-Number(o.price),createdAt:o.decidedAt||o.createdAt})),...(db.fines||[]).map(f=>({id:f.id,driver:f.driver,type:'mandat',description:f.reason,amount:-Number(f.amount),createdAt:f.createdAt}))].filter(x=>admin||x.driver===name).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));

  return send(res,200,{wallets:admin?wallets:{[name]:wallets[name]||0},orders:admin?orders:orders.filter(x=>x.driver===name),payments:admin?payments:payments.filter(x=>x.driver===name),rates:admin?rates:{[name]:rates[name]??0.7},items:db.shopItems||[],history,earnings:(db.routes||[]).filter(r=>r.settledAt&&(admin||r.driver.toLowerCase()===name)).map(r=>({id:r.id,driver:r.driver,km:r.drivenKm,rate:r.payRate??0.7,earned:Math.round(r.drivenKm*(r.payRate??0.7)*100)/100,settledAt:r.settledAt}))});
 }
 if(u.pathname==='/api/economy/rate'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),driver=str(a.driver,50).toLowerCase(),rate=Number(a.rate);
  if(!driver||!Number.isFinite(rate)||rate<0||rate>100)return send(res,400,{error:'Nieprawidłowa stawka'});
  db.driverRates??={};db.driverRates[driver]=rate;await save(db);return send(res,200,{ok:true});
 }
 if(u.pathname==='/api/economy/payment'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),driver=str(a.driver,50).toLowerCase(),month=str(a.month,7),bonus=Number(a.bonus||0),deduction=Number(a.deduction||0),manualAmount=a.amount===undefined||a.amount===null||a.amount===''?null:Number(a.amount);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!driver||![bonus,deduction].every(v=>Number.isFinite(v)&&v>=0&&v<=1000000)||(manualAmount!==null&&(!Number.isFinite(manualAmount)||manualAmount<0||manualAmount>1000000)))return send(res,400,{error:'Nieprawidłowe dane wypłaty'});
  if(!accounts.has(driver))return send(res,404,{error:'Nie znaleziono konta z tym loginem'});
  db.payments??=[];if(db.payments.some(x=>x.driver===driver&&x.month===month))return send(res,409,{error:'Ten miesiąc został już rozliczony'});
  const rows=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.settledAt&&r.settledAt.slice(0,7)===month);
  const base=rows.reduce((sum,r)=>sum+Math.round(r.drivenKm*(r.payRate??0.7)*100),0)/100;
  const amount=roundPLN((manualAmount===null?base:manualAmount)+bonus-deduction);if(amount<0)return send(res,400,{error:'Potrącenia przekraczają wynagrodzenie'});
  db.wallets??={};db.wallets[driver]=Math.round(((db.wallets[driver]||0)+amount)*100)/100;
  db.payments.push({id:crypto.randomUUID(),driver,month,base:manualAmount===null?base:manualAmount,calculatedBase:base,bonus,deduction,amount,createdAt:new Date().toISOString()});
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
  for(const field of ['cargoId','sourceCityId','destinationCityId','sourceCompanyId','destinationCompanyId']){
   telemetry[field]=str(a[field],120);
  }
  const deliveredDistance=a.jobDeliveredDistanceKm;
  telemetry.jobDeliveredDistanceKm=Number.isFinite(deliveredDistance)&&deliveredDistance>0&&deliveredDistance<=100000?deliveredDistance:null;
  const candidates=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.companyId===(me.companyId||MAIN_COMPANY_ID)&&r.status!=='Zakończona');
  const checks=candidates.map(r=>({routeId:r.id,...validateJob(r,telemetry)}));
  const matches=candidates.filter(r=>r.acceptedAt&&checks.find(check=>check.routeId===r.id).match);
  const route=matches.length===1?matches[0]:null;
  const mileageMatches=candidates.filter(r=>r.acceptedAt&&!r.deliveredAt&&jobIdentityReasons(r,telemetry).length===0);
  const mileageRoute=mileageMatches.length===1?mileageMatches[0]:null;
  const event={id:crypto.randomUUID(),eventKey,driver,companyId:me.companyId||MAIN_COMPANY_ID,type,telemetry,routeId:route?.id||null,mileageRouteId:mileageRoute?.id||null,matchStatus:route?'matched':'unmatched',checks,verified:false,settlementAllowed:false,receivedAt:new Date().toISOString()};
  if(mileageRoute&&type==='job-delivered'){
   const previous=db.telemetryEvents.find(e=>(e.mileageRouteId||e.routeId)===mileageRoute.id&&e.driver===driver&&e.companyId===event.companyId&&e.type==='job-started'&&Number.isFinite(e.telemetry?.odometerKm));
   const odometerDistance=previous&&Number.isFinite(telemetry.odometerKm)?telemetry.odometerKm-previous.telemetry.odometerKm:null;
   const distance=telemetry.jobDeliveredDistanceKm??odometerDistance;
   if(distance!==null&&distance>0&&distance<=100000){
    event.distanceKm=Math.round(distance*10)/10;
    mileageRoute.drivenKm=Math.max(mileageRoute.drivenKm||0,event.distanceKm);
    mileageRoute.deliveredAt=event.receivedAt;
    if(mileageRoute.drivenKm>0){
     mileageRoute.status='Zakończona';
     if(!mileageRoute.settledAt){
      mileageRoute.settledAt=event.receivedAt;
      db.ledger??=[];
      db.ledger.push({id:crypto.randomUUID(),routeId:mileageRoute.id,companyId:mileageRoute.companyId,type:'fracht',amount:roundPLN(Number(mileageRoute.freight||0)),createdAt:event.receivedAt});
     }
    }
   }
  }
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
  const expected=req[requestSession]?.desktopDigest,provided=req.headers['x-nowaczyk-desktop-token'];
  if(req.headers.origin||!expected||typeof provided!=='string'||!/^[a-f0-9]{64}$/.test(provided)||!crypto.timingSafeEqual(Buffer.from(digestToken(provided),'hex'),Buffer.from(expected,'hex')))return send(res,403,{error:'Trasę przyjmiesz wyłącznie po zalogowaniu w aplikacji Nowaczyk Transport.'});
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
  const mapProfile=(db.driverMapProfiles||{})[r.driver.toLowerCase()]||'promods-pr';
  const cities={...europe,...middleEast,...(mapProfile==='promods-pr'?poland:{})};
  const companyAliases=require('./ets2-company-aliases.json');
  function companyId(name){
   const key=normalize(name||'').replace(/[^a-z0-9]/g,'');
   return Object.hasOwn(companyAliases,key)?companyAliases[key]:name||'';
  }
  const job={mapProfile,schema:'ks-group-dispatch-v1',acceptedAt:r.acceptedAt||null,id:r.id,driver:r.driver,from:{country:r.fromCountry||'',city:r.mapSetFrom||cityId(r.from,cities),company:r.mapSetFrom?r.sourceCompany:companyId(r.sourceCompany)},to:{country:r.toCountry||'',city:r.mapSetTo||cityId(r.to,cities),company:r.mapSetTo?r.destinationCompany:companyId(r.destinationCompany)},cargo:{name:r.cargo||'',id:alias(polishNames.cargo,r.cargo)||r.cargo||'',tons:r.cargoTons||0},plannedKm:r.plannedKm||0,freightPLN:r.freight||0,trailerId:r.trailerId||null,trailerType:['firanka','chlodnia'].includes(r.trailerType)?r.trailerType:null,createdAt:r.createdAt||null,notice:'Manifest dyspozytorski. Nie tworzy zlecenia w ETS2.'};
  if(mapSetCompany(job.from.city,job.from.company))job.from.loadingPlacement=nowaczykMap[job.from.city][job.from.company].easy?.[0];
  if(mapSetCompany(job.to.city,job.to.company))job.to.deliveryPlacements=nowaczykMap[job.to.city][job.to.company];
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="ks-job-'+r.id+'.json"','Cache-Control':'no-store'});return res.end(JSON.stringify(job,null,2));
 }
 if(u.pathname==='/api/routes/quote'&&method==='POST'){
  if(!canDispatch(req))return send(res,403,{error:'Brak uprawnień'});
  const a=await body(req),km=Number(a.plannedKm),tons=Number(a.cargoTons||0);
  if(!Number.isFinite(km)||km<0||km>20000||!Number.isFinite(tons)||tons<0||tons>100)return send(res,400,{error:'Nieprawidłowy dystans lub masa'});
  const driver=str(a.driver,100).toLowerCase(),rate=(db.driverRates||{})[driver]??0.7;
  return send(res,200,{freight:quoteFreight(km,a.cargo,tons,a.trailerType),driverPay:roundPLN(km*rate),driverRate:rate,estimated:true});
 }
 if(u.pathname==='/api/routes/assignees'&&method==='GET'){
  if(!canDispatch(req))return send(res,403,{error:'Brak dostępu do listy kierowców'});
  return send(res,200,[...accounts.values()].filter(a=>a.active&&(['admin','driver','probation'].includes(a.role)||(a.role==='boss'&&a.companyId===MAIN_COMPANY_ID))).map(a=>a.username).sort());
 }
 if(u.pathname==='/api/routes/archive'&&method==='POST'){
  if(!canDispatch(req))return send(res,403,{error:'Brak dostępu do usuwania tras'});
  const {id}=await body(req),index=(db.routes||[]).findIndex(route=>route.id===id);
  if(index<0)return send(res,404,{error:'Nie znaleziono trasy'});
  const route=db.routes[index];
  if(route.deliveredAt||route.settledAt||route.status==='Zakończona'||Number(route.drivenKm)>0||(db.expenses||[]).some(expense=>expense.routeId===id))return send(res,409,{error:'Trasa ma zapisane kilometry, dostawę lub koszty.'});
  db.archivedRoutes??=[];
  db.archivedRoutes.push({...route,archivedAt:new Date().toISOString()});
  db.routes.splice(index,1);
  await save(db);
  return send(res,200,{ok:true});
 }
 if(u.pathname==='/api/routes'&&method==='GET'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const me=who(req);return send(res,200,canDispatch(req)&&u.searchParams.get('mine')!=='1'?(db.routes||[]):(db.routes||[]).filter(r=>r.driver.toLowerCase()===me.username.toLowerCase()&&r.companyId===me.companyId));
 }
 if(u.pathname==='/api/routes'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Sesja wygasła. Zaloguj się ponownie, aby zapisać trasę.'});
  if(!canDispatch(req))return send(res,403,{error:'Trasy może przydzielać lub aktualizować Szef, Spedytor albo Administrator.'});
  const a=await body(req),from=str(a.from,120),to=str(a.to,120),driver=str(a.driver,100);
  if(!from||!to||!driver)return send(res,400,{error:'Podaj kierowcę, początek i koniec trasy'});
  const account=accounts.get(driver.toLowerCase());
  if(!account?.active||!(['admin','driver','probation'].includes(account.role)||(account.role==='boss'&&account.companyId===MAIN_COMPANY_ID)))return send(res,400,{error:'Wybierz aktywne konto z listy kierowców'});
  const plannedKm=Number(a.plannedKm);
  if(!Number.isFinite(plannedKm)||plannedKm<0||plannedKm>20000)return send(res,400,{error:'Nieprawidłowy dystans'});
  const freight=quoteFreight(plannedKm,a.cargo,a.cargoTons,a.trailerType);if(!Number.isFinite(freight)||freight<0||freight>10000000)return send(res,400,{error:'Nieprawidłowy fracht'});
  if(!Number.isFinite(Number(a.cargoTons||0))||Number(a.cargoTons||0)<0||Number(a.cargoTons||0)>100)return send(res,400,{error:'Nieprawidłowa masa ładunku'});
  const trailerType=str(a.trailerType,20);
  if(trailerType&&!['firanka','chlodnia'].includes(trailerType))return send(res,400,{error:'Wybierz plandekę lub chłodnię.'});
  const trailerId=str(a.trailerId,80),trailer=trailerId?(db.trailers||[]).find(t=>t.id===trailerId):null;
  if(trailer&&trailerType&&trailer.type!==trailerType)return send(res,400,{error:'Typ wybranej naczepy nie odpowiada zleceniu.'});
  if(trailerId&&!trailer)return send(res,400,{error:'Nie znaleziono przypisanej naczepy'});
  if(trailer&&trailer.assigneeUsername&&trailer.assigneeUsername.toLowerCase()!==driver.toLowerCase())return send(res,409,{error:'Naczepa jest przypisana do innego kierowcy lub podwykonawcy'});
  const sourceCompany=str(a.sourceCompany,120),destinationCompany=str(a.destinationCompany,120);
  const mapSetRoute={};
  if(a.catalogProfile==='snapshot'){
   const mapSetFrom=cityId(from,nowaczykCities),mapSetTo=cityId(to,nowaczykCities);
   if(!mapSetCompany(mapSetFrom,sourceCompany)||!mapSetCompany(mapSetTo,destinationCompany))return send(res,400,{error:'Wybierz obie firmy z listy dla właściwych miast na mapie Nowaczyk.'});
   if(mapSetFrom===mapSetTo&&sourceCompany===destinationCompany)return send(res,400,{error:'Wybierz inną firmę rozładunku.'});
   if(!str(a.cargo,120)||!Number.isSafeInteger(plannedKm)||plannedKm<=0)return send(res,400,{error:'Podaj ładunek i planowany dystans w pełnych kilometrach.'});
   Object.assign(mapSetRoute,{mapSetFrom,mapSetTo});
  }
  const r={...mapSetRoute,id:crypto.randomUUID(),trailerId:trailerId||null,trailerType:trailerType||trailer?.type||null,freight,companyId:account.companyId,driver:account.username,from,to,fromCountry:str(a.fromCountry,80),toCountry:str(a.toCountry,80),cargo:str(a.cargo,120),sourceCompany:str(a.sourceCompany,120),destinationCompany:str(a.destinationCompany,120),cargoTons:Number(a.cargoTons)||0,payRate:(db.driverRates||{})[driver.toLowerCase()]??0.7,plannedKm,drivenKm:0,status:'Przydzielona',createdAt:new Date().toISOString()};
  db.routes??=[];db.routes.push(r);await save(db);return send(res,201,r);
 }
 if(u.pathname==='/api/routes/progress'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Sesja wygasła. Zaloguj się ponownie, aby zapisać trasę.'});
  if(!canDispatch(req))return send(res,403,{error:'Trasy może przydzielać lub aktualizować Szef, Spedytor albo Administrator.'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.id);
  if(!r)return send(res,404,{error:'Nie znaleziono trasy'});
  if(r.deliveredAt||r.settledAt||r.status==='Zakończona')return send(res,409,{error:'Ukończona trasa ma już zapisany przebieg.'});
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
  const me=who(req);return send(res,200,canDispatch(req)&&u.searchParams.get('mine')!=='1'?(db.expenses||[]):(db.expenses||[]).filter(e=>e.driver.toLowerCase()===me.username.toLowerCase()));
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
  if(auth(req)&&u.searchParams.get('mine')!=='1')return send(res,200,{fleet,drivers:[...accounts.values()].filter(a=>a.active).map(safeAccount)});
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
  const sessionLifetimeSeconds=desktop?desktopSessionLifetimeSeconds:webSessionLifetimeSeconds;
  if(desktop&&(req.headers.origin||req.headers['x-nowaczyk-client']!=='desktop'))return send(res,403,{error:'Zaloguj się przez aplikację'});
  if(!rate(req,'accounts-login',8))return send(res,429,{error:'Za dużo prób'});
  const a=await body(req),name=str(a.username,50).toLowerCase(),acct=accounts.get(name);
  const dummy=crypto.scryptSync(str(a.password,300),salt,64);
  const candidate=acct?.active?crypto.scryptSync(str(a.password,300),acct.salt,64):dummy;
  const expected=acct?.active?Buffer.from(acct.hash,'hex'):hash;
  if(!acct||!acct.active||!crypto.timingSafeEqual(candidate,expected))return send(res,401,{error:'Nieprawidłowy login lub hasło'});
  const token=crypto.randomBytes(32).toString('hex');
  const desktopToken=desktop?crypto.randomBytes(32).toString('hex'):undefined;
  const now=Date.now();
  db.authSessions??={};
  for(const [key,session] of Object.entries(db.authSessions)){
   if(session.expires<=now)delete db.authSessions[key];
  }
  const previousKey=sessionKey(req);
  if(previousKey)delete db.authSessions[previousKey];
  db.authSessions[digestToken(token)]={id:acct.id,username:acct.username,expires:now+sessionLifetimeSeconds*1000,desktopDigest:desktopToken?digestToken(desktopToken):undefined};
  await save(db);
  return send(res,200,{ok:true,user:safeAccount(acct),desktopToken},{'Set-Cookie':`ks_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeSeconds}${process.env.COOKIE_SECURE==='1'?'; Secure':''}`});
 }
 if(u.pathname==='/api/logout'&&method==='POST'){
  const key=sessionKey(req);
  if(key&&db.authSessions?.[key]){
   delete db.authSessions[key];
   await save(db);
  }
  return send(res,200,{ok:true},{'Set-Cookie':'ks_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
 }
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
  revokeAccountSessions(db,account.id);
  await save(db);
  accounts.set(account.username.toLowerCase(),updated);
  return send(res,200,{ok:true},{'Set-Cookie':'ks_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.COOKIE_SECURE==='1'?'; Secure':'')});
 }
 if(u.pathname==='/api/accounts/me'&&method==='GET')return send(res,200,{user:who(req)});
 if(u.pathname==='/api/accounts'&&method==='GET'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  return send(res,200,[...accounts.values()].filter(a=>!a.deletedAt).map(safeAccount));
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
  if(!acct||acct.deletedAt)return send(res,404,{error:'Nie znaleziono konta'});
  if(who(req).role!=='admin'&&(acct.role==='admin'||a.role==='admin'))return send(res,403,{error:'Tylko administrator może zarządzać kontami administratorów'});
  if(a.active===false&&(acct.role==='admin'||acct.id===who(req).id))return send(res,400,{error:'Nie można zablokować administratora ani własnego konta'});
  if(a.password!==undefined&&(typeof a.password!=='string'||a.password.length<12||a.password.length>300))return send(res,400,{error:'Hasło min. 12 znaków'});
  if(typeof a.active==='boolean')acct.active=a.active;
  if(a.password!==undefined)Object.assign(acct,passwordHash(a.password));
  if(a.role!==undefined&&ROLES.includes(a.role)&&acct.role!=='admin')acct.role=a.role;
  if(!acct.active||a.password!==undefined)revokeAccountSessions(db,acct.id);
  db.accounts=[...accounts.values()];await save(db);return send(res,200,safeAccount(acct));
 }
 if(u.pathname==='/api/accounts/delete'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Brak uprawnień do usuwania kont'});
  const a=await body(req),acct=accounts.get(str(a.username,50).toLowerCase());
  if(!acct||acct.deletedAt)return send(res,404,{error:'Nie znaleziono konta'});
  if(!['driver','probation'].includes(acct.role)||acct.id===who(req).id)return send(res,403,{error:'Można usunąć wyłącznie konto kierowcy'});
  acct.active=false;
  acct.deletedAt=new Date().toISOString();
  delete acct.hash;
  delete acct.salt;
  revokeAccountSessions(db,acct.id);
  db.accounts=[...accounts.values()];await save(db);
  return send(res,200,{ok:true});
 }
 if(u.pathname==='/api/me')return send(res,200,{admin:auth(req)});
 if(u.pathname.startsWith('/api/admin/')){
  if(!auth(req))return send(res,401,{error:'Zaloguj się jako administrator.'});
  if(u.pathname==='/api/admin/applications'&&method==='GET'){
   const cutoff=Date.now()-24*60*60*1000;
   return send(res,200,db.applications.filter(x=>x.status!=='Przyjęte'||!(Date.parse(x.acceptedAt||x.date)<=cutoff)));
  }
  if(u.pathname==='/api/admin/companies'&&method==='GET')return send(res,200,db.companies);
  if(u.pathname==='/api/admin/applications'&&method==='PATCH'){
   const a=await body(req),x=db.applications.find(x=>x.id===a.id);
   if(!x)return send(res,404,{error:'Nie znaleziono podania'});
   if(a.status&&!['Nowe','Przyjęte','Odrzucone'].includes(a.status))return send(res,400,{error:'Niepoprawny status'});
   if(a.companyId&&!db.companies.some(c=>c.id===a.companyId))return send(res,400,{error:'Nieznana firma'});
   if(a.status&&x.status!==a.status){
    x.status=a.status;
    if(a.status==='Przyjęte')x.acceptedAt=new Date().toISOString();
    else delete x.acceptedAt;
   }
   if(a.companyId){x.companyId=a.companyId;x.companyName=db.companies.find(c=>c.id===a.companyId).name}await save(db);return send(res,200,x);
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
 const homePath=auth(req)?'/system.html':canDispatch(req)?'/spedytor.html':canDrive(req)?'/moj-panel.html':'/system-login.html';
 if(['/','/system','/index.html','/login.html'].includes(u.pathname)||(u.pathname==='/system-login.html'&&homePath!==u.pathname)){
  res.writeHead(302,{Location:homePath,'Cache-Control':'no-store'});return res.end();
 }
 if(u.pathname==='/admin.html'&&!auth(req)){
  if(who(req))return send(res,403,{error:'Panel rekrutacji jest dostępny dla kierownictwa.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/centrum-floty.html'&&!canDispatch(req)){
  if(who(req))return send(res,403,{error:'Mapa floty jest dostępna dla dyspozytorni.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/system.html' && !auth(req)){res.writeHead(302,{Location:homePath});return res.end()}
 if(['/driver.html','/moj-panel.html','/spedytor.html','/uzytkownicy.html','/trasy.html','/flota-online.html','/firma.html','/budzety.html','/ekonomia.html'].includes(u.pathname)){const me=who(req);if(!me){res.writeHead(302,{Location:'/system-login.html'});return res.end()}if(u.pathname==='/budzety.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(['/flota-online.html','/firma.html'].includes(u.pathname)&&!canDispatch(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/uzytkownicy.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/spedytor.html'&&!canDispatch(req))return send(res,403,{error:'Tylko spedytor'});if(u.pathname==='/trasy.html'&&!canDispatch(req)){if(!canDrive(req))return send(res,403,{error:'Brak dostępu do zleceń'});res.writeHead(302,{Location:'/moj-panel.html#routes'});return res.end()}if(['/driver.html','/moj-panel.html'].includes(u.pathname)&&!canDrive(req))return send(res,403,{error:'Tylko kierowca'});}
 let file=u.pathname==='/system.html'?'index.html':u.pathname==='/driver.html'?'moj-panel.html':u.pathname.slice(1);
 if(file==='stanowisko.html'){res.writeHead(302,{Location:canDispatch(req)?'/spedytor.html':'/system-login.html'});return res.end()}
 if(file==='pracownik.html'){res.writeHead(302,{Location:'/driver.html'});return res.end()}
 if(file==='index.html'&&u.pathname!=='/system.html')return send(res,403,{error:'Panel administratora wymaga logowania.'});
 if(file==='data.json'||file.includes('..')||file.includes('\\'))return send(res,403,{error:'Brak dostępu'});
 const full=path.resolve(ROOT,file);if(!full.startsWith(ROOT+path.sep))return send(res,403,{error:'Brak dostępu'});
 if(!fs.existsSync(full)||!fs.statSync(full).isFile())return send(res,404,{error:'Nie znaleziono'});
 const basePolicy="default-src 'self' 'unsafe-inline' data:; connect-src 'self'";
 const fleetMapPolicy="; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css; img-src 'self' data: https://map.charlws.com/ets2/promods/tiles/";
 const policy=basePolicy+(file==='centrum-floty.html'?fleetMapPolicy:'');
 res.writeHead(200,{'Content-Type':mime[path.extname(full)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':policy});fs.createReadStream(full).pipe(res);
}catch(e){console.error(e);if(!res.headersSent)send(res,500,{error:'Błąd serwera'})}finally{release?.()}});
initStore().then(async()=>{if(accounts.size===0){const acct={id:crypto.randomUUID(),username:process.env.ADMIN_LOGIN||'admin',role:'admin',companyId:MAIN_COMPANY_ID,active:true,...passwordHash(password)};accounts.set(acct.username.toLowerCase(),acct);const d=await load();d.accounts=[acct];await save(d)}return true}).then(()=>server.listen(PORT,'0.0.0.0',()=>console.log('Nowaczyk Transport Online: http://0.0.0.0:'+PORT))).catch(e=>{console.error('Błąd połączenia z bazą:',e.message);process.exit(1)});
