import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {config} from '../../server/config';
import {generateMiraReply,proposeMiraMemory} from '../../server/llm/gemini';
const previous={provider:config.llmProvider,key:config.llmApiKey,model:config.llmModel,base:config.llmBaseUrl};
const request=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',request);request.mockReset();config.llmProvider='nvidia';config.llmApiKey='fixture-key';config.llmModel='fixture-model';config.llmBaseUrl='https://integrate.api.nvidia.com/v1';});
afterEach(()=>{vi.unstubAllGlobals();Object.assign(config,{llmProvider:previous.provider,llmApiKey:previous.key,llmModel:previous.model,llmBaseUrl:previous.base});});
const completion=(content:string)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{status:200});
test('NVIDIA keeps memory in user JSON and retains reply validation/one repair',async()=>{
  request.mockResolvedValueOnce(completion('{bad')).mockResolvedValueOnce(completion(JSON.stringify({dialogue:'We can look at the map.',expression:'attentive',proposedAction:'invented'})));
  const reply=await generateMiraReply('ferry-first','Hello',['The player said: Call me Rowan']);
  expect(reply.proposedAction).toBeNull();expect(request).toHaveBeenCalledTimes(2);
  const [url,init]=request.mock.calls[0]!;expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  const payload=JSON.parse(init.body);expect(payload.model).toBe('fixture-model');expect(payload.reasoning_effort).toBe('low');expect(payload.chat_template_kwargs).toEqual({clear_thinking:true});expect(payload.messages[0].content).not.toContain('Rowan');expect(payload.messages[1].content).toContain('Rowan');
});
test('NVIDIA auth errors do not expose upstream body or generate fallback',async()=>{
  request.mockResolvedValue(new Response('secret prompt echo',{status:401}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toThrow('LLM_HTTP_401');expect(request).toHaveBeenCalledOnce();
});
test('NVIDIA extraction goes through the same validated candidate schema',async()=>{
  request.mockResolvedValue(completion(JSON.stringify({candidate:{kind:'preference',factKey:'identity.name',text:'Call me Rowan',sourceQuote:'Call me Rowan',expiresInSeconds:null}})));
  expect(await proposeMiraMemory('Call me Rowan')).toMatchObject({factKey:'identity.name'});
});

test('short extracted facts preserve the supporting player wording instead of model paraphrases',async()=>{
  request.mockResolvedValue(completion(JSON.stringify({candidate:{kind:'preference',factKey:'preference.environment',text:'The player prefers quiet places located near water.',sourceQuote:'I prefer quiet places near water.',expiresInSeconds:null}})));
  expect(await proposeMiraMemory('Please remember: I prefer quiet places near water.')).toMatchObject({text:'I prefer quiet places near water.'});
});
test('NVIDIA discards truncated output and refuses unexpected credential destination',async()=>{
  request.mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toThrow('LLM_OUTPUT_TRUNCATED');
  config.llmBaseUrl='https://untrusted.invalid/v1';
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toThrow('NVIDIA_ENDPOINT_NOT_ALLOWED');expect(request).toHaveBeenCalledOnce();
});
