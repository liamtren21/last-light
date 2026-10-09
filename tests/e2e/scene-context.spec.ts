import {legacyCrossing} from './helpers';
import { expect, test } from '@playwright/test';
import { copyFile } from 'node:fs/promises';
import { gotoGame, chooseStory, continueStory, reachChapterTwo, reachSignalRoom } from './helpers';

test.use({ viewport: { width: 1672, height: 941 }, video: { mode: 'on', size: { width: 1280, height: 720 } } });

test('only the confirmed send choice plays the lever and lights the lamp', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await gotoGame(page);
  await reachSignalRoom(page);
  const sprite = page.locator('.mira-sprite');
  const backdrop = page.locator('.sprite-backdrop');
  await expect(sprite).toHaveAttribute('data-sheet', 'mira-signal');
  await expect(sprite).toHaveAttribute('data-clip', 'wait');
  await expect(backdrop).toHaveAttribute('data-lamp', 'standby');
  await expect(sprite).toHaveAttribute('data-frame', '0');
  await page.screenshot({ path: 'verification/visual/context-signal-standby-1672x941.png' });
  const lamp = () => page.locator('canvas').evaluate((element) => {
    const ctx = (element as HTMLCanvasElement).getContext('2d')!;
    return Array.from(ctx.getImageData(55, 80, 55, 115).data).reduce((total, pixel, i) => (total + pixel * (i % 7 + 1)) % 100000007, 0);
  });
  const standby = await lamp();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    expect(['0', '1']).toContain(await sprite.getAttribute('data-frame'));
    expect(await lamp()).toBe(standby);
  }

  await chooseStory(page, 'Send it now. They need the warning.');
  await expect(sprite).toHaveAttribute('data-clip', 'send-signal');
  await expect.poll(() => sprite.getAttribute('data-frame'), { intervals: [60] }).toBe('4');
  await expect(backdrop).toHaveAttribute('data-lamp', 'lit');
  await expect.poll(lamp).not.toBe(standby);
  await expect.poll(() => sprite.getAttribute('data-frame'), { timeout: 5000 }).toBe('7');
  await page.waitForTimeout(1500);
  expect(await sprite.getAttribute('data-frame')).toBe('7');
  await page.screenshot({ path: 'verification/visual/context-signal-ending-1672x941.png' });
  const video = page.video(); await page.close();
  if (video) await copyFile(await video.path(), 'verification/visual/context-animation-preview-v2.webm');
});

test('tower radio appears before the signal-station checkpoint', async ({ page }) => {
  await gotoGame(page);
  await reachChapterTwo(page);
  await chooseStory(page, 'Let’s reach the signal room together.');
  const sprite = page.locator('.mira-sprite');
  await expect(sprite).toHaveAttribute('data-sheet', 'mira-radio');
  await expect(sprite).toHaveAttribute('data-clip', 'radio-check');
  await chooseStory(page, 'Check the handrail and the next few steps.');
  await chooseStory(page, 'We’ll go slowly. Stay close.');
  await continueStory(page, 'second-pause');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-scene', 'signal');
  await continueStory(page, 'signal-inspection');
  await chooseStory(page, 'Follow the cable to the lamp.');
  await continueStory(page, 'signal-tested');
  await chooseStory(page, 'Set the controller to the flood warning.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'signal-room');
});

test('return ending uses the ferry shelter after the passenger count is confirmed', async ({ page }) => {
  await gotoGame(page);
  await reachChapterTwo(page);
  await chooseStory(page, 'The path is flooding. We should bring people back.');
  await chooseStory(page, 'Call from the high steps and point out the route.');
  await continueStory(page, 'return-count');
  await chooseStory(page, 'Check all six names against the people here.');
  await continueStory(page, 'return-plan');
  await chooseStory(page, 'Pin a flood warning beside the ferry board.');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-scene', 'ferry');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-lamp', 'none');
  await expect(page.locator('.mira-sprite')).toHaveAttribute('data-clip', 'shelter');
  await expect(page.locator('.mira-sprite')).toHaveAttribute('data-sheet', 'mira-gesture');
  await expect(page.locator('.mira-sprite')).toHaveAttribute('data-art-version', 'mira-map-v4');
  await expect.poll(() => page.locator('.mira-sprite').getAttribute('data-frame')).toBe('3');
  await page.waitForTimeout(1500);
  expect(await page.locator('.mira-sprite').getAttribute('data-frame')).toBe('3');
  await page.screenshot({ path: 'verification/visual/context-return-ending-1672x941.png' });
});

test('reduced motion still shows the complete warning after an authorized send', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoGame(page);
  await reachSignalRoom(page);
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-lamp', 'standby');
  await chooseStory(page, 'Send it now. They need the warning.');
  await expect(page.locator('.sprite-backdrop')).toHaveAttribute('data-lamp', 'lit');
  await expect(page.locator('.mira-sprite')).toHaveAttribute('data-frame', '7');
});


test.beforeEach(async({page})=>{await legacyCrossing(page);});
