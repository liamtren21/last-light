import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const transport = vi.hoisted(() => ({ recall: vi.fn(), destroy: vi.fn() }));
vi.mock('../../server/memory/adapter', async original => ({ ...await original<object>(), createMemWal: () => transport }));
vi.mock('../../server/llm/gemini', () => ({ generateMiraReply: vi.fn(), proposeMiraMemory: vi.fn() }));
import { app } from '../../server/index';
import { migrate, pool } from '../../server/db';
import { checksum } from '../../server/memory/adapter';
import { encryptPayload, decryptPayload } from '../../server/memory/crypto';
import { factHash, opaqueNamespace } from '../../server/memory/scope';
import { initialState } from '../../src/game/story';
import { transition } from '../../src/game/reducer';
import { commitCooperation, cooperationComplete, cooperationOptions, needsCooperation, type CooperationPlan } from '../../src/game/cooperation';
import type { GameState } from '../../src/game/schema';

const reason = 'PRIVATE PLAN REASON that must never become an action episode';
const plan: CooperationPlan = { meeting: 'water-tower', priority: 'signal', reason };
const firstChapter = ['ask-map', 'continue', 'continue', 'ridge-route', 'mark-channel', 'promise-meet'];
const passengerCount = [...firstChapter, 'continue', 'try-tower', 'turn-back', 'continue', 'call-from-steps', 'continue'];
const remote = new Map<string, { text: string; blob_id: string }>();
const post = (cookie: string, body: unknown) => app.request('/api/actions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function advance(state: GameState, choiceId: string, memoryId: string): GameState {
  if (needsCooperation(state) && !cooperationComplete(state)) {
    const remembered = ['return-call', 'return-plan'].includes(state.sceneId) ? { ...plan, meeting: 'shelter' as const } : plan;
    state = commitCooperation(state, cooperationOptions(state, remembered)[0]!, [memoryId]);
  }
  const result = transition(state, { choiceId, expectedVersion: state.version, clientActionId: crypto.randomUUID() });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe.skipIf(!process.env.LAST_LIGHT_DATABASE_TEST)('action episodes API with isolated PostgreSQL and fixture recall', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    // These regression tests must never connect to an application database.
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/last_light_test') throw new Error('ISOLATED_QA_DATABASE_REQUIRED');
    await migrate();
  });
  beforeEach(() => {
    vi.resetAllMocks(); remote.clear();
    transport.recall.mockImplementation(async ({ namespace }: { namespace: string }) => ({ results: remote.has(namespace) ? [remote.get(namespace)!] : [] }));
  });
  afterAll(async () => { await pool?.end(); });

  async function fixture(choices: string[], repair = false, endingChoice?: string) {
    const response = await app.request('/api/session', { method: 'POST' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const session = (await pool!.query('SELECT user_id,campaign_id FROM sessions WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0];
    const memoryId = crypto.randomUUID();
    let state = choices.reduce((current, choiceId) => advance(current, choiceId, memoryId), initialState({ gameplayVersion: 2 }));
    const endingPlan = { ...plan, meeting: 'shelter' as const, priority: endingChoice === 'keep-watch' ? 'passengers' as const : 'signal' as const };
    if (endingChoice) state = commitCooperation(state, cooperationOptions(state, endingPlan)[0]!, [memoryId]);
    if (repair) state = { ...state, flags: [...state.flags, 'cooperation-repair-prepared'] };
    await pool!.query('UPDATE campaigns SET game_state=$2,version=$3 WHERE id=$1', [session.campaign_id, state, state.version]);
    if (endingChoice) {
      const namespace = opaqueNamespace(session.user_id, session.campaign_id, 'mira', 'cooperation.plan', 1);
      const blobId = `fixture-${memoryId}`;
      const text = JSON.stringify({ schemaVersion: 1, memoryId, campaignId: session.campaign_id, characterId: 'mira', kind: 'promise', factKey: 'cooperation.plan', revision: 1, text: 'Confirmed plan for the shelter.', cooperation: endingPlan, source: { type: 'user', id: crypto.randomUUID() }, occurredAt: new Date().toISOString() });
      remote.set(namespace, { text, blob_id: blobId });
      await pool!.query("INSERT INTO memory_outbox(memory_id,user_id,campaign_id,character_id,fact_key_hash,revision,namespace,payload_ciphertext,status,memory_kind) VALUES($1,$2,$3,'mira',$4,1,$5,$6,'confirmed','promise')", [memoryId, session.user_id, session.campaign_id, factHash('cooperation.plan'), namespace, encryptPayload(text)]);
      await pool!.query('INSERT INTO memory_receipts(memory_id,job_id,blob_id,checksum,recall_verified_at) VALUES($1,$2,$3,$4,now())', [memoryId, `job-${memoryId}`, blobId, checksum(text)]);
      await pool!.query("INSERT INTO fact_heads(campaign_id,character_id,fact_key_hash,active_revision,active_memory_id) VALUES($1,'mira',$2,1,$3)", [session.campaign_id, factHash('cooperation.plan'), memoryId]);
    }
    return { cookie, state, campaignId: session.campaign_id as string, userId: session.user_id as string };
  }
  async function episodes(campaignId: string) {
    return (await pool!.query("SELECT * FROM memory_outbox WHERE campaign_id=$1 AND memory_kind='episode'", [campaignId])).rows;
  }
  async function savedState(campaignId: string) {
    return (await pool!.query('SELECT game_state FROM campaigns WHERE id=$1', [campaignId])).rows[0].game_state as GameState;
  }

  it('commits checkpoint state, game event and an encrypted episode together; replay does not duplicate', async () => {
    const s = await fixture(firstChapter);
    const body = { choiceId: 'continue', expectedVersion: s.state.version, clientActionId: crypto.randomUUID() };
    const response = await post(s.cookie, body);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.state.sceneId).toBe('chapter-two');
    expect(await savedState(s.campaignId)).toEqual(result.state);
    const rows = await episodes(s.campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: s.userId, status: 'queued', namespace: opaqueNamespace(s.userId, s.campaignId) });
    const envelope = JSON.parse(decryptPayload(rows[0].payload_ciphertext));
    expect(envelope).toMatchObject({ kind: 'episode', source: { type: 'game', id: body.clientActionId }, factKey: `episode.${rows[0].memory_id}` });
    expect(envelope.text).toMatch(/reunited.*squall/i);
    expect(envelope.text).not.toMatch(/fulfilled.*tower|met.*water tower|PRIVATE PLAN REASON/i);
    const head = (await pool!.query('SELECT pending_revision FROM fact_heads WHERE campaign_id=$1 AND fact_key_hash=$2', [s.campaignId, factHash(envelope.factKey)])).rows[0];
    expect(head.pending_revision).toBe(1);
    expect((await post(s.cookie, body)).status).toBe(200);
    expect(await episodes(s.campaignId)).toHaveLength(1);
    expect((await pool!.query('SELECT count(*) FROM game_events WHERE campaign_id=$1 AND id=$2', [s.campaignId, body.clientActionId])).rows[0].count).toBe('1');
    expect(transport.recall).not.toHaveBeenCalled();
  });

  it('rejects a failed action without an episode or state mutation', async () => {
    const s = await fixture(firstChapter);
    const id = crypto.randomUUID();
    expect((await post(s.cookie, { choiceId: 'restore-signal', expectedVersion: s.state.version, clientActionId: id })).status).toBe(422);
    expect(await savedState(s.campaignId)).toEqual(s.state);
    expect(await episodes(s.campaignId)).toHaveLength(0);
    expect((await pool!.query('SELECT count(*) FROM game_events WHERE campaign_id=$1 AND id=$2', [s.campaignId, id])).rows[0].count).toBe('0');
  });

  it('rolls back both state and event when episode enqueue fails', async () => {
    const s = await fixture(firstChapter);
    const body = { choiceId: 'continue', expectedVersion: s.state.version, clientActionId: crypto.randomUUID() };
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const functionName = `episode_qa_fail_${suffix}`;
    const triggerName = `episode_qa_trigger_${suffix}`;
    await pool!.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.campaign_id = '${s.campaignId}'::uuid THEN RAISE EXCEPTION 'QA_EPISODE_ENQUEUE_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool!.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON memory_outbox FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await post(s.cookie, body)).status).toBe(500);
      expect(await savedState(s.campaignId)).toEqual(s.state);
      expect(await episodes(s.campaignId)).toHaveLength(0);
      expect((await pool!.query('SELECT count(*) FROM game_events WHERE campaign_id=$1 AND id=$2', [s.campaignId, body.clientActionId])).rows[0].count).toBe('0');
    } finally {
      log.mockRestore();
      await pool!.query(`DROP TRIGGER ${triggerName} ON memory_outbox`);
      await pool!.query(`DROP FUNCTION ${functionName}()`);
    }
    expect((await post(s.cookie, body)).status).toBe(200);
    expect(await episodes(s.campaignId)).toHaveLength(1);
  });

  it('still stores actual passenger count after a cooperation repair', async () => {
    const s = await fixture(passengerCount, true);
    const response = await post(s.cookie, { choiceId: 'check-passengers', expectedVersion: s.state.version, clientActionId: crypto.randomUUID() });
    expect(response.status).toBe(200);
    const rows = await episodes(s.campaignId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(decryptPayload(rows[0].payload_ciphertext)).text).toMatch(/six names.*six passengers/i);
  });

  it.each(['leave-warning', 'keep-watch'])('stores the completed ending with a repair flag: %s', async choiceId => {
    const s = await fixture([...passengerCount, 'check-passengers', 'continue'], true, choiceId);
    const response = await post(s.cookie, { choiceId, expectedVersion: s.state.version, clientActionId: crypto.randomUUID() });
    expect(response.status).toBe(200);
    expect((await response.json()).state.completedEndings).toContain('return');
    const rows = await episodes(s.campaignId);
    expect(rows).toHaveLength(1);
    const envelope = JSON.parse(decryptPayload(rows[0].payload_ciphertext));
    expect(envelope.text).toMatch(/six passengers/i);
    expect(envelope.text).toMatch(choiceId === 'leave-warning' ? /pinned.*warning/i : /first watch/i);
    expect(envelope.text).not.toContain(reason);
    expect(transport.recall).toHaveBeenCalledOnce();
  });
});
