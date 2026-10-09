import {describe,it,expect} from 'vitest';
import {app} from '../../server/index';
describe('request isolation',()=>{
  it('rejects cross-origin writes',async()=>{
    const response=await app.request('/api/session',{method:'POST',headers:{origin:'https://unrelated.example'}});
    expect(response.status).toBe(403);
  });
  it('ignores client scope claims and keeps 20 guests separate',async()=>{
    const cookies=[];
    for(let i=0;i<20;i++){
      const response=await app.request('/api/session',{method:'POST'});const cookie=response.headers.get('set-cookie')!.split(';')[0]!;cookies.push(cookie);
      const action=await app.request('/api/actions',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({choiceId:'ask-map',expectedVersion:0,clientActionId:crypto.randomUUID(),userId:'victim',campaignId:'victim',namespace:'victim'})});expect(action.status).toBe(200);
    }
    const fresh=await app.request('/api/session',{method:'POST'});const untouched=await app.request('/api/game',{headers:{cookie:fresh.headers.get('set-cookie')!.split(';')[0]!}});
    expect((await untouched.json()).state.version).toBe(0);
    for(const cookie of cookies){const state=await app.request('/api/game',{headers:{cookie}});expect((await state.json()).state.version).toBe(1);}
    expect(new Set(cookies).size).toBe(20);
  });
  it('reusing a previous campaign action ID cannot overwrite a replay',async()=>{
    const session=await app.request('/api/session',{method:'POST'});const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
    const headers={cookie,'content-type':'application/json'};const id=crypto.randomUUID();
    await app.request('/api/actions',{method:'POST',headers,body:JSON.stringify({choiceId:'ask-map',expectedVersion:0,clientActionId:id})});
    await app.request('/api/campaigns/new',{method:'POST',headers});
    const action=await app.request('/api/actions',{method:'POST',headers,body:JSON.stringify({choiceId:'ask-weather',expectedVersion:0,clientActionId:id})});
    expect((await action.json()).state.sceneId).toBe('ferry-weather');
  });
});
