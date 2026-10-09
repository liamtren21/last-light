import {mkdir,writeFile} from 'node:fs/promises';
import {MemWal} from '@mysten-incubation/memwal';
import {config} from '../server/config';

let authenticated=false;
let errorCode:string|undefined;
if(!config.memwalAccountId||!config.memwalDelegateKey||!config.memwalRelayerUrl)errorCode='NOT_CONFIGURED';
else if(new URL(config.memwalRelayerUrl).origin!=='https://relayer.memory.walrus.xyz')errorCode='RELAYER_REQUIRES_REVIEW';
else {
  const client=MemWal.create({key:config.memwalDelegateKey,accountId:config.memwalAccountId,serverUrl:config.memwalRelayerUrl,namespace:'last-light-read-only-preflight',requestTimeoutMs:10_000});
  try {
    await client.recall({namespace:'last-light-read-only-preflight',query:'Fictional connection check',limit:1});
    authenticated=true;
  } catch(error){
    // SDK errors may contain response bodies; retain only status classification.
    const message=error instanceof Error?error.message:'';
    const status=message.match(/\b(400|401|403|404|429|500|502|503)\b/)?.[1];
    errorCode=status?`MEMWAL_HTTP_${status}`:'MEMWAL_SIGNED_READ_FAILED';
  } finally {client.destroy();}
}
const evidence={checkedAt:new Date().toISOString(),operation:'signed-read',authenticated,errorCode,databaseConfigured:Boolean(config.databaseUrl),mainnetWritePerformed:false,roundTripVerified:false};
await mkdir('verification',{recursive:true});
await writeFile('verification/memwal-auth.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(!authenticated)process.exitCode=2;
