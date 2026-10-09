import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Availability } from './api/client';
import { story, initialState, availableChoices } from './game/story';
import type { GameState } from './game/schema';
import { ShoreAmbience } from './game/ambience';
import { MiraSprite, SpriteBackdrop, expressions, type MiraExpression } from './game/SpriteScene';
import { DialogueReader } from './ui/DialogueReader';
import { InkIcon } from './ui/InkIcon';
import {CrossingGate,chapterNames} from './ui/CrossingGate';
import {ArrivalGate} from './ui/ArrivalGate';
import {witnessedScenes} from './game/recap';
import {presentationFor} from './game/presentation';
import {needsCooperation,cooperationComplete} from './game/cooperation';
import {CooperationPanel} from './ui/CooperationPanel';
import {useKeyboardViewport} from './ui/useKeyboardViewport';
import {DeviceTransfer} from './ui/DeviceTransfer';
import {takeRecoveryLink,recoveryCodeFrom} from './ui/recovery-link';
import {OpeningTrailer} from './ui/OpeningTrailer';

const incomingRecovery=takeRecoveryLink();
let initialSession: ReturnType<typeof api.game> | undefined;

type View = 'game' | 'journal' | 'settings';
export function App() {
  useKeyboardViewport();
  const [state, setState] = useState<GameState>(initialState());
  const [availability, setAvailability] = useState<Availability>({ llm: false, memory: false, durableSave: false, reasons: [] });
  const [view, setView] = useState<View>('game');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [cooperationBusy,setCooperationBusy]=useState(false);
  const [notice, setNotice] = useState('');
  const [reply, setReply] = useState('');
  const [replyExpression,setReplyExpression]=useState<MiraExpression|null>(null);
  const [proposedAction, setProposedAction] = useState<string | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<'not_configured' | 'empty' | 'recalled' | 'unavailable' | ''>('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryDraft, setRecoveryDraft] = useState('');
  const [transferCode,setTransferCode]=useState(incomingRecovery);
  const [memoryJobs, setMemoryJobs] = useState<Array<{ memory_id: string; status: string; error_code: string | null; recall_verified: boolean;retryable:boolean;forgotten:boolean }>>([]);
  const [started, setStarted] = useState(false);
  const [cover,setCover]=useState(true);
  const [opening,setOpening]=useState<'begin'|'replay'|null>(null);
  const openingSeen=useRef(false);
  const [arrival,setArrival]=useState(false);
  const [arrivalMode,setArrivalMode]=useState<'name'|'restore'>('name');
  const [arrivalError,setArrivalError]=useState('');
  const nameTurn=useRef(crypto.randomUUID());
  const [chapterCard,setChapterCard]=useState<number|null>(null);
  const [transitioning,setTransitioning]=useState(false);
  const [readLine, setReadLine] = useState('');
  const [chatStage,setChatStage]=useState('');
  const chatAbort=useRef<AbortController|null>(null);
  const retryTurn=useRef<{message:string;version:number;id:string}|null>(null);
  const greeted=useRef(false);
  const composing = useRef(false);
  const [sound, setSound] = useState(false);
  const [motion, setMotion] = useState(true);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const [signalActivated, setSignalActivated] = useState(false);
  const [cooperationConsequence,setCooperationConsequence]=useState('');
  const [cooperationGesture,setCooperationGesture]=useState<'map-point'|'radio-check'|'wait'|undefined>();
  const [gestureSequence,setGestureSequence]=useState(0);
  const activateSignal=useCallback(()=>setSignalActivated(true),[]);
  const ambience = useRef<ShoreAmbience | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scene = useMemo(() => story[state.sceneId] ?? story['ferry-first'], [state.sceneId]);
  const choices = availableChoices(state);
  const lineIdentity = `${state.version}:${scene.id}`;
  const lineComplete = readLine === lineIdentity;
  const gated=cover||chapterCard!==null||opening!==null;
  const recap=useMemo(()=>witnessedScenes(state),[state]);
  const cooperationBlocked=needsCooperation(state)&&!cooperationComplete(state);
  useEffect(()=>{setCooperationConsequence('');setCooperationGesture(undefined);},[state.sceneId]);
  useEffect(()=>{if(scene.id!=='ending-signal')setSignalActivated(false);},[scene.id]);
  useEffect(()=>setReplyExpression(null),[state.sceneId,state.version]);
  useEffect(()=>ambience.current?.setScene(scene.background),[scene.background]);
  useEffect(()=>{void ambience.current?.setEnabled(sound&&!opening);},[sound,opening]);

  useEffect(() => {
    initialSession ??= api.game().catch(() => api.start());
    initialSession.then((data) => { setState(data.state); setAvailability(data.availability); setStarted(true); }).catch(() => { initialSession = undefined; setNotice('The story service is not responding. Reload this page to try again.'); });
  }, []);
  useEffect(() => () => { ambience.current?.dispose(); ambience.current = null; }, []);
  useEffect(()=>()=>chatAbort.current?.abort(),[]);
  useEffect(() => {
    const update = () => setPageHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  async function toggleSound() {
    try { ambience.current ??= new ShoreAmbience(); ambience.current.setScene(scene.background); await ambience.current.setEnabled(!sound); setSound(!sound); }
    catch { setNotice('Sound could not start on this device.'); }
  }
  async function presentState(next:GameState){
    const target=story[next.sceneId];
    const changeChapter=target&&target.chapter!==scene.chapter;
    const fade=target&&(changeChapter||target.background!==scene.background)&&motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(fade){
      const profile=presentationFor(next.sceneId);
      await Promise.all([`/assets/sprites/${target.background}/frame-0.png`,`/assets/sprites/${profile.frameRoot??profile.sheet}/frame-${profile.idle}.png`].map(async src=>{const image=new Image();image.src=src;await image.decode();})).catch(()=>{});
      setTransitioning(true);await new Promise(resolve=>setTimeout(resolve,320));
    }
    setState(next);setReadLine('');
    if(changeChapter)setChapterCard(target.chapter);
    if(fade){await new Promise(resolve=>setTimeout(resolve,80));setTransitioning(false);}
  }
  async function enterCrossing(skipArrival=false){
    if(!skipArrival&&state.version===0&&!openingSeen.current){setOpening('begin');return;}
    if(!skipArrival){
      setPending(true);
      try{const profile=await api.onboarding();if(!profile.named){setArrivalMode('name');setArrival(true);setArrivalError('');return;}}
      catch{setNotice('Your saved identity could not be checked. Please try again.');return;}
      finally{setPending(false);}
    }
    setCover(false);if(state.version===0)setChapterCard(scene.chapter);
    if(greeted.current||!availability.llm||!availability.memory)return;
    greeted.current=true;setPending(true);setChatStage('recalling');
    const controller=new AbortController();chatAbort.current=controller;
    try{
      const greeting=await api.revisit(crypto.randomUUID(),state.version,controller.signal);
      if('dialogue' in greeting){setReply(greeting.dialogue);setReplyExpression(expressions.includes(greeting.expression as MiraExpression)?greeting.expression as MiraExpression:null);setMemoryStatus(greeting.memoryStatus);setProposedAction(greeting.proposedAction);}
    }catch{setNotice('Mira could not check her earlier notes. You can continue the crossing or ask her again.');}
    finally{setPending(false);setChatStage('');chatAbort.current=null;}
  }
  async function beginWithName(name:string){
    setPending(true);setArrivalError('');
    try{
      const result=await api.setName(name,nameTurn.current);
      setNotice(result.verified?'Your name has been saved and checked.':'Your name is waiting to be saved. Check the field journal for confirmation.');
      setArrival(false);setCover(false);if(state.version===0)setChapterCard(scene.chapter);
      // Never synthesize a Mira greeting from this form or an unconfirmed job.
    }catch(error){setArrivalError(error instanceof Error&&error.message==='INVALID_PLAYER_NAME'?'Use 1–60 letters, numbers, spaces, apostrophes or hyphens.':'Your name could not be saved. Keep it here and try again.');}
    finally{setPending(false);}
  }
  async function restoreBeforeCrossing(code:string){
    setPending(true);setArrivalError('');
    try{const result=await api.restore(recoveryCodeFrom(code,location.origin));setState(result.state);setAvailability(result.availability);setTransferCode('');setArrival(false);setCover(true);setView('game');setMemoryJobs([]);setRecoveryCode('');setMemoryStatus('');setDraft('');setChapterCard(null);setReply('');setReplyExpression(null);setProposedAction(null);greeted.current=false;setNotice('Your saved story was restored. Continue when you are ready.');initialSession=undefined;}
    catch{setArrivalError('That code could not be used. Check it and try again.');}
    finally{setPending(false);}
  }
  async function newStory() {
    if (pending) return;
    setPending(true);
    try {
      const data = await api.newCampaign(); setState(data.state); setAvailability(data.availability);
      setReply(''); setReplyExpression(null); setProposedAction(null); setDraft(''); setNotice(''); setView('game'); setMemoryJobs([]); setMemoryStatus('');
      setCover(true);setChapterCard(null);setReadLine('');nameTurn.current=crypto.randomUUID();greeted.current=false;
      openingSeen.current=false;
      initialSession = undefined;
    } catch { setNotice('A new crossing could not begin. Please try again.'); }
    finally { setPending(false); }
  }

  async function choose(choiceId: string) {
    if (pending||cooperationBusy||gated||transitioning) return;
    setPending(true); setNotice(''); setReply(''); setReplyExpression(null); setProposedAction(null);
    try {
      const data = await api.action({ choiceId, expectedVersion: state.version, clientActionId: crypto.randomUUID() });
      await presentState(data.state);
      ambience.current?.cue(scene.background==='signal'?'radio':'paper');
    } catch (error) {
      if(error instanceof Error&&error.message==='VERSION_CONFLICT') {
        try { const current=await api.game();setState(current.state);setAvailability(current.availability);setNotice('Your story changed in another tab. Your saved place is now up to date.'); }
        catch { setNotice('Your story changed in another tab. Reload this page to continue.'); }
      } else setNotice('That choice could not be saved. Please try again.');
    } finally { setPending(false); }
  }

  async function send() {
    const message = draft.trim();
    if (!message || pending||cooperationBusy||gated||transitioning) return;
    setPending(true); setNotice(''); setReply(''); setReplyExpression(null); setProposedAction(null);
    try {
      chatAbort.current=new AbortController();
      if(retryTurn.current?.message!==message||retryTurn.current?.version!==state.version)retryTurn.current={message,version:state.version,id:crypto.randomUUID()};
      const response = await api.chat(message, retryTurn.current.id, state.version,setChatStage,chatAbort.current.signal);
      setReply(response.dialogue); setProposedAction(response.proposedAction); setMemoryStatus(response.memoryStatus); setDraft('');
      if(/not what I meant|I (?:didn't|did not) mean|you misunderstood|I meant|ý tôi|hiểu nhầm|không phải vậy|sửa lại/iu.test(message))window.dispatchEvent(new Event('last-light:clarify-plan'));
      setReplyExpression(expressions.includes(response.expression as MiraExpression)?response.expression as MiraExpression:null);
      retryTurn.current=null;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setNotice(code === 'LLM_RATE_LIMITED' ? 'Conversation is temporarily busy. Your message is still here; please wait before trying again.' : code === 'LLM_UNAVAILABLE' ? 'Free conversation is unavailable right now.' : code === 'MEMORY_UNAVAILABLE' ? 'Mira could not reach her earlier notes. Your message is still here; try again.' : code === 'VERSION_CONFLICT' ? 'The story changed in another tab. Reload to continue.' : 'Mira could not answer just now. Your message is still here; try again.');
      input.current?.focus();
    } finally { setPending(false);setChatStage('');chatAbort.current=null; }
  }
  async function createRecoveryCode() {
    try { const result = await api.createRecovery(); setRecoveryCode(result.code); setNotice('Keep this code somewhere private. It restores your story on another device.'); }
    catch { setNotice('Recovery codes need the durable save service, which is not connected here.'); }
  }
  async function restoreRecoveryCode() {
    try { const result = await api.restore(recoveryCodeFrom(recoveryDraft,location.origin)); setState(result.state); setAvailability(result.availability); setView('game'); setRecoveryDraft(''); setNotice('Your saved story was restored.'); }
    catch { setNotice('That recovery code could not be used. Check the code and try again.'); }
  }
  async function openJournal() {
    setView('journal');
    try { const result = await api.memories(); setMemoryJobs(result.jobs); } catch { setMemoryJobs([]); }
  }
  async function retryMemory(memoryId: string) {
    try { await api.retryMemory(memoryId); setNotice('The memory save was queued for retry.'); await openJournal(); }
    catch { setNotice('This memory save cannot be retried right now.'); }
  }

  if (!started && !notice) return <main className="loading paper"><span className="ink-mark" aria-hidden="true">✦</span><p>Finding the shore…</p></main>;
  return <main className="game-shell" data-transition={transitioning?'out':'idle'}>
    <section className={`scene-art art-${scene.background}`} inert={gated} data-scene={scene.id} aria-label={scene.place} data-motion={motion ? 'on' : 'off'} data-paused={pageHidden}>
      <SpriteBackdrop background={scene.background} enabled={motion} paused={pageHidden||gated} lampLit={scene.ending==='signal'&&signalActivated} />
      <div className="weather-grain" />
      <header className="masthead"><a className="wordmark" href="#game" onClick={(event) => event.preventDefault()}>LAST LIGHT</a><span className="chapter-mark">{String(scene.chapter).padStart(2, '0')} / {scene.title}</span></header>
      <div className="scene-location">{scene.place}</div>
      <MiraSprite key={`${scene.id}:${gestureSequence}`} enabled={motion} paused={pageHidden||gated} sceneId={scene.id} onSignal={activateSignal} expression={replyExpression} cooperationGesture={cooperationGesture} />
      <nav className="top-controls" aria-label="Game controls">
        <button className="icon-control sound-control" aria-label={sound ? 'Mute shore ambience' : 'Enable shore ambience'} aria-pressed={sound} onClick={() => void toggleSound()}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 12L9 12 16 6 16 26 9 20 3 20Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5"/><path d={sound ? 'M21 10Q27 16 21 22M25 6Q34 16 25 26' : 'M22 12L29 21M29 12L22 21'} fill="none" stroke="currentColor" strokeWidth="1.7"/></svg></button>
        <button className="icon-control" aria-label="Open journal" onClick={() => void openJournal()}><InkIcon kind="journal" /></button>
        <button className="icon-control menu-control" aria-label="Open settings" onClick={() => setView('settings')}><InkIcon kind="menu" /></button>
      </nav>
    </section>

    <section className="dialogue-paper" data-view={view} inert={gated}>
      <img className="ink-frame" src="/assets/ui/paper-frame-v2.svg" aria-hidden="true" alt="" />
      {view === 'game' && <>
        <p className="speaker-label">MIRA <span className="availability-mark" title={availability.llm ? 'Provider credentials are configured; live conversation has not been verified' : 'Live conversation is unavailable'} aria-label={availability.llm ? 'Provider configured, not verified' : 'Live conversation unavailable'}>{availability.llm ? '●' : '○'}</span></p>
        {scene.checkpoint && <p className="chapter-checkpoint">CHAPTER {scene.chapter} COMPLETE · Your place is saved. Continue when you’re ready.</p>}
        {!gated&&<DialogueReader key={lineIdentity} keyboard={!transitioning} text={scene.mira} identity={lineIdentity} onComplete={() => setReadLine(lineIdentity)} onAdvance={scene.next && !pending && !cooperationBlocked ? () => void choose('continue') : undefined} />}
        {!gated&&state.gameplayVersion===2&&(needsCooperation(state)||scene.ending)&&<CooperationPanel key={`${scene.id}:${state.version}`} state={state} disabled={pending} onBusy={setCooperationBusy} onCommit={result=>{setState(result.state);setCooperationConsequence(result.consequence);if(result.gesture!=='wait'){setCooperationGesture(result.gesture);setGestureSequence(value=>value+1);}setReply('');setProposedAction(null);}}/>}
        {cooperationConsequence&&<p className="cooperation-consequence" role="status">{cooperationConsequence}</p>}
        {reply && <DialogueReader keyboard={false} text={reply} identity={`reply:${lineIdentity}:${reply}`} className="live-reply" />}
        {proposedAction && choices.some((choice) => choice.id === proposedAction) && <button className="proposed-action" onClick={() => void choose(proposedAction)}>Mira suggests: {choices.find((choice) => choice.id === proposedAction)?.text} <span>CONFIRM →</span></button>}
        {lineComplete && choices.length > 0 && <div className="suggestions" aria-label="Story choices">{choices.map((choice) => <button key={choice.id} className="suggestion" disabled={pending || cooperationBusy || !started} onClick={() => void choose(choice.id)}>{choice.text}</button>)}</div>}
        {reply && <p className="live-mark">A live reply from Mira</p>}
        {chatStage && <p className="memory-note" role="status">{chatStage==='recalling'?'Mira is checking her notes…':chatStage==='thinking'?'Mira is thinking…':'Your message is with Mira…'}</p>}
        {reply && memoryStatus && memoryStatus !== 'recalled' && <p className="memory-note" role="status">{memoryStatus === 'not_configured' ? 'No long-term notes are connected for this visit.' : memoryStatus === 'unavailable' ? 'Earlier notes could not be checked; Mira used only this visit.' : 'Mira has no verified earlier notes yet.'}</p>}
        {scene.ending && lineComplete && <div className="ending-seal">{scene.ending === 'signal' ? '✦ SIGNAL RESTORED' : '✦ SAFE RETURN'} <button className="replay-story" disabled={pending || cooperationBusy} onClick={() => void newStory()}>Begin another crossing →</button></div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void send(); }}>
          <span className="composer-chevron" aria-hidden="true"><svg viewBox="0 0 14 30"><path d="M3 3L10 14 4 26 5 16 2 4Z" fill="currentColor"/></svg></span>
          <input ref={input} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault(); }} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} aria-label="Say something to Mira" placeholder="Say something…" />
          <button className="send-stamp" type="submit" disabled={pending || cooperationBusy || !draft.trim()} aria-label={pending ? 'Sending message to Mira' : 'Send message to Mira'}><span>{pending ? 'WAIT' : 'SEND'}</span><span className="send-arrow" aria-hidden="true"><svg viewBox="0 0 25 20"><path d="M1 8L15 8 14 2 24 10 14 18 15 12 1 12Z" fill="currentColor"/></svg></span></button>
        </form>
        
      </>}
      {view === 'journal' && <div className="paper-view"><div className="paper-view-head"><p className="speaker-label">FIELD JOURNAL</p><button className="close-paper" onClick={() => setView('game')} aria-label="Close journal">×</button></div><h1>What we have seen</h1><p className="journal-note">Your choices stay in this story. Personal memories only appear here after a verified save and recall.</p><p className="journal-note">Chapters reached: {state.unlockedChapters.join(' · ')} · In your pack: {state.inventory.length ? state.inventory.map(item => item.replaceAll('-', ' ')).join(', ') : 'nothing yet'}</p><p className="journal-note">Endings found: {state.completedEndings.length ? state.completedEndings.join(' · ').replaceAll('signal', 'Signal Restored').replaceAll('return', 'Safe Return') : 'none yet'}</p><ul className="journal-list">{state.history.length ? state.history.map((id, index) => <li key={`${id}-${index}`}>{story[Object.keys(story).find((key) => story[key].choices.some((choice) => choice.id === id)) ?? 'ferry-first']?.choices.find((choice) => choice.id === id)?.text ?? (id.startsWith('continue:') ? story[id.slice(9)]?.title : id)}</li>) : <li>The map is still folded. Your journey begins at the ferry shelter.</li>}</ul><section className="recap-panel" aria-label="Read witnessed chapters"><h2>Read the crossing</h2><p className="journal-note">Only the path we have taken. Reading here keeps your saved place.</p>{[1,2,3].map(chapter => <details key={chapter}><summary>{String(chapter).padStart(2,"0")} / {chapterNames[chapter]} {state.unlockedChapters.includes(chapter)?"":"· NOT REACHED"}</summary>{recap.filter(item=>item.chapter===chapter).map(item=><article className="recap-scene" key={item.id}><h3>{item.title}</h3><p>{item.mira}</p></article>)}</details>)}</section><div className="journal-status">{availability.memory ? (memoryJobs.some(job=>job.recall_verified&&!job.forgotten)?'MEMORY SAVED · RECALL VERIFIED':'MEMORY CONNECTED · NO VERIFIED NOTES YET') : 'LONG-TERM MEMORY NOT CONNECTED'}<small>{availability.durableSave ? 'Cloud save configured' : 'Story saved on this computer'}</small></div>{memoryJobs.length > 0 && <section className="memory-jobs" aria-label="Memory save status"><h2>Memory save receipts</h2><p className="journal-note">Forget stops Mira using this note in this crossing. It does not erase stored network data. Restoring your story does not undo forgetting.</p>{memoryJobs.map((job) => <div className="memory-job" key={job.memory_id}><span>{job.forgotten ? "FORGOTTEN" : job.status.toUpperCase()} {job.recall_verified ? '· RECALL VERIFIED' : ''}</span>{job.error_code && <small>{job.error_code}</small>}<button onClick={() => void api.forgetMemory(job.memory_id).then(() => { setNotice('This note will no longer be recalled. Stored network data is not erased.'); return openJournal(); }).catch(() => setNotice('This note could not be forgotten yet. Try again.'))}>FORGET</button>{job.retryable && <button onClick={() => void retryMemory(job.memory_id)}>RETRY</button>}</div>)}</section>}<DeviceTransfer enabled={availability.durableSave}/><details><summary>Use a recovery code instead</summary><div className="journal-recovery"><button className="setting-row" onClick={() => void createRecoveryCode()}>Create a recovery code <span>→</span></button>{recoveryCode && <p className="recovery-code" aria-live="polite">{recoveryCode}</p>}<form className="restore-row" onSubmit={(event) => { event.preventDefault(); void restoreRecoveryCode(); }}><label htmlFor="recovery-input">Restore a saved story</label><input id="recovery-input" value={recoveryDraft} onChange={(event) => setRecoveryDraft(event.target.value)} autoComplete="off" placeholder="Enter recovery code" /><button type="submit" disabled={!recoveryDraft.trim()}>RESTORE</button></form></div></details></div>}
      {view === 'settings' && <div className="paper-view"><div className="paper-view-head"><p className="speaker-label">FIELD NOTES</p><button className="close-paper" onClick={() => setView('game')} aria-label="Close settings">×</button></div><h1>Before the storm</h1><p className="journal-note">A few things about this crossing.</p><button className="setting-row" aria-pressed={sound} onClick={() => void toggleSound()}><span>Shore ambience</span><span>{sound ? 'ON' : 'OFF'}</span></button><button className="setting-row" aria-label="Scene motion" aria-pressed={motion} onClick={() => setMotion(!motion)}><span>Scene motion</span><span>{motion ? 'ON' : 'OFF'}</span></button><button className="setting-row" onClick={() => setView('journal')}><span>Open field journal</span><span>→</span></button><button className="setting-row" disabled={pending || cooperationBusy} onClick={() => void newStory()}><span>Begin another crossing</span><span>→</span></button><div className="status-box"><span>STORY SERVICE</span><p>CONNECTED · {availability.durableSave ? 'SAVED' : 'SAVED ON THIS COMPUTER'}</p><span>MIRA’S MEMORY</span><p>{availability.memory ? 'CONFIGURED · NOT PROOFED' : 'NOT CONNECTED'}</p><span>FREE CONVERSATION</span><p>{availability.llm ? 'CONFIGURED' : 'NOT CONNECTED'}</p></div></div>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}
    </section>
    {started&&gated&&!arrival&&!opening&&!transferCode&&<CrossingGate kind={cover?'cover':'chapter'} chapter={chapterCard??scene.chapter} hasSave={state.version>0} pending={pending} onContinue={cover?()=>void enterCrossing():()=>setChapterCard(null)} onNew={()=>void newStory()} onRestore={()=>{setArrivalError('');setArrivalMode('restore');setArrival(true);}} onTrailer={()=>setOpening('replay')} />}
    {opening&&<OpeningTrailer onClose={()=>{const begin=opening==='begin';openingSeen.current=true;setOpening(null);if(begin)void enterCrossing();}}/>}
    {started&&transferCode&&<div className="crossing-gate"><div className="crossing-card" role="dialog" aria-modal="true" aria-labelledby="transfer-title"><p className="crossing-eyebrow">WELCOME BACK</p><h1 id="transfer-title">Continue your crossing</h1><p>Your saved place and Mira’s memories will return together. This will switch this browser to the story linked here.</p><button autoFocus className="crossing-primary" disabled={pending} onClick={()=>void restoreBeforeCrossing(transferCode)}>{pending?'Opening your story…':'Continue this story'}</button><button className="crossing-secondary" disabled={pending} onClick={()=>{setTransferCode('');setArrivalError('');}}>Stay with this device’s story</button>{arrivalError&&<p role="alert">This link could not be used. It may already have been used or replaced. Create a new link on your other device, or try again if the connection failed.</p>}</div></div>}
    {started&&arrival&&!transferCode&&<ArrivalGate initialMode={arrivalMode} busy={pending} error={arrivalError} onName={name=>void beginWithName(name)} onRestore={code=>void restoreBeforeCrossing(code)} onBack={()=>setArrival(false)}/>} 
  </main>;
}







