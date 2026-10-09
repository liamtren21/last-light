import {useEffect,useRef,useState} from 'react';
export function ArrivalGate({busy,error,onName,onRestore,onBack,initialMode='name'}:{busy:boolean;error:string;onName:(name:string)=>void;onRestore:(code:string)=>void;onBack:()=>void;initialMode?:'name'|'restore'}){
  const [mode,setMode]=useState<'name'|'restore'>(initialMode);const [name,setName]=useState('');const [code,setCode]=useState('');
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{panel.current?.querySelector<HTMLInputElement>('input')?.focus();},[mode]);
  return <div className="crossing-gate"><div className="crossing-card arrival-card" ref={panel} role="dialog" aria-modal="true" aria-labelledby="arrival-title" onKeyDown={e=>{
    if(e.key!=='Tab')return;const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')??[]);
    const index=nodes.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&index<=0){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&index===nodes.length-1){e.preventDefault();nodes[0]?.focus();}
  }}>
    <p className="crossing-eyebrow">BEFORE THE CROSSING</p><h1 id="arrival-title">{mode==='name'?'What should Mira call you?':'Return to your story'}</h1><div className="crossing-ink-rule" aria-hidden="true"/>
    <p>{mode==='name'?'Choose a name for this crossing. Your story stays separate from everyone else’s, even if you share a name.':'Use your private recovery code to bring back your saved place and Mira’s memories.'}</p>
    <form onSubmit={e=>{e.preventDefault();if(!busy){if(mode==='name')onName(name.trim());else onRestore(code.trim());}}}>
      <label htmlFor="arrival-input">{mode==='name'?'Your name':'Recovery code'}</label>
      <input id="arrival-input" className="arrival-input" disabled={busy} value={mode==='name'?name:code} onChange={e=>mode==='name'?setName(e.target.value):setCode(e.target.value)} autoComplete="off" maxLength={mode==='name'?60:200} placeholder={mode==='name'?'A name to remember…':'Your private code…'} required />
      <button className="crossing-primary" disabled={busy||!(mode==='name'?name.trim():code.trim())} type="submit">{busy?'Keeping your place…':mode==='name'?'Begin my crossing':'Restore my crossing'} <span aria-hidden="true">→</span></button>
    </form>
    <button className="crossing-secondary" disabled={busy} onClick={()=>setMode(mode==='name'?'restore':'name')}>{mode==='name'?'I have a recovery code':'Start with a new name'}</button>
    <button className="crossing-secondary" disabled={busy} onClick={onBack}>Back</button>
    {error&&<p role="alert" className="arrival-error">{error}</p>}
    <p className="crossing-footnote">A name is how Mira addresses you. Your private session identifies your story.</p>
  </div></div>;
}
