const assert=require('node:assert/strict');const {validateJob}=require('../job-match');
const route={from:'Kraków',to:'Hamburg',sourceCompany:'Firma A',destinationCompany:'Firma B',cargo:'Puste palety',cargoTons:18.5};
const data={sourceCity:'Kraków',destinationCity:'Hamburg',sourceCompany:'Firma A',destinationCompany:'Firma B',cargo:'Puste palety',cargoMassKg:18500};
assert.equal(validateJob(route,data).match,true);
assert.equal(validateJob(route,{...data,cargoMassKg:15000}).match,false);
assert.equal(validateJob(route,{...data,sourceCompany:'Inna firma'}).match,false);
assert.equal(validateJob(route,{...data,destinationCity:''}).match,false);
assert.equal(validateJob(route,{...data,cargoMassKg:NaN}).match,false);
console.log('5 testów zgodności zleceń: OK');
