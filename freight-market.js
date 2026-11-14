'use strict';
const companyCargo=require('./public/ets2-company-cargo.json');
const cargoTypes=require('./public/ets2-cargo-types.json');
const names=require('./public/ets2-polish-names.json');
const cargoLabels=new Map(Object.entries(names.cargo).map(([label,id])=>[id,label]));
const cityLabels=new Map(Object.entries(names.cities).map(([label,id])=>[id,label]));
const regionCodes={
 aland:'AX',albania:'AL',andorra:'AD',armenia:'AM',austria:'AT',azerbaijan:'AZ',belgium:'BE',bosnia:'BA',
 bulgaria:'BG',croatia:'HR',cyprus:'CY',czech:'CZ',denmark:'DK',egypt:'EG',estonia:'EE',faroe:'FO',
 finland:'FI',france:'FR',georgia:'GE',germany:'DE',gibraltar:'GI',greece:'GR',greenland:'GL',guernsey:'GG',
 hungary:'HU',iceland:'IS',iom:'IM',iraq:'IQ',ireland:'IE',israel:'IL',italy:'IT',jersey:'JE',jordan:'JO',
 latvia:'LV',lebanon:'LB',libya:'LY',lithuania:'LT',luxembourg:'LU',macedonia:'MK',malta:'MT',moldova:'MD',
 monaco:'MC',montenegro:'ME',netherlands:'NL',norway:'NO',poland:'PL',portugal:'PT',romania:'RO',russia:'RU',
 saudia:'SA',serbia:'RS',slovakia:'SK',slovenia:'SI',spain:'ES',svalbard:'SJ',sweden:'SE',switzerland:'CH',
 syria:'SY',turkey:'TR',uk:'GB',ukraine:'UA'
};
const regionNames=new Intl.DisplayNames(['pl'],{type:'region'});
const countryLabels={nireland:'Irlandia Północna',westbank:'Zachodni Brzeg',svalbard:'Svalbard'};
function countryLabel(id){
 return countryLabels[id]||(regionCodes[id]?regionNames.of(regionCodes[id]):id);
}
const weights=[12,14,16,18,20,22,24];

function buildOffers(map,cities,quote,excluded=new Set()){
 const receive=new Map();
 const send=[],extraSend=[];
 const refrigerated=new Set(cargoTypes.chlodnia);
 const curtain=new Set(cargoTypes.firanka);
 for(const [cityId,depots] of Object.entries(map)){
  const [city,country]=cities[cityId];
  if(!country)continue;
  for(const [company,positions] of Object.entries(depots)){
   const rules=company==='rybackie_elk'?{in:[],out:['fresh_fish']}:companyCargo[company];
   const point=(positions.easy?.[0]||positions.hard?.[0]||'').match(/^\((-?[\d.]+),\s*-?[\d.]+,\s*(-?[\d.]+)\)/);
   if(!rules||!point)continue;
   const depot={cityId,city:cityLabels.get(cityId)||city,country,company,x:Number(point[1]),z:Number(point[2])};
   for(const cargo of rules.in){
    if(!receive.has(cargo))receive.set(cargo,[]);
    receive.get(cargo).push(depot);
   }
   for(const cargo of rules.out){
    if(cargoLabels.has(cargo)&&(refrigerated.has(cargo)||curtain.has(cargo)))(company==='rybackie_elk'?extraSend:send).push({...depot,cargo});
   }
  }
 }
 // Fixed seed keeps offer IDs and terms stable across restarts.
 let seed=82923;
 const pick=items=>{
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  return items[Math.floor(seed/4294967296*items.length)];
 };
 const offers=[],seen=new Set();
 let sequence=0;
 for(let attempt=0;attempt<500000&&offers.length<25000;attempt++){
  const from=pick(sequence>=10000&&extraSend.length&&attempt%20===0?extraSend:send);
  if(!from)break;
  const to=pick(receive.get(from.cargo)||[]);
  if(!to||from.cityId===to.cityId)continue;
  const key=[from.cityId,from.company,to.cityId,to.company,from.cargo].join('/');
  if(seen.has(key))continue;
  const plannedKm=Math.round(Math.hypot(from.x-to.x,from.z-to.z)*0.025);
  if(plannedKm<80||plannedKm>4500)continue;
  seen.add(key);
  const cargoTons=pick(weights),trailerType=refrigerated.has(from.cargo)?'chlodnia':'firanka';
  sequence++;
  // Preserve IDs of existing offers even when hiding an unsupported country.
  if(excluded.has(regionCodes[from.country])||excluded.has(regionCodes[to.country])||[from.country,to.country].includes('westbank'))continue;
  offers.push({id:'NT-'+String(sequence).padStart(5,'0'),mapSetFrom:from.cityId,mapSetTo:to.cityId,
   from:from.city,to:to.city,fromCountry:countryLabel(from.country),toCountry:countryLabel(to.country),fromCode:regionCodes[from.country],toCode:regionCodes[to.country],sourceCompany:from.company,destinationCompany:to.company,
   cargo:from.cargo,cargoLabel:cargoLabels.get(from.cargo),cargoTons,trailerType,plannedKm,
   freight:quote(plannedKm,trailerType,countryLabel(from.country),countryLabel(to.country))});
 }
 return offers;
}
module.exports={buildOffers};
