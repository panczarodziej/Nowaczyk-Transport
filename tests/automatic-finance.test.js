'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {processAutomatic}=require('../automatic-finance');
function seed(){return {accounts:[{username:'driver'},{username:'subdriver'}],initialBudgets:{nowaczyk:{initialCents:100000},partner:{initialCents:200000}},routes:[{id:'a',driver:'driver',companyId:'nowaczyk',drivenKm:1000,payRate:0.7,settledAt:'2026-10-31T20:00:00Z'},{id:'b',driver:'subdriver',companyId:'partner',drivenKm:1000,payRate:0.8,settledAt:'2026-10-31T20:00:00Z'}],companyLoans:{partner:{remainingCents:120000,createdAt:'2026-11-01T00:00:00Z'}},ledger:[]}}
test('payroll runs on the 10th, pays owning companies and wallets once; loans repeat monthly and catch up',()=>{
 const db=seed();db.archivedRoutes=[db.routes[0]];
 processAutomatic(db,'2026-11-09');assert.equal(db.payments.length,0);assert.equal(db.companyLoans.partner.automatic.nextDue,'2026-12-10');
 processAutomatic(db,'2026-11-10');assert.equal(db.wallets.driver,700);assert.equal(db.wallets.subdriver,800);assert.equal(db.payments.length,2);assert.equal(db.ledger.filter(e=>e.companyId==='partner'&&e.type==='wyplata')[0].amount,-800);
 assert.equal(processAutomatic(db,'2026-11-10'),false);
 processAutomatic(db,'2026-12-10');assert.equal(db.companyLoans.partner.remainingCents,110000);assert.equal(db.companyLoans.partner.automatic.nextDue,'2027-01-10');
 assert.equal(processAutomatic(db,'2026-12-10'),false);
 processAutomatic(db,'2027-02-15');assert.equal(db.companyLoans.partner.remainingCents,90000);assert.equal(db.companyLoans.partner.automatic.paid.length,3);
});
test('insufficient cash never debits funds or credits salary; refill retries; legacy manual pay is respected',()=>{
 const db=seed();db.initialBudgets.partner.initialCents=0;db.companyLoans={};
 processAutomatic(db,'2026-11-10');assert.equal(db.wallets.subdriver,undefined);assert.equal(db.pendingAutomaticPayments.length,1);assert.equal(db.pendingAutomaticPayments[0].status,'overdue');
 db.ledger.push({companyId:'partner',amount:1000});processAutomatic(db,'2026-11-10');assert.equal(db.wallets.subdriver,800);assert.equal(db.pendingAutomaticPayments.length,0);
 const legacy=seed();legacy.payments=[{driver:'driver',month:'2026-10',amount:700}];processAutomatic(legacy,'2026-11-10');assert.equal(legacy.wallets.driver,undefined);assert.equal(legacy.payments.filter(p=>p.driver==='driver').length,1);
});
test('startup credit instalments and final rounding clear principal without overpayment',()=>{
 const db={accounts:[],startupFinance:{p:{source:'credit',initialCents:100001,remainingCents:100001}},routes:[],ledger:[]};
 processAutomatic(db,'2026-11-20');processAutomatic(db,'2027-11-10');assert.equal(db.startupFinance.p.remainingCents,0);assert.equal(db.startupFinance.p.automatic.paid.length,12);assert.equal(Math.round(db.ledger.reduce((s,e)=>s-e.amount,0)*100),100001);
 assert.equal(processAutomatic(db,'2027-12-10'),false);
});
