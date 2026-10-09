import {config} from '../config';
const blocked=new Map<string,{until:number;status:number}>();
let cursor=0;
export function resetRequestyCooldown(){blocked.clear();cursor=0;}
function configuredKeys(){
  const pool=config.requestyApiKeys?.split(',').map(key=>key.trim()).filter(Boolean)??[];
  return [...new Set(pool.length?pool:[config.requestyApiKey?.trim()].filter((key):key is string=>Boolean(key)))].slice(0,8);
}
function httpError(status:number,wait?:number){return Object.assign(new Error(`REQUESTY_HTTP_${status}`),{status,...wait?{retryAfterSeconds:wait}:{}});}
function retrySeconds(header:string|null){
  const numeric=Number(header),seconds=header?(Number.isFinite(numeric)?numeric:(Date.parse(header)-Date.now())/1000):60;
  return Math.ceil(Math.min(3600,Math.max(30,Number.isFinite(seconds)?seconds:60)));
}
export async function generateRequestyJson(system:string,prompt:string,schema:unknown,temperature=.3,maxOutputTokens=2048){
  const keys=configuredKeys();if(!keys.length)throw new Error('REQUESTY_UNAVAILABLE');
  const attempted=new Set<string>(),deadline=Date.now()+60_000;let lastError:Error|undefined;
  while(attempted.size<keys.length&&Date.now()<deadline){
    let key:string|undefined;
    for(let offset=0;offset<keys.length;offset++){
      const index=(cursor+offset)%keys.length,candidate=keys[index]!;
      if(!attempted.has(candidate)&&(blocked.get(candidate)?.until??0)<=Date.now()){key=candidate;cursor=(index+1)%keys.length;break;}
    }
    if(!key)break;attempted.add(key);
    let response:Response;
    try{
      response=await fetch('https://router.requesty.ai/v1/chat/completions',{
        method:'POST',signal:AbortSignal.timeout(Math.max(1,Math.min(30_000,deadline-Date.now()))),
        headers:{'content-type':'application/json',authorization:`Bearer ${key}`},
        body:JSON.stringify({model:config.requestyModel,messages:[{role:'system',content:system+' Return only JSON matching this structure: '+JSON.stringify(schema)},{role:'user',content:prompt}],temperature,reasoning_effort:'none',max_tokens:Math.max(128,Math.min(2048,maxOutputTokens)),stream:false,response_format:{type:'json_object'}}),
      });
    }catch(error){
      const timeout=['TimeoutError','AbortError'].includes((error as Error).name);
      lastError=Object.assign(new Error(timeout?'REQUESTY_TIMEOUT':'REQUESTY_NETWORK_ERROR'),{name:timeout?'RequestyTimeoutError':'RequestyNetworkError',status:timeout?504:503});
      blocked.set(key,{until:Date.now()+30_000,status:timeout?504:503});continue;
    }
    if(!response.ok){
      const status=response.status;
      if(![401,403,408,429].includes(status)&&status<500)throw httpError(status);
      const wait=status===429?retrySeconds(response.headers.get('retry-after')):[401,403].includes(status)?3600:30;
      blocked.set(key,{until:Date.now()+wait*1000,status});lastError=httpError(status,wait);continue;
    }
    // Delivered content errors are repaired above, never by changing credentials.
    const payload=await response.json() as {choices?:Array<{finish_reason?:string;message?:{content?:unknown}}>};
    const choice=payload.choices?.[0];
    if(choice?.finish_reason==='length')throw new Error('REQUESTY_OUTPUT_TRUNCATED');
    if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw new Error('REQUESTY_EMPTY_RESPONSE');
    return {text:choice.message.content,provider:'requesty' as const,model:config.requestyModel};
  }
  if(lastError)throw lastError;
  const first=keys.map(key=>blocked.get(key)).filter((state):state is {until:number;status:number}=>Boolean(state)).sort((a,b)=>a.until-b.until)[0];
  throw httpError(first?.status??429,Math.max(1,Math.ceil(((first?.until??Date.now()+60_000)-Date.now())/1000)));
}
