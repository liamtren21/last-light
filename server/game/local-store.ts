import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { restoreGameState } from '../../src/game/save';
import type { GameState } from '../../src/game/schema';
export type SavedSession={userId:string;campaignId:string;state:GameState};
/** Local gameplay save only. Never stores chat text or recalled Walrus content. */
export class LocalGameStore {
  private records=new Map<string,SavedSession>();
  private actions=new Map<string,GameState>();
  constructor(private path:string){
    if(!existsSync(path))return;
    const data=JSON.parse(readFileSync(path,'utf8'));
    if(data.schemaVersion!==1)throw new Error('LOCAL_STORE_VERSION_UNSUPPORTED');
    for(const [key,row] of data.sessions as Array<[string,SavedSession]>)this.records.set(key,{...row,state:restoreGameState(row.state)});
    for(const [key,state] of data.actions as Array<[string,GameState]>)this.actions.set(key,restoreGameState(state));
  }
  get(key:string){return this.records.get(key);}
  action(key:string){return this.actions.get(key);}
  list(userId:string){return [...this.records.values()].filter(row=>row.userId===userId);}
  save(key:string,session:SavedSession,actionKey?:string){
    const previous=this.records.get(key); const priorAction=actionKey?this.actions.get(actionKey):undefined;
    this.records.set(key,session);if(actionKey)this.actions.set(actionKey,session.state);
    try{
      mkdirSync(dirname(this.path),{recursive:true});
      writeFileSync(`${this.path}.tmp`,JSON.stringify({schemaVersion:1,sessions:[...this.records],actions:[...this.actions]}),{mode:0o600});
      renameSync(`${this.path}.tmp`,this.path);
    }catch(error){if(previous)this.records.set(key,previous);else this.records.delete(key);if(actionKey){if(priorAction)this.actions.set(actionKey,priorAction);else this.actions.delete(actionKey);}throw error;}
  }
}
