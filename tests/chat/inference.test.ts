import {expect,test,vi} from 'vitest';
const provider=vi.hoisted(()=>({reply:vi.fn(),extract:vi.fn()}));
vi.mock('../../server/llm/gemini',()=>({generateMiraReply:provider.reply,proposeMiraMemory:provider.extract}));
import {inferChatTurn} from '../../server/chat/inference';
test('extraction starts while dialogue is pending; neither result is committed by inference',async()=>{
  let finish!:(value:unknown)=>void;
  provider.reply.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  provider.extract.mockResolvedValueOnce(null);
  const pending=inferChatTurn('ferry-first','Hello',[],{},true);
  expect(provider.extract).toHaveBeenCalledWith('Hello',[]);
  finish({dialogue:'Hello.',expression:'neutral',proposedAction:null});
  expect((await pending).proposal).toBeNull();
});
test('extraction failure does not discard a valid reply',async()=>{
  provider.reply.mockResolvedValueOnce({dialogue:'Hello.',expression:'neutral',proposedAction:null});
  provider.extract.mockRejectedValueOnce(new Error('quota'));
  expect((await inferChatTurn('ferry-first','Hello',[],{},true)).proposal).toBeNull();
});
test('revisit or local-only chat does not run extraction',async()=>{
  provider.extract.mockClear();provider.reply.mockResolvedValueOnce({dialogue:'Welcome.',expression:'neutral',proposedAction:null});
  await inferChatTurn('ferry-first','Hello',[],{purpose:'revisit'},false);
  expect(provider.extract).not.toHaveBeenCalled();
});

test.each(['What is our ready call?','What name did I ask you to use?','Do you remember my name?'])('a pure recall question does not launch another model request to extract a fact: %s',async message=>{
 provider.extract.mockClear();provider.reply.mockResolvedValueOnce({dialogue:'Amber window.',expression:'attentive',proposedAction:null});
 await inferChatTurn('signal-room',message,[],{},true);
 expect(provider.extract).not.toHaveBeenCalled();
});

test('a question that includes a new preference still gets extraction',async()=>{
 provider.extract.mockClear();provider.extract.mockResolvedValueOnce(null);provider.reply.mockResolvedValueOnce({dialogue:'Understood.',expression:'attentive',proposedAction:null});
 await inferChatTurn('ferry-first','Can you remember that I prefer checking everyone in pairs?',[],{},true);
 expect(provider.extract).toHaveBeenCalledTimes(1);
});

test('a conversational correction is held for confirmation, never queued on the first turn',async()=>{
 const candidate={kind:'promise' as const,factKey:'promise.meeting',text:'Actually meet at the shelter.',sourceQuote:'Actually meet at the shelter.'};
 provider.reply.mockResolvedValueOnce({dialogue:'At the shelter instead—is that right?',expression:'attentive',proposedAction:null});
 provider.extract.mockResolvedValueOnce(candidate);
 const result=await inferChatTurn('ferry-first',candidate.text,[],{},true);
 expect(result.proposal).toBeNull();expect(result.pendingCorrection?.proposal).toEqual(candidate);
 provider.reply.mockResolvedValueOnce({dialogue:'Understood.',expression:'attentive',proposedAction:null});
 const confirmed=await inferChatTurn('ferry-first','Yes, but not that place',[],{},true,result.pendingCorrection);
 // Only the documented exact affirmative grammar can confirm. A sentence
 // outside it must not accidentally persist the preceding candidate.
 expect(confirmed.candidateMessage).toBe('Yes, but not that place');
});
test('an exact confirmation uses the original supporting quote and clears the pending correction',async()=>{
 const candidate={kind:'promise' as const,factKey:'promise.meeting',text:'Actually meet at the shelter.',sourceQuote:'Actually meet at the shelter.'};
 provider.reply.mockResolvedValueOnce({dialogue:'Understood.',expression:'attentive',proposedAction:null});
 const result=await inferChatTurn('ferry-first','Yes',[],{},true,{message:candidate.text,proposal:candidate});
 expect(result.proposal).toEqual(candidate);expect(result.candidateMessage).toBe(candidate.text);expect(result.pendingCorrection).toBeUndefined();
});
