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
function plan(text,job){
 const list=units(text),source=job.from||{},dest=job.to||{},cargo=job.cargo||{};
 if(!source.company||!source.city||!dest.company||!dest.city||!cargo.name)throw Error('Dyspozytor musi podać obie firmy, oba miasta i towar.');
 const companies=list.filter(u=>u.type==='company'&&u.id.startsWith('company.volatile.'));
 function company(side){const matches=companies.filter(u=>{const parts=u.id.slice(17).split('.');return norm(parts.pop())===norm(side.city)&&norm(parts.join('.'))===norm(side.company)});if(matches.length!==1)throw Error('Nie znaleziono jednoznacznej firmy '+side.company+' w '+side.city+'. W zleceniu użyj identyfikatorów z aktywnej mapy ETS2.');return matches[0]}
 const from=company(source),to=company(dest);
 if(from.id===to.id)throw Error('Załadunek i rozładunek muszą być różne');
 const offers=list.filter(u=>u.type==='job_offer_data');
 const refs=[...from.text.matchAll(/^\s*job_offer\[\d+\]:\s*(\S+)/gm)].map(m=>m[1]);
 // Preserve trailer, unit count and compatibility at source. Never borrow an arbitrary trailer.
 const eligible=offers.filter(u=>refs.includes(u.id)&&norm(field(u,'cargo')?.replace(/^cargo\./,''))===norm(cargo.id||cargo.name));
 if(!eligible.length)throw Error('W firmie załadunku brak szablonu tego towaru. Import wstrzymany: nie można dobrać zgodnej naczepy i masy przez zgadywanie.');
 const slot=eligible[0];if(!field(slot,'trailer_definition')||!field(slot,'units_count'))throw Error('Brak definicji naczepy lub liczby jednostek towaru.');
 const km=Number(job.plannedKm);if(!Number.isSafeInteger(km)||km<=0||km>30000)throw Error('Zlecenie musi mieć całkowity dystans 1–30000 km');
 const economy=list.find(u=>u.type==='economy');const clock=Number(economy&&field(economy,'game_time'));if(!Number.isSafeInteger(clock)||clock<0)throw Error('Brak czasu gry w zapisie');
 const target=to.id.slice(17);let replacement=replaceField(slot.text,'target',JSON.stringify(target));replacement=replaceField(replacement,'expiration_time',clock+7*24*60);replacement=replaceField(replacement,'shortest_distance_km',km);
 return {text:text.slice(0,slot.start)+replacement+text.slice(slot.end),offerId:slot.id,source:from.id,target:to.id,unitsCount:Number(field(slot,'units_count')),notice:'Oferta zapisana. Wczytaj zmieniony zapis w ETS2 i odbierz ładunek w firmie. Masa wynika z definicji towaru i zachowanej liczby jednostek; system porówna ją z tonami zlecenia.'};
}
function importFile(file,job){
 if(path.basename(file).toLowerCase()!=='game.sii')throw Error('Wybierz plik game.sii');
 const bytes=fs.readFileSync(file);if(bytes.length>maxSaveBytes)throw Error('Zapis zbyt duży');const original=decodeSave(bytes);const result=plan(original,job);
 if(!fs.readFileSync(file).equals(bytes))throw Error('Gra zmieniła zapis podczas importu. Wróć do menu profili.');
 const suffix=Date.now()+'-'+crypto.randomBytes(4).toString('hex'),backup=file+'.nowaczyk-'+suffix+'.bak',tmp=file+'.nowaczyk-'+suffix+'.tmp';
 fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
 try{fs.writeFileSync(tmp,result.text,{encoding:'utf8',flag:'wx'});if(!fs.readFileSync(file).equals(bytes))throw Error('Zapis zmienił się podczas importu. Nie został nadpisany.');fs.renameSync(tmp,file)}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}
 const {text,...details}=result;return {...details,backup};
}
module.exports={plan,importFile,decodeSave};
