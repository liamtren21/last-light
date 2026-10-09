import {useEffect} from 'react';

/** Some mobile browsers resize only visualViewport, leaving dvh unchanged. */
export function useKeyboardViewport(){
 useEffect(()=>{
  const viewport=window.visualViewport;
  if(!viewport)return;
  const root=document.documentElement;
  let frame=0;
  const reset=()=>{
   delete root.dataset.keyboard;
   root.style.removeProperty('--keyboard-height');
   root.style.removeProperty('--keyboard-top');
  };
  const update=()=>{
   const active=document.activeElement;
   const editable=active instanceof HTMLTextAreaElement||
    (active instanceof HTMLInputElement&&!['button','checkbox','radio','submit','range','color','file','hidden'].includes(active.type));
   // Exclude pinch zoom and small browser toolbar changes. Focus alone must
   // never compact the scene when a hardware keyboard is in use.
   // Native pointer focus reaches SEND before click. Keep its geometry stable
   // until the keyboard closes rather than reflowing beneath the finger.
   const controlFocus=root.dataset.keyboard==='open'&&active instanceof HTMLButtonElement;
   const keyboard=window.innerWidth<=700&&(editable||controlFocus)&&Math.abs(viewport.scale-1)<.05&&
    window.innerHeight-viewport.height>120;
   if(!keyboard){reset();return;}
   root.dataset.keyboard='open';
   root.style.setProperty('--keyboard-height',`${viewport.height}px`);
   root.style.setProperty('--keyboard-top',`${viewport.offsetTop}px`);
   // Native focus scrolling can precede the keyboard resize. Keep the newly
   // focused field inside its own paper/card after the available height changes.
   if(active instanceof HTMLElement){
    const bounds=active.getBoundingClientRect();
    const paper=active.closest('.dialogue-paper');
    const composer=paper?.querySelector('.composer');
    const bottom=composer&&!composer.contains(active)?
     Math.min(viewport.offsetTop+viewport.height,composer.getBoundingClientRect().top):viewport.offsetTop+viewport.height;
    // Leave an 8px reading/caret gutter above the OS keyboard, rather than
    // aligning a fractional field edge to the exact viewport boundary.
    if(bounds.bottom>bottom-8||bounds.top<viewport.offsetTop+8)
     active.scrollIntoView({block:'nearest',inline:'nearest'});
   }
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
  viewport.addEventListener('resize',schedule);
  viewport.addEventListener('scroll',schedule);
  window.addEventListener('resize',schedule);
  document.addEventListener('focusin',schedule);
  document.addEventListener('focusout',schedule);
  schedule();
  return ()=>{
   cancelAnimationFrame(frame);reset();
   viewport.removeEventListener('resize',schedule);
   viewport.removeEventListener('scroll',schedule);
   window.removeEventListener('resize',schedule);
   document.removeEventListener('focusin',schedule);
   document.removeEventListener('focusout',schedule);
  };
 },[]);
}
