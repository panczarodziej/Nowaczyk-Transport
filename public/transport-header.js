'use strict';
(function mountTransportHeader(){
 const titles={
  'system.html':'Zarządzanie transportem','firma.html':'Moja firma','podwykonawcy.html':'Podwykonawcy',
  'budzety.html':'Budżety firm','moj-panel.html':'Panel kierowcy','driver.html':'Panel kierowcy','gielda.html':'Giełda',
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
})();
