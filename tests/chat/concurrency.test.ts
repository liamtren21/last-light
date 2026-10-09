import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ reply: vi.fn() }));
vi.mock('../../server/llm/gemini', () => ({ generateMiraReply: provider.reply, proposeMiraMemory: vi.fn() }));
import { app } from '../../server/index';
import { config } from '../../server/config';

const post = (path: string, cookie: string, body: unknown) => app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('local campaign turn isolation (mock provider, no live AI claim)', () => {
  const original = { key: config.llmApiKey, model: config.llmModel };
  afterEach(() => { config.llmApiKey = original.key; config.llmModel = original.model; vi.clearAllMocks(); });
  it('blocks a different turn and game action while a reply is running, then replays the completed turn', async () => {
    config.llmApiKey = 'fixture'; config.llmModel = 'fixture';
    let finish!: (value: unknown) => void;
    provider.reply.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const session = await post('/api/session', '', {});
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const turn = { message: 'Hello', clientTurnId: crypto.randomUUID(), expectedVersion: 0 };
    const running = post('/api/chat', cookie, turn);
    await vi.waitFor(() => expect(provider.reply).toHaveBeenCalledOnce());
    const other = await post('/api/chat', cookie, { ...turn, clientTurnId: crypto.randomUUID() });
    expect(await other.json()).toEqual({ error: 'TURN_IN_PROGRESS' });
    const action = await post('/api/actions', cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID() });
    expect(await action.json()).toEqual({ error: 'TURN_IN_PROGRESS' });
    finish({ dialogue: 'Fixture reply', expression: 'neutral', proposedAction: null });
    const first = await running;
    const replay = await post('/api/chat', cookie, turn);
    expect(await first.json()).toEqual(await replay.json());
    expect(provider.reply).toHaveBeenCalledOnce();
    expect((await post('/api/actions', cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID() })).status).toBe(200);
  });
  it('releases the campaign lock after provider failure and does not move the scene', async () => {
    config.llmApiKey = 'fixture'; config.llmModel = 'fixture';
    provider.reply.mockRejectedValue(new Error('fixture failure'));
    const session = await post('/api/session', '', {});
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    expect((await post('/api/chat', cookie, { message: 'I fixed the radio', expectedVersion: 0, clientTurnId: crypto.randomUUID() })).status).toBe(502);
    const read = await app.request('/api/game', { headers: { cookie } });
    expect((await read.json()).state.sceneId).toBe('ferry-first');
    expect((await post('/api/actions', cookie, { choiceId: 'ask-map', expectedVersion: 0, clientActionId: crypto.randomUUID() })).status).toBe(200);
  });
  it('streams progress and emits only the validated complete reply',async()=>{
    config.llmApiKey='fixture';config.llmModel='fixture';provider.reply.mockResolvedValue({dialogue:'Fixture reply',expression:'attentive',proposedAction:null});
    const session=await post('/api/session','',{});const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
    const response=await app.request('/api/chat',{method:'POST',headers:{cookie,'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({message:'Hello',clientTurnId:crypto.randomUUID(),expectedVersion:0})});
    const stream=await response.text();expect(stream).toContain('event: accepted');expect(stream).toContain('event: recalling');expect(stream).toContain('event: thinking');expect(stream).toContain('event: reply');expect(stream).toContain('Fixture reply');
  });
  it('provider quota returns retry metadata and releases the campaign lock',async()=>{
    config.llmApiKey='fixture';config.llmModel='fixture';provider.reply.mockRejectedValueOnce(Object.assign(new Error('quota'),{status:429,retryAfterSeconds:120}));
    const session=await post('/api/session','',{});const cookie=session.headers.get('set-cookie')!.split(';')[0]!;
    const response=await post('/api/chat',cookie,{message:'Hello',clientTurnId:crypto.randomUUID(),expectedVersion:0});
    expect(response.status).toBe(503);expect(response.headers.get('retry-after')).toBe('120');expect(await response.json()).toEqual({error:'LLM_RATE_LIMITED',retryAfterSeconds:120});
    expect((await post('/api/actions',cookie,{choiceId:'ask-map',expectedVersion:0,clientActionId:crypto.randomUUID()})).status).toBe(200);
  });
});
