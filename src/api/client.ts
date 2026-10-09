import type { Action, GameState } from '../game/schema';
import type {CooperationPlan,CooperationOption} from '../game/cooperation';
const visitId=crypto.randomUUID();
type ChatReply={dialogue:string;expression:string;proposedAction:string|null;memoryStatus:'not_configured'|'empty'|'recalled'|'unavailable'};
async function chatStream(message:string,clientTurnId:string,expectedVersion:number,onStage?:(stage:string)=>void,signal?:AbortSignal):Promise<ChatReply>{
  const response=await fetch('/api/chat',{method:'POST',credentials:'include',headers:{'content-type':'application/json','accept':'text/event-stream','x-last-light-visit':visitId},body:JSON.stringify({message,clientTurnId,expectedVersion}),signal});
  if(!response.body)throw new Error('CHAT_STREAM_UNAVAILABLE');
  if(!response.headers.get('content-type')?.includes('text/event-stream')){const body=await response.json();if(!response.ok)throw new Error(body.error??'CHAT_FAILED');return body;}
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});
    let boundary;
    while((boundary=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const lines=block.split('\n');const event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(event==='error')throw new Error(JSON.parse(data).error??'CHAT_FAILED');if(event==='reply')return JSON.parse(data);if(event)onStage?.(event);
    }if(done)throw new Error('CHAT_STREAM_INTERRUPTED');
  }}finally{await reader.cancel().catch(()=>{});}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', 'x-last-light-visit':visitId, ...init?.headers } });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload;
}

export const api = {
  cooperationStatus:(signal?:AbortSignal)=>request<{status:string;required:boolean;complete:boolean}>('/cooperation',{signal}),
  cooperationDraft:(plan:CooperationPlan,expectedVersion:number,clientTurnId:string,signal?:AbortSignal)=>request<{draftId:string;plan:CooperationPlan}>('/cooperation/draft',{method:'POST',body:JSON.stringify({plan,expectedVersion,clientTurnId}),signal}),
  cooperationConfirm:(draftId:string,expectedVersion:number,signal?:AbortSignal)=>request<{memoryId:string;status:string}>('/cooperation/confirm',{method:'POST',body:JSON.stringify({draftId,expectedVersion}),signal}),
  cooperationRebuild:(draftId:string,expectedVersion:number,signal?:AbortSignal)=>request<{state:GameState;consequence:string;gesture:'map-point'|'radio-check'|'wait'}>('/cooperation/rebuild',{method:'POST',body:JSON.stringify({draftId,expectedVersion}),signal}),
  cooperationPropose:(expectedVersion:number,clientTurnId:string,signal?:AbortSignal,preferredAction?:string)=>request<CooperationProposal>('/cooperation/propose',{method:'POST',body:JSON.stringify({expectedVersion,clientTurnId,preferredAction}),signal}),
  cooperationAction:(proposalId:string,expectedVersion:number,clientActionId:string,signal?:AbortSignal)=>request<{state:GameState;consequence:string;gesture:'map-point'|'radio-check'|'wait'}>('/cooperation/action',{method:'POST',body:JSON.stringify({proposalId,expectedVersion,clientActionId}),signal}),
  onboarding:()=>request<{named:boolean;status:string;verified:boolean;memoryId?:string}>('/onboarding'),
  setName:(name:string,clientTurnId:string)=>request<{named:boolean;status:string;verified:boolean;memoryId?:string}>('/onboarding/name',{method:'POST',body:JSON.stringify({name,clientTurnId})}),
  start: () => request<{ state: GameState; availability: Availability }>('/session', { method: 'POST', body: '{}' }),
  game: () => request<{ state: GameState; availability: Availability }>('/game'),
  newCampaign: () => request<{ state: GameState; availability: Availability }>('/campaigns/new', { method: 'POST', body: '{}' }),
  action: (action: Action) => request<{ state: GameState }>('/actions', { method: 'POST', body: JSON.stringify(action) }),
  chat: chatStream,
  revisit: (clientTurnId:string,expectedVersion:number,signal?:AbortSignal)=>request<ChatReply|{available:false;memoryStatus:string}>('/revisit',{method:'POST',body:JSON.stringify({clientTurnId,expectedVersion}),signal}),
  createRecovery: () => request<{ code: string }>('/recovery/create', { method: 'POST', body: '{}' }),
  restore: (code: string) => request<{ state: GameState; availability: Availability }>('/recovery/restore', { method: 'POST', body: JSON.stringify({ code }) }),
  memories: () => request<{ jobs: Array<{ memory_id: string; status: string; error_code: string | null; recall_verified: boolean;retryable:boolean;forgotten:boolean }> }>('/memories'),
  retryMemory: (memoryId: string) => request<{ retried: boolean }>('/memories/retry', { method: 'POST', body: JSON.stringify({ memoryId }) }),
  forgetMemory: (memoryId: string) => request<{ forgotten: boolean }>('/memories/forget', {method:'POST',body:JSON.stringify({memoryId})}),
};

export type CooperationProposal={status:'proposed'|'revise'|'coda';proposalId?:string;dialogue?:string;closingGesture?:string;reason?:string;plan:CooperationPlan;option?:CooperationOption;alternatives?:CooperationOption[];memoryIds?:string[];episodeEvidence?:{status:string;memoryIds:string[]}};

export type Availability = { llm: boolean; memory: boolean; durableSave: boolean; localSave?: boolean; reasons: string[] };
