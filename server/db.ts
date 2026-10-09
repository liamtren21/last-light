import pg from 'pg';
import { config } from './config';
import {isPrivateDatabaseHost} from './database-host';

const localDb=config.databaseUrl&&isPrivateDatabaseHost(new URL(config.databaseUrl).hostname);
if(process.env.DATABASE_SSL==='disable'&&!localDb)throw new Error('SSL_DISABLE_ONLY_FOR_LOCAL_DATABASE');
export const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl, max: 5, ssl: process.env.DATABASE_SSL==='disable'?false:process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined }) : null;
export async function migrate() {
  if (!pool) return;
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const sql = await readFile(resolve(import.meta.dirname, '../db/migrations/001_initial.sql'), 'utf8');
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(9184329)');await client.query(sql);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
