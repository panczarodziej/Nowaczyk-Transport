'use strict';
const {app,BrowserWindow,ipcMain,dialog,Tray,Menu,nativeImage,session,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http');
function resourcePath(...parts){return path.join(app.isPackaged?process.resourcesPath:__dirname,...parts)}
let readerError='';
let lastTelemetry=null; let bridgeServer=null; let readerProcess=null; const pendingEvents=[];
// Kolejka zdarzen zapisana na dysku: restart aplikacji nie gubi dostaw.
function eventQueuePath(){return path.join(app.getPath('userData'),'telemetry-events.json')}
function persistEvents(){try{const f=eventQueuePath();fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=f+'.tmp';fs.writeFileSync(tmp,JSON.stringify(pendingEvents.slice(-500)));fs.renameSync(tmp,f)}catch(e){console.error('Zapis zdarzen:',e.message)}}
function restoreEvents(){try{const saved=JSON.parse(fs.readFileSync(eventQueuePath(),'utf8'));if(Array.isArray(saved))pendingEvents.push(...saved.filter(e=>e&&['job-started','job-delivered'].includes(e.type)&&typeof e.eventKey==='string').slice(-500))}catch{}}

function validPacket(x){if(!x||typeof x!=='object'||Array.isArray(x))return false;const fields=['speedKmh','odometerKm','fuelLiters','cargoMassKg','jobDeliveredDistanceKm','worldX','worldY','worldZ'];return fields.some(k=>Number.isFinite(x[k]))&&fields.every(k=>x[k]===undefined||(typeof x[k]==='number'&&Number.isFinite(x[k])))&&['cargo','sourceCity','destinationCity','sourceCompany','destinationCompany','cargoId','sourceCityId','destinationCityId','sourceCompanyId','destinationCompanyId','jobId','event'].every(k=>x[k]===undefined||(typeof x[k]==='string'&&x[k].length<=160));}
function startReader(){
 if(process.platform!=='win32'||readerProcess)return;
 readerProcess=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resourcePath('rencloud-reader.ps1')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 readerProcess.stdout.on('data',chunk=>{readerError=chunk.toString().trim().split(/\r?\n/).at(-1)});
 readerProcess.stderr.on('data',chunk=>{readerError=chunk.toString().trim().slice(0,500)});
 readerProcess.on('error',e=>{readerError=e.message;readerProcess=null});
 readerProcess.on('exit',code=>{readerError=readerError||'Czytnik zakończył pracę: '+code;readerProcess=null});
}
function startBridge(){bridgeServer=http.createServer((req,res)=>{if(req.url!=='/v1/telemetry'||req.method!=='POST'){res.writeHead(404);return res.end()}if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1'){res.writeHead(403);return res.end()}let raw='';req.on('data',b=>{raw+=b;if(raw.length>8192)req.destroy()});req.on('end',()=>{try{const x=JSON.parse(raw);if(!validPacket(x))throw Error('bad data');lastTelemetry={...x,receivedAt:Date.now()};if(['job-started','job-delivered'].includes(x.event)){pendingEvents.push({...x,driver:captureDriver,type:x.event,eventKey:require('node:crypto').randomUUID()});if(pendingEvents.length>500)pendingEvents.shift();persistEvents()}res.writeHead(204);res.end()}catch{res.writeHead(400);res.end('Invalid telemetry')}})});bridgeServer.listen(38271,'127.0.0.1');bridgeServer.on('error',e=>{console.error('Telemetry bridge:',e.message)})}

let win,tray;
const file=()=>path.join(app.getPath('userData'),'settings.json');
function settings(){try{const saved=JSON.parse(fs.readFileSync(file(),'utf8'));if(saved.server==='https://nowaczyk-transport.onrender.com')saved.server='https://nowaczyk-transport-6kth.onrender.com';return saved}catch{return {etsPath:'',server:'https://nowaczyk-transport-6kth.onrender.com',autostart:false,startMinimized:false,autoSync:true}}}
function save(x){const old=settings();const next={...old,etsPath:String(x.etsPath||''),server:String(x.server||'https://nowaczyk-transport-6kth.onrender.com'),autostart:!!x.autostart,startMinimized:!!x.startMinimized,autoSync:!!x.autoSync};if(!/^https?:\/\//.test(next.server))throw Error('Adres serwera musi zaczynać się od http:// lub https://');fs.writeFileSync(file(),JSON.stringify(next,null,2));app.setLoginItemSettings({openAtLogin:next.autostart,args:next.startMinimized?['--minimized']:[]});return next}
function detectEts(){
 const roots=[process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES,'C:\\Program Files (x86)','C:\\Program Files'].filter(Boolean);
 const candidates=roots.map(r=>path.join(r,'Steam','steamapps','common','Euro Truck Simulator 2'));
 return candidates.find(p=>fs.existsSync(path.join(p,'bin','win_x64','eurotrucks2.exe')))||'';
}
function pluginStatus(etsPath){
 const target=path.join(etsPath||'', 'bin','win_x64','plugins','scs-telemetry.dll');
 return {installed:!!etsPath&&fs.existsSync(target),target};
}
async function installPlugin(etsPath){
 if(process.platform!=='win32')throw Error('Instalacja pluginu jest dostępna tylko na Windows');
 const game=path.resolve(etsPath||'');
 if(!fs.existsSync(path.join(game,'bin','win_x64','eurotrucks2.exe')))throw Error('Wybierz poprawny folder ETS2');
 const running=await gameStatus();if(running.running)throw Error('Zamknij ETS2 przed instalacją pluginu');
 const source=resourcePath('plugins','scs-telemetry.dll');
 if(!fs.existsSync(source))throw Error('Brak dołączonego pluginu. Zainstaluj ponownie aplikację Nowaczyk Transport Telemetry.');
 const target=path.join(game,'bin','win_x64','plugins','scs-telemetry.dll');
 fs.mkdirSync(path.dirname(target),{recursive:true});
 if(fs.existsSync(target))fs.copyFileSync(target,target+'.backup-'+Date.now());
 fs.copyFileSync(source,target);return {installed:true,target};
}
function gameStatus(){return new Promise(resolve=>{
 if(process.platform!=='win32')return resolve({running:false,platform:process.platform});
 cp.execFile('tasklist',['/FI','IMAGENAME eq eurotrucks2.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:4500},(err,out)=>resolve({running:!err&&/"eurotrucks2\.exe"/i.test(out),platform:'win32'}));
});}
async function serverStatus(url){try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw Error('Nieprawidłowy adres');const r=await fetch(new URL('/api/companies',u),{signal:AbortSignal.timeout(8000)});return {online:r.ok,status:r.status}}catch(e){return {online:false,error:'Brak połączenia z serwerem'}}}
let captureDriver=null;
let desktopAuth=null;
async function loginDesktop(credentials){
 const origin=baseUrl();const r=await fetch(origin+'/api/desktop/login',{method:'POST',headers:{'Content-Type':'application/json','X-Nowaczyk-Client':'desktop'},body:JSON.stringify({username:String(credentials?.username||''),password:String(credentials?.password||'')}),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)return {ok:false,error:data.error};
 const cookie=/ks_session=([a-f0-9]+)/.exec(r.headers.get('set-cookie')||'')?.[1];if(!cookie||!data.desktopToken)return {ok:false,error:'Serwer nie obsługuje logowania aplikacji. Wdróż aktualizację serwera.'};
 await driverSession().cookies.set({url:origin,name:'ks_session',value:cookie,httpOnly:true,secure:origin.startsWith('https:'),sameSite:'strict',path:'/'});desktopAuth={origin,cookie,token:data.desktopToken,username:data.user.username};captureDriver=data.user.username.toLowerCase();return {ok:true,user:data.user};
}
let driverWindow=null;let syncInProgress=false;let syncInfo={ok:false,message:"Oczekiwanie na połączenie"};
const driverSession=()=>session.fromPartition('persist:ksgroup-driver');
function baseUrl(){const u=new URL(settings().server);if(u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Wymagany serwer HTTPS');return u.origin}
async function driverRequest(endpoint,options={}){
 const origin=baseUrl();const cookies=await driverSession().cookies.get({url:origin});const authCookie=cookies.find(c=>c.name==='ks_session');
 if(!authCookie)return {ok:false,error:'Zaloguj się w panelu kierowcy'};
 const r=await fetch(origin+endpoint,{...options,headers:{'Content-Type':'application/json',Cookie:'ks_session='+authCookie.value,...(desktopAuth?.origin===origin&&desktopAuth.cookie===authCookie.value?{'X-Nowaczyk-Desktop-Token':desktopAuth.token}:{}),...options.headers},signal:AbortSignal.timeout(30000)});
 const data=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,...data};
}
async function openDriverPanel(){
 const origin=baseUrl();if(driverWindow&&!driverWindow.isDestroyed()){driverWindow.show();driverWindow.focus();return}
 driverWindow=new BrowserWindow({width:1180,height:800,minWidth:760,minHeight:550,webPreferences:{partition:'persist:ksgroup-driver',contextIsolation:true,nodeIntegration:false,sandbox:true}});
 driverWindow.webContents.setWindowOpenHandler(({url})=>{if(new URL(url).origin===origin){shell.openExternal(url)}return {action:'deny'}});
 driverWindow.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==origin)e.preventDefault()});
 const status=await driverRequest('/api/accounts/me');
 await driverWindow.loadURL(origin+(status.user?'/moj-panel.html':'/system-login.html'));
}
async function syncTelemetry(){
 if(syncInProgress)return {ok:false,error:"Synchronizacja już trwa"};
 syncInProgress=true;
 try{
  const result=await syncTelemetryInner();
  syncInfo={...result,at:new Date().toISOString()};
  return result;
 }catch(error){
  const message=error.name==='TimeoutError'?'Serwer nie odpowiedział w 30 sekund. Automatyczna synchronizacja ponowi próbę.':error.message;
  syncInfo={ok:false,error:message,at:new Date().toISOString()};
  return syncInfo;
 }finally{syncInProgress=false}
}
async function syncTelemetryInner(){
 const account=await driverRequest('/api/accounts/me');captureDriver=account.user?.username?.toLowerCase()||null;if(!captureDriver)return {ok:false,error:'Zaloguj się w panelu kierowcy'};
 const t=lastTelemetry;const fresh=t&&Date.now()-t.receivedAt<=15000;
 const hasPosition=fresh&&[t.worldX,t.worldZ].every(Number.isFinite);
 const result=hasPosition?await driverRequest('/api/fleet/position',{method:'POST',body:JSON.stringify({x:t.worldX,z:t.worldZ,speedKmh:Math.max(0,Math.min(200,t.speedKmh||0)),activity:t.paused?'Gra wstrzymana':t.speedKmh>=3?'Jazda':'Postój',city:'',place:t.paused?'Gra wstrzymana':'Telemetria ETS2',cargo:t.cargo,cargoMassKg:t.cargoMassKg,odometerKm:t.odometerKm,onJob:t.onJob,cargoLoaded:t.cargoLoaded})}):{ok:false,error:'Czytnik nie podał współrzędnych ETS2'};
 // Przekazuj zdarzenia niezależnie od rozliczeń. Zachowaj kolejkę przy błędzie serwera.
 let sentEvents=0;
 for(const ev of pendingEvents.filter(e=>e.driver===captureDriver).slice(0,10)){
  try{const reply=await driverRequest('/api/telemetry/events',{method:'POST',body:JSON.stringify(ev)});
   if(!reply.ok)break;pendingEvents.splice(pendingEvents.indexOf(ev),1);persistEvents();sentEvents++;
   if(ev.type==='job-delivered'&&win&&!win.isDestroyed())win.webContents.send('driver-routes-changed');
  }catch{break}
 }
 const outcome=result.ok?{ok:true,driver:result.position?.driver,verified:false,sentEvents}:{...result,sentEvents};return outcome;
}
function create(){const s=settings();win=new BrowserWindow({width:680,height:650,minWidth:560,minHeight:500,show:false,icon:path.join(__dirname,'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});win.loadFile('ui.html');win.once('ready-to-show',()=>{if(!((process.argv.includes('--minimized')||s.startMinimized)&&app.getLoginItemSettings().wasOpenedAtLogin))win.show()});win.on('close',e=>{if(!app.isQuitting){e.preventDefault();win.hide()}});
 // Ikona zasobnika generowana w kodzie, bez pobierania z internetu.
 const icon=nativeImage.createFromPath(path.join(__dirname,'icon.png'));tray=new Tray(icon);tray.setToolTip('Nowaczyk Transport Telemetry');tray.setContextMenu(Menu.buildFromTemplate([{label:'Pokaż ustawienia',click:()=>win.show()},{label:'Zakończ',click:()=>{app.isQuitting=true;app.quit()}}]));tray.on('double-click',()=>win.show());}
async function listDriverRoutes(){const origin=baseUrl();const cookies=await driverSession().cookies.get({url:origin});const c=cookies.find(x=>x.name==='ks_session');if(!c)return {ok:false,error:'Zaloguj się w panelu kierowcy'};const r=await fetch(origin+'/api/routes?mine=1',{headers:{Cookie:'ks_session='+c.value},signal:AbortSignal.timeout(9000)});if(r.status===401)return {ok:false,error:'Sesja wygasła. Zaloguj się ponownie formularzem w aplikacji, a potem pobierz zlecenia.'};if(!r.ok)return {ok:false,error:'Nie udało się pobrać zleceń: HTTP '+r.status};const data=await r.json();return {ok:true,routes:Array.isArray(data)?data.filter(route=>!route.deliveredAt&&!route.settledAt&&route.status!=='Zakończona'):[]}}
const autoDispatchFile=()=>path.join(app.getPath('userData'),'auto-dispatch.json');
let autoDispatchBusy=false;
let autoDispatchMessage='';
function autoDispatchSettings(){
 try{return JSON.parse(fs.readFileSync(autoDispatchFile(),'utf8'))}
 catch(error){if(error.code!=='ENOENT')throw error;return {savePath:'',prepared:{}}}
}
function writeAutoDispatch(config){
 const target=autoDispatchFile();
 fs.writeFileSync(target+'.tmp',JSON.stringify(config));
 fs.renameSync(target+'.tmp',target);
}
async function autoDispatch(){
 if(autoDispatchBusy||!desktopAuth)return;
 autoDispatchBusy=true;
 try{
  const config=autoDispatchSettings(),auth=desktopAuth;
  if(!config.savePath)return;
  if(auth.origin!==baseUrl())throw Error('Zaloguj się ponownie po zmianie serwera.');
  if(!lastTelemetry||Date.now()-lastTelemetry.receivedAt>10000||lastTelemetry.onJob!==false){
   autoDispatchMessage='Oczekiwanie na ETS2 i zakończenie aktywnego zlecenia.';
   return;
  }
  const result=await listDriverRoutes();
  if(!result.ok)throw Error(result.error);
  const waitingRoutes=result.routes.filter(r=>r.driver?.toLowerCase()===auth.username.toLowerCase()&&!r.deliveredAt&&['Przydzielona','Przyjęta','W trasie'].includes(r.status));
  if(waitingRoutes.some(r=>Object.hasOwn(config.prepared,r.id))){
   autoDispatchMessage='Oferta jest gotowa. Wczytaj ręczny zapis ETS2 i dokończ trasę przed przygotowaniem następnej.';
   return;
  }
  const route=waitingRoutes.filter(r=>r.status!=='W trasie')
   .sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))[0];
  if(!route)return;
  const exported=await driverRequest('/api/routes/export?id='+encodeURIComponent(route.id));
  if(!exported.ok)throw Error(exported.error||'Nie udało się pobrać danych trasy.');
  if(desktopAuth!==auth||autoDispatchSettings().savePath!==config.savePath)return;
  const importer=require('./save-importer');
  const ramps={source:importer.loadingPoint(exported.from)};
  importer.plan(importer.decodeSave(fs.readFileSync(config.savePath)),exported,ramps);
  if(!route.acceptedAt){
   const accepted=await driverRequest('/api/routes/accept',{method:'POST',body:JSON.stringify({routeId:route.id})});
   if(!accepted.ok)throw Error(accepted.error||'Nie udało się przyjąć trasy.');
  }
  if(desktopAuth!==auth||autoDispatchSettings().savePath!==config.savePath||Date.now()-lastTelemetry.receivedAt>10000||lastTelemetry.onJob!==false)return;
  const prepared=importer.importFile(config.savePath,exported,ramps);
  config.prepared[route.id]=true;
  writeAutoDispatch(config);
  autoDispatchMessage=prepared.notice;
 }catch(error){autoDispatchMessage=error.message}
 finally{autoDispatchBusy=false}
}
function startUpdates(){
 if(!app.isPackaged||process.platform!=='win32')return;
 const {autoUpdater}=require('electron-updater');
 autoUpdater.on('error',error=>console.error('Aktualizacja:',error.message));
 const check=()=>autoUpdater.checkForUpdates().catch(error=>console.error('Sprawdzanie aktualizacji:',error.message));
 check();
 setInterval(check,6*60*60*1000).unref();
}
app.whenReady().then(()=>{
 ipcMain.handle('auto-dispatch-status',()=>({enabled:!!autoDispatchSettings().savePath,message:autoDispatchMessage}));
 ipcMain.handle('auto-dispatch-configure',async()=>{
  const picked=await dialog.showOpenDialog(win,{title:'Wybierz stały ręczny zapis ETS2 dla automatycznych tras',properties:['openFile'],filters:[{name:'Zapis ETS2',extensions:['sii']}]});
  if(picked.canceled)return;
  const savePath=picked.filePaths[0];
  if(path.basename(savePath).toLowerCase()!=='game.sii'||/^auto(?:save)?/i.test(path.basename(path.dirname(savePath))))throw Error('Wybierz game.sii z ręcznego zapisu.');
  writeAutoDispatch({...autoDispatchSettings(),savePath});
  autoDispatchMessage='Automatyczny import włączony. Wczytaj ręczny zapis, gdy trasa będzie gotowa.';
 });
 ipcMain.handle('auto-dispatch-disable',()=>{
  writeAutoDispatch({...autoDispatchSettings(),savePath:''});
  autoDispatchMessage='';
 });
 setInterval(()=>void autoDispatch(),15000);
 restoreEvents();startBridge();startReader();setInterval(()=>{if(!readerProcess)startReader()},10000);ipcMain.handle('desktop-login',(_,credentials)=>loginDesktop(credentials));ipcMain.handle('accept-driver-route',async(_,id)=>{if(typeof id!=='string'||!(/^[a-f0-9-]{8,80}$/i.test(id)))return {ok:false,error:'Nieprawidłowe ID'};return driverRequest('/api/routes/accept',{method:'POST',body:JSON.stringify({routeId:id})})});ipcMain.handle('import-driver-route',async(_,id)=>{try{if(typeof id!=='string'||!(/^[a-f0-9-]{8,80}$/i.test(id)))throw Error('Nieprawidłowe ID');const job=await driverRequest('/api/routes/export?id='+encodeURIComponent(id));if(!job.ok)return job;if(!job.acceptedAt)return {ok:false,error:'Najpierw przyjmij trasę w aplikacji'};const picked=await dialog.showOpenDialog(win,{title:'Wybierz zapis game.sii z profilu ETS2 (menu profili)',properties:['openFile'],filters:[{name:'Zapis ETS2',extensions:['sii']}]});if(picked.canceled)return {ok:false,error:'Anulowano'};const importer=require('./save-importer');const ramps={source:importer.loadingPoint(job.from)};
 const r=importer.importFile(picked.filePaths[0],job,ramps);return {ok:true,...r}}catch(e){return {ok:false,error:e.message}}});ipcMain.handle('open-driver-panel',()=>openDriverPanel());ipcMain.handle('driver-status',async()=>{const r=await driverRequest('/api/accounts/me');captureDriver=r.user?.username?.toLowerCase()||null;return {...r,desktopReady:!!desktopAuth&&desktopAuth.origin===baseUrl()&&desktopAuth.username.toLowerCase()===captureDriver}});ipcMain.handle('map-profile-get',()=>driverRequest('/api/driver/map-profile'));ipcMain.handle('map-profile-set',async(_,mapProfile)=>{if(!['promods','promods-pr'].includes(mapProfile))return {ok:false,error:'Nieprawidłowy profil'};return driverRequest('/api/driver/map-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mapProfile})})});ipcMain.handle('driver-routes',listDriverRoutes);ipcMain.handle('export-driver-route',async(_,id)=>{if(typeof id!=='string'||!(/^[a-f0-9-]{8,80}$/i.test(id)))return {ok:false,error:'Nieprawidłowe ID zlecenia'};const result=await driverRequest('/api/routes/export?id='+encodeURIComponent(id));if(!result.ok)return result;const destination=await dialog.showSaveDialog(win,{title:'Zapisz manifest zlecenia Nowaczyk Transport',defaultPath:'ks-job-'+id+'.json',filters:[{name:'JSON',extensions:['json']}]});if(destination.canceled||!destination.filePath)return {ok:false,error:'Anulowano'};fs.writeFileSync(destination.filePath,JSON.stringify(result,null,2),'utf8');return {ok:true,path:destination.filePath};});ipcMain.handle('sync-telemetry',()=>syncTelemetry());ipcMain.handle('sync-info',()=>({...syncInfo,readerError}));setInterval(()=>{if(settings().autoSync)syncTelemetry().catch(e=>{syncInfo={ok:false,error:e.message,at:new Date().toISOString()}})},5000);ipcMain.handle('plugin-status',(_,p)=>pluginStatus(p));ipcMain.handle('install-plugin',(_,p)=>installPlugin(p));ipcMain.handle('telemetry-status',()=>lastTelemetry?{...lastTelemetry,ageMs:Date.now()-lastTelemetry.receivedAt}:null);ipcMain.handle('get-settings',()=>({...settings(),appVersion:app.getVersion()}));ipcMain.handle('save-settings',async(_,x)=>{
 const saved=save({...x,etsPath:x.etsPath||detectEts()});
 if(process.platform!=='win32'||!saved.etsPath||pluginStatus(saved.etsPath).installed)return saved;
 try{await installPlugin(saved.etsPath);return {...saved,pluginMessage:'Plugin ETS2 zainstalowany.'}}
 catch(e){return {...saved,pluginMessage:e.message}}
});ipcMain.handle('choose-ets',async()=>{const r=await dialog.showOpenDialog(win,{title:'Wybierz folder Euro Truck Simulator 2',properties:['openDirectory']});return r.canceled?'':r.filePaths[0]});ipcMain.handle('minimize',()=>win.hide());ipcMain.handle('detect-ets',()=>detectEts());ipcMain.handle('game-status',()=>gameStatus());ipcMain.handle('server-status',(_,url)=>serverStatus(url));create();startUpdates()});app.on('before-quit',()=>{app.isQuitting=true;readerProcess?.kill();bridgeServer?.close()});app.on('window-all-closed',()=>{});
