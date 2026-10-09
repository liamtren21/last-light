export type Presentation = {
  background:'ferry'|'tower'|'signal'; sheet:'mira-gesture'|'mira-radio'|'mira-signal';
  clip:'attentive'|'map-point'|'radio-check'|'wait'|'send-signal'|'shelter';
  lamp:'none'|'standby'|'activate'; alt:string; frameCount:number; idle:number; blink?:number;
  intro:Array<[number,number]>; frameRoot?:string;
};
const map = {background:'ferry',sheet:'mira-gesture',frameRoot:'mira-map-v4',lamp:'none',frameCount:4,idle:0,alt:'Mira holds a paper map at the ferry shelter'} as const;
const radio = {sheet:'mira-radio',frameRoot:'mira-radio-v4',lamp:'none',frameCount:4,idle:0,alt:'Mira checks her shoulder radio with the folded map in her other hand'} as const;
const signal = {background:'signal',sheet:'mira-signal',frameRoot:'mira-signal-v4',frameCount:8,idle:0,alt:'Mira waits beside the wired signal controller in the coastal station'} as const;
const scenes: Record<string,Presentation> = {
  'ferry-first': {...map,clip:'attentive',intro:[]},
  'ferry-plan': {...map,clip:'map-point',intro:[[0,350],[1,400],[2,800],[3,400],[0,300]]},
  'chapter-two': {...radio,background:'ferry',clip:'radio-check',intro:[[0,700],[1,250],[2,600],[3,300],[0,500]]},
  'tower-road': {...radio,background:'tower',clip:'radio-check',intro:[[0,600],[1,250],[2,700],[3,350],[0,500]]},
  'signal-room': {...signal,lamp:'standby',clip:'wait',intro:[]},
  'ending-signal': {...signal,lamp:'activate',clip:'send-signal',idle:7,blink:undefined,alt:'Mira pulls the signal lever and looks toward the responding harbor',intro:[[2,240],[3,260],[4,360],[5,650],[6,350],[7,800]]},
  'ending-return': {...map,clip:'shelter',idle:3,blink:undefined,alt:'Mira holds the map safely at the ferry shelter, ready to return together',intro:[]},
};
const mapPoint = scenes['ferry-plan']!;
const radioCheck = scenes['tower-road']!;
const stationWait = scenes['signal-room']!;
for (const id of ['ferry-map','ferry-plan','route-review','ferry-rendezvous']) scenes[id] = {...mapPoint};
for (const id of ['ferry-weather','ferry-purpose','ferry-board','low-waterline','first-pause','return-gather','return-count','return-confirmed','return-plan']) scenes[id] = {...map,clip:'attentive',intro:[]};
scenes['ridge-lookout'] = {...mapPoint,background:'tower',alt:'Mira marks the coast map beside the water tower'};
for (const id of ['tower-inspection','station-door','return-descent']) scenes[id] = {...radioCheck};
scenes['return-call'] = {...radioCheck,background:'ferry'};
for (const id of ['second-pause','signal-inspection','signal-cable','signal-shutter','signal-tested']) scenes[id] = {...stationWait};
export function presentationFor(sceneId:string):Presentation { return scenes[sceneId] ?? scenes['ferry-first']!; }
