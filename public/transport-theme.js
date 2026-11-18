'use strict';
(function(){
 const key='nowaczyk-theme',root=document.documentElement;
 const read=()=>{try{const value=localStorage.getItem(key);return value==='dark'||value==='light'?value:null}catch{return null}};
 const preferred=()=>window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
 let theme=read()||preferred(),button;
 function apply(value){theme=value;root.dataset.theme=value;root.style.colorScheme=value;if(button){button.textContent=value==='dark'?'☀ Jasny':'☾ Ciemny';button.setAttribute('aria-label',value==='dark'?'Włącz tryb jasny':'Włącz tryb ciemny');button.title='Aktualny motyw: '+(value==='dark'?'ciemny':'jasny');button.setAttribute('aria-pressed',String(value==='dark'))}}
 apply(theme);
 function mount(){
  button=document.createElement('button');button.type='button';button.className='nt-theme-toggle';
  button.addEventListener('click',()=>{const next=theme==='dark'?'light':'dark';try{localStorage.setItem(key,next)}catch{}apply(next)});
  apply(theme);
  function place(){
   const target=document.querySelector('.transport-heading-actions')||document.querySelector('body > header, body > .topbar, body > .layout > header');
   if(target){if(button.parentElement!==target)target.append(button);document.querySelector('.nt-theme-tools:empty')?.remove()}
   else if(!button.isConnected){const tools=document.createElement('div');tools.className='nt-theme-tools';tools.append(button);document.body.prepend(tools)}
  }
  place();new MutationObserver(place).observe(document.body,{childList:true,subtree:true});
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
 window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue==='dark'||event.newValue==='light'?event.newValue:preferred())});
 window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(!read())apply(preferred())});
})();
