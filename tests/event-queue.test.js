'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {stageEvent,claimCurrentEvents,eventResult}=require('../telemetry-app/event-queue');
test('pre-login delivery is claimed only by current login in same app run and server',()=>{
 const current=stageEvent({event:'job-delivered'},{driver:null,origin:'https://company',runId:'this-run'});
 const old={...current,captureRun:'old-run'},foreign={...current,origin:'https://other'},owned={...current,driver:'another-driver'};
 const queue=[current,old,foreign,owned];assert.equal(claimCurrentEvents(queue,{driver:'subboss',origin:'https://company',runId:'this-run'}),true);
 assert.equal(current.driver,'subboss');assert.equal(old.driver,null);assert.equal(foreign.driver,null);assert.equal(owned.driver,'another-driver');
 claimCurrentEvents(queue,{driver:'other',origin:'https://company',runId:'this-run'});assert.equal(current.driver,'subboss');
});
test('delivery errors cannot be masked by successful position updates and transport failures remain retryable',()=>{
 assert.equal(eventResult({ok:false,error:'Sesja wygasła'},'job-delivered').retry,true);
 assert.match(eventResult({ok:true,event:{checks:[{reasons:['Towar: niezgodność']}]}},'job-delivered').error,/Towar/);
 assert.match(eventResult({ok:true,event:{mileageRouteId:'route'}},'job-delivered').error,/dystansu/);
 assert.equal(eventResult({ok:true,event:{distanceKm:123}},'job-delivered').error,null);
});
