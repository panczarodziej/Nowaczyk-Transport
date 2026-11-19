'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {expireRejectedApplications}=require('../application-retention');
test('rejected applications expire exactly 24 hours after decision, with legacy date fallback',()=>{
 const now=Date.parse('2026-11-19T17:00:00Z'),date=offset=>new Date(now-offset).toISOString(),day=86400000;
 const db={applications:[{id:'boundary',status:'Odrzucone',decidedAt:date(day)},{id:'recent',status:'Odrzucone',date:date(day*3),decidedAt:date(day-1)},{id:'legacy',status:'Odrzucone',date:date(day*2)},{id:'pending',status:'Nowe',date:date(day*10)},{id:'accepted',status:'Przyjęte',decidedAt:date(day*10)},{id:'unknown',status:'Odrzucone',date:'invalid'}]};
 assert.equal(expireRejectedApplications(db,now),true);assert.deepEqual(db.applications.map(a=>a.id),['recent','pending','accepted','unknown']);assert.equal(expireRejectedApplications(db,now),false);
});
