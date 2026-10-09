/** Mira has no authored relatives. Personal player reasons cannot become her biography. */
export function validatePersonalAttribution(dialogue:string){
 if(/\bmy (?:brother|sister|mother|father|family|partner|child|son|daughter)\b|(?:anh trai|em trai|chị gái|em gái|gia đình) (?:của )?tôi/iu.test(dialogue))throw new Error('GROUNDING_REVERSED_RELATIONSHIP');
}
export function validateSceneActors(sceneId:string,dialogue:string){
 if(sceneId==='ferry-rendezvous'&&(/\byou(?:['’]re| are| will| can)\b(?:(?!\bI\b)[^.;!?]){0,30}\b(?:fetch|fetching|collect|collecting|get|getting)\b[^.;!?]{0,25}\bkey\b/i.test(dialogue)||/\bI(?:['’]ll| will| am|['’]m)\b(?:(?!\byou\b)[^.;!?]){0,20}\bcheck(?:ing)?\b[^.;!?]{0,20}\blanding\b/i.test(dialogue)))throw new Error('GROUNDING_REVERSED_SCENE_ROLES');
}

export function validateRememberedRoles(dialogue:string,context:{playerName?:string;coordination?:{technique:string};sceneId:string}){
 if(context.playerName&&/\b(?:what (?:should|can|do) I call you|what(?:['’]s| is) your name|tell me your name|may I (?:have|know) your name|didn['’]t catch your name)\b/i.test(dialogue))throw new Error('GROUNDING_KNOWN_NAME');
 if(context.coordination&&(/\b(?:say|call|speak|repeat)\b[^.;!?]{0,85}\b(?:wait for my (?:answer|reply|response)|I(?:['’]ll| will) (?:answer|reply|respond))\b/i.test(dialogue)||/\byou(?:['’]ll| will| should| can)?\s+(?:say|call|speak)\s+(?:it first|(?:our|the) (?:shared |ready )?cue)\b/i.test(dialogue)))throw new Error('GROUNDING_REVERSED_CUE_ROLES');
}
