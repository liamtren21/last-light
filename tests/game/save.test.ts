import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState} from '../../src/game/story';
import {restoreGameState} from '../../src/game/save';
import {LocalGameStore} from '../../server/game/local-store';
describe('versioned saves',()=>{
  it('rejects unknown scenes and newer schemas without resetting the save',()=>{
    expect(()=>restoreGameState({...initialState(),sceneId:'missing'})).toThrow('SAVE_SCENE_NOT_FOUND');
    expect(()=>restoreGameState({...initialState(),schemaVersion:99})).toThrow('SAVE_VERSION_UNSUPPORTED');
  });
  it('migrates unfinished legacy final room to the equipment inspection',()=>{
    const state=restoreGameState({sceneId:'signal-room',version:5,flags:[],history:[]});
    expect(state.sceneId).toBe('signal-inspection');expect(state.flags).toContain('station-reached');
    expect(state.version).toBe(5);
  });
  it('survives a new store instance with action idempotency and no personal memory payload',()=>{
    const directory=mkdtempSync(join(tmpdir(),'last-light-save-'));const path=join(directory,'state.json');
    try{const store=new LocalGameStore(path);const row={userId:'u',campaignId:'c',state:initialState()};
      store.save('hashed-token',row,'c:action');const restarted=new LocalGameStore(path);
      expect(restarted.get('hashed-token')).toEqual(row);expect(restarted.action('c:action')).toEqual(row.state);
      expect(readFileSync(path,'utf8')).not.toMatch(/transcript|verifiedWalrusFacts|playerMessage/);
    }finally{rmSync(directory,{recursive:true});}
  });
});
