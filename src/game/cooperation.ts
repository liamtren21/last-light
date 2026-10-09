import {z} from 'zod';
import type {GameState} from './schema';
import {relationshipConsequences} from './relationship';
export const cooperationPlanSchema=z.object({meeting:z.enum(['shelter','water-tower']),priority:z.enum(['passengers','signal']),reason:z.string().trim().min(1).max(350),technique:z.enum(['pair-check','call-response']).optional(),cue:z.string().trim().min(1).max(80).optional()}).strict().refine(plan=>Boolean(plan.technique)===Boolean(plan.cue),{message:'Technique and cue must be taught together'});
export type CooperationPlan=z.infer<typeof cooperationPlanSchema>;
export const cooperationScenes=['ferry-plan','ferry-rendezvous','chapter-two','route-review','signal-tested','signal-room','return-call','return-plan'] as const;
export type CooperationOption={id:string;label:string;consequence:string;gesture:'map-point'|'radio-check'|'wait';allowedChoices:string[];preparation?:string;preparationKind?:'route-review'|'repair-handoff'|'continued-handoff'};
export function needsCooperation(state:GameState){return state.gameplayVersion===2&&cooperationScenes.includes(state.sceneId as typeof cooperationScenes[number]);}
export function cooperationComplete(state:GameState){return !![...(state.cooperation??[])].reverse().find(event=>event.sceneId===state.sceneId)?.allowedChoices?.length;}
export function cooperationOptions(state:GameState,plan:CooperationPlan,episodes:string[]=[]):CooperationOption[]{
 if(!needsCooperation(state))return [];
 // At the rescue scene the observed flooding makes a tower rendezvous obsolete.
 if(['return-call','return-plan'].includes(state.sceneId)&&plan.meeting!=='shelter')return [];
 const location=plan.meeting==='shelter'?'the ferry shelter':'the water tower';
 const passengerFirst=plan.priority==='passengers';
 const preparation=passengerFirst?'Coordinate the passenger list first':'Coordinate the warning first';
 const label=state.sceneId==='ferry-rendezvous'?`Confirm our rendezvous at ${location}`:state.sceneId==='signal-tested'?'Prepare the flood-warning controller together':state.sceneId==='signal-room'?'Check our warning and passenger handoff together':state.sceneId==='return-call'?(passengerFirst?'Gather the passengers in pairs along the wall':'Call the passengers in from the high steps'):state.sceneId==='return-plan'?(passengerFirst?'Arrange the first watch at the shelter gate':'Arrange the flood warning at the ferry board'):state.sceneId==='route-review'?'Review our route against the flooded steps':state.sceneId==='chapter-two'?(passengerFirst?'Gather the waiting passengers under cover':'Prepare to reach the signal station together'):`${preparation} along the route to ${location}`;
 const consequence=state.sceneId==='signal-room'?(passengerFirst?'Mira places the passenger list beside the controller for the handoff after sending.':'Mira checks the controller setting against the warning route before the handoff.'):passengerFirst?`Mira marks the gathering route to ${location} and checks the six-name list before the warning.`:`Mira checks the radio and marks the warning route through ${location} before the passenger handoff.`;
 const allowedChoices=state.sceneId==='chapter-two'?[passengerFirst?'safe-return':'try-tower']:state.sceneId==='ferry-plan'?[plan.meeting==='shelter'?'low-route':'ridge-route']:state.sceneId==='return-call'?[passengerFirst?'escort-pairs':'call-from-steps']:state.sceneId==='ferry-rendezvous'?['promise-meet']:state.sceneId==='return-plan'?[passengerFirst?'keep-watch':'leave-warning']:state.sceneId==='signal-room'?['restore-signal','save-charge']:state.sceneId==='signal-tested'?['arm-controller']:['continue'];
 const relationship=relationshipConsequences(state);
 const options:CooperationOption[]=[{id:`cooperate:${state.sceneId}:${plan.meeting}:${plan.priority}`,label,consequence,gesture:['signal-tested','signal-room'].includes(state.sceneId)?'wait':passengerFirst?'map-point':'radio-check',allowedChoices,
  preparation:state.sceneId==='signal-tested'?'If you confirm, Mira will stand beside the controller while you prepare its flood-warning setting.':state.sceneId==='signal-room'?'If you confirm, Mira will check the warning and passenger handoff beside the controller before you choose whether to send.':passengerFirst?`If you confirm, Mira will open the passenger list and point out the gathering route through ${location}.`:`If you confirm, Mira will check the radio and mark the warning route through ${location}.`}];
 // Continuity changes the next executable step as well as the visible prop.
 // The current recalled priority remains the primary path; review is optional.
 if(state.sceneId==='chapter-two'&&relationship.returnedAfterAgreement&&!passengerFirst)options.push({
  id:`cooperate:${state.sceneId}:${plan.meeting}:${plan.priority}:review`,label:'Compare our marked route together before the station',
  consequence:'After the return under the roof, Mira opens the coast map between you and points to the flooded steps. You can inspect the route together before approaching the station.',
  gesture:'map-point',allowedChoices:['keep-promise'],preparationKind:'route-review',preparation:'If you confirm, Mira will open the coast map between you and point out the flooded steps for a joint route review.'
 });
 if(state.sceneId==='return-call'&&relationship.signalInterrupted){
  const repair:CooperationOption={id:`cooperate:${state.sceneId}:${plan.meeting}:${plan.priority}:repair`,label:'Rebuild our handoff with a pair-by-pair passenger check',
   consequence:'The signal work stopped when we chose to return. Mira unfolds the passenger list and marks pairs along the sheltered wall; you can carry out the handoff together before checking every name.',
   gesture:'map-point',allowedChoices:['escort-pairs'],preparationKind:'repair-handoff',preparation:'If you confirm, Mira will unfold the six-name list and mark pairs along the sheltered wall so you can carry out a new handoff together.'};
  // Do not add duplicate physical choices for passenger-first plans.
  if(passengerFirst)options[0]={...repair,id:options[0]!.id};else options.push(repair);
 }
 if(state.sceneId==='return-plan'&&relationship.repairCompleted)options[0]={...options[0]!,
  consequence:passengerFirst?'Mira lays the passenger list beside the gate after the paired handoff. You can now take the first watch with the checked list close at hand.':'Mira places the coast map and passenger list beside the ferry board after the paired handoff. You can pin the flood warning where later arrivals will see it.',
  gesture:'map-point',preparationKind:'continued-handoff',preparation:passengerFirst?'If you confirm, Mira will lay the checked passenger list beside the gate for the first watch.':'If you confirm, Mira will lay the map and checked passenger list beside the ferry board before you pin the warning.'};
 if(plan.technique&&plan.cue){
  const cue=JSON.stringify(plan.cue);
  if(state.sceneId==='return-call')options[0]={...options[0]!,label:plan.technique==='pair-check'?'Use the paired check you taught Mira':'Use your call-and-answer check',allowedChoices:[plan.technique==='pair-check'?'escort-pairs':'call-from-steps'],gesture:plan.technique==='pair-check'?'map-point':'radio-check',consequence:plan.technique==='pair-check'?`Mira marks pairs on the list and says ${cue}. Each pair must answer together before you escort them along the wall; an unanswered pair stays on the unchecked list.`:`Mira calls ${cue} from the high steps and waits for each passenger to answer their own name. She points out the sheltered route only after hearing a reply; silence leaves a name unchecked.`,preparation:`If you agree, Mira will use ${cue} as your shared cue, ${plan.technique==='pair-check'?'checking partners together beside the wall':'waiting for individual answers from the high steps'}. The final count still has to be checked under the roof.`};
  if(state.sceneId==='signal-room')options[0]={...options[0]!,consequence:plan.technique==='pair-check'?`Mira says ${cue} and divides the handoff into pairs: you watch the harbor window while she stands beside the lever. Neither touches it until both report ready.`:`Mira says ${cue}, waits for your ready answer, then repeats the controller setting aloud. You answer it back before either touches the lever.`,preparation:`Mira proposes the ${plan.technique==='pair-check'?'paired roles':'call-and-answer handoff'} you taught her, using ${cue}. This prepares the warning; it does not send it.`};
 }
 if(state.sceneId==='signal-tested')options[0]={...options[0]!,consequence:'Mira stands beside the controller and points out the flood-warning setting. The charge remains unused while you prepare to set it together.'};
 // Only verified remote episode content can introduce this alternative. SQL
 // relationship flags alone cannot supply autobiographical memory.
 if(state.sceneId==='chapter-two'&&episodes.some(text=>text.includes('returned to Mira under the ferry shelter roof'))&&!options.some(option=>option.allowedChoices.includes('keep-promise'))){
  options.push({id:`cooperate:${state.sceneId}:${plan.meeting}:${plan.priority}:episode-review`,label:'Use our reunion to plan a route check together',consequence:'Mira opens the coast map at the shelter, where you reunited, and traces the approach to the tower steps. You will inspect that route together before committing to the station.',gesture:'map-point',allowedChoices:['keep-promise'],preparationKind:'route-review',preparation:'After recalling your reunion, Mira suggests comparing the route here before approaching the station.'});
 }
 return options;
}

