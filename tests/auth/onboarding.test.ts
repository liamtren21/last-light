import {expect,test} from 'vitest';
import {app} from '../../server/index';
import {pool} from '../../server/db';
import {config} from '../../server/config';
import {decryptPayload} from '../../server/memory/crypto';
const dbtest=pool?test:test.skip;
const post=(path:string,cookie:string,body:unknown)=>app.request(path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
test('onboarding requires a session',async()=>{
  expect((await app.request('/api/onboarding')).status).toBe(401);
});
dbtest('names queue real scoped memory once, preserve the story, and distinguish same-name players',async()=>{
  const old={account:config.memwalAccountId,delegate:config.memwalDelegateKey,relayer:config.memwalRelayerUrl};
  Object.assign(config,{memwalAccountId:'fixture',memwalDelegateKey:'fixture',memwalRelayerUrl:'https://fixture.invalid'});
  try{
    const ids=[];
    for(let i=0;i<2;i++){
      const s=await post('/api/session','',{});const cookie=s.headers.get('set-cookie')!.split(';')[0]!;
      const body={name:'Nora Finch',clientTurnId:crypto.randomUUID()};
      const response=await post('/api/onboarding/name',cookie,body);expect(response.status).toBe(200);
      const result=await response.json();expect(result).toMatchObject({named:true,status:'queued'});ids.push(result.memoryId);
      expect(await (await post('/api/onboarding/name',cookie,{...body,clientTurnId:crypto.randomUUID()})).json()).toEqual(result);
      const state=await (await app.request('/api/game',{headers:{cookie}})).json();expect(state.state.version).toBe(0);
      const row=(await pool!.query('SELECT namespace,payload_ciphertext FROM memory_outbox WHERE memory_id=$1',[result.memoryId])).rows[0];
      expect(JSON.parse(decryptPayload(row.payload_ciphertext))).toMatchObject({factKey:'identity.name',text:'Call me Nora Finch.',source:{type:'user'}});
      const info=await (await app.request('/api/onboarding',{headers:{cookie}})).json();expect(info).toMatchObject({named:true,status:'queued',verified:false});
    }
    expect(ids[0]).not.toBe(ids[1]);
  }finally{Object.assign(config,{memwalAccountId:old.account,memwalDelegateKey:old.delegate,memwalRelayerUrl:old.relayer});}
});
test('invalid names are rejected without creating a memory',async()=>{
  const s=await post('/api/session','',{});const cookie=s.headers.get('set-cookie')!.split(';')[0]!;
  expect((await post('/api/onboarding/name',cookie,{name:'<script>',clientTurnId:crypto.randomUUID()})).status).toBe(400);
});
