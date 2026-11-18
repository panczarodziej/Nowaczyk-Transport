'use strict';
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const money=v=>Math.round((v+Number.EPSILON)*100)/100;
const monthOf=v=>String(v||'').slice(0,7);
const completed=r=>!!(r.settledAt||r.deliveredAt||r.status==='Zakończona');
const CAPITAL=new Set(['kredyt firmowy','spłata kredytu','zakup_pojazdu','sprzedaz_pojazdu','finansowanie_poczatkowe','wpłata leasingowa']);
function report(db,companyId,month,today,reviewAll=false){
 const companies=db.companies||[],accounts=db.accounts||[];
 const routes=[...new Map([...(db.archivedRoutes||[]),...(db.routes||[])].filter(r=>r.companyId===companyId).map(r=>[r.id,r])).values()];
 const routeById=new Map(routes.map(r=>[r.id,r]));
 const expenseCompany=e=>e.companyId||routeById.get(e.routeId)?.companyId;
 const ledger=(db.ledger||[]).filter(e=>(e.companyId||'nowaczyk')===companyId);
 const expenses=(db.expenses||[]).filter(e=>expenseCompany(e)===companyId);
 const period=r=>monthOf(r.deliveredAt||r.settledAt)===month;
 const done=routes.filter(r=>completed(r)&&period(r));
 const cashEntries=ledger.filter(e=>monthOf(e.createdAt)===month);
 const costs=expenses.filter(e=>monthOf(e.createdAt)===month);
 const revenue=money(done.reduce((s,r)=>s+num(r.freight),0));
 const accruedPay=money(done.reduce((s,r)=>s+num(r.drivenKm)*num(r.payRate??0.7),0));
 const payments=(db.payments||[]).filter(p=>(p.companyId||'nowaczyk')===companyId&&p.month===month);
 // Payroll cost is accrued on delivered work, not charged twice when paid.
 const wages=money(accruedPay+payments.reduce((s,p)=>s+num(p.bonus)-num(p.deduction),0));
 const isCapital=e=>CAPITAL.has(e.type)||/kredyt|kapitał|zakup pojazdu|sprzedaż pojazdu/i.test(e.type||'');
 const operatingLedger=cashEntries.filter(e=>num(e.amount)<0&&e.type!=='wyplata'&&!isCapital(e));
 const operatingCosts=money(costs.reduce((s,e)=>s+num(e.amount),0)+operatingLedger.reduce((s,e)=>s-num(e.amount),0));
 const km=money(done.reduce((s,r)=>s+num(r.drivenKm),0));
 const leaseInterest=money((db.fleetLeases||[]).filter(l=>l.companyId===companyId).flatMap(l=>l.schedule||[]).filter(p=>monthOf(p.due)===month&&p.due<=today).reduce((s,p)=>s+num(p.interest),0));
 const leaseCharges=operatingLedger.filter(e=>String(e.operationKey||'').startsWith('lease:')).reduce((s,e)=>s-num(e.amount),0);
 // Instalments move cash; only interest reduces the operating result here.
 const result=money(revenue-operatingCosts+leaseCharges-leaseInterest-wages);
 const start=num(db.initialBudgets?.[companyId]?.initialCents??db.startupFinance?.[companyId]?.initialCents)/100;
 const cash=money(start+ledger.reduce((s,e)=>s+num(e.amount),0)-expenses.reduce((s,e)=>s+num(e.amount),0));
 const cashIn=money(cashEntries.filter(e=>num(e.amount)>0).reduce((s,e)=>s+num(e.amount),0));
 const cashOut=money(costs.reduce((s,e)=>s+num(e.amount),0)-cashEntries.filter(e=>num(e.amount)<0).reduce((s,e)=>s+num(e.amount),0));
 const dues=[];
 for(const l of db.fleetLeases||[])if(l.companyId===companyId)for(const p of l.schedule||[])if(p.status!=='paid')dues.push({id:l.id+':'+p.number,kind:'Leasing',label:'Rata '+p.number,vehicleId:l.vehicleId,due:p.due,amount:num(p.amount),overdue:p.due<today,url:'/finanse-floty.html'});
 for(const p of db.fleetPolicies||[])if(p.companyId===companyId&&!p.paid&&!p.cancelledAt)dues.push({id:p.id,kind:'Ubezpieczenie',label:p.kind,vehicleId:p.vehicleId,due:p.due,amount:num(p.premium),overdue:p.due<today,url:'/finanse-floty.html'});
 const payroll=new Map();
 for(const r of done){const key=String(r.driver||'').toLowerCase();const d=payroll.get(key)||{driver:r.driver,routes:0,km:0,earned:0,paid:0};d.routes++;d.km+=num(r.drivenKm);d.earned+=num(r.drivenKm)*num(r.payRate??0.7);payroll.set(key,d)}
 for(const p of payments){const key=String(p.driver||'').toLowerCase();const d=payroll.get(key)||{driver:p.driver,routes:0,km:0,earned:0,paid:0};d.earned+=num(p.bonus)-num(p.deduction);d.paid+=num(p.amount);payroll.set(key,d)}
 const drivers=[...payroll.values()].map(d=>({...d,km:money(d.km),earned:money(d.earned),paid:money(d.paid),pending:money(Math.max(0,d.earned-d.paid))}));
 const vehicles=[...(db.fleet||[]).filter(v=>(v.companyId||'nowaczyk')===companyId).map(v=>({...v,kind:'Ciągnik'})),...(db.trailers||[]).filter(v=>(v.ownerCompanyId||'nowaczyk')===companyId).map(v=>({...v,kind:'Naczepa'}))];
 const fleet=vehicles.map(v=>{
  const jobs=done.filter(r=>v.kind==='Ciągnik'?r.vehicleId===v.id:r.trailerId===v.id);
  const routeIds=new Set(jobs.map(r=>r.id));
  const revenue=jobs.reduce((s,r)=>s+num(r.freight),0),pay=jobs.reduce((s,r)=>s+num(r.drivenKm)*num(r.payRate??0.7),0);
  const directCosts=costs.filter(e=>e.vehicleId===v.id||(v.kind==='Ciągnik'&&routeIds.has(e.routeId))).reduce((s,e)=>s+num(e.amount),0)+operatingLedger.filter(e=>e.vehicleId===v.id&&!String(e.operationKey||'').startsWith('lease:')).reduce((s,e)=>s-num(e.amount),0);
  const interest=(db.fleetLeases||[]).filter(l=>l.companyId===companyId&&l.vehicleId===v.id).flatMap(l=>l.schedule||[]).filter(p=>monthOf(p.due)===month&&p.due<=today).reduce((s,p)=>s+num(p.interest),0);
  return {id:v.id,plate:v.plate,model:v.model,kind:v.kind,routes:jobs.length,km:money(jobs.reduce((s,r)=>s+num(r.drivenKm),0)),revenue:money(revenue),costs:money(directCosts+pay+interest),margin:jobs.length?money(revenue-directCosts-pay-interest):null,registrationDueAt:v.registrationDueAt};
 });
 const decisions=[];
 for(const r of db.vehicleRequests||[])if((reviewAll||r.companyId===companyId)&&r.status==='pending')decisions.push({id:r.id,label:(reviewAll?(companies.find(c=>c.id===r.companyId)?.name||r.companyId)+' · ':'')+'Zakup: '+(r.model||r.brand||'pojazd'),createdAt:r.createdAt,url:'/wnioski.html',kind:'Pojazd'});
 for(const r of db.companyLoanRequests||[])if((reviewAll||r.companyId===companyId)&&r.status==='pending')decisions.push({id:r.id,label:'Kredyt: '+money(num(r.amountCents)/100)+' zł',createdAt:r.createdAt,url:'/wnioski.html',kind:'Finansowanie'});
 for(const r of db.shopOrders||[])if((r.companyId||accounts.find(a=>a.username?.toLowerCase()===String(r.driver).toLowerCase())?.companyId||'nowaczyk')===companyId&&r.status==='Oczekuje')decisions.push({id:r.id,label:r.name,createdAt:r.createdAt,url:'/ekonomia.html',kind:'Wyposażenie'});
 for(const [id,l] of Object.entries(db.trailerLicenses||{}))if((reviewAll||id===companyId)&&l.status==='pending')decisions.push({id:l.id,label:'Licencja na naczepy · '+(companies.find(c=>c.id===id)?.name||id),createdAt:l.createdAt,url:'/wnioski.html',kind:'Licencja'});
 const alerts=[];
 const stale=routes.filter(r=>!completed(r)&&r.acceptedAt&&Date.parse(r.acceptedAt)<Date.parse(today+'T00:00:00Z')-3*86400000);
 if(stale.length)alerts.push({label:'Przyjęte trasy bez dostawy od ponad 3 dni: '+stale.length,url:'/trasy.html',severity:'warning'});
 const unmapped=done.filter(r=>!r.vehicleId).length;
 if(unmapped)alerts.push({label:unmapped+' dostaw bez historycznego przypisania auta — poza rentownością pojazdów',url:'/trasy.html',severity:'info'});
 if(cash<0)alerts.push({label:'Ujemne saldo firmy. Sprawdź zaległe zobowiązania.',url:'/firma.html',severity:'warning'});
 const overdue=dues.filter(d=>d.overdue);
 if(overdue.length)alerts.push({label:overdue.length+' zaległych rat lub składek',url:'/finanse-floty.html',severity:'warning'});
 const maintenance=(db.maintenance||[]).filter(x=>x.companyId===companyId).map(x=>({...x,overdue:x.status==='planned'&&x.due<today}));
 if(maintenance.some(x=>x.overdue))alerts.push({label:'Zaległe terminy serwisu — sprawdź harmonogram',url:'#service',severity:'warning'});
 const days=Array.from({length:new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()},(_,i)=>{const day=month+'-'+String(i+1).padStart(2,'0');return {day,revenue:money(done.filter(r=>String(r.deliveredAt||r.settledAt).startsWith(day)).reduce((s,r)=>s+num(r.freight),0)),costs:money(costs.filter(e=>String(e.createdAt).startsWith(day)).reduce((s,e)=>s+num(e.amount),0)+operatingLedger.filter(e=>String(e.createdAt).startsWith(day)).reduce((s,e)=>s-num(e.amount),0))}});
 return {company:{id:companyId,name:companies.find(c=>c.id===companyId)?.name||companyId},month,today,generatedAt:new Date().toISOString(),summary:{cash,revenue,operatingCosts:money(operatingCosts-leaseCharges+leaseInterest),wages,result,margin:revenue?money(result/revenue*100):null,cashIn,cashOut,cashChange:money(cashIn-cashOut),km,deliveries:done.length,active:routes.filter(r=>!completed(r)).length,pendingPay:money(drivers.reduce((s,d)=>s+d.pending,0)),unmapped},drivers,fleet,dues:dues.sort((a,b)=>a.due.localeCompare(b.due)),decisions,alerts,days,maintenance,notes:['Wynik zarządczy przed podatkami i amortyzacją. Przychód według dostaw, wynagrodzenia według przejechanych kilometrów i zapisanej stawki.','Saldo obejmuje finansowanie i zakupy. Kredyt i zakup pojazdu nie są kosztem operacyjnym; leasing obciąża wynik odsetkami.','Rentowność obejmuje przypisane koszty. Starsze trasy bez zapisanego auta pozostają w wyniku firmy. Wyników ciągników i naczep nie należy sumować.']};
}
module.exports={report};
