'use strict';
const DEFAULT_SERVER='https://nowaczyk-transport-6kth.onrender.com';
function normalizeSettings(saved){
 const data=saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{};
 return {etsPath:'',server:DEFAULT_SERVER,autostart:false,startMinimized:false,...data,
  server:data.server==='https://nowaczyk-transport.onrender.com'?DEFAULT_SERVER:data.server||DEFAULT_SERVER,
  autoSync:typeof data.autoSync==='boolean'?data.autoSync:true};
}
function positionPayload(t,now=Date.now()){
 if(!t||!Number.isFinite(t.receivedAt)||now-t.receivedAt>15000||now<t.receivedAt)return {ok:false,error:'Brak aktualnej telemetrii ETS2. Wczytaj profil w grze.'};
 if(![t.worldX,t.worldZ].every(Number.isFinite)||(t.worldX===0&&t.worldZ===0))return {ok:false,error:'ETS2 nie podał pozycji na mapie. Wczytaj profil i wejdź do jazdy.'};
 return {ok:true,payload:{x:t.worldX,z:t.worldZ,speedKmh:Math.max(0,Math.min(200,t.speedKmh||0)),activity:t.paused?'Gra wstrzymana':t.speedKmh>=3?'Jazda':'Postój',city:'',place:t.paused?'Gra wstrzymana':'Telemetria ETS2',cargo:t.cargo,cargoMassKg:t.cargoMassKg,odometerKm:t.odometerKm,onJob:t.onJob,cargoLoaded:t.cargoLoaded}};
}
module.exports={normalizeSettings,positionPayload};
