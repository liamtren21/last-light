import {config} from '../config';
import {retryTransientRead} from '../memory/read-retry';
export async function generateNineRouterJson(system:string,prompt:string,schema:unknown,temperature=.3,maxTokens=2048){
 const endpoint=new URL(config.llmBaseUrl);
 const allowed=(process.env.LLM_ALLOWED_ORIGINS??process.env.NINE_ROUTER_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
 const local=['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname);
 const internal=endpoint.hostname.endsWith('.railway.internal');
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||(!local&&!internal&&!allowed.includes(endpoint.origin))||(!['http:','https:'].includes(endpoint.protocol))||(!local&&!internal&&endpoint.protocol!=='https:'))throw new Error('NINE_ROUTER_ENDPOINT_NOT_ALLOWED');
 if(!config.llmApiKey||!config.llmModel)throw new Error('NINE_ROUTER_NOT_CONFIGURED');
 let response:Response;
 const signal=AbortSignal.timeout(30000);
 try{
  response=await retryTransientRead(async()=>{let result:Response;try{result=await fetch(`${config.llmBaseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:{'content-type':'application/json',authorization:`Bearer ${config.llmApiKey}`,'x-9router-token-saver':'off'},body:JSON.stringify({model:config.llmModel,reasoning_effort:'low',messages:[{role:'system',content:system+' Return only a JSON object without markdown matching this structure: '+JSON.stringify(schema)},{role:'user',content:prompt}],temperature,max_tokens:Math.max(128,Math.min(2048,maxTokens)),stream:false})});}catch(error){if(['TimeoutError','AbortError'].includes((error as Error).name))throw Object.assign(new Error('NINE_ROUTER_TIMEOUT'),{status:504});throw error;}
 if([502,503,504].includes(result.status)){await result.body?.cancel();throw Object.assign(new Error('NINE_ROUTER_GATEWAY_UNAVAILABLE'),{status:result.status});}
 return result;},()=>!signal.aborted);
 }catch(error){if([502,503,504].includes((error as {status?:number}).status??0))throw error;const timeout=['TimeoutError','AbortError'].includes((error as Error).name);throw Object.assign(new Error(timeout?'NINE_ROUTER_TIMEOUT':'NINE_ROUTER_NETWORK_ERROR'),{status:timeout?504:503});}
 if(!response.ok){const seconds=Number(response.headers.get('retry-after'));throw Object.assign(new Error(`NINE_ROUTER_HTTP_${response.status}`),{status:response.status,...response.status===429?{retryAfterSeconds:Number.isFinite(seconds)&&seconds>0?Math.min(3600,Math.ceil(seconds)):60}:{}});}
 const payload=await response.json() as {choices?:Array<{finish_reason?:string;message?:{content?:unknown}}>};
 const choice=payload.choices?.[0];
 if(choice?.finish_reason==='length')throw new Error('NINE_ROUTER_OUTPUT_TRUNCATED');
 if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw new Error('NINE_ROUTER_EMPTY_RESPONSE');
 return {text:choice.message.content,provider:'9router' as const,model:config.llmModel};
}
