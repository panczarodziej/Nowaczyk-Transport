'use strict';
(async function mountTransportMenu(){
 const response=await fetch('/api/accounts/me');
 if(!response.ok)return;
 const {user}=await response.json();
 if(!user)return;
 const main=user.role==='admin'||(user.role==='boss'&&user.companyId==='nowaczyk');
 const partner=user.role==='subcontractor'||(user.role==='boss'&&!main);
 const dispatcher=user.role==='dispatcher'||user.dispatchAccess;
 if(!main&&!partner&&!dispatcher)return;

 const links=main?[
  ['/system.html','Przegląd'],['/biuro-zarzadu.html','Biuro zarządu'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],
  ['/centrum-floty.html','Mapa kierowców'],['/flota-online.html','Flota'],['/dokumenty.html','Dokumenty'],
  ['/wnioski.html','Wnioski'],['/admin.html','Rekrutacja'],['/firma.html','Moja firma'],['/podwykonawcy.html','Podwykonawcy'],
  ['/uzytkownicy.html','Role pracowników'],['/naczepy.html','Naczepy'],['/budzety.html','Budżety firm'],
  ['/ekonomia.html','Ekonomia'],['/moj-panel.html','Panel kierowcy'],['/telemetry.html','Aplikacja Windows']
 ]:partner?[
  ['/firma.html','Moja firma'],['/biuro-zarzadu.html','Biuro zarządu'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],
  ['/centrum-floty.html','Mapa kierowców'],['/flota-online.html','Flota'],['/naczepy.html','Naczepy'],
  ['/dokumenty.html','Dokumenty'],['/wnioski.html','Wnioski'],['/admin.html','Rekrutacja'],['/ekonomia.html','Ekonomia'],
  ['/firma.html#companyDrivers','Kierowcy'],['/moj-panel.html#settings','Ustawienia konta'],['/moj-panel.html','Panel kierowcy'],['/telemetry.html','Aplikacja Windows']
 ]:[
  ['/moj-panel.html','Mój panel'],['/spedytor.html','Dyspozytor'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],['/centrum-floty.html','Mapa kierowców']
 ];
 const menu=document.createElement('nav');
 menu.className='transport-nav persistent-menu';
 menu.setAttribute('aria-label','Zarządzanie transportem');
 for(const [href,label] of links){
  const link=document.createElement('a');
  link.href=href;
  link.textContent=label;
  if((href.includes('#')?location.pathname+location.hash:location.pathname)===href)link.setAttribute('aria-current','page');
  menu.append(link);
 }
 document.body.classList.add('has-transport-menu');
 const shell=document.querySelector('.transport-shell, body[data-view="gielda"] .layout, body[data-view="spedytor"] .layout');
 const oldMenu=shell?.querySelector(':scope > aside');
 if(oldMenu){
  const logout=oldMenu.querySelector('a[href="#"]');
  if(logout)menu.append(logout);
  oldMenu.remove();
 }
 const header=document.querySelector('body > header');
 if(main||partner){
  const switchView=document.createElement('a');
  switchView.href='/moj-panel.html';
  switchView.textContent='Widok kierowcy →';
  switchView.style.marginLeft='auto';
  (header?.querySelector('.transport-heading-actions')||header||menu).append(switchView);
 }
 if(partner){
  const logout=document.createElement('button');
  logout.type='button';
  logout.textContent='Wyloguj';
  logout.className='transport-partner-logout';
  logout.style.cssText='background:#17698e;color:white;border:0;border-radius:5px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer;margin-left:12px';
  logout.addEventListener('click',async()=>{
   logout.disabled=true;logout.textContent='Wylogowywanie…';
   try{
    const response=await fetch('/api/logout',{method:'POST',credentials:'same-origin'});
    if(!response.ok)throw Error('Nie udało się wylogować.');
    location.replace('/');
   }catch(error){logout.disabled=false;logout.textContent='Wyloguj';alert(error.message)}
  });
  (header?.querySelector('.transport-heading-actions')||header||menu).append(logout);
 }
 if(header)header.after(menu);
 else{
  const bar=document.createElement('header');
  bar.className='transport-bar';
  bar.textContent='Nowaczyk Transport';
  document.body.prepend(bar,menu);
 }
})().catch(error=>console.error('Nie udało się wczytać menu transportu.',error));

