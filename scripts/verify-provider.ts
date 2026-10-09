import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {config} from '../server/config';
import {generateMiraReply,proposeMiraMemory} from '../server/llm/gemini';
import {validateCandidateProposal} from '../server/memory/extract';

// Fictional inputs only; no DB writes, memory writes or user transcripts.
function safeError(error:unknown){
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))return 'LLM_TIMEOUT';
  const message=error instanceof Error?error.message:'';
  return /^(LLM_[A-Z_0-9]+|NVIDIA_ENDPOINT_NOT_ALLOWED)$/.test(message)?message:'PROVIDER_REQUEST_OR_VALIDATION_FAILED';
}
const started=Date.now();
const message='Please remember: call me Rowan. I prefer the sheltered lower path.';
const results=await Promise.allSettled([
  generateMiraReply('ferry-first','Hello Mira. What can we check while waiting for the boat?'),
  proposeMiraMemory(message),
]);
const reply=results[0]!;
const proposal=results[1]!;
const validated=proposal.status==='fulfilled'&&proposal.value?validateCandidateProposal({proposal:proposal.value,message,campaignId:randomUUID(),eventId:randomUUID()}):null;
const evidence={checkedAt:new Date().toISOString(),provider:config.llmProvider,model:config.llmModel,durationMs:Date.now()-started,
  reply:reply.status==='fulfilled'?{validated:true,...reply.value}:{validated:false,error:safeError(reply.reason)},
  extraction:proposal.status==='fulfilled'?{validated:Boolean(validated),factKey:validated?.factKey??null}:{validated:false,error:safeError(proposal.reason)},
  walrusWritePerformed:false,databaseWritePerformed:false};
await mkdir('verification',{recursive:true});
await writeFile('verification/live-provider.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(reply.status!=='fulfilled'||!validated)process.exitCode=2;
