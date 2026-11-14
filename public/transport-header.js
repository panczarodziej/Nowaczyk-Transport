'use strict';
(function mountTransportHeader(){
 const titles={
  'system.html':'Zarządzanie transportem','firma.html':'Moja firma','podwykonawcy.html':'Podwykonawcy',
  'wnioski.html':'Wnioski','budzety.html':'Budżety firm','moj-panel.html':'Panel kierowcy','driver.html':'Panel kierowcy','gielda.html':'Giełda',
  'centrum-floty.html':'Mapa kierowców','flota-online.html':'Flota','trasy.html':'Przydzielone trasy',
  'uzytkownicy.html':'Role pracowników','naczepy.html':'Naczepy','admin.html':'Rekrutacja',
  'ekonomia.html':'Ekonomia','dokumenty.html':'Dokumenty','spedytor.html':'Dyspozytornia'
 };
 const title=titles[location.pathname.slice(1)];
 if(!title)return;
 const header=document.querySelector('body > header, .topbar')||document.createElement('header');
 if(!header.isConnected)document.body.prepend(header);
 if(header.firstElementChild?.matches('h1,h2,strong'))header.firstElementChild.remove();
 else if(header.firstChild?.nodeType===Node.TEXT_NODE)header.firstChild.remove();
 const actions=document.createElement('div');
 actions.className='transport-heading-actions';
 actions.append(...header.childNodes);
 const brand=document.createElement('a');
 brand.className='transport-wordmark';
 brand.href='/';
 brand.textContent='Nowaczyk System';
 const heading=document.createElement('span');
 heading.className='transport-heading-title';
 heading.textContent=title;
 header.classList.add('transport-heading');
 header.append(brand,heading,actions);
 const notifications=document.createElement('details');

 notifications.style.cssText='position:relative;color:white';
 const toggle=document.createElement('summary');
 toggle.textContent='Powiadomienia ';
 const badge=document.createElement('strong');
 badge.hidden=true;
 badge.style.cssText='background:#b42335;color:white;border-radius:999px;padding:2px 7px;margin-left:4px';
 toggle.append(badge);
 const list=document.createElement('ul');
 list.style.cssText='position:absolute;right:0;top:100%;z-index:1100;width:min(340px,80vw);max-height:360px;overflow:auto;background:white;color:#183046;padding:12px;list-style:none;border:1px solid #d8e3eb;border-radius:8px;box-shadow:0 4px 16px #07375130';
 const notice=document.createElement('li');
 notice.textContent='Wczytywanie powiadomień…';
 list.append(notice);
 notifications.append(toggle,list);
 actions.prepend(notifications);
 async function refreshNotifications(){
  const response=await fetch('/api/notifications');
  if(!response.ok)throw Error('Nie udało się pobrać powiadomień.');
  const data=await response.json();

  badge.hidden=!data.unread;
  badge.textContent=data.unread;
  list.replaceChildren();
  if(!data.items.length){const empty=document.createElement('li');empty.textContent='Brak powiadomień.';list.append(empty)}
  for(const item of data.items){
   const row=document.createElement('li');
   const link=document.createElement('a');
   link.href=item.url;
   link.textContent=item.label;
   link.style.cssText='display:block;padding:8px;color:#146587;'+(item.read?'':'font-weight:700;background:#edf2f6');
   link.addEventListener('click',async event=>{
    if(item.read||event.ctrlKey||event.metaKey)return;
    event.preventDefault();
    try{
     const result=await fetch('/api/notifications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id}),keepalive:true});
     if(!result.ok)throw Error('Nie udało się oznaczyć powiadomienia.');
    }catch(error){
     notice.textContent=error.message;
     list.prepend(notice);
     return;
    }
    location.href=item.url;
    notifications.open=false;
    updateNotifications();
   });
   row.append(link);list.append(row);
  }
 }
 let loading=false;
 async function updateNotifications(){
  if(loading)return;
  loading=true;
  try{await refreshNotifications()}
  catch{notice.textContent='Nie udało się pobrać powiadomień. Spróbuj ponownie.';list.prepend(notice)}
  finally{loading=false}
 }
 notifications.addEventListener('toggle',()=>{if(notifications.open)updateNotifications()});
 window.addEventListener('focus',updateNotifications);
 window.addEventListener('requests-changed',updateNotifications);
 updateNotifications();
 setInterval(updateNotifications,10000);
})();
