import {test,expect,type Page} from '@playwright/test';
import {initialState} from '../../src/game/story';
import {gotoGame} from './helpers';

// Model the browser that shrinks only its visual viewport when the OS keyboard
// opens. This deliberately leaves innerHeight, dvh and media queries unchanged.
async function fixture(page:Page,cooperation=false){
 page.on('pageerror',error=>console.log(error.message));
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  const viewport=new EventTarget();
  Object.assign(viewport,{height:844,width:390,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
 });
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(!path.startsWith('/api/'))return route.fallback();
  if(['/api/game','/api/session'].includes(path))return route.fulfill({json:{state:{...(cooperation?initialState({gameplayVersion:2}):initialState()),...(cooperation?{sceneId:'ferry-plan',version:4}:{})},availability:{llm:false,memory:false,durableSave:false,reasons:[]}}});
  if(path==='/api/cooperation')return route.fulfill({json:{status:'empty',required:true,complete:false}});
  if(path==='/api/onboarding')return route.fulfill({json:{named:true}});
  return route.fulfill({json:{jobs:[]}});
 });
 await gotoGame(page);
}
async function resizeVisual(page:Page,height:number,offsetTop=0,scale=1){
 await page.evaluate(({height,offsetTop,scale})=>{
  Object.assign(window.visualViewport!,{height,offsetTop,scale});
  window.visualViewport!.dispatchEvent(new Event('resize'));
 },{height,offsetTop,scale});
}

test('visual-only keyboard resize keeps composer visible and preserves draft on close',async({page})=>{
 await fixture(page);
 const input=page.getByRole('textbox',{name:'Say something to Mira'});
 await input.fill('Gặp ở bến phà');
 await resizeVisual(page,430,20);
 await expect.poll(async()=>page.locator('.game-shell').evaluate(el=>Math.round(el.getBoundingClientRect().height))).toBe(430);
 const composer=await page.locator('.composer').boundingBox();
 expect(composer!.y).toBeGreaterThanOrEqual(20);
 expect(composer!.y+composer!.height).toBeLessThanOrEqual(450);
 expect((await page.locator('.scene-art').boundingBox())!.height).toBeGreaterThanOrEqual(140);
 await expect(input).toBeFocused();
 await page.screenshot({path:'verification/visual/mobile-keyboard-20261007/visual-only-430.png'});
 // Tapping SEND moves native focus before click; that must not move the target
 // underneath a finger while the OS keyboard is still visible.
 await page.getByRole('button',{name:'Send message to Mira'}).focus();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(page.locator('.game-shell')).toHaveCSS('height','430px');
 await input.focus();
 await resizeVisual(page,330);
 await expect.poll(async()=>page.locator('.game-shell').evaluate(el=>Math.round(el.getBoundingClientRect().height))).toBe(330);
 const shortComposer=await page.locator('.composer').boundingBox();
 expect(shortComposer!.y+shortComposer!.height).toBeLessThanOrEqual(330);
 await resizeVisual(page,844);
 await expect.poll(async()=>page.locator('.game-shell').evaluate(el=>Math.round(el.getBoundingClientRect().height))).toBe(844);
 await expect(input).toHaveValue('Gặp ở bến phà');
 await expect(input).toBeFocused();
 await page.screenshot({path:'verification/visual/mobile-keyboard-20261007/closed-844.png'});
});

test('pinch zoom and browser chrome do not trigger the keyboard layout',async({page})=>{
 await fixture(page);
 await page.getByRole('textbox',{name:'Say something to Mira'}).focus();
 await resizeVisual(page,422,0,2);
 await expect(page.locator('.game-shell')).toHaveCSS('height','844px');
 await resizeVisual(page,780);
 await expect(page.locator('.game-shell')).toHaveCSS('height','844px');
});

test('cooperation reason stays reachable and survives visual viewport scrolling and blur',async({page})=>{
 await fixture(page,true);
 const reason=page.getByLabel('Tell Mira why this matters to you');
 await reason.fill('Đợi mọi người dưới mái che.');
 await resizeVisual(page,430,15);
 await expect(page.locator('html')).toHaveAttribute('data-keyboard','open');
 await expect.poll(async()=>{
  const bounds=await reason.boundingBox();const composer=await page.locator('.composer').boundingBox();
  return bounds!.y+bounds!.height-composer!.y;
 }).toBeLessThanOrEqual(-8);
 expect((await reason.boundingBox())!.y).toBeGreaterThanOrEqual(15);
 await page.evaluate(()=>{
  Object.assign(window.visualViewport!,{offsetTop:25});
  window.visualViewport!.dispatchEvent(new Event('scroll'));
 });
 await expect(page.locator('.game-shell')).toHaveCSS('top','25px');
 await page.screenshot({path:'verification/visual/mobile-keyboard-20261007/cooperation-reason-430.png'});
 await reason.evaluate(el=>(el as HTMLTextAreaElement).blur());
 await expect(page.locator('html')).not.toHaveAttribute('data-keyboard','open');
 await expect(reason).toHaveValue('Đợi mọi người dưới mái che.');
});
