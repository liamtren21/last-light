import {useEffect,useRef,useState} from 'react';
import {api,type CooperationProposal} from '../api/client';
import {cooperationComplete,type CooperationPlan} from '../game/cooperation';
import {story} from '../game/story';
import type {GameState} from '../game/schema';

export function CooperationPanel({state,disabled,onBusy,onCommit}:{state:GameState;disabled:boolean;onBusy:(busy:boolean)=>void;onCommit:(result:{state:GameState;consequence:string;gesture:'map-point'|'radio-check'|'wait'})=>void}){
 const [status,setStatus]=useState('checking');
 const [editing,setEditing]=useState(false);
 const [plan,setPlan]=useState<CooperationPlan>({meeting:'shelter',priority:'passengers',reason:''});
 const [draftId,setDraftId]=useState('');
 const [proposal,setProposal]=useState<CooperationProposal|null>(null);
 const [error,setError]=useState('');
 const [why,setWhy]=useState(false);
 const [inspect,setInspect]=useState(false);
 const [working,setWorking]=useState(false);
 const [actionUncertain,setActionUncertain]=useState(false);
 const [refresh,setRefresh]=useState(0);
 const controller=useRef<AbortController|null>(null);
 const proposalTurn=useRef(crypto.randomUUID());
 const actionTurn=useRef(crypto.randomUUID());
 const complete=cooperationComplete(state);
 const ending=Boolean(story[state.sceneId]?.ending);
 const cancelled=useRef(false);
 const manualPlan=useRef(false);
 useEffect(()=>{
  const clarify=()=>{if(!ending&&!actionUncertain){manualPlan.current=true;setEditing(true);setDraftId('');setError('Review what you mean here. Nothing changes until you confirm.');}};
  window.addEventListener('last-light:clarify-plan',clarify);
  return()=>window.removeEventListener('last-light:clarify-plan',clarify);
 },[ending,actionUncertain]);
 useEffect(()=>{
  cancelled.current=false;manualPlan.current=false;const abort=new AbortController();controller.current=abort;
  let timer:ReturnType<typeof setTimeout>|undefined;
  async function check(){
   if(manualPlan.current)return;
   try{
    const result=await api.cooperationStatus(abort.signal);if(abort.signal.aborted)return;
    setStatus(result.status);
    if(complete&&!ending){setStatus('complete');return;}
    if(['empty','forgotten','failed'].includes(result.status)){setEditing(!ending);if(result.status==='failed')setError('The plan was not saved. Agree on it again here, or retry its save from the journal.');return;}
    if(result.status==='pending'){timer=setTimeout(()=>void check(),1800);return;}
    if(!complete){await recall(abort.signal);}else setStatus('complete');
   }catch{if(!abort.signal.aborted){setError('Our earlier plan could not be checked. Your place is safe; try again.');setStatus('unavailable');}}
  }
  void check();return()=>{cancelled.current=true;abort.abort();onBusy(false);if(timer)clearTimeout(timer);};
 },[state.version,state.sceneId,refresh]);
 async function recall(signal?:AbortSignal,preferredAction?:string){
  setWorking(true);onBusy(true);setError('');setStatus('recalling');setProposal(null);
  try{const result=await api.cooperationPropose(state.version,proposalTurn.current,signal,preferredAction);if(signal?.aborted||cancelled.current)return;setProposal(result);setPlan(result.plan);setStatus(result.status);setEditing(result.status==='revise');}
  catch{if(!signal?.aborted&&!cancelled.current){setError('Mira could not recall a checked plan. Try again, or agree on a new plan together.');setStatus('unavailable');}}
  finally{if(!cancelled.current){setWorking(false);onBusy(false);}}
 }
 async function readBack(){
  manualPlan.current=true;
  setWorking(true);onBusy(true);setError('');
  try{const result=await api.cooperationDraft(plan,state.version,crypto.randomUUID(),controller.current?.signal);if(cancelled.current)return;setDraftId(result.draftId);setEditing(false);setStatus('draft');}
  catch{if(!cancelled.current)setError('That plan could not be prepared. Keep your words here and try again.');}
  finally{if(!cancelled.current){setWorking(false);onBusy(false);}}
 }
 async function confirm(){
  setWorking(true);onBusy(true);setError('');
  try{await api.cooperationConfirm(draftId,state.version,controller.current?.signal);if(cancelled.current)return;proposalTurn.current=crypto.randomUUID();actionTurn.current=crypto.randomUUID();setActionUncertain(false);setDraftId('');setProposal(null);setStatus('pending');
   // Parent reloads the authoritative state, including invalidated old authorization.
   const fresh=await api.game();if(!cancelled.current){onCommit({state:fresh.state,consequence:'',gesture:'wait'});setRefresh(value=>value+1);}
  }catch{if(!cancelled.current)setError('The plan could not be saved. Try confirming it again.');}
  finally{if(!cancelled.current){setWorking(false);onBusy(false);}}
 }
 async function act(){
  if(!proposal?.proposalId)return;
  setWorking(true);onBusy(true);setError('');
  try{const result=await api.cooperationAction(proposal.proposalId,state.version,actionTurn.current,controller.current?.signal);if(!cancelled.current)onCommit(result);}
  catch(error){if(!cancelled.current){
   const definitive=error instanceof Error&&['PROPOSAL_STALE','VERSION_CONFLICT','ACTION_NOT_ALLOWED','PLAN_NOT_READY','ACTION_ID_REUSED'].includes(error.message);
   if(definitive){try{const fresh=await api.game();if(!cancelled.current){onCommit({state:fresh.state,consequence:'',gesture:'wait'});setProposal(null);setActionUncertain(false);setStatus('unavailable');proposalTurn.current=crypto.randomUUID();actionTurn.current=crypto.randomUUID();setError('The plan has changed. Recall it again before acting.');}}catch{setActionUncertain(true);setError('Your place could not be checked. Try the same step again.');}}
   else{setActionUncertain(true);setError('The reply did not reach us. Check the same step again before making another plan.');}
  }}
  finally{if(!cancelled.current){setWorking(false);onBusy(false);}}
 }
 const busy=working||disabled;
 async function rebuild(){
  setWorking(true);onBusy(true);setError('');
  try{const result=await api.cooperationRebuild(draftId,state.version,controller.current?.signal);if(!cancelled.current)onCommit(result);}
  catch{if(!cancelled.current)setError('That step could not be agreed. Check the current situation and try again.');}
  finally{if(!cancelled.current){setWorking(false);onBusy(false);}}
 }
 return <section className="cooperation-panel" data-complete={complete&&!editing&&!why&&!inspect&&!error} aria-label="Our shared plan" aria-busy={working}>
  <p className="cooperation-objective">{ending?'THE PLAN WE CARRIED':'OUR NEXT STEP'} · {ending?'Remember what brought us here':complete?'The agreed step is done. Continue when ready.':'Agree, recall, then act together'}</p>
  {error&&<p role="status" className="cooperation-error">{error}</p>}
  {status==='checking'&&<p role="status">Checking our earlier plan…</p>}
  {status==='pending'&&<p role="status">The plan is waiting to be saved. You can look around or keep talking while we wait.</p>}
  {status==='recalling'&&<p role="status">Mira is recalling what you agreed…</p>}
  {proposal?.dialogue&&<p className="cooperation-dialogue">{proposal.dialogue}</p>}
  {proposal?.closingGesture&&<p className="cooperation-observation" aria-label="Mira's closing gesture">{proposal.closingGesture}</p>}
  {proposal?.status==='proposed'&&!editing&&!complete&&proposal.option?.preparation&&<p className="cooperation-observation" aria-label="What Mira will prepare">{proposal.option.preparation}</p>}
  {proposal?.reason&&<p>{proposal.reason}</p>}
  {editing&&<form className="cooperation-form" onSubmit={event=>{event.preventDefault();void readBack();}}>
   <label>Where should we meet?<select value={plan.meeting} disabled={busy} onChange={event=>{setDraftId('');setPlan({...plan,meeting:event.target.value as CooperationPlan['meeting']});}}><option value="shelter">The ferry shelter</option><option value="water-tower">The water tower</option></select></label>
   <label>What comes first?<select value={plan.priority} disabled={busy} onChange={event=>{setDraftId('');setPlan({...plan,priority:event.target.value as CooperationPlan['priority']});}}><option value="passengers">Bring the passengers under cover</option><option value="signal">Reach the station and warn the boats</option></select></label>
   <label>Teach Mira how to coordinate<select value={plan.technique??''} disabled={busy} onChange={event=>{setDraftId('');setPlan({...plan,technique:(event.target.value||undefined) as CooperationPlan['technique'],cue:event.target.value?plan.cue:undefined});}}><option value="">Choose together at the scene</option><option value="pair-check">Check partners together, with separate roles</option><option value="call-response">Call a cue and wait for an answer</option></select></label>
   {plan.technique&&<label>Your shared cue<input value={plan.cue??''} maxLength={80} required disabled={busy} onChange={event=>{setDraftId('');setPlan({...plan,cue:event.target.value});}} placeholder="A short phrase only the two of you use"/></label>}
   <label className="cooperation-reason" htmlFor={`plan-reason-${state.sceneId}`}>Tell Mira why this matters to you<textarea id={`plan-reason-${state.sceneId}`} value={plan.reason} maxLength={350} required disabled={busy} onChange={event=>{setDraftId('');setPlan({...plan,reason:event.target.value});}} placeholder="What should we keep in mind if we are separated?"/></label>
   <button className="cooperation-confirm" type="submit" disabled={busy||!plan.reason.trim()}>REVIEW OUR PLAN →</button>
  </form>}
  {status==='draft'&&<div className="cooperation-draft"><p>Your plan: meet at {plan.meeting==='shelter'?'the ferry shelter':'the water tower'}; {plan.priority==='passengers'?'help the passengers first':'warn the boats first'}. {plan.reason}</p>{plan.technique&&<p>{plan.technique==='pair-check'?'Check partners together':'Call and wait for an answer'}, using “{plan.cue}”.</p>}<p>This is your draft. Confirm before Mira stores it.</p><button className="cooperation-confirm" disabled={busy} onClick={()=>void confirm()}>CONFIRM & REMEMBER →</button><button disabled={busy} onClick={()=>void rebuild()}>AGREE ON THIS STEP NOW · WITHOUT SAVING</button><button disabled={busy} onClick={()=>setEditing(true)}>Change my words</button></div>}
  {proposal?.status==='proposed'&&!editing&&!complete&&<button className="cooperation-confirm" disabled={busy} onClick={()=>void act()}>{actionUncertain?'CHECK THE SAME STEP':`AGREE · ${proposal.option?.label}`} →</button>}
  <div className="cooperation-tools">
   {proposal?.status==='proposed'&&!editing&&!complete&&!actionUncertain&&proposal.alternatives?.filter(option=>option.id!==proposal.option?.id).map(option=><button key={option.id} disabled={busy} onClick={()=>{proposalTurn.current=crypto.randomUUID();actionTurn.current=crypto.randomUUID();void recall(controller.current?.signal,option.id);}}>Consider: {option.label}</button>)}
   {proposal&&<button disabled={busy} aria-expanded={why} onClick={()=>setWhy(!why)}>Why this plan?</button>}
   {!ending&&<button disabled={busy} aria-expanded={inspect} onClick={()=>setInspect(!inspect)}>Look at the situation</button>}
   {!ending&&!editing&&<button disabled={busy||actionUncertain} onClick={()=>{manualPlan.current=true;setEditing(true);setDraftId('');setError('');}}>Revise our plan</button>}
   {['unavailable','failed'].includes(status)&&<button disabled={busy} onClick={()=>{proposalTurn.current=crypto.randomUUID();void recall(controller.current?.signal);}}>Try recalling again</button>}
  </div>
  {why&&proposal&&<p className="cooperation-observation">Our checked agreement: {proposal.plan.reason} We agreed to {proposal.plan.priority==='passengers'?'help the passengers first':'warn the boats first'}, meeting at {proposal.plan.meeting==='shelter'?'the shelter':'the water tower'}. You can change it before acting.</p>}
  {inspect&&<p className="cooperation-observation">What we can see now: {story[state.sceneId]?.mira}</p>}
  {why&&proposal?.episodeEvidence&&<p className="cooperation-observation">{proposal.episodeEvidence.memoryIds.length?`Mira recalled ${proposal.episodeEvidence.memoryIds.length} shared episode(s) for this suggestion.`:'No earlier episode was recalled for this suggestion.'}</p>}
 </section>;
}
