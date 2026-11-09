"use strict";
// Read-only validation of a received ETS2 job against a dispatch order.
function norm(s){return String(s??'').normalize('NFKC').trim().toLocaleLowerCase('pl').replace(/\s+/g,' ')}
function validateJob(route,t){
 if(!route||!t||typeof t!=='object')return {match:false,reasons:['Brak danych zlecenia lub telemetrii']};
 const checks=[['from','sourceCity','Miasto załadunku'],['to','destinationCity','Miasto rozładunku'],['sourceCompany','sourceCompany','Firma załadunku'],['destinationCompany','destinationCompany','Firma rozładunku'],['cargo','cargo','Towar']];
 const reasons=[];
 for(const [a,b,label] of checks){if(!route[a]){reasons.push(label+': nieokreślone w zleceniu');continue}if(!t[b]){reasons.push(label+': brak danych z gry');continue}if(norm(route[a])!==norm(t[b]))reasons.push(label+': niezgodność')}
 const expected=Number(route.cargoTons),actual=Number(t.cargoMassKg)/1000;
 if(!Number.isFinite(expected)||expected<=0)reasons.push('Masa nieokreślona w zleceniu');
 else if(!Number.isFinite(actual)||actual<=0)reasons.push('Brak prawidłowej masy z ETS2');
 else if(Math.abs(expected-actual)>0.05)reasons.push('Masa ładunku niezgodna (tolerancja 50 kg)');
 return {match:reasons.length===0,reasons,expectedTons:expected,actualTons:Number.isFinite(actual)?actual:null};
}
module.exports={validateJob};
