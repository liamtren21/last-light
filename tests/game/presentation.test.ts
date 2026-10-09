import { describe, expect, it } from 'vitest';
import { presentationFor } from '../../src/game/presentation';
import { story } from '../../src/game/story';
describe('canonical scene, gesture and lamp compatibility', () => {
  it('map gestures use complete individual poses and only valid frame indices',()=>{
    const map=presentationFor('ferry-plan');
    expect(map.frameRoot).toBe('mira-map-v4');
    expect(map.frameCount).toBe(4);
    expect(map.intro.some(([frame])=>frame===2)).toBe(true);
    for(const [frame] of map.intro)expect(frame).toBeLessThan(map.frameCount);
    expect(presentationFor('ending-return').idle).toBeLessThan(map.frameCount);
  });
  it('radio and signal use native individual pose families without automatic lever operation',()=>{
    expect(presentationFor('tower-road').frameRoot).toBe('mira-radio-v4');
    expect(presentationFor('signal-room').frameRoot).toBe('mira-signal-v4');
    expect(presentationFor('signal-room').intro).toEqual([]);
    expect(presentationFor('signal-room').blink).toBeUndefined();
  });
  it('covers every scene in the authored graph with its canonical background', () => {
    for (const scene of Object.values(story)) {
      expect(presentationFor(scene.id).background, scene.id).toBe(scene.background);
      expect(presentationFor(scene.id).alt.length, scene.id).toBeGreaterThan(0);
    }
  });
  it('keeps every linear continuation and choice target inside the authored graph', () => {
    for (const scene of Object.values(story)) {
      if (scene.next) expect(story[scene.next], `${scene.id} -> ${scene.next}`).toBeDefined();
      for (const choice of scene.choices) expect(story[choice.next], `${scene.id}/${choice.id} -> ${choice.next}`).toBeDefined();
      if (scene.checkpoint) {
        expect(scene.next, `${scene.id} checkpoint must expose a continuation`).toBeDefined();
        expect(story[scene.next!]?.chapter).toBe(scene.chapter + 1);
      }
    }
  });
  it('never uses the map-pointing clip at the tower or signal station', () => {
    expect(presentationFor('ferry-plan').clip).toBe('map-point');
    expect(presentationFor('tower-road').sheet).toBe('mira-radio');
    expect(presentationFor('signal-room').sheet).toBe('mira-signal');
  });
  it('waits for a canonical send decision before operating the lever or lighting the lamp', () => {
    expect(presentationFor('signal-room').lamp).toBe('standby');
    expect(presentationFor('signal-room').clip).toBe('wait');
    expect(presentationFor('ending-signal').clip).toBe('send-signal');
    expect(presentationFor('ending-signal').lamp).toBe('activate');
    expect(presentationFor('ending-return').lamp).toBe('none');
    expect(presentationFor('ending-return').clip).toBe('shelter');
  });
});
