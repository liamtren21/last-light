import { config } from '../config';

/** Server-only OpenAI-compatible transport; schema validation remains above it. */
export async function generateNvidiaJson(system:string,prompt:string,schema:unknown):Promise<{text:string}> {
  if(new URL(config.llmBaseUrl).origin!=='https://integrate.api.nvidia.com')throw new Error('NVIDIA_ENDPOINT_NOT_ALLOWED');
  const response=await fetch(`${config.llmBaseUrl.replace(/\/$/,'')}/chat/completions`,{
    method:'POST',signal:AbortSignal.timeout(config.llmTimeoutMs),headers:{'content-type':'application/json',authorization:`Bearer ${config.llmApiKey}`},
    body:JSON.stringify({model:config.llmModel,messages:[{role:'system',content:system+' Return a JSON object only, without markdown. Required structure: '+JSON.stringify(schema)},{role:'user',content:prompt}],temperature:0.3,top_p:1,max_tokens:2048,reasoning_effort:'low',chat_template_kwargs:{clear_thinking:true},stream:false}),
  });
  // Never include upstream response bodies: they can echo prompts or credentials.
  if(!response.ok)throw new Error(`LLM_HTTP_${response.status}`);
  const payload=await response.json() as {choices?:Array<{finish_reason?:string;message?:{content?:unknown}}>};
  const choice=payload.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('LLM_OUTPUT_TRUNCATED');
  if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw new Error('LLM_EMPTY_RESPONSE');
  return {text:choice.message.content};
}
