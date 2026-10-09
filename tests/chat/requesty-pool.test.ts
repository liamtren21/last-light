import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {config} from '../../server/config';
import {generateRequestyJson,resetRequestyCooldown} from '../../server/llm/requesty';
const saved={requestyApiKeys:config.requestyApiKeys,requestyApiKey:config.requestyApiKey};
const fetcher=vi.fn(),reply=()=>new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
const call=()=>generateRequestyJson('system','input',{});
beforeEach(()=>{resetRequestyCooldown();vi.resetAllMocks();vi.stubGlobal('fetch',fetcher);config.requestyApiKeys='one,two,three';config.requestyApiKey='old';});
afterEach(()=>{Object.assign(config,saved);resetRequestyCooldown();vi.unstubAllGlobals();vi.useRealTimers();});
test('rotates on 429 and auth failure, then skips cooling keys',async()=>{
 fetcher.mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'120'}})).mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply());
 await call();await call();expect(fetcher.mock.calls.map(([,init])=>init.headers.authorization)).toEqual(['Bearer one','Bearer two','Bearer three','Bearer three']);
});
test('round robin distributes successful requests',async()=>{
 fetcher.mockImplementation(async()=>reply());await Promise.all([call(),call(),call()]);expect(fetcher.mock.calls.map(([,init])=>init.headers.authorization)).toEqual(['Bearer one','Bearer two','Bearer three']);
});
test('all keys exhausted stops once per key and no calls during cooldown',async()=>{
 vi.useFakeTimers();fetcher.mockImplementation(async()=>new Response('',{status:429}));
 await expect(call()).rejects.toMatchObject({status:429});await expect(call()).rejects.toMatchObject({status:429});expect(fetcher).toHaveBeenCalledTimes(3);
 vi.advanceTimersByTime(60_001);fetcher.mockResolvedValueOnce(reply());await call();expect(fetcher).toHaveBeenCalledTimes(4);
});
test.each([500,503,408])('temporary HTTP%s tries next key',async status=>{
 fetcher.mockResolvedValueOnce(new Response('',{status})).mockResolvedValueOnce(reply());await call();expect(fetcher).toHaveBeenCalledTimes(2);
});
test('timeout rotates but obeys the total deadline',async()=>{
 vi.useFakeTimers();fetcher.mockImplementation(async()=>{vi.advanceTimersByTime(30_000);throw Object.assign(new Error('private details'),{name:'TimeoutError'});});
 await expect(call()).rejects.toMatchObject({message:'REQUESTY_TIMEOUT',status:504});expect(fetcher).toHaveBeenCalledTimes(2);
});
test('billing and bad requests are not fixed by trying another key',async()=>{
 fetcher.mockResolvedValueOnce(new Response('private echo',{status:402}));await expect(call()).rejects.toThrow('REQUESTY_HTTP_402');expect(fetcher).toHaveBeenCalledOnce();
});
test('malformed/truncated content never rotates',async()=>{
 fetcher.mockResolvedValueOnce(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})));
 await expect(call()).rejects.toThrow('REQUESTY_OUTPUT_TRUNCATED');expect(fetcher).toHaveBeenCalledOnce();
});
test('deduplicates keys and uses the pool without the old singleton',async()=>{
 config.requestyApiKeys='one,one,two';fetcher.mockResolvedValue(new Response('',{status:429}));await expect(call()).rejects.toMatchObject({status:429});expect(fetcher).toHaveBeenCalledTimes(2);
});
