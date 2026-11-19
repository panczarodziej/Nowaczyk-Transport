'use strict';
const crypto=require('node:crypto');
function stageEvent(packet,{driver,origin,runId}){
 return {...packet,driver:driver||null,origin,captureRun:runId,type:packet.event,eventKey:crypto.randomUUID()};
}
function claimCurrentEvents(events,{driver,origin,runId}){
 let changed=false;
 for(const event of events)if(!event.driver&&event.origin===origin&&event.captureRun===runId){event.driver=driver;changed=true}
 return changed;
}
function eventResult(reply,type){
 if(!reply.ok)return {retry:true,error:reply.error||'Serwer odrzucił zdarzenie telemetrii'};
 const event=reply.event;
 if(type==='job-delivered'&&!event?.distanceKm){
  const reasons=(event?.checks||[]).flatMap(check=>check.reasons||[]);
  return {retry:false,error:event?.mileageRouteId?'Dostawa odebrana, ale brak prawidłowego dystansu z ETS2.':'Dostawa odebrana, ale nie pasuje do przyjętej trasy. '+[...new Set(reasons)].join('; ')};
 }
 return {retry:false,error:null};
}
module.exports={stageEvent,claimCurrentEvents,eventResult};
