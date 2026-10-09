import 'dotenv/config';
if(process.env.NODE_ENV==='production'){
  for(const key of ['DATABASE_URL','SESSION_SECRET','PUBLIC_ORIGIN'])if(!process.env[key])throw new Error(`MISSING_${key}`);
  if(!process.env.PUBLIC_ORIGIN?.startsWith('https://'))throw new Error('PRODUCTION_REQUIRES_HTTPS_ORIGIN');
  if((process.env.SESSION_SECRET?.length??0)<32)throw new Error('SESSION_SECRET_TOO_SHORT');
}

export const config = {
  port: 4329,
  databaseUrl: process.env.DATABASE_URL,
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL,
  llmProvider: process.env.LLM_PROVIDER === 'chatgpt' ? '9router' : process.env.LLM_PROVIDER ?? 'gemini',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
  llmTimeoutMs: 90_000,
  requestyApiKey: process.env.REQUESTY_API_KEY,
  requestyApiKeys: process.env.REQUESTY_API_KEYS,
  get requestyConfigured(){return Boolean(this.requestyApiKey?.trim()||this.requestyApiKeys?.split(',').some(key=>key.trim()));},
  requestyModel: process.env.REQUESTY_MODEL ?? 'google/gemma-4-31b-it',
  memwalAccountId: process.env.MEMWAL_ACCOUNT_ID,
  memwalDelegateKey: process.env.MEMWAL_DELEGATE_KEY,
  memwalRelayerUrl: process.env.MEMWAL_RELAYER_URL,
  get sessionSecret() { return process.env.SESSION_SECRET; },
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4328',
  get availability() {
    return {
      llm: Boolean(this.llmApiKey && this.llmModel),
      memory: Boolean(this.memwalAccountId && this.memwalDelegateKey && this.memwalRelayerUrl && this.databaseUrl && this.sessionSecret),
      durableSave: Boolean(this.databaseUrl),
      localSave: !this.databaseUrl && process.env.NODE_ENV !== 'test',
      reasons: [
        ...(!this.databaseUrl ? ['PostgreSQL is not configured; gameplay is saved on this computer, with no long-term NPC memory.'] : []),
        ...(!(this.llmApiKey && this.llmModel) ? ['LLM credentials/model are not configured; free text will not be answered by a scripted imitation.'] : []),
        ...(!(this.memwalAccountId && this.memwalDelegateKey && this.memwalRelayerUrl) ? ['Walrus Memory credentials are not configured; no long-term recall is claimed.'] : []),
      ],
    };
  },
};
