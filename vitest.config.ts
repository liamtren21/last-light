import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000,
  // Unit/integration tests must never inherit live provider credentials from .env.
  env: { DATABASE_URL:process.env.DATABASE_URL??'', DATABASE_SSL:process.env.DATABASE_SSL??'', LLM_PROVIDER:'gemini', LLM_API_KEY:'', LLM_MODEL:'', REQUESTY_API_KEY:'', REQUESTY_API_KEYS:'', MEMWAL_ACCOUNT_ID:'', MEMWAL_DELEGATE_KEY:'', MEMWAL_RELAYER_URL:'' },
} });
