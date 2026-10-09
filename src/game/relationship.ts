import type {GameState} from './schema';

export type RelationshipConsequences={
 status:'unproven'|'kept'|'interrupted'|'repairing'|'repaired';
 returnedAfterAgreement:boolean;
 signalInterrupted:boolean;
 repairPrepared:boolean;
 repairCompleted:boolean;
 observations:string[];
};

// These are witnessed game actions, not a personality score or a replacement
// for recalling the player's plan. Never expose memory IDs or reason text here.
export function relationshipConsequences(state:GameState):RelationshipConsequences{
 const events=(state.cooperation??[]).filter(event=>event.memoryIds.length>0&&event.version>0&&event.version<=state.version);
 const completed=(scene:string,choice:string)=>events.some(event=>event.sceneId===scene&&event.allowedChoices?.includes(choice))&&state.history.includes(choice);
 const returnedAfterAgreement=completed('ferry-rendezvous','promise-meet')&&state.flags.includes('made-meeting-plan')&&state.history.includes('continue:first-pause');
 const signalStart=completed('chapter-two','try-tower')||completed('chapter-two','keep-promise');
 const startIndex=Math.max(state.history.indexOf('try-tower'),state.history.indexOf('keep-promise'));
 const signalInterrupted=signalStart&&['turn-back','leave-steps','save-charge'].some(choice=>state.history.indexOf(choice)>startIndex)&&state.flags.includes('return-chosen');
 const repairPrepared=signalInterrupted&&state.flags.includes('cooperation-repair-prepared')&&events.some(event=>event.sceneId==='return-call'&&event.allowedChoices?.includes('escort-pairs'));
 const repairCompleted=repairPrepared&&completed('return-call','escort-pairs')&&state.flags.includes('return-organized');
 const status=repairCompleted?'repaired':repairPrepared?'repairing':signalInterrupted?'interrupted':returnedAfterAgreement?'kept':'unproven';
 const observations:string[]=[];
 if(returnedAfterAgreement)observations.push('The agreed separation plan was confirmed, and the player returned under the ferry roof after the squall. This does not establish that a tower meeting occurred or that an earlier plan matches the current recalled plan.');
 if(signalInterrupted)observations.push('After agreeing to approach the signal station, the player chose to return or preserve the charge. The signal work was interrupted; this is an observed change of action, not evidence of dishonesty or betrayal.');
 if(repairPrepared)observations.push('Mira and the player prepared a paired passenger handoff after interrupting the signal work. Preparation alone does not establish that anyone has arrived safely.');
 if(repairCompleted)observations.push('The player carried out the paired handoff that was prepared together. All six passengers are accounted for only if the later passenger check is completed.');
 return {status,returnedAfterAgreement,signalInterrupted,repairPrepared,repairCompleted,observations};
}
