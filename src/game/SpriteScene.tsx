import { useEffect, useRef, useState } from 'react';
import { presentationFor } from './presentation';

function useReducedMotion() {
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export const expressions = ['neutral','attentive','concerned','skeptical','relieved','determined'] as const;
export type MiraExpression = typeof expressions[number];
export function MiraSprite({ enabled, paused, sceneId, onSignal, expression,cooperationGesture }: { enabled:boolean; paused:boolean; sceneId:string; onSignal:()=>void; expression?:MiraExpression|null;cooperationGesture?:'map-point'|'radio-check'|'wait' }) {
  const baseProfile=presentationFor(sceneId);
  const profile=cooperationGesture==='map-point'&&baseProfile.background!=='signal'?{...presentationFor(baseProfile.background==='tower'?'ridge-lookout':'ferry-plan'),background:baseProfile.background}:cooperationGesture==='radio-check'&&baseProfile.background!=='signal'?{...presentationFor('tower-road'),background:baseProfile.background}:baseProfile;
  const [frame,setFrame] = useState(0);
  const [settled,setSettled]=useState(false);
  const progress=useRef({sceneId,index:0,done:false});
  const reduced = useReducedMotion();
  useEffect(() => {
    if(progress.current.sceneId!==sceneId) { progress.current={sceneId,index:0,done:false};setFrame(profile.idle);setSettled(false); }
    if (!enabled || reduced) { setFrame(profile.idle); if(profile.lamp==='activate')onSignal(); return; }
    if (paused) return;
    let timer: ReturnType<typeof setTimeout>; let stopped=false;let idleIndex=0;
    // Decode all frames before playback: no blank frame while switching poses.
    Promise.all(Array.from({length:profile.frameCount}, (_,i) => { const img=new Image();img.src=`/assets/sprites/${profile.frameRoot??profile.sheet}/frame-${i}.png`;return img.decode(); })).then(() => {
      const advance = () => {
        if(stopped)return;
        const state=progress.current;
        if(!state.done && state.index<profile.intro.length) {
          const [next,hold]=profile.intro[state.index++]!;
          setFrame(next); if(profile.lamp==='activate'&&next>=4)onSignal();
          timer=setTimeout(advance,hold);return;
        }
        state.done=true;
        setSettled(true);
        const idle:Array<[number,number]>=profile.blink===undefined?[[profile.idle,5000]]:[[profile.idle,4200],[profile.blink,110],[profile.idle,2800]];
        const [next,hold]=idle[idleIndex%idle.length]!;idleIndex++;setFrame(next);
        timer=setTimeout(advance,hold);
      };
      advance();
    }).catch(() => { if(!stopped)setFrame(profile.idle); });
    return () => { stopped=true;clearTimeout(timer); };
  },[enabled,paused,reduced,sceneId,profile,onSignal]);
  const safeFrame=progress.current.sceneId===sceneId&&frame<profile.frameCount?frame:profile.idle;
  // An expression can replace only the settled pose, never an action or ending.
  const expressionContext=profile.sheet==='mira-gesture'?'map':profile.sheet==='mira-radio'?'radio':'signal';
  const expressionSrc=expression?`/assets/characters/expression-cameras/${expressionContext}/${expression}-v3.svg`:null;
  const [decodedExpression,setDecodedExpression]=useState<string|null>(null);
  useEffect(()=>{let cancelled=false;setDecodedExpression(null);if(expressionSrc){const image=new Image();image.src=expressionSrc;image.decode().then(()=>{if(!cancelled)setDecodedExpression(expressionSrc);}).catch(()=>{});}return()=>{cancelled=true;};},[expressionSrc]);
  const showExpression=decodedExpression===expressionSrc&&expression&&profile.clip!=='shelter'&&profile.clip!=='send-signal'&&(settled&&progress.current.sceneId===sceneId||!enabled||reduced);
  return <div className="mira-stage" data-context={profile.sheet} aria-hidden="false"><img className="mira-portrait mira-sprite" src={showExpression?expressionSrc!:`/assets/sprites/${profile.frameRoot??profile.sheet}/frame-${safeFrame}.png`} data-art-version={showExpression?'expression-camera-v3':profile.frameRoot??'v1'} data-expression={showExpression?expression:'scene'} data-frame={safeFrame} data-sheet={profile.sheet} data-clip={profile.clip} alt={profile.alt} /></div>;
}

const regions: Record<string, number[][][]> = {
  ferry: [[[0,203],[542,204],[542,240],[488,240],[466,263],[394,263],[350,258],[303,275],[227,257],[136,264],[0,262]]],
  tower: [[[0,229],[489,229],[478,250],[422,275],[365,289],[269,310],[156,317],[0,337]]],
  signal: [[[444,222],[677,222],[677,274],[444,274]],[[262,220],[385,220],[385,264],[262,264]],[[752,222],[832,222],[832,294],[752,286]]],
};

export function SpriteBackdrop({ background, enabled, paused, lampLit=false }: { background:'ferry'|'tower'|'signal'; enabled:boolean; paused:boolean; lampLit?:boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  const painted = useRef<{background:string;lampLit:boolean}|null>(null);
  const reduced=useReducedMotion();
  useEffect(() => {
    let stopped=false; let raf=0;
    // Visibility pause freezes the last painted pixels, including their blend.
    // Re-decoding and redrawing here could alter the frame after reporting stop.
    if(paused && painted.current?.background===background && painted.current.lampLit===lampLit){
      canvas.current?.setAttribute('data-playback','stopped');
      return;
    }
    canvas.current?.setAttribute('data-playback','loading');
    const images=Array.from({length:4},(_,i)=>{ const img=new Image();img.src=`/assets/sprites/${background}/frame-${i}.png`;return img; });
    const master=new Image();master.src=`/assets/backgrounds/${({ferry:'ferry-shelter',tower:'water-tower-road',signal:'signal-room'} as const)[background]}.png`;
    Promise.all([...images,master].map(img=>img.decode())).then(()=> {
      if(stopped)return;
      const ctx=canvas.current?.getContext('2d');if(!ctx)return;
      ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.drawImage(master,0,0,1672,941);
      // The lamp is static until the committed signal action changes lampLit.
      // Repainting fractional clipped edges each animation frame accumulates
      // antialiasing and visibly alters a standby lamp without authorization.
      if(background==='signal'){
        ctx.save();ctx.setTransform(1672/832,0,0,941/466,0,0);
        ctx.beginPath();ctx.rect(48,76,67,126);ctx.clip();
        ctx.globalAlpha=1;ctx.drawImage(images[lampLit?2:0]!,0,0,832,466);ctx.restore();
      }
      let last=performance.now();let lastPaint=0;
      const draw=(now:number)=>{
        if(stopped)return;
        if(enabled&&!paused&&!reduced)clock.current+=Math.min(now-last,100);
        last=now;
        if(now-lastPaint>=65 || !lastPaint) {
          lastPaint=now;
          const time=enabled&&!reduced?clock.current:0;
          const phase=(time/900)%4, index=Math.floor(phase), mix=phase-index;
          ctx.setTransform(1672/832,0,0,941/466,0,0);
          ctx.save();ctx.beginPath();
          for(const polygon of regions[background]!) { polygon.forEach(([x,y],i)=>i?ctx.lineTo(x!,y!):ctx.moveTo(x!,y!));ctx.closePath(); }
          ctx.clip();ctx.globalAlpha=1;ctx.drawImage(master,0,0,832,466);ctx.globalAlpha=.22*(1-mix);ctx.drawImage(images[index]!,0,0,832,466);ctx.globalAlpha=.22*mix;ctx.drawImage(images[(index+1)%4]!,0,0,832,466);ctx.restore();
          canvas.current?.setAttribute('data-frame',String(index));
          canvas.current?.setAttribute('data-playback',enabled&&!paused&&!reduced?'playing':'stopped');
          painted.current={background,lampLit};
        }
        if(enabled&&!paused&&!reduced)raf=requestAnimationFrame(draw);
      };
      draw(performance.now());
    }).catch(()=>{/* CSS static background stays visible if a frame cannot load. */});
    return ()=>{stopped=true;cancelAnimationFrame(raf);};
  },[background,enabled,paused,reduced,lampLit]);
  return <canvas ref={canvas} width={1672} height={941} className="scene-backdrop sprite-backdrop" data-scene={background} data-lamp={background==='signal'?(lampLit?'lit':'standby'):'none'} aria-hidden="true" />;
}
