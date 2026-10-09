import {afterEach,expect,test,vi} from 'vitest';
import {config} from '../../server/config';
import {generateNineRouterJson} from '../../server/llm/nine-router';
const old={base:config.llmBaseUrl,key:config.llmApiKey,model:config.llmModel};
afterEach(()=>{config.llmBaseUrl=old.base;config.llmApiKey=old.key;config.llmModel=old.model;vi.unstubAllGlobals();});
function setup(response:Response){config.llmBaseUrl='http://127.0.0.1:20128/v1';config.llmApiKey='dummy-router-test-key';config.llmModel='cx/test-model';const fn=vi.fn().mockResolvedValue(response);vi.stubGlobal('fetch',fn);return fn;}
test('sends scoped prompt without router transforms or conversation sharing',async()=>{
 const fn=setup(Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
 expect(await generateNineRouterJson('Mira canon','Only user A verified facts',{type:'OBJECT'})).toEqual({text:'{"ok":true}',provider:'9router',model:'cx/test-model'});
 const [url,options]=fn.mock.calls[0]!;expect(url).toBe('http://127.0.0.1:20128/v1/chat/completions');
 expect(options.headers.authorization).toBe('Bearer dummy-router-test-key');expect(options.headers['x-9router-token-saver']).toBe('off');
 const body=JSON.parse(options.body);expect(body.messages[1].content).toBe('Only user A verified facts');expect(body.reasoning_effort).toBe('low');expect(body.stream).toBe(false);expect(body.conversation_id).toBeUndefined();expect(body.previous_response_id).toBeUndefined();
});
test('preserves rate limit and never echoes upstream body containing a secret',async()=>{
 setup(new Response('private-token',{status:429,headers:{'retry-after':'60'}}));
 await expect(generateNineRouterJson('s','p',{})).rejects.toMatchObject({message:'NINE_ROUTER_HTTP_429',status:429,retryAfterSeconds:60});
});
test.each(['https://evil.test/v1','http://public.example/v1','http://169.254.169.254/v1','http://127.0.0.1:20128/v1?token=secret'])('rejects unapproved endpoint %s',async(base)=>{
 const fn=setup(Response.json({}));config.llmBaseUrl=base;await expect(generateNineRouterJson('s','p',{})).rejects.toThrow('NINE_ROUTER_ENDPOINT_NOT_ALLOWED');expect(fn).not.toHaveBeenCalled();
});
test.each([{finish_reason:'length',message:{content:'{}'}},{finish_reason:'stop',message:{content:''}}])('rejects incomplete content',async(choice)=>{
 setup(Response.json({choices:[choice]}));await expect(generateNineRouterJson('s','p',{})).rejects.toThrow(/NINE_ROUTER_(OUTPUT_TRUNCATED|EMPTY_RESPONSE)/);
});
test('timeout returns a sanitized provider error',async()=>{
 const fn=setup(Response.json({}));fn.mockRejectedValue(new DOMException('private details','TimeoutError'));
 await expect(generateNineRouterJson('s','p',{})).rejects.toMatchObject({message:'NINE_ROUTER_TIMEOUT',status:504});expect(fn).toHaveBeenCalledTimes(2);
});

test('one transient gateway failure is retried inside the same request budget',async()=>{
 const fn=setup(Response.json({}));fn.mockReset().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
 expect((await generateNineRouterJson('s','p',{})).text).toBe('{"ok":true}');expect(fn).toHaveBeenCalledTimes(2);
 expect(fn.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);expect(fn.mock.calls[1]![1].signal).toBeInstanceOf(AbortSignal);
});

test('recovers once from a stalled provider attempt, without an unbounded retry loop',async()=>{
 const fn=setup(Response.json({}));fn.mockReset().mockRejectedValueOnce(new DOMException('private details','TimeoutError')).mockResolvedValueOnce(Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
 expect((await generateNineRouterJson('s','p',{})).text).toBe('{"ok":true}');expect(fn).toHaveBeenCalledTimes(2);
});
