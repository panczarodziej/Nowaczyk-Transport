'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function pluginFiles(game,source){
 if(!game||!fs.existsSync(path.join(game,'bin','win_x64','eurotrucks2.exe')))throw Error('Nie znaleziono ETS2. Wybierz folder gry w ustawieniach.');
 if(!fs.existsSync(source))throw Error('Brak wtyczki w aplikacji. Zainstaluj najnowszą wersję aplikacji.');
 return {source,target:path.join(game,'bin','win_x64','plugins','nowaczyk-telemetry.dll')};
}
async function ensurePlugin({game,source,running,elevate}){
 const files=pluginFiles(game,source),{target}=files;
 if(fs.existsSync(target)&&digest(target)===digest(source))return {installed:true,target,changed:false};
 if(running!==false)return {installed:false,target,pending:true,message:'Zamknij ETS2 — wtyczka zainstaluje się automatycznie po zamknięciu gry.'};
 try{fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target))fs.copyFileSync(target,target+'.backup-'+Date.now());fs.copyFileSync(source,target)}
 catch(error){if(!['EACCES','EPERM'].includes(error.code)||!elevate)throw error;await elevate(files)}
 if(!fs.existsSync(target)||digest(target)!==digest(source))throw Error('Nie udało się zapisać wtyczki ETS2. Sprawdź uprawnienia folderu gry lub blokadę antywirusa.');
 return {installed:true,target,changed:true};
}
module.exports={ensurePlugin};
