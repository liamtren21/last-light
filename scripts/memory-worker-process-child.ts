import { processMemoryJob } from '../server/memory/worker';

type RunMessage = { type: 'run'; payload: string; mode: 'hold' | 'complete'; blobId: string; jobId: string };
type ReceiptMessage = { type: 'receipt' };
type ParentMessage = RunMessage | ReceiptMessage;

let run: RunMessage | undefined;
let receiptResolver: ((value: { blob_id: string }) => void) | undefined;
let receiptRequested = false;

process.on('message', (message: ParentMessage) => {
  if (message.type === 'run') run = message;
  if (message.type === 'receipt') receiptResolver?.({ blob_id: run!.blobId });
});

process.send?.({ type: 'ready' });
while (!run) await new Promise((resolve) => setTimeout(resolve, 5));

const fixture = run;
const worked = await processMemoryJob(() => ({
  remember: async () => {
    process.send?.({ type: 'remember' });
    return { job_id: fixture.jobId };
  },
  waitForRememberJob: async () => {
    process.send?.({ type: 'poll', jobId: fixture.jobId });
    receiptRequested = true;
    if (fixture.mode === 'complete') return { blob_id: fixture.blobId };
    return new Promise((resolve) => { receiptResolver = resolve; });
  },
  recall: async () => ({ results: [{ blob_id: fixture.blobId, text: fixture.payload }] }),
  destroy: () => {},
}) as unknown as ReturnType<typeof import('../server/memory/adapter').createMemWal>);

process.send?.({ type: 'done', worked, receiptRequested });
process.exit(0);