export function personalClosing(state:GameState,plan:CooperationPlan){
 if(!state.completedEndings.length||!plan.technique||!plan.cue)return '';
 const cue=JSON.stringify(plan.cue);
 return state.sceneId==='ending-return'&&state.flags.includes('passengers-accounted')
  ?`Mira folds the checked six-name list beside the dry map. She quietly repeats ${cue}, ${plan.technique==='pair-check'?'touching the paired marks you taught her to make':'leaving room for your answering voice'}, then keeps the list dry beside her.`
  :state.sceneId==='ending-signal'&&state.flags.includes('ending-signal')?`After the harbor's two answering flashes, Mira lets go of the handle and repeats ${cue}, ${plan.technique==='pair-check'?'turning toward the window you watched together':'waiting for your answer instead of speaking over it'}.`:'';
}

/** Current consent, explicitly without claiming past memory or a Walrus receipt. */
export function commitPresentAgreement(state:GameState,option:CooperationOption):GameState{
 if(!needsCooperation(state))throw new Error('COOPERATION_REQUIRED');
 return {...state,version:state.version+1,cooperation:[...(state.cooperation??[]),{sceneId:state.sceneId,actionId:`cooperate:${crypto.randomUUID()}`,memoryIds:[],version:state.version+1,allowedChoices:option.allowedChoices}]};
}
// Called only by the server after recall and transaction revalidation. Never
// accepted as a client action or used to reconstruct the remembered plan.
export function commitCooperation(state:GameState,option:CooperationOption,memoryIds:string[]):GameState{
 if(!needsCooperation(state)||!memoryIds.length)throw new Error('COOPERATION_REQUIRED');
 return {...state,version:state.version+1,flags:[...new Set([...state.flags,option.gesture==='map-point'?'passenger-list-coordinated':'warning-radio-coordinated',...(option.preparationKind==='repair-handoff'?['cooperation-repair-prepared']:[])])],cooperation:[...(state.cooperation??[]),{sceneId:state.sceneId,actionId:`cooperate:${crypto.randomUUID()}`,memoryIds,version:state.version+1,allowedChoices:option.allowedChoices}]};
}
