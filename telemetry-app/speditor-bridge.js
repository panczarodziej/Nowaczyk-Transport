'use strict';
// Safe dispatcher-to-Speditor handoff. Does not edit ETS2 saves.
const fs=require('node:fs');
const path=require('node:path');
function value(x){return String(x??'').trim().slice(0,180)}
function prepare(raw,folder){
 const r=raw&&raw.route?raw.route:raw;
 if(!r||typeof r!=='object')throw Error('Brak danych zlecenia');
 const fields={id:value(r.id||r.routeId),from:value(r.from?.city||r.from||r.sourceCity||r.origin),to:value(r.to?.city||r.to||r.destinationCity||r.destination),sourceCompany:value(r.from?.company||r.sourceCompany||r.fromCompany),destinationCompany:value(r.to?.company||r.destinationCompany||r.toCompany),cargo:value(r.cargo?.name||r.cargo||r.cargoName),massKg:Number(r.massKg??r.cargoMassKg??r.weightKg??(Number(r.cargo?.tons??r.cargoTons??0)*1000)),mapProfile:value(raw.mapProfile||r.mapProfile)};
 if(!fields.from||!fields.to||!fields.cargo)throw Error('Zlecenie nie zawiera miasta początkowego, końcowego lub ładunku');
 if(!Number.isFinite(fields.massKg)||fields.massKg<0)throw Error('Nieprawidłowa masa ładunku');
 if(!['promods','promods-pr',''].includes(fields.mapProfile))throw Error('Nieznany wariant mapy');
 const instructions=[
 'NOWACZYK TRANSPORT — KARTA ZLECENIA DLA VIRTUAL SPEDITORA',
 'Numer: '+fields.id,
 'Mapa: '+(fields.mapProfile==='promods'?'ProMods 2.83':fields.mapProfile==='promods-pr'?'ProMods 2.83 + Poland Rebuilding 3.0':'Nieokreślona'),
 'Source: '+fields.from,'Source company: '+(fields.sourceCompany||'Wybierz zgodną firmę'),
 'Destination: '+fields.to,'Destination company: '+(fields.destinationCompany||'Wybierz zgodną firmę'),
 'Cargo: '+fields.cargo,'Masa zlecenia: '+(fields.massKg?fields.massKg+' kg':'Nie podano'),
 '',
 'WAŻNE: Virtual Speditor może oferować tylko ładunki i firmy istniejące w danej mapie.',
 'Waga w ETS2 jest określana przez definicję ładunku; wpis na tej karcie jej nie zmienia.',
 'Wybierz profil, dodaj kurs, zapisz i ponownie wczytaj profil ETS2.',
 'Ten plik NIE modyfikuje zapisu ETS2 i NIE oznacza dostawy jako wykonanej.'
 ].join('\r\n');
 fs.mkdirSync(folder,{recursive:true});
 const safe=fields.id.replace(/[^a-z0-9_-]/gi,'').slice(0,60)||Date.now().toString();
 const dest=path.join(folder,'nowaczyk-kurs-'+safe+'.txt');
 fs.writeFileSync(dest,instructions,'utf8');
 return {path:dest,fields};
}
module.exports={prepare};
