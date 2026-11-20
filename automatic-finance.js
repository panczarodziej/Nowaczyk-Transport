'use strict';
const crypto=require('node:crypto'),{cash}=require('./fleet-finance');
const cents=value=>Math.round(Number(value||0)*100);
function nextPayday(today){const d=new Date(today+'T00:00:00Z');d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);return d.toISOString().slice(0,7)+'-10'}
function nextMonth(due){const d=new Date(due+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);return d.toISOString().slice(0,10)}
function processAutomatic(db,today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Warsaw'})){
 let changed=false;const at=new Date().toISOString();
 db.ledger??=[];db.payments??=[];
 // Pay accrued wages first; a credit instalment cannot consume the payroll funds first.
 const routes=[...new Map([...(db.archivedRoutes||[]),...(db.routes||[])].map(r=>[r.id,r])).values()];
 const groups=new Map();
 for(const r of routes){
  if(!r.settledAt&&!r.deliveredAt)continue;
  const month=String(r.settledAt||r.deliveredAt).slice(0,7);if(!/^\d{4}-\d{2}$/.test(month))continue;
  const due=nextPayday(month+'-01');if(due>today)continue;
  const driver=String(r.driver||'').toLowerCase(),companyId=r.companyId||'nowaczyk';
  if(!(db.accounts||[]).some(a=>a.username.toLowerCase()===driver))continue;
  const key=JSON.stringify([driver,companyId,month]);
  const group=groups.get(key)||{driver,companyId,month,due,baseCents:0,routeIds:[]};
  group.baseCents+=cents(Number(r.drivenKm||0)*Number(r.payRate??0.7));group.routeIds.push(r.id);groups.set(key,group);
 }
 const pending=[];
 for(const g of [...groups.values()].sort((a,b)=>a.due.localeCompare(b.due)||a.driver.localeCompare(b.driver))){
  // Legacy manual payments had no companyId: respect them instead of paying again.
  if(db.payments.some(p=>p.driver===g.driver&&p.month===g.month&&(!p.companyId||p.companyId===g.companyId)))continue;
  if(g.baseCents<=0)continue;
  if(cents(cash(db,g.companyId))<g.baseCents){pending.push({...g,amount:g.baseCents/100,status:'overdue'});continue}
  const amount=g.baseCents/100,id=crypto.randomUUID(),operationKey='payroll:'+JSON.stringify([g.companyId,g.driver,g.month]);
  if(db.ledger.some(e=>e.operationKey===operationKey))continue;
  db.wallets??={};db.wallets[g.driver]=(cents(db.wallets[g.driver])+g.baseCents)/100;
  db.payments.push({id,driver:g.driver,companyId:g.companyId,month:g.month,base:amount,calculatedBase:amount,bonus:0,deduction:0,amount,createdAt:at,due:g.due,automatic:true,routeIds:g.routeIds});
  db.ledger.push({id:crypto.randomUUID(),paymentId:id,companyId:g.companyId,driver:g.driver,type:'wyplata',amount:-amount,createdAt:at,operationKey,description:'Automatyczna wypłata za '+g.month});changed=true;
 }
 if(JSON.stringify(db.pendingAutomaticPayments||[])!==JSON.stringify(pending)){db.pendingAutomaticPayments=pending;changed=true}
 const loans=[...Object.entries(db.companyLoans||{}).map(([companyId,loan])=>({companyId,loan,kind:'company'})),...Object.entries(db.startupFinance||{}).filter(([,l])=>l.source==='credit').map(([companyId,loan])=>({companyId,loan,kind:'startup'}))];
 for(const {companyId,loan,kind} of loans){
  if(!(loan.remainingCents>0)){if(loan.automatic&&loan.automatic.status!=='paid'){loan.automatic.status='paid';changed=true}continue;}
  if(!loan.automatic){const originalDue=nextPayday(String(loan.createdAt||loan.lockedAt||today).slice(0,10));loan.automatic={id:crypto.randomUUID(),months:12,instalmentCents:Math.ceil(loan.remainingCents/12),nextDue:originalDue>=today?originalDue:nextPayday(today),paid:[]};changed=true}
  const schedule=loan.automatic;
  for(let i=0;loan.remainingCents>0&&schedule.nextDue<=today&&i<1200;i++){
   const due=schedule.nextDue,amountCents=Math.min(loan.remainingCents,schedule.instalmentCents),operationKey='loan:'+kind+':'+schedule.id+':'+due;
   if(cents(cash(db,companyId))<amountCents){if(schedule.status!=='overdue'){schedule.status='overdue';changed=true}break}
   if(!db.ledger.some(e=>e.operationKey===operationKey)){
    db.ledger.push({id:crypto.randomUUID(),companyId,type:'spłata kredytu',amount:-amountCents/100,createdAt:at,operationKey,description:'Automatyczna rata kredytu · '+due});
    loan.remainingCents-=amountCents;schedule.paid.push({due,amountCents,paidAt:at});
   }
   schedule.nextDue=nextMonth(due);schedule.status=loan.remainingCents>0?'active':'paid';changed=true;
  }
 }
 return changed;
}
module.exports={processAutomatic,nextPayday};
