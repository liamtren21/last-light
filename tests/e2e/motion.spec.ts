import {legacyCrossing} from './helpers';
import { expect, test } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';
import { gotoGame, chooseStory, continueStory } from './helpers';
test.use({ viewport: { width: 1280, height: 900 }, video: { mode: 'on', size: { width: 1280, height: 900 } } });

test('drawn gesture frames and background sprites play without moving the entire image', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await gotoGame(page);
  await chooseStory(page, 'What does your map say?');
  await continueStory(page, 'ferry-board');
  await continueStory(page, 'ferry-plan');
  const sample = () => page.evaluate(() => {
    const sprite = document.querySelector<HTMLImageElement>('.mira-sprite')!;
    const canvas = document.querySelector<HTMLCanvasElement>('.sprite-backdrop')!;
    const ctx = canvas.getContext('2d')!;
    const panel = document.querySelector('.dialogue-paper')!.getBoundingClientRect();
    const digest = (x:number,y:number,w:number,h:number) => Array.from(ctx.getImageData(x,y,w,h).data).reduce((sum,p,i) => (sum + p*(i%7+1))%1000000007,0);
    return { mira: sprite.dataset.frame, src:sprite.getAttribute('src'), transform:getComputedStyle(sprite).transform, frame:canvas.dataset.frame,
      staticRoof:digest(1400,100,160,120), sea:digest(100,425,400,60), panel:[panel.x,panel.y,panel.width,panel.height] };
  });
  await expect.poll(async () => (await sample()).frame).toBeDefined();
  const first = await sample();
  await expect.poll(async () => (await sample()).sea, {timeout:4000}).not.toBe(first.sea);
  expect((await sample()).staticRoof).toBe(first.staticRoof);
  await expect.poll(async () => (await sample()).mira, {timeout:6000,intervals:[80]}).toBe('2');
  const pointing=await sample();
  expect(pointing.transform).toBe('none');
  expect(pointing.panel).toEqual(first.panel);
  await page.screenshot({path:'verification/visual/sprite-mira-pointing-1280x900.png'});
  await page.getByRole('button', {name:'Open settings'}).click();
  await page.getByRole('button', {name:'Scene motion',exact:true}).click();
  await expect.poll(async () => (await sample()).mira).toBe('0');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-playback','stopped');
  const stopped=await sample();await page.waitForTimeout(400);expect(await sample()).toEqual(stopped);
  await page.getByRole('button', {name:'Scene motion',exact:true}).click();
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(async () => (await sample()).mira).toBe('0');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-playback','stopped');
  const reduced=await sample();await page.waitForTimeout(400);expect(await sample()).toEqual(reduced);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('.scene-art')).toHaveAttribute('data-paused','true');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-playback','stopped');
  const hidden=await sample();await page.waitForTimeout(350);expect(await sample()).toEqual(hidden);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.getByRole('button', {name:'Close settings'}).click();
  await chooseStory(page, 'Take the ridge. We’ll have a clear view.');
  await chooseStory(page, 'Mark the clear outer channel.');
  await chooseStory(page, 'Let’s meet back here if we get separated.');
  await continueStory(page, 'chapter-two');
  await chooseStory(page, 'Let’s reach the signal room together.');
  await chooseStory(page, 'Check the handrail and the next few steps.');
  await chooseStory(page, 'We’ll go slowly. Stay close.');
  await continueStory(page, 'second-pause');
  await continueStory(page, 'signal-inspection');
  await chooseStory(page, 'Follow the cable to the lamp.');
  await continueStory(page, 'signal-tested');
  await chooseStory(page, 'Set the controller to the flood warning.');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-scene','signal');
  const video=page.video();await page.close();
  if(video){await mkdir('verification/visual',{recursive:true});await copyFile(await video.path(),'verification/visual/sprite-animation-preview-v1.webm');}
});


test.beforeEach(async({page})=>{await legacyCrossing(page);});
