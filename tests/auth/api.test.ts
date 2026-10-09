import { afterAll, describe, expect, it } from 'vitest';
import { app, sessions } from '../../server/index';

async function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}
const uuid = () => crypto.randomUUID();

// These assertions inspect the in-process guest store. The real database path
// is covered by isolation.integration.test.ts and database.integration.test.ts.
describe.skipIf(Boolean(process.env.DATABASE_URL))('guest API and authoritative game actions (in-memory)', () => {
  afterAll(() => { process.env.NODE_ENV = 'test'; });
  it('creates an HttpOnly guest session and refuses unauthenticated reads', async () => {
    const unauthorized = await call('/api/game');
    expect(unauthorized.status).toBe(401);
    const response = await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
  it('rejects malformed JSON and unavailable LLM without a scripted substitute', async () => {
    const started = await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const malformed = await call('/api/actions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    const chat = await call('/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hello Mira', clientTurnId: uuid(), expectedVersion: 0 }) });
    expect(chat.status).toBe(503);
    expect(await chat.json()).toEqual({ error: 'LLM_UNAVAILABLE' });
  });
  it('replays duplicate local action IDs as the same transition result', async () => {
    const started = await call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const action = { choiceId:'ask-map',expectedVersion:0,clientActionId:uuid() };
    const first = await call('/api/actions',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(action)});
    const replay = await call('/api/actions',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(action)});
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
  });
  it('starts a separate campaign while preserving guest identity and clearing story choices', async () => {
    const started = await call('/api/session', { method: 'POST' });
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const token = cookie.split('=')[1]!;
    const before = sessions.get(token)!;
    const fresh = await call('/api/campaigns/new', { method: 'POST', headers: { cookie } });
    const after = sessions.get(token)!;
    expect(after.userId).toBe(before.userId);
    expect(after.campaignId).not.toBe(before.campaignId);
    expect((await fresh.json()).state.history).toEqual([]);
  });
});
