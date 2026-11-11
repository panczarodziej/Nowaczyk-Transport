"use strict";
// Read-only validation of a received ETS2 job against a dispatch order.
function norm(s){return String(s??'').normalize('NFKC').trim().toLocaleLowerCase('pl').replace(/\s+/g,' ')}
const polishNames=require('./public/ets2-polish-names.json');
const companyAliases=require('./ets2-company-aliases.json');
function comparable(value,field){
 const aliases=field==='cargo'?polishNames.cargo:field==='from'||field==='to'?polishNames.cities:null;
 const key=norm(value);
 if(field==='sourceCompany'||field==='destinationCompany'){
  const company=key.normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/ł/g,'l').replace(/[^a-z0-9]/g,'');
  return Object.hasOwn(companyAliases,company)?companyAliases[company]:key;
 }
 const alias=aliases&&Object.entries(aliases).find(([label])=>norm(label)===key);
 return alias?alias[1]:key;
}
function jobIdentityReasons(route,t){
 if(!route||!t||typeof t!=='object')return ['Brak danych zlecenia lub telemetrii'];
 const checks=[['from','sourceCity','Miasto załadunku'],['to','destinationCity','Miasto rozładunku'],['sourceCompany','sourceCompany','Firma załadunku'],['destinationCompany','destinationCompany','Firma rozładunku'],['cargo','cargo','Towar']];
 const reasons=[];
 for(const [a,b,label] of checks){
  if(!route[a]){reasons.push(label+': nieokreślone w zleceniu');continue}
  const id=t[b+'Id'];
  const values=[a==='cargo'&&id?id.replace(/^cargo\./i,''):id,t[b]].filter(Boolean);
  if(!values.length){reasons.push(label+': brak danych z gry');continue}
  const expected=[route[a],a==='from'?route.mapSetFrom:a==='to'?route.mapSetTo:null].filter(Boolean);
  if(!expected.some(value=>values.some(actual=>comparable(value,a)===comparable(actual,a))))reasons.push(label+': niezgodność');
 }
 return reasons;
}
function validateJob(route,t){
 const reasons=jobIdentityReasons(route,t);
 if(!route||!t||typeof t!=='object')return {match:false,reasons};
 const expected=Number(route.cargoTons),actual=Number(t.cargoMassKg)/1000;
 if(!Number.isFinite(expected)||expected<=0)reasons.push('Masa nieokreślona w zleceniu');
 else if(!Number.isFinite(actual)||actual<=0)reasons.push('Brak prawidłowej masy z ETS2');
 else if(Math.abs(expected-actual)>0.05)reasons.push('Masa ładunku niezgodna (tolerancja 50 kg)');
 return {match:reasons.length===0,reasons,expectedTons:expected,actualTons:Number.isFinite(actual)?actual:null};
}
module.exports={validateJob,jobIdentityReasons};
