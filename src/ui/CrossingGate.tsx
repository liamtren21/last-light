import {useEffect,useRef} from 'react';

export const chapterNames:Record<number,string>={1:'First Contact',2:'The Return',3:'The Last Signal'};
export function CrossingGate({kind,chapter,hasSave,pending,onContinue,onNew,onRestore,onTrailer}:{kind:'cover'|'chapter';chapter:number;hasSave:boolean;pending:boolean;onContinue:()=>void;onNew:()=>void;onRestore?:()=>void;onTrailer?:()=>void}){
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{const before=document.activeElement as HTMLElement|null;panel.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>before?.focus();},[kind,chapter]);
  return <div className={`crossing-gate gate-${kind}`}>
    <div className="crossing-card" ref={panel} role="dialog" aria-modal="true" aria-labelledby="crossing-title" onKeyDown={event=>{
      if(event.key!=='Tab')return;
      const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(event.shiftKey&&index<=0){event.preventDefault();buttons.at(-1)?.focus();}else if(!event.shiftKey&&index===buttons.length-1){event.preventDefault();buttons[0]?.focus();}
    }}>
      <p className="crossing-eyebrow">{kind==='cover'?'A crossing in three chapters':`CHAPTER ${String(chapter).padStart(2,'0')}`}</p>
      <h1 id="crossing-title">{kind==='cover'?'LAST LIGHT':chapterNames[chapter]}</h1>
      <div className="crossing-ink-rule" aria-hidden="true" />
      <p>{kind==='cover'?'The tide is rising. Six people wait for a ferry, and the coast has gone quiet. Meet Mira at the shelter and decide what comes next.':chapter===1?'A map, a waiting ferry, and a little daylight.':chapter===2?'Back under the roof. A chance to compare what we found.':'One warning left. We need to choose it carefully.'}</p>
      {kind==='cover'&&hasSave&&<p className="crossing-saved">Saved place · {chapterNames[chapter]}</p>}
      <button className="crossing-primary" disabled={pending} onClick={onContinue}>{kind==='chapter'?'Enter chapter':hasSave?'Continue crossing':'Begin crossing'} <span aria-hidden="true">→</span></button>
      {kind==='cover'&&hasSave&&<button className="crossing-secondary" disabled={pending} onClick={onNew}>Begin a new crossing</button>}
      {kind==='cover'&&onRestore&&<button className="crossing-secondary" disabled={pending} onClick={onRestore}>Restore a saved crossing</button>}
      {kind==='cover'&&onTrailer&&<button className="crossing-secondary" disabled={pending} onClick={onTrailer}>Watch the opening film</button>}
      <p className="crossing-footnote">{kind==='cover'?'A story about what we choose, and what we keep.':'Your choices are saved. Take your time.'}</p>
    </div>
  </div>;
}
