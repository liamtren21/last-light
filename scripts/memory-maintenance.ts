import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createMemWal } from '../server/memory/adapter';
import { boundedLimit, loadMaintenanceInventory, restoreScopedIndex, retentionInventory, validateMaintenanceScope } from '../server/memory/lifecycle';

export function parseMaintenanceArgs(args: string[]) {
  const options = new Map<string, string>(); let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply') { if (apply) throw new Error('DUPLICATE_OPTION'); apply = true; continue; }
    if (!['--operation', '--user', '--campaign', '--rows', '--namespaces', '--blobs'].includes(key) || options.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('INVALID_MAINTENANCE_ARGUMENT');
    options.set(key, args[++index]);
  }
  const operation = options.get('--operation') ?? 'inventory';
  if (!['inventory', 'restore-index'].includes(operation) || operation === 'inventory' && apply) throw new Error('INVALID_MAINTENANCE_OPERATION');
  const scope = { userId: options.get('--user') ?? '', campaignId: options.get('--campaign') ?? '', characterId: 'mira' as const };
  validateMaintenanceScope(scope);
  return { operation, scope, apply, rows: boundedLimit(Number(options.get('--rows') ?? 100), 500), namespaceLimit: boundedLimit(Number(options.get('--namespaces') ?? 8), 16), blobLimit: boundedLimit(Number(options.get('--blobs') ?? 10), 50) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool: (typeof import('../server/db'))['pool'] = null;
  try {
    const args = parseMaintenanceArgs(process.argv.slice(2));
    pool = (await import('../server/db')).pool;
    if (!pool) throw new Error('DATABASE_URL_REQUIRED');
    // No migration or writes to the application database, even in apply mode.
    const inventory = await loadMaintenanceInventory((sql, values) => pool!.query(sql, values), args.scope, args.rows);
    const report = args.operation === 'inventory' ? retentionInventory(inventory.rows, args.scope, inventory.truncated) : await restoreScopedIndex({ ...args, rows: inventory.rows, inventoryTruncated: inventory.truncated, createTransport: createMemWal });
    console.log(JSON.stringify(report, null, 2));
    if ('outcomes' in report && report.outcomes.some(item => item.errorCode || item.result?.failed || item.result?.truncated)) process.exitCode = 2;
  } catch (error) {
    // Never emit SDK/network errors that could contain credentials or decrypted content.
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'MEMORY_MAINTENANCE_FAILED');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
