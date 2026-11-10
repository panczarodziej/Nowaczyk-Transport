'use strict';
// Importer rynku ładunków: korzysta wyłącznie z ofert i firm obecnych w zapisie.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const {inflateSync}=require('node:zlib');
const maxSaveBytes=100*1024*1024;
function decodeSave(bytes){
 let payload=bytes;
 if(bytes.toString('ascii',0,4)==='ScsC'){
  if(bytes.length<72||(bytes.length-56)%16!==0)throw Error('Niepełny plik zapisu ScsC.');
  try{
   const key=Buffer.from('2a5fcb1791d22fb60245b3d8369ed0b2c27371563fbf1f3c9edf6b11825a5d0a','hex');
   const decipher=crypto.createDecipheriv('aes-256-cbc',key,bytes.subarray(36,52));
   decipher.setAutoPadding(false);
   const compressed=Buffer.concat([decipher.update(bytes.subarray(56)),decipher.final()]);
   payload=inflateSync(compressed,{maxOutputLength:maxSaveBytes});
  }catch{throw Error('Nie udało się odczytać zawartości zapisu ScsC.')}
 }
 if(payload.toString('ascii',0,4)==='BSII')throw Error('Zapis zawiera binarny format BSII. Importer obsługuje tekstowy format SiiNunit.');
 return payload.toString('utf8');
}
function norm(v){return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').toLowerCase().replace(/[^a-z0-9]/g,'')}
function units(text){
 if(!/^\uFEFF?SiiNunit\s*\{/.test(text))throw Error('Plik nie zawiera tekstowego zapisu SiiNunit.');
 const out=[];const re=/^\s*(\w+)\s*:\s*([^\s{]+)\s*\{[^{}]*^\s*\}/gm;let m;
 while((m=re.exec(text)))out.push({type:m[1],id:m[2],text:m[0],start:m.index,end:re.lastIndex});
 if(!out.length)throw Error('Nieobsługiwany format jednostek zapisu');return out;
}
function field(unit,key){const m=unit.text.match(new RegExp('^\\s*'+key+':\\s*([^\\r\\n]+)','m'));return m?m[1].trim().replace(/^"|"$/g,''):null}
function replaceField(text,key,value){const re=new RegExp('^(\\s*'+key+':\\s*)[^\\r\\n]+','m');if(!re.test(text))throw Error('Brak pola '+key+' — zapis nieobsługiwany');return text.replace(re,(_,prefix)=>prefix+value)}
function validPlacement(value){
 return typeof value==='string'&&/^\([0-9&., +eEabcdefA-F-]+\)\s*\([0-9&.,; +eEabcdefA-F-]+\)$/.test(value)&&!value.includes('&60ad78ec');
}
function readLoadingPoint(file,side){
 if(fs.statSync(file).size>maxSaveBytes)throw Error('Zapis wzorcowy jest zbyt duży.');
 const list=units(decodeSave(fs.readFileSync(file)));
 const player=list.find(unit=>unit.type==='player');
 const active=player&&field(player,'current_job');
 const job=list.find(unit=>unit.type==='player_job'&&unit.id===active);
 const company=job&&field(job,'source_company');
 if(!company||company!=='company.volatile.'+side.company+'.'+side.city||field(job,'is_cargo_market_job')!=='true'){
  throw Error('Zapis wzorcowy musi zawierać aktywne zlecenie rynku ładunków z tej samej firmy załadunku.');
 }
 const placement=field(job,'source_placement');
 if(!validPlacement(placement))throw Error('Zapis wzorcowy nie zawiera punktu załadunku.');
 return placement;
}
function loadingPoint(side){
 if(!validPlacement(side?.loadingPlacement))throw Error('Brak punktu firmy w katalogu mapy. Odśwież trasę w aplikacji lub wybierz firmę z mapy Nowaczyk.');
 return side.loadingPlacement;
}
function plan(text,job,ramps){
 const list=units(text),source=job.from||{},dest=job.to||{},cargo=job.cargo||{};
 if(!source.company||!source.city||!dest.company||!dest.city||!cargo.name)throw Error('Dyspozytor musi podać obie firmy, oba miasta i towar.');
 const companies=list.filter(u=>u.type==='company'&&u.id.startsWith('company.volatile.'));
 function company(side){const matches=companies.filter(u=>{const parts=u.id.slice(17).split('.');return norm(parts.pop())===norm(side.city)&&norm(parts.join('.'))===norm(side.company)});if(matches.length!==1)throw Error('Nie znaleziono jednoznacznej firmy '+side.company+' w '+side.city+'. W zleceniu użyj identyfikatorów z aktywnej mapy ETS2.');return matches[0]}
 const from=company(source),to=company(dest);
 if(from.id===to.id)throw Error('Załadunek i rozładunek muszą być różne');
 const refs=new Set([...from.text.matchAll(/^\s*job_offer\[\d+\]:\s*(\S+)/gm)].map(m=>m[1]));
 const definitions=new Map(list.filter(unit=>unit.type==='trailer_def').map(unit=>[unit.id,unit]));
 const allowedTypes={firanka:['curtainside',/(?:^|\.)curtain(?:_|$)/i],chlodnia:['refrigerated',/(?:^|\.)reefer(?:_|$)/i]};
 let expected=Object.hasOwn(allowedTypes,job.trailerType)?allowedTypes[job.trailerType]:null;
 const player=list.find(unit=>unit.type==='player');
 if(ramps){
  if(!player||field(player,'current_job')!=='null'||field(player,'selected_job')!=='null')throw Error('Zakończ aktywne zlecenie i usuń wybraną ofertę przed importem.');
  const ref=field(player,'assigned_trailer');
  const trailer=list.find(unit=>unit.type==='trailer'&&unit.id===ref);
  const definition=definitions.get(trailer&&field(trailer,'trailer_definition'));
  const body=definition&&field(definition,'body_type');
  if(!trailer||field(player,'my_trailer_attached')!=='true'||field(player,'my_trailer')!==ref)throw Error('Podepnij własną naczepę i wykonaj ręczny zapis.');
  if(field(trailer,'slave_trailer')!=='null')throw Error('Tryb własnej naczepy obsługuje pojedynczą naczepę.');
  const ownType=Object.values(allowedTypes).find(([type])=>type===body);
  if(!ownType||(expected&&expected!==ownType))throw Error('Typ podpiętej naczepy nie pasuje do zlecenia.');
  expected=ownType;
 }
 const options=list.filter(offer=>{
  if(offer.type!=='job_offer_data'||!refs.has(offer.id)||!field(offer,'units_count'))return false;
  const ref=field(offer,'trailer_definition');
  if(!ref)return false;
  if(!expected)return true;
  const definition=definitions.get(ref);
  const body=definition&&field(definition,'body_type');
  return body?body===expected[0]:expected[1].test((definition&&field(definition,'source_name'))||ref);
 });
 const cargoId=offer=>field(offer,'cargo')?.replace(/^cargo\./,'');
 const slot=options.find(offer=>norm(cargoId(offer))===norm(cargo.id||cargo.name));
 if(!slot){
  const available=[...new Set(options.map(cargoId).filter(Boolean))].sort();
  const type=job.trailerType==='firanka'?'plandeka':job.trailerType==='chlodnia'?'chłodnia':'dowolny';
  throw Error('W firmie załadunku brak zgodnego szablonu tego towaru (typ: '+type+'). '+(available.length?'Towary dostępne w tym zapisie: '+available.join(', ')+'.':'W tym zapisie firma nie ma ofert dla wybranego typu.'));
 }
 const km=Number(job.plannedKm);if(!Number.isSafeInteger(km)||km<=0||km>30000)throw Error('Zlecenie musi mieć całkowity dystans 1–30000 km');
 const economy=list.find(u=>u.type==='economy');const clock=Number(economy&&field(economy,'game_time'));if(!Number.isSafeInteger(clock)||clock<0)throw Error('Brak czasu gry w zapisie');
 if(ramps){
  const sourcePlacement=ramps.source;
  const points=dest.deliveryPlacements;
  const target=points?.easy?.[0];
  if(!validPlacement(sourcePlacement)||!validPlacement(target))throw Error('Brak punktu załadunku lub rozładunku. Wybierz trasę z katalogu Nowaczyk.');
  const [medium,hard]=['medium','hard'].map(type=>validPlacement(points[type]?.[0])?points[type][0]:target);
  const numbers={units_count:Number(field(slot,'units_count')),ferry_time:Number(field(slot,'ferry_time')||0),ferry_price:Number(field(slot,'ferry_price')||0),urgency:Number(field(slot,'urgency')||0)};
  if(Object.values(numbers).some(n=>!Number.isSafeInteger(n)||n<0)||!numbers.units_count)throw Error('Nieprawidłowe dane wzorcowej oferty ETS2.');
  const id='_nameless.aaa.'+crypto.randomBytes(2).toString('hex')+'.'+crypto.randomBytes(2).toString('hex');
  if(list.some(unit=>unit.id===id))throw Error('Konflikt identyfikatora zlecenia. Spróbuj ponownie.');
  const properties={company_truck:'null',company_trailer:'null',target_placement:target,target_placement_medium:medium,target_placement_hard:hard,target_placement_rigid:'(0, &60ad78ec, 0) (1; 0, 0, 0)',source_placement:sourcePlacement,selected_target:'nil',time_lower_limit:clock+6000,time_upper_limit:clock+8000,job_distance:0,fuel_consumed:0,last_reported_fuel:0,total_fines:0,is_trailer_loaded:'false',online_job_id:'nil',online_job_trailer_model:'null',autoload_used:'false',cargo:field(slot,'cargo'),source_company:from.id,target_company:to.id,is_articulated:'false',is_cargo_market_job:'true',start_time:clock,planned_distance_km:km,special:'null',fill_ratio:1,...numbers};
  const changed=text.slice(0,player.start)+replaceField(player.text,'current_job',id)+text.slice(player.end);
  const end=changed.lastIndexOf('}');
  const jobUnit='\nplayer_job : '+id+' {\n'+Object.entries(properties).map(([key,value])=>' '+key+': '+value).join('\n')+'\n}\n';
  return {text:changed.slice(0,end)+jobUnit+changed.slice(end),notice:'Aktywne zlecenie zapisane. Wczytaj zmieniony zapis w ETS2 i sprawdź punkt załadunku.'};
 }
 const target=to.id.slice(17);let replacement=replaceField(slot.text,'target',JSON.stringify(target));replacement=replaceField(replacement,'expiration_time',clock+7*24*60);replacement=replaceField(replacement,'shortest_distance_km',km);
 return {text:text.slice(0,slot.start)+replacement+text.slice(slot.end),offerId:slot.id,source:from.id,target:to.id,unitsCount:Number(field(slot,'units_count')),notice:'Oferta zapisana. Wczytaj zmieniony zapis w ETS2 i odbierz ładunek w firmie. Masa wynika z definicji towaru i zachowanej liczby jednostek; system porówna ją z tonami zlecenia.'};
}
function importFile(file,job,ramps){
 if(path.basename(file).toLowerCase()!=='game.sii')throw Error('Wybierz plik game.sii');
 const bytes=fs.readFileSync(file);if(bytes.length>maxSaveBytes)throw Error('Zapis zbyt duży');const original=decodeSave(bytes);const result=plan(original,job,ramps);
 if(!fs.readFileSync(file).equals(bytes))throw Error('Gra zmieniła zapis podczas importu. Wróć do menu profili.');
 const suffix=Date.now()+'-'+crypto.randomBytes(4).toString('hex'),backup=file+'.nowaczyk-'+suffix+'.bak',tmp=file+'.nowaczyk-'+suffix+'.tmp';
 fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
 try{fs.writeFileSync(tmp,result.text,{encoding:'utf8',flag:'wx'});if(!fs.readFileSync(file).equals(bytes))throw Error('Zapis zmienił się podczas importu. Nie został nadpisany.');fs.renameSync(tmp,file)}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}
 const {text,...details}=result;return {...details,backup};
}
module.exports={plan,importFile,decodeSave,readLoadingPoint,loadingPoint};
