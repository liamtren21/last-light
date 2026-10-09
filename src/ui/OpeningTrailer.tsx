import {useEffect,useRef,useState} from 'react';
import timeline from '../game/opening-timeline.json';
export function OpeningTrailer({onClose}:{onClose:()=>void}){
 const video=useRef<HTMLVideoElement>(null),panel=useRef<HTMLDivElement>(null);
 const [blocked,setBlocked]=useState(false),[failed,setFailed]=useState(false),[muted,setMuted]=useState(false);
 const [caption,setCaption]=useState(timeline.segments[0]?.text??'');
 useEffect(()=>{
  const before=document.activeElement as HTMLElement|null;
  panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  video.current?.play().catch(()=>setBlocked(true));
  const pause=()=>{if(document.hidden)video.current?.pause();};document.addEventListener('visibilitychange',pause);
  return()=>{video.current?.pause();document.removeEventListener('visibilitychange',pause);before?.focus();};
 },[]);
 return <div className="opening-trailer" ref={panel} role="dialog" aria-modal="true" aria-label="LAST LIGHT opening film" onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();onClose();}
  if(event.key==='Tab'){
   const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary')??[]);
   const index=controls.indexOf(document.activeElement as HTMLElement);
   if(event.shiftKey&&index<=0){event.preventDefault();controls.at(-1)?.focus();}
   else if(!event.shiftKey&&index===controls.length-1){event.preventDefault();controls[0]?.focus();}
  }
 }}>
  <video ref={video} playsInline preload="metadata" muted={muted} poster="/assets/video/intro/opening-poster.jpg" onTimeUpdate={()=>{const frame=(video.current?.currentTime??0)*timeline.fps;setCaption(timeline.segments.find(s=>frame>=s.from&&frame<s.from+s.frames)?.text??'');}} onEnded={onClose} onError={()=>{video.current?.pause();setFailed(true);setBlocked(false);}} onPause={()=>{if(video.current&&!video.current.ended)setBlocked(true);}} onPlay={()=>setBlocked(false)} aria-label="The storm, Mira, and the promises you make together">
   <source src="/assets/video/intro/opening-v4.mp4" type="video/mp4" onError={()=>{video.current?.pause();setFailed(true);setBlocked(false);}}/>
   <track kind="captions" src="/assets/video/intro/opening-en.vtt" srcLang="en" label="English"/>
  </video>
  <p className="trailer-mobile-caption">{caption}</p>
  <div className="trailer-controls">
   {failed?<p role="status">The opening film could not load. You can begin the story.</p>:<>
    <button onClick={()=>{if(video.current?.paused)void video.current.play().catch(()=>setBlocked(true));else video.current?.pause();}}>{blocked?'PLAY FILM':'PAUSE'}</button>
    <button aria-pressed={muted} onClick={()=>setMuted(value=>!value)}>{muted?'ENABLE VOICE':'MUTE'}</button>
   </>}
   <button className="trailer-skip" onClick={onClose}>SKIP · BEGIN CROSSING →</button>
  </div>
  <details className="trailer-transcript"><summary>Read the opening story</summary>{timeline.segments.map(s=><p key={s.from}>{s.text}</p>)}</details>
 </div>;
}





