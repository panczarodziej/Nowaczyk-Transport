'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeSettings,positionPayload}=require('../telemetry-app/telemetry-sync');
test('fresh and legacy installations sync by default without overriding an explicit opt out',()=>{
 for(const saved of [null,{},[],{etsPath:'D:\\ETS2'},{autoSync:undefined}])assert.equal(normalizeSettings(saved).autoSync,true);
 assert.equal(normalizeSettings({autoSync:false}).autoSync,false);
 assert.equal(normalizeSettings({etsPath:'D:\\ETS2'}).etsPath,'D:\\ETS2');
 assert.equal(normalizeSettings({server:'https://nowaczyk-transport.onrender.com'}).server,'https://nowaczyk-transport-6kth.onrender.com');
});
test('local reception without usable coordinates does not pretend to publish a map position',()=>{
 assert.equal(positionPayload(null,10000).ok,false);
 assert.equal(positionPayload({receivedAt:10000,speedKmh:50},10000).ok,false);
 assert.equal(positionPayload({receivedAt:10000,worldX:0,worldZ:0},10000).ok,false);
 assert.equal(positionPayload({receivedAt:10000,worldX:10,worldZ:20},26000).ok,false);
 const p=positionPayload({receivedAt:10000,worldX:0,worldZ:20,speedKmh:50,onJob:true},10001);
 assert.equal(p.ok,true);assert.equal(p.payload.x,0);assert.equal(p.payload.z,20);assert.equal(p.payload.speedKmh,50);assert.equal(p.payload.activity,'Jazda');
});
