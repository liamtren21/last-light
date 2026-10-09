export const expressions = ['neutral', 'attentive', 'concerned', 'skeptical', 'relieved', 'determined'] as const;
export type Expression = (typeof expressions)[number];

export type Choice = { id: string; text: string; reply: string; next: string; sets?: string[]; requires?: string[]; gives?: string[] };
export type Scene = { id: string; chapter: number; title: string; place: string; background: 'ferry' | 'tower' | 'signal'; mira: string; expression: Expression; choices: Choice[]; next?: string; checkpoint?: boolean; requires?: string[]; ending?: 'signal' | 'return' };
export type GameState = { schemaVersion: 2; gameplayVersion?:2; cooperation?:Array<{sceneId:string;actionId:string;memoryIds:string[];version:number;allowedChoices?:string[]}>; sceneId: string; version: number; flags: string[]; history: string[]; unlockedChapters: number[]; inventory: string[]; completedEndings: Array<'signal' | 'return'> };
export type Action = { choiceId: string; expectedVersion: number; clientActionId: string };
