import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { pool, migrate } from '../../server/db';
import { app } from '../../server/index';
const post=(path:string,cookie:string,body:unknown={})=>app.request(path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('dedicated PostgreSQL integration',()=>{
  beforeAll(async()=>{if(!pool)throw new Error('DATABASE_REQUIRED');await migrate();});
  afterAll(async()=>{await pool?.end();});
  it('serializes duplicate actions and restores identity on a new cookie with a one-use recovery code',async()=>{
    const session=await post('/api/session','');const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
    const action={choiceId:'ask-map',expectedVersion:0,clientActionId:crypto.randomUUID()};
    const results=await Promise.all([post('/api/actions',cookie,action),post('/api/actions',cookie,action)]);
    expect(results.map(r=>r.status)).toEqual([200,200]);expect(await results[0]!.json()).toEqual(await results[1]!.json());
    const recovery=await post('/api/recovery/create',cookie);const {code}=await recovery.json();
    const restored=await post('/api/recovery/restore','',{code});expect(restored.status).toBe(200);
    expect((await restored.json()).state.sceneId).toBe('ferry-map');
    expect((await post('/api/recovery/restore','',{code})).status).toBe(401);
    const outsider=await post('/api/session','');const outsiderCookie=outsider.headers.get('set-cookie')!.split(';')[0]!;
    expect((await (await app.request('/api/game',{headers:{cookie:outsiderCookie}})).json()).state.version).toBe(0);
    const saved=await pool!.query('SELECT game_state FROM campaigns WHERE game_state->>\'sceneId\'=\'ferry-map\'');expect(saved.rowCount).toBeGreaterThan(0);
  });
  it('same caller action UUID in another campaign cannot collide',async()=>{
    const id=crypto.randomUUID();const cookies=[];
    for(let i=0;i<2;i++){const session=await post('/api/session','');cookies.push(session.headers.get('set-cookie')!.split(';')[0]!);}
    for(const cookie of cookies)expect((await post('/api/actions',cookie,{choiceId:'ask-map',expectedVersion:0,clientActionId:id})).status).toBe(200);
  });
});
