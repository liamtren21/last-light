import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const primary=vi.hoisted(()=>vi.fn());
vi.mock('@google/genai',()=>({GoogleGenAI:class{models={generateContent:primary};}}));
import {config} from '../../server/config';
import {generateMiraReply,proposeMiraMemory,resetQuotaRouting} from '../../server/llm/gemini';
const original={llmProvider:config.llmProvider,llmApiKey:config.llmApiKey,llmModel:config.llmModel,requestyApiKey:config.requestyApiKey};
const fetcher=vi.fn();const valid={dialogue:'We can check the map.',expression:'attentive',proposedAction:null};
const completion=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

test('fallback requests minimal reasoning without truncating the output budget',async()=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  fetcher.mockResolvedValueOnce(completion(valid)).mockResolvedValueOnce(completion({candidate:null}));
  await generateMiraReply('ferry-first','Hello');await proposeMiraMemory('Hello');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).max_tokens).toBe(2048);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).reasoning_effort).toBe('none');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).max_tokens).toBe(2048);
});
test('Requesty quota cooldown prevents repeated calls then allows recovery',async()=>{
  vi.useFakeTimers();primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  fetcher.mockResolvedValueOnce(new Response('private echo',{status:429,headers:{'retry-after':'120'}}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toMatchObject({status:429,retryAfterSeconds:120});
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toMatchObject({status:429});expect(fetcher).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(120001);fetcher.mockResolvedValueOnce(completion(valid));
  expect(await generateMiraReply('ferry-first','Hello')).toMatchObject(valid);expect(fetcher).toHaveBeenCalledTimes(2);
});
beforeEach(()=>{resetQuotaRouting();vi.resetAllMocks();vi.stubGlobal('fetch',fetcher);Object.assign(config,{llmProvider:'gemini',llmApiKey:'fixture-gemini',llmModel:'fixture-model',requestyApiKey:'fixture-requesty'});});
afterEach(()=>{resetQuotaRouting();Object.assign(config,original);vi.unstubAllGlobals();vi.useRealTimers();});
test('429 switches once, routes extraction too and retries Gemini after cooldown',async()=>{
  vi.useFakeTimers();primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  fetcher.mockResolvedValueOnce(completion(valid)).mockResolvedValueOnce(completion({candidate:null}));
  expect(await generateMiraReply('ferry-first','Hello')).toMatchObject({...valid,llmProvider:'requesty',llmModel:'google/gemma-4-31b-it'});
  expect(await proposeMiraMemory('Hello')).toBeNull();expect(primary).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(300_001);primary.mockResolvedValueOnce({text:JSON.stringify(valid)});
  await generateMiraReply('ferry-first','Hello');expect(primary).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![0]).toBe('https://router.requesty.ai/v1/chat/completions');
});
test.each([401,403])('does not switch on primary HTTP %s',async status=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('failure'),{status}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toMatchObject({status});expect(fetcher).not.toHaveBeenCalled();
});

test.each([500,502,503,504])('primary HTTP %s uses a short fallback circuit and then retries Gemini',async status=>{
 vi.useFakeTimers();primary.mockRejectedValueOnce(Object.assign(new Error('fixture outage'),{status}));
 fetcher.mockResolvedValueOnce(completion(valid)).mockResolvedValueOnce(completion(valid));
 expect(await generateMiraReply('ferry-first','Hello')).toMatchObject({...valid,llmProvider:'requesty'});
 await generateMiraReply('ferry-first','Hello');expect(primary).toHaveBeenCalledOnce();
 vi.advanceTimersByTime(15001);primary.mockResolvedValueOnce({text:JSON.stringify(valid)});
 await generateMiraReply('ferry-first','Hello');expect(primary).toHaveBeenCalledTimes(2);
});
test('missing fallback credentials preserve the original quota failure',async()=>{
  config.requestyApiKey='';primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toMatchObject({status:429});expect(fetcher).not.toHaveBeenCalled();
});
test('fallback timeout identifies provider and stops without another model call',async()=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));fetcher.mockRejectedValueOnce(Object.assign(new Error('sensitive upstream detail'),{name:'TimeoutError'}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toMatchObject({name:'RequestyTimeoutError',message:'REQUESTY_TIMEOUT',status:504});
  expect(fetcher).toHaveBeenCalledOnce();
});
test('fallback JSON goes through repair and allowed-action validation',async()=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  fetcher.mockResolvedValueOnce(completion({...valid,expression:null})).mockResolvedValueOnce(completion({...valid,proposedAction:'restore-signal'}));
  expect((await generateMiraReply('ferry-first','Hello')).proposedAction).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);
});
test('fallback error neither leaks body nor loops back to Gemini',async()=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));fetcher.mockResolvedValueOnce(new Response('private upstream echo',{status:402}));
  await expect(generateMiraReply('ferry-first','Hello')).rejects.toThrow('REQUESTY_HTTP_402');expect(primary).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
});
test('Requesty still performs grounding audit and bounded regeneration',async()=>{
  primary.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429}));
  fetcher.mockResolvedValueOnce(completion({...valid,dialogue:'The wind will strengthen on the ridge.'}))
    .mockResolvedValueOnce(completion({supported:false,reason:'unsupported_scene_claim'}))
    .mockResolvedValueOnce(completion(valid));
  expect(await generateMiraReply('ferry-first','Hello',['The player said: Call me Rowan'])).toMatchObject(valid);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const body=JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body.messages[0].content).not.toContain('Call me Rowan');expect(body.messages[1].content).toContain('Call me Rowan');
});
