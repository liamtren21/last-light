import {legacyCrossing} from './helpers';
import {test,expect} from '@playwright/test';
import {gotoGame,chooseStory,reachChapterTwo,reachSignalRoom} from './helpers';

test('validated chat expressions display in map context and clear on story change (mock provider)',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await gotoGame(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-first');
  for(const expression of ['neutral','attentive','concerned','skeptical','relieved','determined']){
    await page.route('**/api/chat',route=>route.fulfill({json:{dialogue:'I am listening.',expression,proposedAction:null,memoryStatus:'not_configured'}}));
    await page.getByRole('textbox',{name:'Say something to Mira'}).fill(`Expression fixture: ${expression}`);
    await page.getByRole('button',{name:'Send message to Mira'}).click();
    await expect(page.locator('.mira-sprite')).toHaveAttribute('data-expression',expression);
    await expect.poll(()=>page.locator('.mira-sprite').evaluate(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0)).toBe(true);
    // The portrait cut must sit behind the dialogue, not float above it.
    const overlap=await page.locator('.mira-sprite').evaluate(element=>{
      const img=element as HTMLImageElement,box=img.getBoundingClientRect();
      const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let last=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]!>32)last=y;
      return box.top+(last+1)/canvas.height*box.height-document.querySelector('.scene-art')!.getBoundingClientRect().bottom;
    });
    expect(overlap).toBeGreaterThanOrEqual(-4);
    if(expression==='concerned')await page.screenshot({path:'verification/visual/chat-expression-concerned-mock.png'});
    await page.unroute('**/api/chat');
  }
  await chooseStory(page,'What does your map say?');
  await expect(page.locator('.mira-sprite')).toHaveAttribute('data-expression','scene');
});

test('radio and controller expressions use matching props; chat cannot light the lamp (mock provider)',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await gotoGame(page);await reachChapterTwo(page);
  const send=async(expression:string)=>{
    await page.route('**/api/chat',route=>route.fulfill({json:{dialogue:'I hear you.',expression,proposedAction:null,memoryStatus:'not_configured'}}));
    await page.getByRole('textbox',{name:'Say something to Mira'}).fill(`Expression fixture ${expression}`);
    await page.getByRole('button',{name:'Send message to Mira'}).click();
    await expect(page.locator('.mira-sprite')).toHaveAttribute('data-expression',expression);
    await page.unroute('**/api/chat');
  };
  await chooseStory(page,'Let’s reach the signal room together.');
  for(const expression of ['neutral','attentive','concerned','skeptical','relieved','determined']){
    await send(expression);await expect(page.locator('.mira-sprite')).toHaveAttribute('src',`/assets/characters/expression-cameras/radio/${expression}-v3.svg`);
  }
  await page.screenshot({path:'verification/visual/chat-radio-expression-mock.png'});
  // A new independent browser visit below follows the complete signal path.
  await legacyCrossing(page);await gotoGame(page);
  await reachSignalRoom(page);
  for(const expression of ['neutral','attentive','concerned','skeptical','relieved','determined']){
    await send(expression);await expect(page.locator('.mira-sprite')).toHaveAttribute('src',`/assets/characters/expression-cameras/signal/${expression}-v3.svg`);
    await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-lamp','standby');
  }
  await page.screenshot({path:'verification/visual/chat-signal-expression-mock.png'});
});

test('a stale choice refreshes the saved state without repeating the action',async({page,context})=>{
  await gotoGame(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-first');
  const other=await context.newPage();await gotoGame(other);
  await expect(other.locator('.scene-art')).toHaveAttribute('data-scene','ferry-first');
  await chooseStory(other,'What does your map say?');
  await chooseStory(page,'What changed out there?');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-map');
  await expect(page.getByRole('status').filter({hasText:'Your saved place is now up to date.'})).toBeVisible();
  const state=await page.evaluate(async()=> (await (await fetch('/api/game')).json()).state);
  expect(state.version).toBe(1);expect(state.history).toHaveLength(1);
});


test.beforeEach(async({page})=>{await legacyCrossing(page);});
