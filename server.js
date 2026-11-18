'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateJob,jobIdentityReasons}=require('./job-match');
const fleetFinance=require('./fleet-finance');
const managementReport=require('./management-report');
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
function safeAccount(a){return {id:a.id,username:a.username,role:a.role,dispatchAccess:a.role!=='dispatcher'&&hasDispatcherRole(a),companyId:a.companyId,active:a.active,canHire:!a.active&&Boolean(a.pendingHire||a.dismissedAt)}}
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
function archiveDeletedLogin(db,account){
 const key=account.username.toLowerCase();
 // The archive key cannot be registered as a login. Keep historical rows and totals.
 const archiveKey=key+'#'+account.id;
 for(const records of [db.routes,db.archivedRoutes,db.expenses,db.fines,db.payments,
  db.shopOrders,db.cmrDocuments,db.telemetryEvents,db.fleetActivityEvents]){
  for(const record of records||[]){
   if(record.driver?.toLowerCase()===key){
    record.originalDriver=record.driver;
    record.driver=archiveKey;
    if(record.invoice&&!record.invoice.driverId)record.invoice.driverId=account.id;
   }
  }
 }
 for(const records of [db.wallets,db.driverRates,db.driverMapProfiles,db.tachographs]){
  if(records&&Object.hasOwn(records,key)){
   records[archiveKey]=records[key];
   delete records[key];
  }
 }
 if(db.fleetPositions&&Object.hasOwn(db.fleetPositions,key))delete db.fleetPositions[key];
 for(const vehicle of db.fleet||[]){
  if(vehicle.driverAccountId===account.id)Object.assign(vehicle,{driverAccountId:'',driverUsername:''});
 }
 for(const trailer of db.trailers||[]){
  if(trailer.assigneeId===account.id)Object.assign(trailer,{assigneeId:'',assigneeUsername:'',assigneeRole:''});
 }
 revokeAccountSessions(db,account.id);
}
function revokeAccountSessions(db,id){
 for(const [key,session] of Object.entries(db.authSessions||{})){
  if(session.id===id)delete db.authSessions[key];
 }
}
function auth(req){const me=who(req);return me?.role==='admin'||(me?.role==='boss'&&me.companyId===MAIN_COMPANY_ID)}
function canSetInitialBudget(req,companyId){
 return auth(req);
}
function isSubcontractorBoss(req){const me=who(req);return me?.role==='subcontractor'||(me?.role==='boss'&&me.companyId!==MAIN_COMPANY_ID)}
function hasDispatcherRole(account){
 return account?.role==='dispatcher'||(['driver','probation'].includes(account?.role)&&account.dispatchAccess===true);
}
function canDispatch(req){return auth(req)||hasDispatcherRole(who(req))}
function canAssignRoutes(req){
 const me=who(req);
 return auth(req)||hasDispatcherRole(me)||isSubcontractorBoss(req);
}
function canDrive(req){const me=who(req);return !!me?.active&&!me.deletedAt}
function routeAssigneeAllowed(req,account){return !!account?.active&&!account.deletedAt&&(!isSubcontractorBoss(req)||account.companyId===who(req).companyId)}
function companyManager(req){return auth(req)||isSubcontractorBoss(req)}
function employee(account){return !account.deletedAt&&['driver','probation'].includes(account.role)}
function drivingRoster(db){
 const assigned=new Set((db.fleet||[]).map(v=>v.driverAccountId));
 const routed=new Set((db.routes||[]).map(r=>r.companyId+':'+r.driver?.toLowerCase()));
 return [...accounts.values()].filter(a=>{
  if(!a.active||a.deletedAt)return false;
  if(employee(a))return true;
  const name=a.username.toLowerCase();
  return assigned.has(a.id)||routed.has(a.companyId+':'+name)||db.fleetPositions?.[name]?.companyId===a.companyId;
 });
}
function driverOnline(db,account,now){
 const position=db.fleetPositions?.[account.username.toLowerCase()];
 const age=now-Date.parse(position?.updatedAt);
 return position?.companyId===account.companyId&&age>=0&&age<45000;
}
function expenseCompany(db,expense){
 return expense.companyId||(db.routes||[]).find(route=>route.id===expense.routeId)?.companyId||MAIN_COMPANY_ID;
}
function priceCents(value){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value))return null;
 return Math.round(Number(value)*100);
}
function validDate(value){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function httpsLink(value){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password}catch{return false}
}
function companyCashFlow(db,companyId){
 const transactions=(db.ledger||[]).filter(x=>x.companyId===companyId).map(x=>Math.round(Number(x.amount||0)*100));
 const income=transactions.reduce((sum,cents)=>sum+Math.max(0,cents),0);
 const operatingCosts=(db.expenses||[]).filter(x=>expenseCompany(db,x)===companyId)
  .reduce((sum,x)=>sum+Math.round(Number(x.amount||0)*100),0);
 const costs=transactions.reduce((sum,cents)=>sum+Math.max(0,-cents),operatingCosts);
 return {income,costs};
}
function body(req){
 return new Promise((resolve,reject)=>{
  if(req.destroyed&&!req.readableEnded)return reject(new Error('Połączenie zamknięte przed odebraniem żądania'));
  let s='';
  req.on('data',b=>{s+=b;if(s.length>150000)req.destroy()});
  req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Niepoprawny JSON'))}});
  req.on('error',reject);
  req.on('close',()=>{if(!req.readableEnded)reject(new Error('Przerwano odbieranie żądania'))});
 });
}
// Orientacyjne stawki wirtualnej spedycji PLN/km, bez podatku VAT.
const roundPLN=n=>Math.round(n*100)/100;
// Fixed conversion for the virtual economy.
const EURO_PLN=4.25;
function freightRate(trailerType,from,to){
 const region=value=>{
  const key=normalize(value);
  for(const [area,pattern] of Object.entries({
   pl:/^(polska|poland|pl)$/,de:/^(niemcy|germany|de)$/,
   benelux:/^(benelux|belgia|belgium|holandia|niderlandy|netherlands|luksemburg|luxembourg|be|nl|lu)$/,
   fr:/^(francja|france|fr)$/,it:/^(wlochy|italy|it)$/,es:/^(hiszpania|spain|es)$/,
   nordic:/^(skandynawia|dania|denmark|norwegia|norway|szwecja|sweden|finlandia|finland|dk|no|se|fi)$/
  }))if(pattern.test(key))return area;
 };
 const origin=region(from),destination=region(to);
 const corridor=origin==='pl'?destination:destination==='pl'?origin:null;
 const rates={de:[0.95,1.10],benelux:[0.95,1.15],fr:[1.00,1.20],it:[1.05,1.25],es:[1.05,1.30],nordic:[1.20,1.45]};
 return (rates[corridor]||[0.95,1.10])[trailerType==='chlodnia'?1:0];
}
function quoteFreight(km,trailerType,from,to,emptyKm=0){
 const loadedRate=freightRate(trailerType,from,to);
 return roundPLN((km*loadedRate+emptyKm*0.30)*EURO_PLN);
}
let offersCache;
function marketOffers(){
 if(!offersCache){
  const excluded=new Set(['AM','AZ','EG','GE','IL','IQ','JO','LB','LY','SA','SY','TR','RU']);
  offersCache=require('./freight-market').buildOffers(nowaczykMap,nowaczykCities,quoteFreight,excluded)
   .map(o=>({...o,rateEUR:freightRate(o.trailerType,o.fromCountry,o.toCountry)}));
 }
 return offersCache;
}
function matchesMarketLocation(query,city,country,code){
 if(!query)return true;
 const cityName=normalize(city),countryName=normalize(country),countryCode=normalize(code||'');
 return query===countryName||query===countryCode||cityName.startsWith(query)||
  query===cityName+' '+countryName||query===cityName+' '+countryCode;
}
function str(s,max=100){return typeof s==='string'?s.trim().slice(0,max):''}
function client(req){return req.socket.remoteAddress||'unknown'}
const limits=new Map();function rate(req,key,max=10){const k=client(req)+key,now=Date.now(),v=(limits.get(k)||[]).filter(t=>t>now-60000);v.push(now);limits.set(k,v);return v.length<=max}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.zip':'application/zip','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
let mutationTail=Promise.resolve();
const server=http.createServer(async(req,res)=>{let release; if(!['GET','HEAD'].includes(req.method)){const previous=mutationTail;mutationTail=new Promise(resolve=>{release=resolve});await previous}try{
 const u=new URL(req.url,'http://localhost');const method=req.method;const db=await load();
 if(u.pathname.startsWith('/api/fleet-finance/')&&pool){const budgets=await pool.query('SELECT company_id,initial_cents FROM ks_company_budget');db.initialBudgets=Object.fromEntries(budgets.rows.map(x=>[x.company_id,{initialCents:Number(x.initial_cents)}]))}
  const key=sessionKey(req);
 req[requestSession]=key?db.authSessions?.[key]:null;
 const subcontractorCompanySettings=u.pathname==='/api/admin/companies'&&['GET','PATCH'].includes(method)&&isSubcontractorBoss(req);
 if(isSubcontractorBoss(req)&&u.pathname.startsWith('/api/')&&!subcontractorCompanySettings&&!u.pathname.startsWith('/api/transport-documents')&&
    !u.pathname.startsWith('/api/fleet-finance/')&&!['/api/my-applications','/api/applications','/api/notifications','/api/company/startup-finance','/api/company/loan','/api/company/loan-requests','/api/company/trailer-license','/api/company/management','/api/fleet/sell','/api/fleet/sales','/api/company/board','/api/company/maintenance','/api/company/maintenance/complete','/api/economy/order/decide','/api/company/accessory-invoice','/api/company/employment','/api/company/fleet-expense','/api/company/vehicle-requests','/api/fleet/buy'].includes(u.pathname)&&
    !(method==='GET'&&['/api/fleet','/api/trailers','/api/freight-market','/api/routes/assignees','/api/routes/export','/api/driver/mileage','/api/telemetry/me','/api/finance'].includes(u.pathname))&&
    !['/api/fleet','/api/trailers','/api/desktop/login','/api/routes/accept','/api/driver/map-profile','/api/telemetry/events','/api/fleet/position','/api/routes','/api/routes/archive','/api/routes/progress','/api/routes/quote','/api/expenses','/api/tachograph','/api/economy/lights'].includes(u.pathname)&&
    !(method==='GET'&&u.pathname==='/api/economy'&&u.searchParams.get('mine')==='1')&&
    !(method==='GET'&&u.pathname==='/api/budgets'&&u.searchParams.get('mine')==='1')&&
    !(method==='GET'&&['/api/fleet/positions','/api/company/summary'].includes(u.pathname))&&
    !['/api/accounts/me','/api/accounts/login','/api/accounts/password','/api/logout','/api/admin/applications','/api/companies','/api/me'].includes(u.pathname)){
  return send(res,403,{error:'Konto szefa podwykonawcy ma dostęp do rekrutacji i mapy własnej firmy.'});
 }

 if(u.pathname.startsWith('/api/fleet-finance/')){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const me=who(req),companyId=auth(req)&&u.searchParams.get('companyId')||me.companyId;
  if(companyId!==me.companyId&&!auth(req))return send(res,403,{error:'Brak dostępu'});
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Brak firmy'});
  if(method==='GET'&&u.pathname==='/api/fleet-finance/overview')return send(res,200,{
   leases:(db.fleetLeases||[]).filter(x=>x.companyId===companyId),
   policies:(db.fleetPolicies||[]).filter(x=>x.companyId===companyId),
   tolls:(db.fleetTolls||[]).filter(x=>x.companyId===companyId),
   notices:fleetFinance.notices(db,companyId)
  });
  if(method==='POST'){
   const a=await body(req);
   try{
    let result;
    if(u.pathname==='/api/fleet-finance/lease')result=fleetFinance.createLease(db,companyId,a);
    else if(u.pathname==='/api/fleet-finance/policy')result=fleetFinance.createPolicy(db,companyId,a);
    else if(u.pathname==='/api/fleet-finance/toll')result=fleetFinance.createToll(db,companyId,a);
    else return send(res,404,{error:'Nie znaleziono'});
    await save(db);return send(res,201,result);
   }catch(error){return send(res,400,{error:error.message})}
  }
  return send(res,405,{error:'Metoda niedozwolona'});
 }
 if(u.pathname==='/api/my-applications'&&method==='GET'){
  const me=who(req);
  if(!me)return send(res,401,{error:'Zaloguj się.'});
  return send(res,200,(db.applications||[]).filter(a=>a.applicantId===me.id).map(({id,companyName,date,status})=>({id,companyName,date,status})));
 }
 if(u.pathname==='/api/notifications'&&['GET','POST'].includes(method)){
  const me=who(req);
  if(!me)return send(res,401,{error:'Zaloguj się.'});
  const name=me.username.toLowerCase(), manager=companyManager(req);
  const scope=id=>auth(req)||id===me.companyId;
  const rows=[];
  function add(kind,id,status,label,at,url,review){
   const key=kind+':'+id+':'+status;
   rows.push({id:key,label,at,url:review?'/wnioski.html#'+encodeURIComponent(key):url,...(review?{review}: {})});
  }
  const companyName=id=>db.companies.find(c=>c.id===id)?.name||'Firma';
  for(const route of db.routes||[]){
   if(route.companyId===me.companyId&&route.driver?.toLowerCase()===name&&route.createdAt){
    add('route',route.id,'assigned','Przydzielona trasa · '+route.from+' → '+route.to,route.createdAt,'/moj-panel.html#routes');
   }
  }
  for(const a of db.applications||[]){
   if(a.applicantId===me.id&&a.status!=='Nowe')add('job',a.id,a.status,'Podanie o pracę · '+a.companyName+' · '+a.status,a.decidedAt||a.acceptedAt||a.date,'/rekrutacja.html#myApplications');
   if(manager&&scope(a.companyId)&&a.status==='Nowe')add('job',a.id,a.status,'Podanie o pracę · '+a.fullname+' · '+companyName(a.companyId),a.date,'/admin.html',{kind:'job',id:a.id,details:[a.discord,a.age!=null?'Wiek: '+a.age:'',a.hours!=null?'ETS2: '+a.hours+' h':'',a.experience,a.availability,a.reason].filter(Boolean),acceptOnly:false});
  }
  for(const r of db.vehicleRequests||[]){
   const label=(r.kind==='trailer'?'Naczepa':'Ciągnik')+' · '+r.model;
   if(r.status==='pending'&&manager&&scope(r.companyId))add('vehicle',r.id,r.status,'Nowy wniosek · '+companyName(r.companyId)+' · '+label,r.createdAt,'/firma.html#vehicleRequests',auth(req)?{kind:'vehicle',id:r.id,lease:r.financing==='lease',details:[r.brand,r.chassis,r.color,r.emission,r.mileage+' km',(r.amount/100).toFixed(2)+' zł',r.description,r.bankCity,r.plate].filter(Boolean),listing:r.listing,cash:r.financing==='cash'}:null);
   if(r.status!=='pending'&&manager&&r.companyId===me.companyId)add('vehicle',r.id,r.status,label+' · '+(r.status==='approved'?'zatwierdzono':'odrzucono'),r.decidedAt,'/firma.html#vehicleRequests');
  }
  for(const o of db.shopOrders||[]){
   if(o.category!=='lights')continue;
   const companyId=o.companyId||accounts.get(o.driver)?.companyId||MAIN_COMPANY_ID;
   if(manager&&scope(companyId)&&o.status==='Oczekuje')add('accessory',o.id,o.status,'Wniosek o dodatki · '+o.name,o.createdAt,'/firma.html',{kind:'accessory',id:o.id,details:[companyName(companyId),o.driver,o.quantity+' szt.',o.price+' zł']});
   if(o.status!=='Oczekuje'&&(o.driverId?o.driverId===me.id:o.driver===name))add('accessory',o.id,o.status,o.name+' · '+o.status,o.decidedAt,'/moj-panel.html#lights');
  }
  for(const [id,license] of Object.entries(db.trailerLicenses||{})){
   if(license.status==='pending'&&auth(req))add('license',license.createdAt+':'+id,license.status,'Licencja na naczepy · '+companyName(id),license.createdAt,'/podwykonawcy.html',{kind:'license',id,details:[license.reason].filter(Boolean)});
   if(license.status!=='pending'&&manager&&id===me.companyId)add('license',license.createdAt+':'+id,license.status,'Licencja na naczepy · '+(license.status==='approved'?'zatwierdzono':'odrzucono'),license.decidedAt,'/firma.html#trailerLicense');
  }
  if(manager)for(const n of fleetFinance.notices(db,me.companyId))rows.push({id:'finance:'+n.id,label:n.label+' · '+n.due,at:n.at,url:n.url});
  if(manager)for(const job of db.maintenance||[]){if(job.companyId===me.companyId&&job.status==='planned'&&Date.parse(job.due+'T00:00:00Z')<=Date.now()+7*86400000)add('maintenance',job.id,'planned','Serwis · '+job.plate+' · '+job.description,job.due+'T12:00:00Z','/biuro-zarzadu.html#service')}
  const reads=db.notificationReads?.[me.id]||[];
  if(method==='POST'){
   const a=await body(req);
   if(!rows.some(row=>row.id===a.id))return send(res,404,{error:'Powiadomienie jest niedostępne.'});
   (db.notificationReads??={})[me.id]=[...new Set([...reads,a.id])];
   await save(db);
   return send(res,200,{ok:true});
  }
  const seen=new Set(reads);
  rows.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  return send(res,200,{unread:rows.filter(row=>!seen.has(row.id)).length,items:rows.map(row=>({...row,read:seen.has(row.id)}))});
 }
 // Centrum floty: dane pozycji z uwierzytelnionego konta; NIE jest to jeszcze integracja z ETS2.
 if(u.pathname==='/api/client-release'&&method==='GET'){let url='https://github.com/panczarodziej/Nowaczyk-Transport/releases/latest/download/Nowaczyk-Transport-Setup.exe';try{const candidate=new URL(process.env.TELEMETRY_DOWNLOAD_URL||'');if(candidate.protocol==='https:')url=candidate.href}catch{}return send(res,200,{version:'0.3.30',available:!!url,url})}
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
 if(u.pathname==='/api/company/board'&&method==='GET'){
  if(!companyManager(req))return send(res,403,{error:'Biuro zarządu jest dostępne tylko dla szefów.'});
  const companyId=u.searchParams.get('companyId')||who(req).companyId;
  if(companyId!==who(req).companyId&&!auth(req))return send(res,403,{error:'Brak dostępu do firmy.'});
  if(!(db.companies||[]).some(c=>c.id===companyId&&!c.archivedAt))return send(res,404,{error:'Nie znaleziono firmy.'});
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'});
  const month=u.searchParams.get('month')||today.slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2000-01'||month>'2100-12')return send(res,400,{error:'Wybierz poprawny miesiąc.'});
  if(pool){const result=await pool.query('SELECT initial_cents FROM ks_company_budget WHERE company_id=$1',[companyId]);if(result.rows[0]){db.initialBudgets??={};db.initialBudgets[companyId]={initialCents:Number(result.rows[0].initial_cents)}}}
  return send(res,200,managementReport.report(db,companyId,month,today,auth(req)&&companyId===MAIN_COMPANY_ID));
 }
 if(u.pathname==='/api/company/maintenance'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy.'});
  const a=await body(req),companyId=who(req).companyId;
  const vehicle=[...(db.fleet||[]),...(db.trailers||[])].find(v=>v.id===a.vehicleId&&(v.companyId||v.ownerCompanyId||MAIN_COMPANY_ID)===companyId);
  const description=str(a.description,300),due=str(a.due,10),estimate=Number(a.estimate||0);
  if(!vehicle||!description||!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||new Date(due).toISOString().slice(0,10)!==due||!Number.isFinite(estimate)||estimate<0||estimate>1000000)return send(res,400,{error:'Wybierz własny pojazd, poprawny termin, opis i koszt planowany.'});
  const item={id:crypto.randomUUID(),companyId,vehicleId:vehicle.id,plate:vehicle.plate,description,due,estimate:roundPLN(estimate),status:'planned',createdAt:new Date().toISOString(),createdBy:who(req).username};
  (db.maintenance??=[]).push(item);await save(db);return send(res,201,item);
 }
 if(u.pathname==='/api/company/maintenance/complete'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy.'});
  const a=await body(req),companyId=who(req).companyId,item=(db.maintenance||[]).find(x=>x.id===a.id&&x.companyId===companyId);
  if(!item)return send(res,404,{error:'Nie znaleziono serwisu.'});
  if(item.status==='cancelled')return send(res,409,{error:'Serwis anulowano po sprzedaży pojazdu.'});
  if(item.status==='completed')return send(res,200,{ok:true,duplicate:true,item});
  const amount=Number(a.amount),invoiceNumber=str(a.invoiceNumber,100);
  if(!Number.isFinite(amount)||amount<0||amount>1000000||(amount>0&&!invoiceNumber))return send(res,400,{error:'Podaj koszt rzeczywisty i numer faktury.'});
  if(pool){const result=await pool.query('SELECT initial_cents FROM ks_company_budget WHERE company_id=$1',[companyId]);if(result.rows[0]){db.initialBudgets??={};db.initialBudgets[companyId]={initialCents:Number(result.rows[0].initial_cents)}}}
  if(amount>0&&!fleetFinance.charge(db,companyId,roundPLN(amount),'maintenance:'+item.id,'Serwis: '+item.description,item.vehicleId))return send(res,409,{error:'Brak środków firmy na opłacenie serwisu.'});
  Object.assign(item,{status:'completed',amount:roundPLN(amount),invoiceNumber,completedAt:new Date().toISOString(),completedBy:who(req).username});
  const entry=(db.ledger||[]).find(e=>e.operationKey==='maintenance:'+item.id);if(entry)entry.invoiceNumber=invoiceNumber;
  await save(db);return send(res,200,{ok:true,item});
 }
 if(u.pathname==='/api/company/summary'&&method==='GET'){
  if(!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Tylko kierownictwo i dyspozytorzy'});
  const companyId=who(req).companyId||MAIN_COMPANY_ID;
  const routes=(db.routes||[]).filter(route=>route.companyId===companyId);
  const completed=routes.filter(route=>route.settledAt||route.deliveredAt||route.status==='Zakończona');
  const earned=roundPLN(routes.filter(route=>route.settledAt).reduce((sum,route)=>sum+Number(route.freight||0),0));
  const paid=roundPLN((db.payments||[]).filter(p=>routes.some(r=>r.driver.toLowerCase()===p.driver)).reduce((sum,p)=>sum+Number(p.amount||0),0));
  const roster=drivingRoster(db),now=Date.now();
  const drivers=roster.filter(account=>account.companyId===companyId);
  const online=drivers.filter(account=>driverOnline(db,account,now)).length;
  if(isSubcontractorBoss(req))return send(res,200,{
   companyName:db.companies.find(company=>company.id===companyId)?.name||companyId,
   km:Math.round(routes.reduce((sum,route)=>sum+(Number(route.drivenKm)||0),0)*10)/10,
   completedRoutes:completed.length,
   openRoutes:routes.length-completed.length,
   drivers:drivers.length,
   online
  });
  return send(res,200,{
   km:Math.round(routes.reduce((sum,route)=>sum+(Number(route.drivenKm)||0),0)*10)/10,
   deliveries:completed.length,
   completedRoutes:completed.length,
   revenue:earned,
   driverPayments:paid,
   pendingDriverPay:roundPLN(routes.filter(r=>r.settledAt).reduce((sum,r)=>sum+Number(r.drivenKm||0)*Number(r.payRate??0.7),0)- (db.payments||[]).filter(p=>routes.some(r=>r.driver.toLowerCase()===p.driver)).reduce((sum,p)=>sum+Number(p.base||0),0)),
   openRoutes:routes.filter(route=>!route.deliveredAt&&route.status!=='Zakończona').length,
   drivers:drivers.length,
   online,
   ...(auth(req)?{allDrivers:roster.length,allOnline:roster.filter(account=>driverOnline(db,account,now)).length}:{}),
   vehicles:(db.fleet||[]).filter(vehicle=>vehicle.companyId===companyId).length
  });
 }
 if(u.pathname==='/api/fleet/positions'&&method==='GET'){
  if(!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Brak dostępu do mapy kierowców'});
  const now=Date.now();
  const deliveries=new Map();
  for(const event of db.telemetryEvents||[]){
   if(event.type==='job-delivered'&&event.telemetry?.destinationCity)deliveries.set(event.driver.toLowerCase(),event);
  }
  const companyNames=new Map(db.companies.map(company=>[company.id,company.name]));
  const positions=drivingRoster(db).map(account=>{
   const companyId=account.companyId;
   const report=db.fleetPositions?.[account.username.toLowerCase()];
   const p=report?.companyId===companyId?report:{driver:account.username,companyId};
   const candidates=(db.routes||[]).filter(r=>r.driver?.toLowerCase()===p.driver.toLowerCase()&&r.companyId===p.companyId&&r.acceptedAt&&!r.deliveredAt&&['Przyjęta','W trasie'].includes(r.status));
   const inProgress=candidates.filter(r=>r.status==='W trasie');
   const route=inProgress.length===1?inProgress[0]:candidates.length===1?candidates[0]:null;
   const delivery=deliveries.get(p.driver.toLowerCase());
   return {...p,companyId,companyName:companyNames.get(companyId)||companyId,online:driverOnline(db,account,now),dispatchRoute:route?{from:route.from,to:route.to}:null,lastDelivery:delivery?.companyId===companyId?{city:delivery.telemetry.destinationCity,company:delivery.telemetry.destinationCompany}:null};

  });
  return send(res,200,{positions,source:'telemetry-client',gameMapReady:false});
 }
 if(u.pathname==='/api/fleet/position'&&method==='POST'){
  const me=who(req);if(!me||!canDrive(req))return send(res,403,{error:'Tylko zalogowany kierowca'});
  if(!rate(req,'fleet-position',120))return send(res,429,{error:'Zbyt wiele aktualizacji'});
  const a=await body(req),x=Number(a.x),z=Number(a.z),speed=Number(a.speedKmh||0);
  if(![x,z,speed].every(Number.isFinite)||Math.abs(x)>1e7||Math.abs(z)>1e7||speed<0||speed>200)return send(res,400,{error:'Nieprawidłowe współrzędne ETS2'});
  const driver=me.username.toLowerCase(),companyId=me.companyId||MAIN_COMPANY_ID;
  const latestJob=(db.telemetryEvents||[]).findLast(event=>event.driver===driver&&event.companyId===companyId);
  const activeJob=latestJob?.type==='job-started'&&a.onJob===true&&a.cargoLoaded===true&&
   str(a.cargo,120)===latestJob.telemetry?.cargo&&
   Number.isFinite(a.odometerKm)&&a.odometerKm>=latestJob.telemetry.odometerKm;
  const route=activeJob?(db.routes||[]).find(r=>r.id===latestJob.mileageRouteId&&
   r.driver.toLowerCase()===driver&&r.companyId===companyId&&r.acceptedAt&&!r.deliveredAt&&
   ['Przyjęta','W trasie'].includes(r.status)):null;
  if(route){
   route.status='W trasie';
   const start=latestJob.telemetry.odometerKm;
   const distance=a.odometerKm-start;
   if(Number.isFinite(start)&&start>=0&&distance<=100000)route.liveDrivenKm=Math.round(distance*10)/10;
  }
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
 if(u.pathname==='/api/vehicles/reregister'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy może przerejestrować pojazd.'});
  const a=await body(req),kind=str(a.kind,20),id=str(a.id,80),plate=str(a.plate,30).toUpperCase().replace(/\s+/g,' ').trim();
  if(!['truck','trailer'].includes(kind))return send(res,400,{error:'Wybierz ciężarówkę lub naczepę.'});
  const list=kind==='truck'?(db.fleet||[]):(db.trailers||[]);
  const vehicle=list.find(v=>v.id===id);
  if(!vehicle)return send(res,404,{error:'Nie znaleziono pojazdu.'});
  const ownerId=kind==='truck'?vehicle.companyId:vehicle.ownerCompanyId;
  if(!auth(req)&&ownerId!==who(req).companyId)return send(res,403,{error:'Możesz zmieniać tylko rejestracje swojej firmy.'});
  const normalize=v=>String(v||'').toUpperCase().replace(/[\s-]/g,'');
  if(!/^[A-Z0-9][A-Z0-9 -]{2,14}$/.test(plate)||normalize(plate)===normalize(vehicle.plate))return send(res,400,{error:'Wpisz inną, poprawną rejestrację.'});
  if((db.fleet||[]).some(v=>(v.id!==id||kind!=='truck')&&normalize(v.plate)===normalize(plate))||
     (db.trailers||[]).some(v=>(v.id!==id||kind!=='trailer')&&normalize(v.plate)===normalize(plate)))
    return send(res,409,{error:'Ta rejestracja jest już przypisana do innego pojazdu.'});
  const oldPlate=vehicle.plate,now=new Date().toISOString();
  (vehicle.registrationHistory??=[]).push({from:oldPlate,to:plate,at:now,by:who(req).username});
  Object.assign(vehicle,{previousPlate:oldPlate,plate,registeredAt:now,registeredBy:who(req).username});
  if(kind==='truck')vehicle.trailerPlate=vehicle.trailerPlate||'';
  else for(const truck of db.fleet||[])if(normalize(truck.trailerPlate)===normalize(oldPlate))truck.trailerPlate=plate;
  await save(db);return send(res,200,{ok:true,id,kind,plate,previousPlate:oldPlate});
 }
 if(u.pathname==='/api/trailers'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const list=db.trailers||[];
  if(isSubcontractorBoss(req))return send(res,200,{assignees:[...accounts.values()].filter(a=>a.active&&a.companyId===me.companyId).map(safeAccount),trailers:list.filter(t=>t.ownerCompanyId===me.companyId||
   [...accounts.values()].some(a=>a.id===t.assigneeId&&a.active&&a.companyId===me.companyId))});
  if(canDispatch(req))return send(res,200,{trailers:list,assignees:[...accounts.values()].filter(a=>a.active).map(safeAccount)});
  return send(res,200,{trailers:list.filter(t=>t.assigneeId===me.id)});
 }
 if(u.pathname==='/api/trailers'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const a=await body(req),id=str(a.id,80),plate=str(a.plate,30).toUpperCase(),model=str(a.model,100),type=str(a.type,60),assigneeId=str(a.assigneeId,80),ownerCompanyId=isSubcontractorBoss(req)?who(req).companyId:str(a.ownerCompanyId,80)||MAIN_COMPANY_ID;
  if(!plate||!model||!['firanka','chlodnia','platforma','kontener','inna'].includes(type))return send(res,400,{error:'Podaj rejestrację, model i rodzaj naczepy'});
  if(!db.companies.some(c=>c.id===ownerCompanyId))return send(res,400,{error:'Nieznana firma właściciela'});
  const assignee=assigneeId?[...accounts.values()].find(x=>x.id===assigneeId&&x.active):null;
  if(assigneeId&&!assignee)return send(res,400,{error:'Wybierz aktywne konto pracownika'});
  db.trailers??=[];
  if(db.trailers.some(t=>t.plate===plate&&t.id!==id))return send(res,409,{error:'Naczepa o tej rejestracji już istnieje'});
  let t=id?db.trailers.find(t=>t.id===id):null;
  if(id&&!t)return send(res,404,{error:'Nie znaleziono naczepy'});
  if(isSubcontractorBoss(req)){
   if(!t||t.ownerCompanyId!==ownerCompanyId)return send(res,403,{error:'Wniosek o nową naczepę złóż w Mojej firmie. Tu przypiszesz własne naczepy.'});
   if(assignee&&assignee.companyId!==ownerCompanyId)return send(res,403,{error:'Wybierz kierowcę swojej firmy.'});
   if(t.plate!==plate||t.model!==model||t.type!==type)return send(res,403,{error:'Możesz zmienić przypisanie naczepy.'});
  }
  if(t?.requestId&&(ownerCompanyId!==t.ownerCompanyId||(assignee&&assignee.companyId!==t.ownerCompanyId))){
   return send(res,400,{error:'Wybierz kierowcę z firmy właściciela naczepy.'});
  }
  if(!t){t={id:crypto.randomUUID(),createdAt:new Date().toISOString()};db.trailers.push(t)}
  Object.assign(t,{plate,model,type,ownerCompanyId,assigneeId,assigneeUsername:assignee?.username||'',assigneeRole:assignee?.role||'',updatedAt:new Date().toISOString()});
  await save(db);return send(res,200,t);
 }
 // Budżet początkowy: niezmienny wpis, zabezpieczony unikalnym kluczem w PostgreSQL.
 if(u.pathname==='/api/budgets'&&method==='GET'){
  const mine=u.searchParams.get('mine')==='1';
  if(!auth(req)&&!(mine&&isSubcontractorBoss(req)))return send(res,403,{error:'Tylko administrator'});
  let entries;
  if(pool){const q=await pool.query('SELECT company_id,initial_cents,locked_at FROM ks_company_budget');entries=q.rows.map(x=>({companyId:x.company_id,initialCents:Number(x.initial_cents),lockedAt:x.locked_at}))}
  else entries=Object.entries(db.initialBudgets||{}).map(([companyId,x])=>({companyId,...x}));
  const budgets=(db.companies||[]).filter(c=>!c.archivedAt&&(!mine||c.id===who(req).companyId)).map(c=>{
   const funding=db.startupFinance?.[c.id];
   const b=entries.find(x=>x.companyId===c.id)||funding;
   const {income,costs}=companyCashFlow(db,c.id);
   return {companyId:c.id,name:c.name,canSetInitialBudget:canSetInitialBudget(req,c.id)&&!b,fundingSource:funding?.source,loanRemainingCents:(db.companyLoans?.[c.id]?.remainingCents??0)+(funding?.remainingCents??0),locked:!!b,initialCents:b?.initialCents??null,lockedAt:b?.lockedAt??null,incomeCents:income,costCents:costs,balanceCents:b||db.companyLoans?.[c.id]?(b?.initialCents??0)+income-costs:null};
  });return send(res,200,budgets);
 }
 if(u.pathname==='/api/company/loan-requests'&&method==='GET'){
  if(!companyManager(req))return send(res,403,{error:'Brak uprawnień.'});
  const me=who(req);
  return send(res,200,(db.companyLoanRequests||[]).filter(x=>auth(req)||x.companyId===me.companyId).slice().reverse());
 }
 if(u.pathname==='/api/company/loan-requests/decide'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Wnioski zatwierdza główny szef.'});
  const a=await body(req),request=(db.companyLoanRequests||[]).find(x=>x.id===a.id);
  if(!request||request.status!=='pending')return send(res,409,{error:'Wniosek nie istnieje lub został rozpatrzony.'});
  if(!['approved','rejected'].includes(a.decision))return send(res,400,{error:'Nieprawidłowa decyzja.'});
  if(a.decision==='approved'){
   const companyId=request.companyId,loans=db.companyLoans??={},current=loans[companyId];
   if(current?.remainingCents>0||db.startupFinance?.[companyId]?.remainingCents>0)return send(res,409,{error:'Firma ma aktywny kredyt.'});
   loans[companyId]={remainingCents:request.amountCents,createdAt:new Date().toISOString(),requestId:request.id};
   (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,type:'kredyt firmowy',
    description:'Kredyt zatwierdzony przez głównego szefa',amount:request.amountCents/100,createdAt:new Date().toISOString(),requestId:request.id});
  }
  Object.assign(request,{status:a.decision,decidedAt:new Date().toISOString(),decidedBy:who(req).username});
  await save(db);return send(res,200,request);
 }
 if(u.pathname==='/api/company/loan'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy.'});
  const a=await body(req),cents=priceCents(a.amount),companyId=who(req).companyId;
  if(!cents)return send(res,400,{error:'Podaj dodatnią kwotę w PLN.'});
  const loans=db.companyLoans??={},current=loans[companyId];
  const createdAt=new Date().toISOString();
  if(a.action==='repay'){
   if(!current||cents>current.remainingCents)return send(res,400,{error:'Kwota przekracza pozostały kredyt.'});
   const budget=pool?(await pool.query('SELECT initial_cents FROM ks_company_budget WHERE company_id=$1',[companyId])).rows[0]?.initial_cents:db.initialBudgets?.[companyId]?.initialCents;
   const {income,costs}=companyCashFlow(db,companyId);
   if(Number(budget??db.startupFinance?.[companyId]?.initialCents??0)+income-costs<cents)return send(res,409,{error:'Za mało środków na koncie firmy.'});
   current.remainingCents-=cents;
   (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,type:'spłata kredytu',amount:-cents/100,createdAt});
   await save(db);return send(res,200,current);
  }
  if(a.action!=='borrow'||cents>50000000)return send(res,400,{error:'Wybierz kredyt do 500 000 zł.'});
  if(current?.remainingCents>0||db.startupFinance?.[companyId]?.remainingCents>0)return send(res,409,{error:'Najpierw spłać aktywny kredyt.'});
  if(companyId!==MAIN_COMPANY_ID){
   if((db.companyLoanRequests||[]).some(x=>x.companyId===companyId&&x.status==='pending'))return send(res,409,{error:'Masz już oczekujący wniosek kredytowy.'});
   const request={id:crypto.randomUUID(),companyId,amountCents:cents,status:'pending',createdAt,requestedBy:who(req).username};
   (db.companyLoanRequests??=[]).push(request);await save(db);return send(res,201,request);
  }
  loans[companyId]={remainingCents:cents,createdAt};
  (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,type:'kredyt firmowy',amount:cents/100,createdAt});
  await save(db);return send(res,201,loans[companyId]);
 }
 if(u.pathname==='/api/company/startup-finance'&&method==='POST'){
  if(!isSubcontractorBoss(req))return send(res,403,{error:'Finansowanie uruchamia szef podwykonawcy.'});
  const me=who(req),companyId=me.companyId,a=await body(req),cents=priceCents(a.amount);
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Nie znaleziono firmy.'});
  if(!cents)return send(res,400,{error:'Podaj dodatnią kwotę w PLN.'});
  const current=db.startupFinance?.[companyId];
  const now=new Date().toISOString();
  if(a.source==='repay'){
   if(current?.source!=='credit'||cents>current.remainingCents)return send(res,400,{error:'Kwota przekracza pozostały kredyt.'});
   const {income,costs}=companyCashFlow(db,companyId);
   if(current.initialCents+income-costs<cents)return send(res,409,{error:'Za mało środków na koncie firmy.'});
   current.remainingCents-=cents;
   (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,type:'spłata kredytu',amount:-cents/100,createdAt:now});
   await save(db);return send(res,200,current);
  }
  if(!['wallet','credit'].includes(a.source))return send(res,400,{error:'Wybierz źródło finansowania.'});
  const legacy=pool?(await pool.query('SELECT 1 FROM ks_company_budget WHERE company_id=$1',[companyId])).rowCount:
   Object.hasOwn(db.initialBudgets||{},companyId);
  if(current||legacy)return send(res,409,{error:'Firma ma już finansowanie startowe.'});
  const driver=me.username.toLowerCase();
  if(a.source==='wallet'){
   const wallet=Math.round((db.wallets?.[driver]||0)*100);
   if(cents>wallet)return send(res,409,{error:'Za mało środków w portfelu kierowcy.'});
   db.wallets[driver]=(wallet-cents)/100;
   (db.startupTransfers??=[]).push({id:crypto.randomUUID(),driverId:me.id,driver,companyId,
    type:'wkład do firmy',description:'Finansowanie startowe firmy',amount:-cents/100,createdAt:now});
  }else if(cents>50000000)return send(res,400,{error:'Kredyt startowy może wynieść maksymalnie 500 000 zł.'});
  const funding={source:a.source,initialCents:cents,remainingCents:a.source==='credit'?cents:0,lockedAt:now};
  Object.defineProperty(db.startupFinance??={},companyId,{value:funding,enumerable:true,writable:true,configurable:true});
  await save(db);return send(res,201,funding);
 }
 if(u.pathname==='/api/budgets'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),companyId=str(a.companyId,80),amount=a.amount;
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Nie znaleziono firmy'});
  if(!canSetInitialBudget(req,companyId))return send(res,403,{error:'Brak uprawnień do ustawienia budżetu.'});
  if(db.startupFinance?.[companyId])return send(res,409,{error:'Firma ma już finansowanie początkowe. Nie można ustawić drugiego budżetu.'});
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
  const history=[...(db.startupTransfers||[]).filter(x=>admin||x.driverId===me.id),...payments.map(p=>({id:p.id,driver:p.driver,type:'wypłata',description:'Wypłata za '+p.month,amount:Number(p.amount),createdAt:p.createdAt,bonus:Number(p.bonus||0),deduction:Number(p.deduction||0)})),...orders.filter(o=>o.status==='Zatwierdzone'&&o.category!=='lights').map(o=>({id:o.id,driver:o.driver,type:'zakup',description:o.name,amount:-Number(o.price),createdAt:o.decidedAt||o.createdAt})),...(db.fines||[]).map(f=>({id:f.id,driver:f.driver,type:'mandat',description:f.reason,amount:-Number(f.amount),createdAt:f.createdAt}))].filter(x=>admin||x.driver===name).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));

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
 if(u.pathname==='/api/economy/lights'&&['GET','POST'].includes(method)){
  const me=who(req);
  if(!canDrive(req))return send(res,403,{error:'Tylko kierowca'});
  const driver=me.username.toLowerCase();
  db.shopOrders??=[];
  if(method==='GET')return send(res,200,db.shopOrders.filter(order=>order.category==='lights'&&(order.driverId?order.driverId===me.id:order.driver===driver)));
  const a=await body(req),name=str(a.name,100),unitPrice=a.unitPrice,quantity=a.quantity;
  const cents=Math.round(unitPrice*100);
  if(!name||!Number.isFinite(unitPrice)||cents<1||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000||cents*quantity>100000000){
   return send(res,400,{error:'Podaj nazwę, poprawną cenę za sztukę i ilość.'});
  }
  const order={id:crypto.randomUUID(),driver,category:'lights',companyId:me.companyId,driverId:me.id,name,unitPrice:cents/100,quantity,price:cents*quantity/100,status:'Oczekuje',createdAt:new Date().toISOString()};
  db.shopOrders.push(order);
  await save(db);
  return send(res,201,order);
 }
 if(u.pathname==='/api/economy/order'&&method==='POST'){
  const me=who(req);if(!me||!['driver','probation','admin'].includes(me.role))return send(res,403,{error:'Tylko kierowca'});
  const a=await body(req),item=(db.shopItems||[]).find(x=>x.id===a.itemId);
  if(!item)return send(res,404,{error:'Nie znaleziono produktu'});
  db.shopOrders??=[];const order={id:crypto.randomUUID(),driver:me.username.toLowerCase(),itemId:item.id,name:item.name,price:item.price,status:'Oczekuje',createdAt:new Date().toISOString()};db.shopOrders.push(order);await save(db);return send(res,201,order);
 }
 if(u.pathname==='/api/company/accessory-invoice'&&method==='GET'){
  const me=who(req);
  if(!me)return send(res,401,{error:'Zaloguj się.'});
  const invoice=(db.shopOrders||[]).find(x=>x.id===u.searchParams.get('id'))?.invoice
   ||(db.ledger||[]).find(x=>x.id===u.searchParams.get('id'))?.invoice;
  if(!invoice||!(auth(req)||(companyManager(req)&&invoice.companyId===me.companyId)||
     (invoice.driverId?invoice.driverId===me.id:invoice.driver===me.username.toLowerCase()))){
   return send(res,404,{error:'Nie znaleziono dokumentu.'});
  }
  return send(res,200,invoice);
 }
 if(u.pathname==='/api/economy/order/decide'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const a=await body(req),order=(db.shopOrders||[]).find(x=>x.id===a.id);
  if(!order)return send(res,404,{error:'Nie znaleziono zamówienia'});
  const accessory=order.category==='lights',me=who(req);
  const companyId=order.companyId||accounts.get(order.driver)?.companyId||MAIN_COMPANY_ID;
  if(!auth(req)&&(!accessory||companyId!==me.companyId))return send(res,403,{error:'Brak dostępu do tego wniosku.'});
  if(order.status!=='Oczekuje')return send(res,409,{error:'Zamówienie już rozpatrzone'});
  if(!['Zatwierdzone','Odrzucone'].includes(a.status))return send(res,400,{error:'Nieprawidłowa decyzja'});
  const createdAt=new Date().toISOString();
  if(a.status==='Zatwierdzone'){
   if(accessory){
    const company=db.companies.find(c=>c.id===companyId);
    if(!company)return send(res,404,{error:'Nie znaleziono firmy.'});
    order.invoice={number:'DOD-'+order.id.toUpperCase(),companyId,company:company.name,driver:order.driver,driverId:order.driverId,
     name:order.name,quantity:order.quantity,unitPrice:order.unitPrice,total:order.price,createdAt,approvedBy:me.username};
    (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,orderId:order.id,type:'dodatki do pojazdu',
     description:order.name,amount:-order.price,createdAt,invoiceNumber:order.invoice.number});
   }else{
    db.wallets??={};
    const balance=db.wallets[order.driver]||0;
    if(balance<order.price)return send(res,409,{error:'Za mało środków kierowcy'});
    db.wallets[order.driver]=roundPLN(balance-order.price);
   }
  }
  order.status=a.status;
  order.decidedAt=createdAt;
  await save(db);
  return send(res,200,order);
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
  const candidates=(db.routes||[]).filter(r=>r.driver.toLowerCase()===driver&&r.companyId===(me.companyId||MAIN_COMPANY_ID)&&!r.deliveredAt&&!r.settledAt&&r.status!=='Zakończona');
  const checks=candidates.map(r=>({routeId:r.id,...validateJob(r,telemetry)}));
  const matches=candidates.filter(r=>r.acceptedAt&&checks.find(check=>check.routeId===r.id).match);
  let route=matches.length===1?matches[0]:null;
  const mileageMatches=candidates.filter(r=>r.acceptedAt&&!r.deliveredAt&&jobIdentityReasons(r,telemetry).length===0);
  // Reuse the started order when the driver has several identical dispatches.
  const started=db.telemetryEvents.findLast(e=>e.driver===driver&&e.companyId===(me.companyId||MAIN_COMPANY_ID)&&e.type==='job-started'&&mileageMatches.some(r=>r.id===(e.mileageRouteId||e.routeId)));
  const active=mileageMatches.filter(r=>r.status==='W trasie');
  const mileageRoute=mileageMatches.length===1?mileageMatches[0]:
   started?mileageMatches.find(r=>r.id===(started.mileageRouteId||started.routeId)):
   active.length===1?active[0]:type==='job-started'?mileageMatches.slice().sort((a,b)=>String(a.acceptedAt).localeCompare(String(b.acceptedAt))||String(a.id).localeCompare(String(b.id)))[0]||null:null;
  if(mileageRoute&&checks.find(c=>c.routeId===mileageRoute.id)?.match)route=mileageRoute;
  const event={id:crypto.randomUUID(),eventKey,driver,companyId:me.companyId||MAIN_COMPANY_ID,type,telemetry,routeId:route?.id||null,mileageRouteId:mileageRoute?.id||null,matchStatus:route?'matched':'unmatched',checks,verified:false,settlementAllowed:false,receivedAt:new Date().toISOString()};
  if(mileageRoute?.status==='Przyjęta'&&type==='job-started')mileageRoute.status='W trasie';
  if(mileageRoute&&type==='job-delivered'){
   const previous=db.telemetryEvents.findLast(e=>(e.mileageRouteId||e.routeId)===mileageRoute.id&&e.driver===driver&&e.companyId===event.companyId&&e.type==='job-started'&&Number.isFinite(e.telemetry?.odometerKm));
   const odometerDistance=previous&&Number.isFinite(telemetry.odometerKm)?telemetry.odometerKm-previous.telemetry.odometerKm:null;
   const distance=telemetry.jobDeliveredDistanceKm??odometerDistance;
   if(Number.isFinite(distance)&&distance>0&&distance<=100000&&Math.round(distance*10)>0){
    event.distanceKm=Math.round(distance*10)/10;
    mileageRoute.drivenKm=event.distanceKm;
    delete mileageRoute.liveDrivenKm;
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
  const assignedVehicle=(db.fleet||[]).find(v=>v.driverAccountId===me.id&&v.companyId===r.companyId);
  if(assignedVehicle){r.vehicleId=assignedVehicle.id;r.vehiclePlate=assignedVehicle.plate}
  r.acceptedAt=new Date().toISOString();r.acceptedBy=me.username;r.acceptedVia='desktop';r.status='Przyjęta';await save(db);return send(res,200,{ok:true,route:r});
 }
 if(u.pathname==='/api/routes/export'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const r=(db.routes||[]).find(x=>x.id===u.searchParams.get('id'));
  if(!r)return send(res,404,{error:'Nie znaleziono zlecenia'});
  if(!canDispatch(req)&&(r.companyId!==me.companyId||(!isSubcontractorBoss(req)&&r.driver.toLowerCase()!==me.username.toLowerCase())))return send(res,403,{error:'Brak dostępu'});
  const mapProfile=(db.driverMapProfiles||{})[r.driver.toLowerCase()]||'promods-pr';
  const cities={...europe,...middleEast,...(mapProfile==='promods-pr'?poland:{})};
  const companyAliases=require('./ets2-company-aliases.json');
  function companyId(name){
   const key=normalize(name||'').replace(/[^a-z0-9]/g,'');
   return Object.hasOwn(companyAliases,key)?companyAliases[key]:name||'';
  }
  const job={mapProfile,schema:'ks-group-dispatch-v1',acceptedAt:r.acceptedAt||null,id:r.id,driver:r.driver,from:{country:r.fromCountry||'',city:r.mapSetFrom||cityId(r.from,cities),company:r.mapSetFrom?r.sourceCompany:companyId(r.sourceCompany)},to:{country:r.toCountry||'',city:r.mapSetTo||cityId(r.to,cities),company:r.mapSetTo?r.destinationCompany:companyId(r.destinationCompany)},cargo:{name:r.cargo||'',id:alias(polishNames.cargo,r.cargo)||r.cargo||'',tons:r.cargoTons||0},plannedKm:r.plannedKm||0,freightPLN:r.freight||0,trailerId:r.trailerId||null,trailerType:['firanka','chlodnia'].includes(r.trailerType)?r.trailerType:null,createdAt:r.createdAt||null,notice:'Manifest dyspozytorski. Nie tworzy zlecenia w ETS2.'};
  if(mapSetCompany(job.from.city,job.from.company)){
   const points=nowaczykMap[job.from.city][job.from.company];
   job.from.loadingPlacements=points.easy||[];
   job.from.loadingPlacement=job.from.loadingPlacements[0];
  }
  if(mapSetCompany(job.to.city,job.to.company))job.to.deliveryPlacements=nowaczykMap[job.to.city][job.to.company];
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="ks-job-'+r.id+'.json"','Cache-Control':'no-store'});return res.end(JSON.stringify(job,null,2));
 }
 if(u.pathname==='/api/routes/quote'&&method==='POST'){
  if(!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Brak uprawnień'});
  const a=await body(req),km=Number(a.plannedKm),tons=Number(a.cargoTons||0),emptyKm=Number(a.emptyKm??0);
  if(!Number.isFinite(emptyKm)||emptyKm<0||emptyKm>20000||!Number.isFinite(km)||km<0||km>20000||!Number.isFinite(tons)||tons<0||tons>100)return send(res,400,{error:'Nieprawidłowy dystans lub masa'});
  const driver=str(a.driver,100).toLowerCase();
  if(isSubcontractorBoss(req)&&driver&&accounts.get(driver)?.companyId!==who(req).companyId)return send(res,403,{error:'Wybierz kierowcę swojej firmy.'});
  const rate=(db.driverRates||{})[driver]??0.7;
  return send(res,200,{freight:quoteFreight(km,a.trailerType,a.fromCountry,a.toCountry,emptyKm),emptyFreight:roundPLN(emptyKm*0.30*EURO_PLN),driverPay:roundPLN(km*rate),driverRate:rate,estimated:true});
 }
 if(u.pathname==='/api/freight-market'&&method==='GET'){
  if(!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Giełda jest dostępna dla szefa i dyspozytora.'});
  const filters=['from','to','cargo'].map(key=>normalize(u.searchParams.get(key)||''));
  const trailer=u.searchParams.get('trailer'),min=Number(u.searchParams.get('min')||0),max=Number(u.searchParams.get('max')||100);
  const assigned=new Set([...(db.routes||[]),...(db.archivedRoutes||[])].map(r=>r.offerId));
  const matches=marketOffers().filter(offer=>!assigned.has(offer.id)&&
   matchesMarketLocation(filters[0],offer.from,offer.fromCountry,offer.fromCode)&&matchesMarketLocation(filters[1],offer.to,offer.toCountry,offer.toCode)&&
   normalize(offer.cargoLabel).includes(filters[2])&&(!trailer||offer.trailerType===trailer)&&offer.cargoTons>=min&&offer.cargoTons<=max);
  const size=25,page=Math.min(Math.max(1,Math.floor(Number(u.searchParams.get('page'))||1)),Math.max(1,Math.ceil(matches.length/size)));
  return send(res,200,{total:matches.length,page,size,assign:canAssignRoutes(req),offers:matches.slice((page-1)*size,page*size)});
 }
 if(u.pathname==='/api/routes/assignees'&&method==='GET'){
  if(!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Brak dostępu do listy kierowców'});
  return send(res,200,[...accounts.values()].filter(a=>routeAssigneeAllowed(req,a)).map(a=>a.username).sort());
 }
 if(u.pathname==='/api/routes/archive'&&method==='POST'){
  if(!canAssignRoutes(req))return send(res,403,{error:'Zleceniami zarządza główny szef lub dyspozytor.'});
  const {id}=await body(req),index=(db.routes||[]).findIndex(route=>route.id===id);
  if(index<0||(isSubcontractorBoss(req)&&db.routes[index].companyId!==who(req).companyId))return send(res,404,{error:'Nie znaleziono trasy'});
  const route=db.routes[index];
  if(route.status==='Zakończona'||(db.expenses||[]).some(expense=>expense.routeId===id))return send(res,409,{error:'Trasa zakończona lub ma zapisane koszty.'});
  db.archivedRoutes??=[];
  db.archivedRoutes.push({...route,archivedAt:new Date().toISOString()});
  db.routes.splice(index,1);
  await save(db);
  return send(res,200,{ok:true});
 }
 if(u.pathname==='/api/routes'&&method==='GET'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const me=who(req),mine=u.searchParams.get('mine')==='1';
  return send(res,200,(db.routes||[]).filter(r=>!mine&&canDispatch(req)||
   r.companyId===me.companyId&&(!mine&&isSubcontractorBoss(req)||r.driver.toLowerCase()===me.username.toLowerCase())));
 }
 if(u.pathname==='/api/routes'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Sesja wygasła. Zaloguj się ponownie, aby zapisać trasę.'});
  if(!canAssignRoutes(req))return send(res,403,{error:'Zleceniami zarządza główny szef lub dyspozytor.'});
  const input=await body(req),offerId=str(input.offerId,20);
  const offer=offerId?marketOffers().find(item=>item.id===offerId):null;
  if(offerId&&!offer)return send(res,404,{error:'Oferta jest niedostępna.'});
  if(offer&&[...(db.routes||[]),...(db.archivedRoutes||[])].some(r=>r.offerId===offerId))return send(res,409,{error:'Oferta została już przydzielona.'});
  const a=offer?{...offer,driver:input.driver,emptyKm:input.emptyKm,catalogProfile:'snapshot'}:input;
  const from=str(a.from,120),to=str(a.to,120),driver=str(a.driver,100);
  if(!from||!to||!driver)return send(res,400,{error:'Podaj kierowcę, początek i koniec trasy'});
  const account=accounts.get(driver.toLowerCase());
  if(!routeAssigneeAllowed(req,account))return send(res,400,{error:'Wybierz aktywne konto z listy odbiorców trasy.'});
  const plannedKm=Number(a.plannedKm);
  if(!Number.isFinite(plannedKm)||plannedKm<0||plannedKm>20000)return send(res,400,{error:'Nieprawidłowy dystans'});
  const emptyKm=Number(a.emptyKm??0);
  if(!Number.isFinite(emptyKm)||emptyKm<0||emptyKm>20000)return send(res,400,{error:'Nieprawidłowy pusty przebieg.'});
  const freight=quoteFreight(plannedKm,a.trailerType,a.fromCountry,a.toCountry,emptyKm);if(!Number.isFinite(freight)||freight<0||freight>10000000)return send(res,400,{error:'Nieprawidłowy fracht'});
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
   const mapSetFrom=offer?.mapSetFrom||cityId(from,nowaczykCities),mapSetTo=offer?.mapSetTo||cityId(to,nowaczykCities);
   if(!mapSetCompany(mapSetFrom,sourceCompany)||!mapSetCompany(mapSetTo,destinationCompany))return send(res,400,{error:'Wybierz obie firmy z listy dla właściwych miast na mapie Nowaczyk.'});
   if(mapSetFrom===mapSetTo&&sourceCompany===destinationCompany)return send(res,400,{error:'Wybierz inną firmę rozładunku.'});
   if(!str(a.cargo,120)||!Number.isSafeInteger(plannedKm)||plannedKm<=0)return send(res,400,{error:'Podaj ładunek i planowany dystans w pełnych kilometrach.'});
   Object.assign(mapSetRoute,{mapSetFrom,mapSetTo});
  }
  const r={...mapSetRoute,...(offer?{offerId}:{}),id:crypto.randomUUID(),trailerId:trailerId||null,trailerType:trailerType||trailer?.type||null,freight,companyId:account.companyId,driver:account.username,from,to,fromCountry:str(a.fromCountry,80),toCountry:str(a.toCountry,80),cargo:str(a.cargo,120),sourceCompany:str(a.sourceCompany,120),destinationCompany:str(a.destinationCompany,120),cargoTons:Number(a.cargoTons)||0,payRate:(db.driverRates||{})[driver.toLowerCase()]??0.7,plannedKm,emptyKm,drivenKm:0,status:'Przydzielona',createdAt:new Date().toISOString()};
  db.routes??=[];db.routes.push(r);await save(db);return send(res,201,r);
 }
 if(u.pathname==='/api/routes/progress'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Sesja wygasła. Zaloguj się ponownie, aby zapisać trasę.'});
  if(!canAssignRoutes(req))return send(res,403,{error:'Zleceniami zarządza główny szef lub dyspozytor.'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.id);
  if(!r||(isSubcontractorBoss(req)&&r.companyId!==who(req).companyId))return send(res,404,{error:'Nie znaleziono trasy'});
  if(r.deliveredAt||r.settledAt||r.status==='Zakończona')return send(res,409,{error:'Dystans ukończonej trasy pochodzi z dostawy ETS2.'});
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
  if(!companyManager(req))return send(res,401,{error:'Wymagane logowanie szefa'});
  const companyId=who(req).companyId;
  const ledger=(db.ledger||[]).filter(x=>auth(req)||x.companyId===companyId),expenses=(db.expenses||[]).filter(x=>auth(req)||expenseCompany(db,x)===companyId);return send(res,200,{ledger,expenses,revenue:ledger.reduce((a,x)=>a+Number(x.amount||0),0),costs:expenses.reduce((a,x)=>a+Number(x.amount||0),0)});
 }
 if(u.pathname==='/api/expenses'&&method==='GET'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const me=who(req),mine=u.searchParams.get('mine')==='1';
  return send(res,200,(db.expenses||[]).filter(e=>!mine&&canDispatch(req)||expenseCompany(db,e)===me.companyId&&
   (!mine&&isSubcontractorBoss(req)||e.driver.toLowerCase()===me.username.toLowerCase())));
 }
 if(u.pathname==='/api/expenses'&&method==='POST'){
  if(!who(req))return send(res,401,{error:'Zaloguj się'});
  const a=await body(req),r=(db.routes||[]).find(x=>x.id===a.routeId);
  if(!r)return send(res,400,{error:'Wybierz istniejącą trasę'});
  if(!canDispatch(req)&&(r.companyId!==who(req).companyId||(!isSubcontractorBoss(req)&&r.driver.toLowerCase()!==who(req).username.toLowerCase())))return send(res,403,{error:'To nie jest Twoja trasa'});
  if(!['Paliwo','Opłata drogowa','Parking','Inne'].includes(a.type))return send(res,400,{error:'Nieprawidłowy rodzaj kosztu'});
  const amount=Number(a.amount);if(!Number.isFinite(amount)||amount<=0||amount>1000000)return send(res,400,{error:'Nieprawidłowa kwota'});
  const e={id:crypto.randomUUID(),routeId:r.id,vehicleId:r.vehicleId||null,companyId:r.companyId,driver:r.driver,type:a.type,country:str(a.country,80),from:str(a.from,120),to:str(a.to,120),place:str(a.place,120),liters:Number(a.liters)||0,amount,currency:'PLN',createdAt:new Date().toISOString()};
  db.expenses??=[];db.expenses.push(e);await save(db);return send(res,201,e);
 }
 if(u.pathname==='/api/admin/subcontractor-mileage'&&method==='GET'){
  if(!auth(req))return send(res,403,{error:'Tylko główny szef lub administrator'});
  const partners=(db.companies||[]).filter(c=>c.id!==MAIN_COMPANY_ID&&!c.archivedAt);
  const items=partners.map(company=>{
   const routes=(db.routes||[]).filter(r=>r.companyId===company.id);
   const completed=routes.filter(r=>r.settledAt||r.deliveredAt||r.status==='Zakończona');
   const km=rows=>Math.round(rows.reduce((sum,r)=>sum+Math.max(0,Number(r.drivenKm)||0),0)*10)/10;
   const drivers=new Map();
   for(const route of routes){
    const key=String(route.driver||'').trim().toLowerCase();if(!key)continue;
    const item=drivers.get(key)||{driver:route.driver,km:0,completedRoutes:0,allRoutes:0};
    item.km=Math.round((item.km+Math.max(0,Number(route.drivenKm)||0))*10)/10;
    item.allRoutes++;if(route.settledAt||route.deliveredAt||route.status==='Zakończona')item.completedRoutes++;
    drivers.set(key,item);
   }
   return {companyId:company.id,companyName:company.name,km:km(routes),completedKm:km(completed),
    completedRoutes:completed.length,allRoutes:routes.length,drivers:[...drivers.values()].sort((a,b)=>b.km-a.km)};
  });
  return send(res,200,{items,totals:{km:Math.round(items.reduce((sum,x)=>sum+x.km,0)*10)/10,
   completedKm:Math.round(items.reduce((sum,x)=>sum+x.completedKm,0)*10)/10,
   completedRoutes:items.reduce((sum,x)=>sum+x.completedRoutes,0)}});
 }
 if(u.pathname==='/api/companies'&&method==='GET')return send(res,200,db.companies.filter(c=>!c.archivedAt).map(({id,name,bases,open,logo})=>({id,name,bases,open,logo})));
 if(u.pathname==='/api/applications'&&method==='POST'){
  if(!rate(req,'apply',5))return send(res,429,{error:'Za dużo prób. Spróbuj później.'});
  const a=await body(req),c=db.companies.find(x=>x.id===a.companyId&&x.open);
  if(!c)return send(res,400,{error:'Ta firma nie prowadzi rekrutacji.'});
  const fullname=str(a.fullname,80),discord=str(a.discord,70),age=Number(a.age),hours=Number(a.hours);
  if(fullname.split(/\s+/).filter(part=>/\p{L}/u.test(part)).length<2||discord.length<2||!Number.isInteger(age)||age<13||age>99||!Number.isFinite(hours)||hours<0)return send(res,400,{error:'Uzupełnij wymagane pola.'});
  const photoUrl=str(a.photoUrl,1000);
  if(photoUrl){
   try{
    const url=new URL(photoUrl);
    if(url.protocol!=='https:'||url.username||url.password)throw Error();
   }catch{return send(res,400,{error:'Link do zdjęć musi być poprawnym adresem HTTPS.'})}
  }
  const x={id:crypto.randomUUID(),applicantId:who(req)?.id,companyId:c.id,companyName:c.name,fullname,discord,age,hours,photoUrl,experience:str(a.experience,1200),mapProfile:str(a.mapProfile,80),norm:str(a.norm),availability:str(a.availability,500),truck:str(a.truck,150),reason:str(a.reason,2000),date:new Date().toISOString(),status:'Nowe'};
  db.applications.push(x);await save(db);return send(res,201,{ok:true,id:x.id});
 }
 // Flota online: przypisania według ID konta, niezależne od lokalnych danych DEMO.
 if(u.pathname==='/api/fleet'&&method==='GET'){
  const me=who(req);if(!me)return send(res,401,{error:'Zaloguj się'});
  const fleet=db.fleet||[];
  if(u.searchParams.get('company')==='1'){
   if(!auth(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Brak dostępu do floty firmy'});
   return send(res,200,{fleet:fleet.filter(vehicle=>vehicle.companyId===me.companyId)});
  }
  if(isSubcontractorBoss(req)&&u.searchParams.get('mine')!=='1')return send(res,200,{fleet:fleet.filter(v=>v.companyId===me.companyId),drivers:[...accounts.values()].filter(a=>a.active&&a.companyId===me.companyId).map(safeAccount)});
  if(auth(req)&&u.searchParams.get('mine')!=='1')return send(res,200,{fleet,drivers:[...accounts.values()].filter(a=>a.active).map(safeAccount)});
  return send(res,200,{fleet:fleet.filter(v=>v.driverAccountId===me.id&&v.companyId===me.companyId)});
 }
 if(u.pathname==='/api/fleet'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),plate=str(a.plate,30).toUpperCase(),model=str(a.model,100),trailerPlate=str(a.trailerPlate,30).toUpperCase(),trailerModel=str(a.trailerModel,100),driverAccountId=str(a.driverAccountId,80),id=str(a.id,80);
  if(!plate||!model)return send(res,400,{error:'Podaj rejestrację i model ciągnika'});
  const acct=[...accounts.values()].find(x=>x.id===driverAccountId&&x.active);
  if(driverAccountId&&!acct)return send(res,400,{error:'Wybierz aktywne konto pracownika'});
  db.fleet??=[];
  if(db.fleet.some(x=>x.plate===plate&&x.id!==id))return send(res,409,{error:'Taka rejestracja już istnieje'});
  if(driverAccountId&&db.fleet.some(x=>x.driverAccountId===driverAccountId&&x.id!==id))return send(res,409,{error:'Ten kierowca ma już przypisany pojazd'});
  let v=id?db.fleet.find(x=>x.id===id):null;
  if(id&&!v)return send(res,404,{error:'Nie znaleziono pojazdu'});
  if(isSubcontractorBoss(req)){
   const companyId=who(req).companyId;
   if(!v||v.companyId!==companyId)return send(res,403,{error:'Wniosek o nowy ciągnik złóż w Mojej firmie. Tu przypiszesz własne pojazdy.'});
   if(acct&&acct.companyId!==companyId)return send(res,403,{error:'Wybierz kierowcę swojej firmy.'});
   if(v.plate!==plate||v.model!==model)return send(res,403,{error:'Możesz zmienić przypisanie ciągnika.'});
  }
  if(v?.purchasedAt&&acct&&acct.companyId!==v.companyId)return send(res,400,{error:'Wybierz kierowcę z firmy właściciela.'});
  if(!v){v={id:crypto.randomUUID()};db.fleet.push(v)}
  Object.assign(v,{plate,model,trailerPlate,trailerModel,driverAccountId:driverAccountId||'',driverUsername:acct?.username||'',companyId:(v.purchasedAt||isSubcontractorBoss(req))?v.companyId:acct?.companyId||MAIN_COMPANY_ID});
  await save(db);return send(res,200,v);
 }
 if(u.pathname.startsWith('/api/transport-documents')){
  const me=who(req),manager=companyManager(req);
  if(!me||(!manager&&!canDrive(req)))return send(res,403,{error:'Brak dostępu do dokumentów.'});
  const companyId=auth(req)?u.searchParams.get('companyId')||me.companyId:me.companyId;
  const routes=(db.routes||[]).filter(r=>r.companyId===companyId&&
   (manager||r.driver.toLowerCase()===me.username.toLowerCase())&&
   (r.deliveredAt||r.settledAt||r.status==='Zakończona'));
  const fleet=manager?[
   ...(db.fleet||[]).filter(v=>(v.companyId||MAIN_COMPANY_ID)===companyId),
   ...(db.trailers||[]).filter(v=>(v.ownerCompanyId||MAIN_COMPANY_ID)===companyId)
  ]:[];
  const company=db.companies.find(c=>c.id===companyId);
  if(!company)return send(res,404,{error:'Nie znaleziono firmy.'});
  if(u.pathname==='/api/transport-documents'&&method==='GET'){
   const routeIds=new Set(routes.map(r=>r.id));
   return send(res,200,{company:company.name,manager,routes:routes.map(({id,driver,from,to,sourceCompany,destinationCompany,cargo,cargoTons,deliveredAt,settledAt})=>
    ({id,driver,from,to,sourceCompany,destinationCompany,cargo,cargoTons,deliveredAt:deliveredAt||settledAt})),
    cmrs:(db.cmrDocuments||[]).filter(d=>routeIds.has(d.routeId)),
    registrations:manager?(db.fleet||[]).filter(v=>v.companyId===companyId&&v.registrationDueAt).map(({id,model,plate,previousPlate,registrationDueAt,registeredAt})=>({id,model,plate,previousPlate,registrationDueAt,registeredAt})):[],
    fleet:fleet.map(({id,plate,model})=>({id,plate,model})),
    permits:manager?(db.vehiclePermits||[]).filter(d=>d.companyId===companyId):[],
    inspections:manager?(db.vehicleInspections||[]).filter(d=>d.companyId===companyId):[]});
  }
  if(u.pathname==='/api/transport-documents/registration'&&method==='POST'){
   if(!manager)return send(res,403,{error:'Przerejestrowanie zapisuje szef firmy.'});
   const a=await body(req),plate=str(a.plate,30).toUpperCase().replace(/\s+/g,' ');
   const vehicle=(db.fleet||[]).find(v=>v.id===a.vehicleId&&v.companyId===companyId&&v.registrationDueAt);
   if(!vehicle)return send(res,404,{error:'Wybierz ciągnik z zatwierdzonego wniosku swojej firmy.'});
   if(vehicle.registeredAt)return send(res,409,{error:'Pojazd został już przerejestrowany.'});
   const key=value=>String(value||'').toUpperCase().replace(/[\s-]/g,'');
   if(!/^[A-Z0-9][A-Z0-9 -]{2,14}$/.test(plate)||key(plate)===key(vehicle.plate))return send(res,400,{error:'Wpisz nową rejestrację.'});
   if((db.fleet||[]).some(v=>key(v.plate)===key(plate)||key(v.trailerPlate)===key(plate))||
      (db.trailers||[]).some(v=>key(v.plate)===key(plate)))return send(res,409,{error:'Ta rejestracja jest już zajęta.'});
   Object.assign(vehicle,{previousPlate:vehicle.plate,plate,registeredAt:new Date().toISOString(),registeredBy:me.username});
   await save(db);
   return send(res,200,vehicle);
  }
  if(u.pathname==='/api/transport-documents/cmr'&&method==='POST'){
   const a=await body(req),route=routes.find(r=>r.id===a.routeId);
   if(!route)return send(res,404,{error:'Nie znaleziono zakończonej dostawy.'});
   const existing=(db.cmrDocuments||[]).find(d=>d.routeId===route.id);
   if(existing)return send(res,409,{error:'Ta dostawa ma już zapisany CMR.'});
   const receiver=str(a.receiver,140),receivedDate=str(a.receivedDate,10);
   const result=str(a.result,20),notes=str(a.notes,1000);
   if(!receiver||!validDate(receivedDate)||!['ok','remarks'].includes(result)||(result==='remarks'&&!notes)){
    return send(res,400,{error:'Podaj odbiorcę, datę i wynik odbioru. Wpisz uwagi, jeśli zgłoszono zastrzeżenia.'});
   }
   const document={routeId:route.id,companyId,number:'CMR-'+route.id.toUpperCase(),receiver,receivedDate,result,notes,
    carrier:company.name,driver:route.driver,sender:str(a.sender,200)||route.sourceCompany,
    consignee:str(a.consignee,200)||route.destinationCompany,from:route.from,to:route.to,
    cargo:route.cargo,cargoTons:route.cargoTons,packages:str(a.packages,150),plate:str(a.plate,30).toUpperCase(),
    trailerPlate:str(a.trailerPlate,30).toUpperCase(),createdBy:me.username,createdAt:new Date().toISOString()};
   (db.cmrDocuments??=[]).push(document);
   await save(db);
   return send(res,201,document);
  }
  if(u.pathname==='/api/transport-documents/permit'&&method==='POST'){
   if(!manager)return send(res,403,{error:'Dokumenty floty wpisuje szef firmy.'});
   const a=await body(req),vehicle=fleet.find(v=>v.id===a.vehicleId);
   if(!vehicle)return send(res,404,{error:'Wybierz pojazd z floty firmy.'});
   const kind=str(a.kind,20),type=str(a.type,80),issuer=str(a.issuer,150),reference=str(a.reference,100);
   const starts=str(a.starts,10),ends=str(a.ends,10),notes=str(a.notes,500);
   if(!['insurance','vignette'].includes(kind)||!type||!issuer||!reference||!validDate(starts)||!validDate(ends)||ends<starts){
    return send(res,400,{error:'Uzupełnij rodzaj, ubezpieczyciela lub kraj, numer dokumentu i poprawne daty ważności.'});
   }
   const records=db.vehiclePermits??=[];
   if(records.some(d=>d.vehicleId===vehicle.id&&d.companyId===companyId&&d.kind===kind&&
      d.issuer.toLowerCase()===issuer.toLowerCase()&&d.reference.toLowerCase()===reference.toLowerCase())){
    return send(res,409,{error:'Taki dokument jest już zapisany dla tego pojazdu.'});
   }
   const record={id:crypto.randomUUID(),vehicleId:vehicle.id,companyId,plate:vehicle.plate,model:vehicle.model,
    kind,type,issuer,reference,starts,ends,notes,createdBy:me.username,createdAt:new Date().toISOString()};
   records.push(record);
   await save(db);
   return send(res,201,record);
  }
  if(u.pathname==='/api/transport-documents/inspection'&&method==='POST'){
   if(!manager)return send(res,403,{error:'Przeglądy wpisuje szef firmy.'});
   const a=await body(req),vehicle=fleet.find(v=>v.id===a.vehicleId);
   if(!vehicle)return send(res,404,{error:'Wybierz pojazd z floty firmy.'});
   const date=str(a.date,10),nextDate=str(a.nextDate,10),result=str(a.result,15),notes=str(a.notes,1000),station=str(a.station,150);
   if(!validDate(date)||(nextDate&&(!validDate(nextDate)||nextDate<date))||!['ok','failed'].includes(result)||
      (result==='ok'&&!nextDate)||(!notes&&result==='failed')||!station){
    return send(res,400,{error:'Sprawdź daty i podaj stację, wynik oraz usterki przy wyniku negatywnym.'});
   }
   const mileage=a.mileage===''||a.mileage===undefined?null:Number(a.mileage);
   if(mileage!==null&&(!Number.isSafeInteger(mileage)||mileage<0||mileage>99999999))return send(res,400,{error:'Nieprawidłowy przebieg pojazdu.'});
   const inspection={id:crypto.randomUUID(),vehicleId:vehicle.id,companyId,plate:vehicle.plate,model:vehicle.model,
    date,nextDate,result,notes,station,mileage,reference:str(a.reference,100),createdBy:me.username,createdAt:new Date().toISOString()};
   (db.vehicleInspections??=[]).push(inspection);
   await save(db);
   return send(res,201,inspection);
  }
  return send(res,404,{error:'Nie znaleziono.'});
 }
 if(u.pathname==='/api/company/trailer-license'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const a=await body(req),me=who(req);
  const licenses=db.trailerLicenses??={};
  if(a.decision){
   if(!auth(req))return send(res,403,{error:'Licencje rozpatruje główny szef lub administrator.'});
   const license=Object.hasOwn(licenses,a.companyId)?licenses[a.companyId]:null;
   if(!license||license.status!=='pending')return send(res,409,{error:'Brak oczekującego wniosku.'});
   if(!['approved','rejected'].includes(a.decision))return send(res,400,{error:'Wybierz decyzję.'});
   if(a.decision==='approved'){
    const companyId=a.companyId;
    if(!db.companies.some(c=>c.id===companyId)||companyId===MAIN_COMPANY_ID)return send(res,400,{error:'Wybierz firmę podwykonawcy.'});
    const budget=db.startupFinance?.[companyId]?.initialCents??(pool
     ?(await pool.query('SELECT initial_cents FROM ks_company_budget WHERE company_id=$1',[companyId])).rows[0]?.initial_cents
     :db.initialBudgets?.[companyId]?.initialCents);
    const {income,costs}=companyCashFlow(db,companyId);
    if(budget==null||Number(budget)+income-costs<17000000)return send(res,409,{error:'Firma nie ma wystarczających środków na licencję (170 000 zł).'});
    (db.ledger??=[]).push({id:crypto.randomUUID(),companyId,type:'licencja_naczepy',
     description:'Licencja na własne naczepy · opłata jednorazowa',amount:-170000,createdAt:new Date().toISOString(),licenseId:license.id});
    license.paidAmount=170000;
    license.paidAt=new Date().toISOString();
   }
   Object.assign(license,{status:a.decision,decidedBy:me.username,decidedAt:new Date().toISOString()});
   await save(db);return send(res,200,license);
  }
  const previous=Object.hasOwn(licenses,me.companyId)?licenses[me.companyId]:null;
  if(previous&&previous.status!=='rejected')return send(res,409,{error:'Firma ma już licencję albo oczekujący wniosek.'});
  const license={id:crypto.randomUUID(),status:'pending',price:170000,reason:str(a.reason,500),submittedBy:me.username,createdAt:new Date().toISOString()};
  Object.defineProperty(licenses,me.companyId,{value:license,enumerable:true,writable:true,configurable:true});
  await save(db);return send(res,201,license);
 }
 if(u.pathname==='/api/company/management'&&method==='GET'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const companyId=u.searchParams.get('companyId')||who(req).companyId;
  if(companyId!==who(req).companyId&&!auth(req))return send(res,403,{error:'Brak dostępu do tej firmy.'});
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Nie znaleziono firmy.'});
  const expenses=(db.expenses||[]).filter(x=>expenseCompany(db,x)===companyId);
  const charges=(db.ledger||[]).filter(x=>x.companyId===companyId&&x.amount<0);
  return send(res,200,{
   expenses:[...expenses.map(x=>({...x,amount:-x.amount})),...charges].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))),
   fleet:(db.fleet||[]).filter(x=>(x.companyId||MAIN_COMPANY_ID)===companyId),
   trailers:(db.trailers||[]).filter(x=>(x.ownerCompanyId||MAIN_COMPANY_ID)===companyId),
   drivers:(db.accounts||[]).filter(x=>x.companyId===companyId&&employee(x)).map(safeAccount),
   trailerLicense:Object.hasOwn(db.trailerLicenses||{},companyId)?db.trailerLicenses[companyId]:null,
   accessoryRequests:(db.shopOrders||[]).filter(o=>o.category==='lights'&&(o.companyId||accounts.get(o.driver)?.companyId||MAIN_COMPANY_ID)===companyId),
   requests:(db.vehicleRequests||[]).filter(x=>x.companyId===companyId),
  });
 }
 if(u.pathname==='/api/company/charge'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko główny szef lub administrator'});
  const a=await body(req),description=str(a.description,500),type=str(a.type,20);
  const cents=priceCents(a.amount);
  if(!db.companies.some(c=>c.id===a.companyId))return send(res,404,{error:'Nie znaleziono firmy.'});
  if(!['kara','mandat'].includes(type)||!description||!cents)return send(res,400,{error:'Podaj rodzaj obciążenia, kwotę i powód.'});
  const charge={id:crypto.randomUUID(),companyId:a.companyId,type,description,amount:-cents/100,createdBy:who(req).username,createdAt:new Date().toISOString()};
  (db.ledger??=[]).push(charge);
  await save(db);
  return send(res,201,charge);
 }
 if(u.pathname==='/api/company/fleet-expense'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const a=await body(req),companyId=who(req).companyId,description=str(a.description,500),invoiceNumber=str(a.invoiceNumber,100);
  const cents=priceCents(a.amount);
  const vehicle=(db.fleet||[]).find(x=>x.id===a.vehicleId&&(x.companyId||MAIN_COMPANY_ID)===companyId)
   ||(db.trailers||[]).find(x=>x.id===a.vehicleId&&(x.ownerCompanyId||MAIN_COMPANY_ID)===companyId);
  if(!vehicle)return send(res,404,{error:'Wybierz pojazd swojej firmy.'});
  if(!cents||!description)return send(res,400,{error:'Podaj opis i kwotę wydatku.'});
  const expense={id:crypto.randomUUID(),vehicleId:vehicle.id,companyId,type:'wyposażenie floty',description,
   invoiceNumber,plate:vehicle.plate,amount:-cents/100,createdBy:who(req).username,createdAt:new Date().toISOString()};
  expense.invoice={number:invoiceNumber||'DOD-'+expense.id.toUpperCase(),companyId,company:db.companies.find(c=>c.id===companyId)?.name,
   name:description,quantity:1,unitPrice:cents/100,total:cents/100,plate:vehicle.plate,createdAt:expense.createdAt,approvedBy:who(req).username};
  (db.ledger??=[]).push(expense);
  await save(db);
  return send(res,201,expense);
 }
 if(u.pathname==='/api/company/employment'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  const a=await body(req),companyId=a.companyId||who(req).companyId;
  if(companyId!==who(req).companyId&&!auth(req))return send(res,403,{error:'Brak dostępu do tej firmy.'});
  const account=(db.accounts||[]).find(x=>x.id===a.id&&x.companyId===companyId&&employee(x));
  if(!account)return send(res,404,{error:'Nie znaleziono konta kierowcy w tej firmie.'});
  if(!['hire','dismiss'].includes(a.action))return send(res,400,{error:'Wybierz zatrudnienie lub zwolnienie.'});
  const hiring=a.action==='hire';
  if(hiring===account.active)return send(res,409,{error:'Status kierowcy już się zmienił.'});
  if(hiring&&!account.pendingHire&&!account.dismissedAt)return send(res,403,{error:'Konto jest zablokowane administracyjnie.'});
  account.active=hiring;
  if(!hiring){
   account.dismissedAt=new Date().toISOString();
   revokeAccountSessions(db,account.id);
   for(const vehicle of db.fleet||[]){
    if(vehicle.driverAccountId===account.id)Object.assign(vehicle,{driverAccountId:'',driverUsername:''});
   }
   for(const trailer of db.trailers||[]){
    if(trailer.assigneeId===account.id)Object.assign(trailer,{assigneeId:'',assigneeUsername:'',assigneeRole:''});
   }
  }else{
   delete account.dismissedAt;
   delete account.pendingHire;
  }
  await save(db);
  accounts.set(account.username.toLowerCase(),account);
  return send(res,200,safeAccount(account));
 }
 if(['/api/company/vehicle-requests','/api/fleet/buy'].includes(u.pathname)&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});
  if(u.pathname==='/api/fleet/buy')return send(res,409,{error:'Złóż wniosek w zakładce Moja firma.'});
  const a=await body(req),companyId=who(req).companyId;
  if(!db.companies.some(c=>c.id===companyId))return send(res,404,{error:'Nie znaleziono firmy.'});
  if(a.kind==='trailer'&&companyId!==MAIN_COMPANY_ID&&
     (!Object.hasOwn(db.trailerLicenses||{},companyId)||db.trailerLicenses[companyId].status!=='approved')){
   return send(res,403,{error:'Firma potrzebuje zatwierdzonej licencji na własne naczepy.'});
  }
  const kind=str(a.kind,10),financing=str(a.financing,10),brand=str(a.brand,60),model=str(a.model,100);
  const chassis=str(a.chassis,10),color=str(a.color,60),emission=kind==='truck'?str(a.emission,10):'';
  const mileage=Number(a.mileage),amount=priceCents(a.amount),listing=str(a.listing,2048);
  const plate=financing==='cash'?str(a.plate,30).toUpperCase():'';
  const bankCity=financing==='lease'?str(a.bankCity,100):'';
  const downPayment=financing==='lease'?priceCents(a.downPayment):amount;
  const trailerType=kind==='trailer'?str(a.trailerType,20):'';
  if(!['truck','trailer'].includes(kind)||!['cash','lease'].includes(financing)||!brand||!model||
     !['mega','standard'].includes(chassis)||!color||!/^\d{1,8}$/.test(a.mileage)||!amount||!httpsLink(listing)||
     (kind==='truck'&&!['Euro 5','Euro 6'].includes(emission))||
     (kind==='trailer'&&!['firanka','chlodnia','platforma','kontener','inna'].includes(trailerType))||
     (financing==='cash'&&!plate)||(financing==='lease'&&(!bankCity||downPayment===null||downPayment>amount))){
   return send(res,400,{error:'Uzupełnij dane pojazdu, cenę, link HTTPS i dane finansowania.'});
  }
  const request={id:crypto.randomUUID(),companyId,kind,financing,brand,model,chassis,color,emission,mileage,amount,listing,plate,
   bankCity,downPayment,trailerType,seller:str(a.seller,120),year:str(a.year,4),vin:str(a.vin,25).toUpperCase(),
   lessor:financing==='lease'?str(a.lessor,120):'',description:str(a.description,500),status:'pending',submittedBy:who(req).username,createdAt:new Date().toISOString()};
  (db.vehicleRequests??=[]).push(request);
  await save(db);
  return send(res,201,request);
 }
 if(u.pathname==='/api/company/vehicle-requests/decide'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Wnioski rozpatruje główny szef lub administrator.'});
  const a=await body(req),request=(db.vehicleRequests||[]).find(x=>x.id===a.id);
  if(!request)return send(res,404,{error:'Nie znaleziono wniosku.'});
  if(request.status!=='pending')return send(res,409,{error:'Wniosek został już rozpatrzony.'});
  if(!['approved','rejected'].includes(a.status))return send(res,400,{error:'Wybierz decyzję.'});
  const createdAt=new Date().toISOString(),decisionNote=str(a.note,500);
  if(a.status==='rejected'&&!decisionNote)return send(res,400,{error:'Podaj powód odrzucenia.'});
  if(a.status==='approved'){
   const {companyId,kind,financing,model,description}=request;
   const host=new URL(request.listing).hostname;
   const autoline=/(^|\.)autoline\.[a-z.]+$/i.test(host);
   let downPayment=request.downPayment;
   if(financing==='cash'&&(autoline||a.listingPrice)){
    const price=priceCents(a.listingPrice);
    if(!price||!['PLN','EUR'].includes(a.listingCurrency))return send(res,400,{error:'Sprawdź ogłoszenie i wpisz cenę oraz walutę.'});
    downPayment=Math.round(price*(a.listingCurrency==='EUR'?EURO_PLN:1));
   }
   const plate=financing==='lease'?str(a.plate,30).toUpperCase():request.plate;
   if(!plate)return send(res,400,{error:'Wpisz rejestrację z miasta banku lub leasingodawcy.'});
   if([...(db.fleet||[]),...(db.trailers||[])].some(x=>x.plate===plate))return send(res,409,{error:'Ta rejestracja jest już we flocie.'});
   const budget=db.startupFinance?.[companyId]?.initialCents??(pool
    ?(await pool.query('SELECT initial_cents FROM ks_company_budget WHERE company_id=$1',[companyId])).rows[0]?.initial_cents
    :db.initialBudgets?.[companyId]?.initialCents);
   const {income,costs}=companyCashFlow(db,companyId);
   if((budget==null&&!db.companyLoans?.[companyId])||Number(budget??0)+income-costs<downPayment)return send(res,409,{error:'Firma nie ma budżetu startowego lub wystarczających środków.'});
   const vehicle={id:crypto.randomUUID(),requestId:request.id,model,plate,description,brand:request.brand,chassis:request.chassis,
    color:request.color,emission:request.emission,mileage:request.mileage,financing,purchasedAt:createdAt};
   if(kind==='truck'){
    const registrationDueAt=companyId!==MAIN_COMPANY_ID&&financing==='cash'
     ?new Date(Date.parse(createdAt)+7*86400000).toISOString():undefined;
    (db.fleet??=[]).push({...vehicle,companyId,registrationDueAt,driverAccountId:'',driverUsername:''});
   }else{
    (db.trailers??=[]).push({...vehicle,ownerCompanyId:companyId,type:request.trailerType,createdAt,updatedAt:createdAt,assigneeId:'',assigneeUsername:''});
   }
   if(downPayment>0)(db.ledger??=[]).push({id:crypto.randomUUID(),vehicleId:vehicle.id,companyId,
    type:financing==='lease'?'wpłata leasingowa':'zakup_pojazdu',description:[model,plate,description].filter(Boolean).join(' · '),amount:-downPayment/100,createdAt});
   Object.assign(request,{plate,vehicleId:vehicle.id,downPayment});
   if(financing==='cash')request.amount=downPayment;
  }
  Object.assign(request,{status:a.status,decisionNote,decidedBy:who(req).username,decidedAt:createdAt});
  await save(db);
  return send(res,200,request);
 }
 if(u.pathname==='/api/fleet/sales'&&method==='GET'){
  if(!companyManager(req))return send(res,403,{error:'Historia sprzedaży jest dostępna dla szefów.'});
  const companyId=who(req).companyId;
  return send(res,200,{sales:(db.fleetSales||[]).filter(x=>auth(req)||x.companyId===companyId).slice().reverse()});
 }
 if(u.pathname==='/api/fleet/sell'&&method==='POST'){
  if(!companyManager(req))return send(res,403,{error:'Sprzedaż jest dostępna dla szefa firmy.'});
  const {id,amount,buyer:buyerInput}=await body(req),buyer=str(buyerInput,120);
  if(typeof amount!=='string'||!/^(0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0)return send(res,400,{error:'Podaj cenę sprzedaży w PLN.'});
  const allowed=vehicle=>auth(req)||(vehicle.companyId||MAIN_COMPANY_ID)===who(req).companyId;
  const index=(db.fleet||[]).findIndex(vehicle=>vehicle.id===id&&allowed(vehicle));
  if(index<0){
   const previous=(db.fleetSales||[]).find(vehicle=>vehicle.id===id&&allowed(vehicle));
   if(previous&&previous.price===Number(amount))return send(res,200,{ok:true,duplicate:true,price:previous.price,companyId:previous.companyId,sale:previous});
   return send(res,404,{error:'Pojazdu nie ma we flocie Twojej firmy lub został już sprzedany.'});
  }
  const vehicle=db.fleet[index],companyId=vehicle.companyId||MAIN_COMPANY_ID;
  const leases=(db.fleetLeases||[]).filter(l=>l.vehicleId===vehicle.id&&l.companyId===companyId);
  if((vehicle.financing==='lease'&&!leases.length)||leases.some(l=>!l.schedule?.length||l.schedule.some(p=>p.status!=='paid')))return send(res,409,{error:'Najpierw spłać leasing pojazdu. Nie można sprzedać auta z niespłaconym leasingiem.'});
  const active=(db.routes||[]).some(r=>r.companyId===companyId&&!r.deliveredAt&&!r.settledAt&&r.status!=='Zakończona'&&(r.acceptedAt||r.status==='W trasie')&&
   (r.vehicleId===vehicle.id||(!r.vehicleId&&vehicle.driverUsername&&r.driver?.toLowerCase()===vehicle.driverUsername.toLowerCase())));
  if(active)return send(res,409,{error:'Pojazd obsługuje aktywną trasę. Zakończ kurs przed sprzedażą.'});
  const soldAt=new Date().toISOString(),price=Number(amount);
  const sale={...vehicle,companyId,soldAt,price,buyer,saleId:crypto.randomUUID(),soldBy:who(req).username};
  db.fleetSales??=[];db.ledger??=[];db.fleetSales.push(sale);
  db.ledger.push({id:crypto.randomUUID(),vehicleId:vehicle.id,saleId:sale.saleId,companyId,type:'sprzedaz_pojazdu',description:vehicle.model+' · '+vehicle.plate+(buyer?' · '+buyer:''),amount:price,createdAt:soldAt});
  for(const job of db.maintenance||[])if(job.companyId===companyId&&job.vehicleId===vehicle.id&&job.status==='planned')Object.assign(job,{status:'cancelled',cancelledAt:soldAt,cancelReason:'Sprzedaż pojazdu'});
  for(const policy of db.fleetPolicies||[])if(policy.companyId===companyId&&policy.vehicleId===vehicle.id&&!policy.paid)policy.cancelledAt=soldAt;
  db.fleet.splice(index,1);await save(db);
  return send(res,200,{ok:true,price,companyId,sale});
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
  if(typeof next!=='string'||next.length<6||next.length>300||next!==next.trim())return send(res,400,{error:'Nowe hasło musi mieć od 6 do 300 znaków, bez spacji na początku i końcu.'});
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
  if(!/^[a-zA-Z0-9._-]{3,50}$/.test(username)||pass.length<6||!ROLES.includes(role))return send(res,400,{error:'Login: 3–50 znaków, hasło min. 6 znaków, poprawna rola'});
  if(role==='admin'&&who(req).role!=='admin')return send(res,403,{error:'Tylko administrator może utworzyć konto administratora'});
  if(!db.companies.some(company=>company.id===companyId))return send(res,400,{error:'Wybierz istniejącą firmę.'});
  if(role==='subcontractor'&&companyId===MAIN_COMPANY_ID)return send(res,400,{error:'Wybierz firmę podwykonawcy.'});
  const key=username.toLowerCase(),previous=accounts.get(key);
  if(previous&&!previous.deletedAt)return send(res,409,{error:'Login zajęty'});
  const pendingHire=['driver','probation'].includes(role)&&a.pendingHire===true;
  const acct={id:crypto.randomUUID(),username,role,pendingHire,dispatchAccess:['driver','probation'].includes(role)&&a.dispatchAccess===true,companyId,active:!pendingHire,...passwordHash(pass)};
  if(previous)archiveDeletedLogin(db,previous);
  db.accounts=[...accounts.values()].filter(account=>account.id!==previous?.id);
  db.accounts.push(acct);
  await save(db);
  accounts.set(key,acct);
  return send(res,201,safeAccount(acct));
 }
 if(u.pathname==='/api/accounts/update'&&method==='POST'){
  if(!auth(req))return send(res,403,{error:'Tylko administrator'});
  const a=await body(req),acct=accounts.get(str(a.username,50).toLowerCase());
  if(!acct||acct.deletedAt)return send(res,404,{error:'Nie znaleziono konta'});
  if(who(req).role!=='admin'&&(acct.role==='admin'||a.role==='admin'))return send(res,403,{error:'Tylko administrator może zarządzać kontami administratorów'});
  if(a.active===false&&(acct.role==='admin'||acct.id===who(req).id))return send(res,400,{error:'Nie można zablokować administratora ani własnego konta'});
  if(a.password!==undefined&&(typeof a.password!=='string'||a.password.length<6||a.password.length>300))return send(res,400,{error:'Hasło min. 6 znaków'});
  if(a.companyId!==undefined){
   const companyId=str(a.companyId,80);
   if(!db.companies.some(company=>company.id===companyId))return send(res,400,{error:'Wybierz istniejącą firmę.'});
   if(a.role!==undefined||['admin','boss','subcontractor'].includes(acct.role))return send(res,403,{error:'Przeniesienie firmy jest dostępne dla kont pracowników.'});
   acct.companyId=companyId;
  }
  if(typeof a.active==='boolean'){
   acct.active=a.active;
   delete acct.pendingHire;
   delete acct.dismissedAt;
  }
  if(a.password!==undefined)Object.assign(acct,passwordHash(a.password));
  if(a.role!==undefined&&ROLES.includes(a.role)&&acct.role!=='admin')acct.role=a.role;
  if(!['driver','probation'].includes(acct.role))delete acct.dispatchAccess;
  else if(typeof a.dispatchAccess==='boolean')acct.dispatchAccess=a.dispatchAccess;
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
  const recruiter=isSubcontractorBoss(req)&&u.pathname==='/api/admin/applications';
  if(!auth(req)&&!recruiter&&!subcontractorCompanySettings)return send(res,401,{error:'Zaloguj się jako administrator.'});
  if(u.pathname==='/api/admin/applications'&&method==='GET'){
   const cutoff=Date.now()-24*60*60*1000;
   return send(res,200,db.applications.filter(x=>(!recruiter||x.companyId===who(req).companyId)&&(x.status!=='Przyjęte'||!(Date.parse(x.acceptedAt||x.date)<=cutoff))));
  }
  if(u.pathname==='/api/admin/companies'&&method==='GET')return send(res,200,db.companies.filter(company=>!company.archivedAt&&(!subcontractorCompanySettings||company.id===who(req).companyId)));
  if(u.pathname==='/api/admin/companies'&&method==='DELETE'){
   if(!auth(req))return send(res,403,{error:'Tylko główny szef może usunąć firmę podwykonawczą.'});
   const a=await body(req),company=db.companies.find(c=>c.id===a.id&&!c.archivedAt);
   if(!company)return send(res,404,{error:'Nie znaleziono aktywnej firmy.'});
   if(company.id===MAIN_COMPANY_ID||company.id===LEGACY_COMPANY_ID)return send(res,403,{error:'Nie można usunąć firmy głównej.'});
   if(a.confirmName!==company.name)return send(res,400,{error:'Potwierdź usunięcie dokładną nazwą firmy.'});
   company.archivedAt=new Date().toISOString();company.open=false;
   for(const account of db.accounts||[]){
    if(account.companyId===company.id){account.active=false;revokeAccountSessions(db,account.id)}
   }
   await save(db);return send(res,200,{ok:true,companyId:company.id,archived:true});
  }
  if(u.pathname==='/api/admin/applications'&&method==='PATCH'){
   const a=await body(req),x=db.applications.find(x=>x.id===a.id);
   if(!x||(recruiter&&x.companyId!==who(req).companyId))return send(res,404,{error:'Nie znaleziono podania'});
   if(recruiter&&(!['Przyjęte','Odrzucone'].includes(a.status)||(x.status!=='Nowe'&&x.status!==a.status)||Object.hasOwn(a,'companyId')))return send(res,403,{error:'Możesz przyjąć lub odrzucić nowe podanie wyłącznie do własnej firmy.'});
   if(a.status&&!['Nowe','Przyjęte','Odrzucone'].includes(a.status))return send(res,400,{error:'Niepoprawny status'});
   if(a.companyId&&!db.companies.some(c=>c.id===a.companyId))return send(res,400,{error:'Nieznana firma'});
   if(a.status&&x.status!==a.status){
    x.status=a.status;x.decidedAt=new Date().toISOString();x.decidedBy=who(req).username;
    if(a.status==='Przyjęte')x.acceptedAt=new Date().toISOString();
    else delete x.acceptedAt;
   }
   if(a.companyId){x.companyId=a.companyId;x.companyName=db.companies.find(c=>c.id===a.companyId).name}await save(db);return send(res,200,x);
  }
  if(u.pathname==='/api/admin/companies'&&method==='POST'){
   const a=await body(req),name=str(a.name,90);if(name.length<2)return send(res,400,{error:'Podaj nazwę firmy'});
   const id=str(a.id,80)||crypto.randomUUID();
   if(id.toLowerCase()===LEGACY_COMPANY_ID||id.toLowerCase()===MAIN_COMPANY_ID||db.companies.some(company=>company.id.toLowerCase()===id.toLowerCase()))return send(res,409,{error:'Identyfikator firmy jest zajęty.'});
   const x={id,name,bases:[str(a.city,90)||'Nie podano'],open:true,logo:''};db.companies.push(x);await save(db);return send(res,201,x);
  }
  if(u.pathname==='/api/admin/companies'&&method==='PATCH'){
   const a=await body(req),x=db.companies.find(c=>c.id===a.id);if(!x||(subcontractorCompanySettings&&x.id!==who(req).companyId))return send(res,404,{error:'Brak firmy'});
   if(typeof a.open==='boolean')x.open=a.open;
   if(Array.isArray(a.bases))x.bases=a.bases.map(y=>str(y,90)).filter(Boolean).slice(0,12);
   if(typeof a.logo==='string'&&(/^data:image\/(png|jpeg|webp);base64,[\w+/=]+$/.test(a.logo)&&a.logo.length<120000||a.logo===''))x.logo=a.logo;
   await save(db);return send(res,200,x);
  }
  return send(res,404,{error:'Nie znaleziono'});
 }
 if(method!=='GET')return send(res,405,{error:'Metoda niedozwolona'});
 const homePath=auth(req)?'/system.html':isSubcontractorBoss(req)?'/firma.html':canDispatch(req)?'/spedytor.html':canDrive(req)?'/moj-panel.html':'/system-login.html';
 if(['/','/system','/index.html','/login.html'].includes(u.pathname)||(u.pathname==='/system-login.html'&&homePath!==u.pathname)){
  res.writeHead(302,{Location:homePath,'Cache-Control':'no-store'});return res.end();
 }
 if(u.pathname==='/admin.html'&&!auth(req)&&!isSubcontractorBoss(req)){
  if(who(req))return send(res,403,{error:'Panel rekrutacji jest dostępny dla kierownictwa.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/centrum-floty.html'&&!canDispatch(req)&&!isSubcontractorBoss(req)){
  if(who(req))return send(res,403,{error:'Mapa floty jest dostępna dla dyspozytorni.'});
  res.writeHead(302,{Location:'/system-login.html'});return res.end();
 }
 if(u.pathname==='/gielda.html'&&!canDispatch(req)&&!isSubcontractorBoss(req)){
  res.writeHead(302,{Location:homePath,'Cache-Control':'no-store'});return res.end();
 }
 if(u.pathname==='/system.html' && !auth(req)){res.writeHead(302,{Location:homePath});return res.end()}
 if(['/driver.html','/moj-panel.html','/spedytor.html','/uzytkownicy.html','/trasy.html','/flota-online.html','/firma.html','/budzety.html','/ekonomia.html','/finanse-floty.html'].includes(u.pathname)){const me=who(req);if(!me){res.writeHead(302,{Location:'/system-login.html'});return res.end()}if(u.pathname==='/finanse-floty.html'&&!companyManager(req))return send(res,403,{error:'Tylko szef firmy'});if(u.pathname==='/budzety.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(['/flota-online.html','/firma.html'].includes(u.pathname)&&!canDispatch(req)&&!isSubcontractorBoss(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/uzytkownicy.html'&&!auth(req))return send(res,403,{error:'Tylko administrator'});if(u.pathname==='/spedytor.html'&&!canDispatch(req))return send(res,403,{error:'Tylko spedytor'});if(u.pathname==='/trasy.html'&&!canDispatch(req)&&!isSubcontractorBoss(req)){if(!canDrive(req))return send(res,403,{error:'Brak dostępu do zleceń'});res.writeHead(302,{Location:'/moj-panel.html#routes'});return res.end()}if(['/driver.html','/moj-panel.html'].includes(u.pathname)&&!canDrive(req))return send(res,403,{error:'Tylko kierowca'});}
 if(u.pathname==='/biuro-zarzadu.html'&&!companyManager(req)){if(!who(req)){res.writeHead(302,{Location:'/system-login.html'});return res.end()}return send(res,403,{error:'Biuro zarządu jest dostępne tylko dla szefów.'})}
 let file=u.pathname==='/system.html'?'index.html':u.pathname==='/driver.html'?'moj-panel.html':u.pathname.slice(1);
 if(file==='podwykonawcy.html'){
  if(!auth(req))return send(res,403,{error:'Tylko główny szef lub administrator'});
  file='firma.html';
 }
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
}catch(e){if(res.destroyed)return;console.error(e);if(!res.headersSent)send(res,500,{error:'Błąd serwera'})}finally{release?.()}});
async function financeTick(){const previous=mutationTail;let release;mutationTail=new Promise(resolve=>{release=resolve});await previous;try{const db=await load();if(pool){const budgets=await pool.query('SELECT company_id,initial_cents FROM ks_company_budget');db.initialBudgets=Object.fromEntries(budgets.rows.map(x=>[x.company_id,{initialCents:Number(x.initial_cents)}]))}if(fleetFinance.processDue(db))await save(db)}catch(error){console.error('Finanse floty:',error)}finally{release()}}
initStore().then(async()=>{if(accounts.size===0){const acct={id:crypto.randomUUID(),username:process.env.ADMIN_LOGIN||'admin',role:'admin',companyId:MAIN_COMPANY_ID,active:true,...passwordHash(password)};accounts.set(acct.username.toLowerCase(),acct);const d=await load();d.accounts=[acct];await save(d)}return true}).then(()=>server.listen(PORT,'0.0.0.0',()=>{console.log('Nowaczyk Transport Online: http://0.0.0.0:'+PORT);financeTick();setInterval(financeTick,60*60*1000).unref()})).catch(e=>{console.error('Błąd połączenia z bazą:',e.message);process.exit(1)});

