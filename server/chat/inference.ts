import {generateMiraReply,proposeMiraMemory} from '../llm/gemini';
import type {ReplyContext} from './context';
import type {CandidateProposal} from '../memory/extract';
export type PendingCorrection={message:string;proposal:CandidateProposal};
export const isCorrection=(message:string)=>/\b(?:not what I meant|I didn't mean|I did not mean|actually|correction|you misunderstood|I meant|that is wrong|that's wrong)\b|ý tôi|hiểu nhầm|không phải vậy|sửa lại/iu.test(message);
const confirms=(message:string)=>/^(?:yes|yes[, ]+that(?:['’]?s| is) (?:right|correct)|that(?:['’]?s| is) (?:right|correct)|confirm|đúng|đúng rồi|xác nhận)[.!\s]*$/iu.test(message.trim());
// Both read identical verified evidence. Persistence is still a transaction
// after a valid whole reply; speculative extraction never writes memory.
export async function inferChatTurn(sceneId:string,message:string,facts:string[],context:ReplyContext,extract:boolean,pending?:PendingCorrection){
  if(extract&&pending&&confirms(message)){
    const response=await generateMiraReply(sceneId,message,facts,{...context,clarification:{text:pending.proposal.text,confirmed:true}});
    return {response,proposal:pending.proposal,candidateMessage:pending.message,pendingCorrection:undefined};
  }
  const correcting=isCorrection(message);
  // A single information-seeking question without a first-person assertion
  // supplies no new durable fact. Statements embedded in questions still run extraction.
  const nameRecallQuestion=/^(?:what name did I ask you to use|do you remember my name)\?$/i.test(message.trim());
  const questionOnly=nameRecallQuestion||/^(?:who|what|where|when|why|how|do you|did you|can you|could you|is it|are we)\b[^.!;]*\?$/i.test(message.trim())&&!/\b(?:I|my|remember that|call me)\b/i.test(message);
  const proposal=extract&&(!questionOnly||correcting)?Promise.resolve(proposeMiraMemory(message,facts)).catch(()=>null):Promise.resolve(null);
  const response=await generateMiraReply(sceneId,message,facts,correcting?{...context,clarification:{text:message,confirmed:false}}:context);
  const candidate=await proposal;
  return {response,proposal:correcting?null:candidate,candidateMessage:message,pendingCorrection:correcting&&candidate?{message,proposal:candidate}:undefined};
}
