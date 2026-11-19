'use strict';
const path=require('node:path').win32;
function runningGameLocation(json){
 const data=JSON.parse(json||'null'),rows=Array.isArray(data)?data:[data];
 const folders=new Set();let unsupported=false;
 for(const row of rows){
  const exe=row?.ExecutablePath;
  if(typeof exe!=='string'||path.basename(exe).toLowerCase()!=='eurotrucks2.exe')continue;
  const bin=path.dirname(exe);
  if(path.basename(bin).toLowerCase()==='win_x64'&&path.basename(path.dirname(bin)).toLowerCase()==='bin')folders.add(path.dirname(path.dirname(bin)));
  else unsupported=true;
 }
 return {folder:folders.size===1?[...folders][0]:null,ambiguous:folders.size>1,unsupported};
}
module.exports={runningGameLocation};
