'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runningGameLocation}=require('../telemetry-app/game-location');
test('finds the actual running x64 ETS2 installation across Steam libraries and custom folders',()=>{
 for(const folder of ['D:\\SteamLibrary\\steamapps\\common\\Euro Truck Simulator 2','C:\\Gry z polskimi znakami ł\\ETS2']){
  const location=runningGameLocation(JSON.stringify({ExecutablePath:folder+'\\bin\\win_x64\\eurotrucks2.exe'}));assert.equal(location.folder,folder);assert.equal(location.unsupported,false);
 }
 assert.equal(runningGameLocation(JSON.stringify({ExecutablePath:'D:\\ETS2\\bin\\win_x86\\eurotrucks2.exe'})).unsupported,true);
 assert.equal(runningGameLocation('[{"ExecutablePath":null}]').folder,null);
 assert.equal(runningGameLocation('null').folder,null);
 const conflict=runningGameLocation(JSON.stringify([{ExecutablePath:'C:\\ETS2\\bin\\win_x64\\eurotrucks2.exe'},{ExecutablePath:'D:\\ETS2\\bin\\win_x64\\eurotrucks2.exe'}]));assert.equal(conflict.ambiguous,true);assert.equal(conflict.folder,null);
});
