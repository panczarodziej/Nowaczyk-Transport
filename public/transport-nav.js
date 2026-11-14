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
  ['/system.html','Przegląd'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],
  ['/centrum-floty.html','Mapa kierowców'],['/flota-online.html','Flota'],['/dokumenty.html','Dokumenty'],
  ['/admin.html','Rekrutacja'],['/firma.html','Moja firma'],['/podwykonawcy.html','Podwykonawcy'],
  ['/uzytkownicy.html','Role pracowników'],['/naczepy.html','Naczepy'],['/budzety.html','Budżety firm'],
  ['/ekonomia.html','Ekonomia'],['/moj-panel.html','Panel kierowcy']
 ]:partner?[
  ['/firma.html','Moja firma'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],
  ['/centrum-floty.html','Mapa kierowców'],['/flota-online.html','Flota'],['/naczepy.html','Naczepy'],
  ['/dokumenty.html','Dokumenty'],['/admin.html','Rekrutacja'],['/ekonomia.html','Ekonomia'],
  ['/firma.html#companyDrivers','Kierowcy'],['/moj-panel.html#settings','Ustawienia konta'],['/moj-panel.html','Panel kierowcy']
 ]:[
  ...(user.dispatchAccess?[['/moj-panel.html','Mój panel']]:[]),['/spedytor.html','Dyspozytor'],['/gielda.html','Giełda'],['/trasy.html','Przydzielone trasy'],['/centrum-floty.html','Mapa kierowców']
 ];
 const menu=document.createElement('nav');
 menu.className='transport-nav persistent-menu';
 menu.setAttribute('aria-label','Zarządzanie transportem');
 for(const [href,label] of links){
  const link=document.createElement('a');
  link.href=href;
  link.textContent=label;
  if(location.pathname+location.hash===href)link.setAttribute('aria-current','page');
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
  if(header)header.append(switchView);
  else menu.prepend(switchView);
 }
 if(header)header.after(menu);
 else{
  const bar=document.createElement('header');
  bar.className='transport-bar';
  bar.textContent='Nowaczyk Transport';
  document.body.prepend(bar,menu);
 }
})().catch(error=>console.error('Nie udało się wczytać menu transportu.',error));
