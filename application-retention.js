'use strict';
function expireRejectedApplications(db,now=Date.now()){
 const previous=db.applications||[];
 db.applications=previous.filter(application=>{
  if(application.status!=='Odrzucone')return true;
  const decided=Date.parse(application.decidedAt||application.date);
  return !Number.isFinite(decided)||now-decided<24*60*60*1000;
 });
 return db.applications.length!==previous.length;
}
module.exports={expireRejectedApplications};
