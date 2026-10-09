import {legacyCrossing} from './helpers';
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { gotoGame, enterSavedCrossing, chooseStory, continueStory, reachChapterTwo, reachSignalRoom } from './helpers';

test('signal ending follows the readable story path at the approved reference viewport', async ({ page }) => {
  await page.route('**/api/chat', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'LLM_UNAVAILABLE'})}));
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) { super(options); Object.assign(window, { __shoreContext: this }); }
    };
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await gotoGame(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'ferry-first');
  await expect(page.getByRole('img', { name: 'Mira holds a paper map at the ferry shelter' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable shore ambience' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Enable shore ambience' }).click();
  await expect(page.getByRole('button', { name: 'Mute shore ambience' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shoreContext?: AudioContext }).__shoreContext?.state)).toBe('running');
  await page.getByRole('button', { name: 'Mute shore ambience' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shoreContext?: AudioContext }).__shoreContext?.state)).toBe('suspended');

  await mkdir('verification/visual', { recursive: true });
  await page.getByRole('button', { name: 'Reveal full dialogue line' }).click();
  await page.screenshot({ path: 'verification/visual/desktop-1672x941.png', fullPage: true });
  await page.locator('.dialogue-paper').screenshot({ path: 'verification/visual/chat-composer-concept-v2.png' });

  await reachSignalRoom(page);
  await chooseStory(page, 'Send it now. They need the warning.');
  await expect(page.getByText('SIGNAL RESTORED', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Open journal' }).click();
  await expect(page.getByRole('heading', { name: 'What we have seen' })).toBeVisible();
  await page.getByRole('button', { name: 'Close journal' }).click();
  const input = page.getByRole('textbox', { name: 'Say something to Mira' });
  await input.fill('Hello Mira');
  await page.getByRole('button', { name: 'Send message to Mira' }).click();
  await expect(page.getByText('Free conversation is unavailable right now.')).toBeVisible();
  await expect(input).toHaveValue('Hello Mira');
  await page.screenshot({ path: 'verification/visual/ending-signal-restored-1672x941.png', fullPage: true });
});

test('1440 desktop supports focused typing and a genuinely transparent portrait', async ({ page }) => {
  await page.route('**/api/chat', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'LLM_UNAVAILABLE'})}));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGame(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'ferry-first');
  const pixels = await page.getByRole('img', { name: 'Mira holds a paper map at the ferry shelter' }).evaluate(async (element) => {
    const img = element as HTMLImageElement; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(img, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0, painted = 0;
    for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] === 0) clear++; else if (rgba[i]! >= 240) painted++; }
    return { clear, painted };
  });
  expect(pixels.clear).toBeGreaterThan(1000); expect(pixels.painted).toBeGreaterThan(1000);
  const input = page.getByRole('textbox', { name: 'Say something to Mira' });
  await input.fill('Mira, can you hear me?');
  await input.focus(); await expect(input).toBeFocused();
  await page.screenshot({ path: 'verification/visual/desktop-focus-1440x900.png', fullPage: true });
  await page.getByRole('button', { name: 'Send message to Mira' }).hover();
  await page.locator('.composer').screenshot({ path: 'verification/visual/chat-composer-typing-hover-v2.png' });
  await page.getByRole('button', { name: 'Send message to Mira' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Free conversation is unavailable right now.')).toBeVisible();
  await expect(input).toHaveValue('Mira, can you hear me?');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test('safe return gathers and checks every passenger before the ending', async ({ page }) => {
  await gotoGame(page);
  await reachChapterTwo(page);
  await chooseStory(page, 'The path is flooding. We should bring people back.');
  await chooseStory(page, 'Call from the high steps and point out the route.');
  await continueStory(page, 'return-count');
  await chooseStory(page, 'Check all six names against the people here.');
  await continueStory(page, 'return-plan');
  await chooseStory(page, 'Pin a flood warning beside the ferry board.');
  await expect(page.getByText('SAFE RETURN', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Begin another crossing', exact: false })).toBeVisible();
});

test('reload restores the current chapter and a checkpoint Continue advances forward', async ({ page }) => {
  await gotoGame(page);
  await reachChapterTwo(page);
  await expect(page.locator('.chapter-mark')).toContainText('02 / THE RETURN');
  await page.reload(); await enterSavedCrossing(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'chapter-two');
  await expect(page.locator('.chapter-mark')).toContainText('02 / THE RETURN');
  await chooseStory(page, 'Let’s reach the signal room together.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'tower-road');
  await expect(page.locator('.scene-art')).not.toHaveAttribute('data-scene', 'ferry-first');
});

test('keyboard shortcuts do not consume composer input, IME, or unrelated g presses', async ({ page }) => {
  await gotoGame(page);
  const scene = page.locator('.scene-art');
  await expect(scene).toHaveAttribute('data-scene', 'ferry-first');
  await page.keyboard.press('g');
  await expect(scene).toHaveAttribute('data-scene', 'ferry-first');

  await page.keyboard.press('Space');
  await expect(scene).toHaveAttribute('data-scene', 'ferry-first');
  const input = page.getByRole('textbox', { name: 'Say something to Mira' });
  await input.fill('Hello Mira');
  await input.focus();
  await page.keyboard.press('Space');
  await expect(input).toHaveValue('Hello Mira ');
  await page.keyboard.press('g');
  await expect(input).toHaveValue('Hello Mira g');
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, isComposing: true, keyCode: 229,
  })));
  await expect(scene).toHaveAttribute('data-scene', 'ferry-first');
  await expect(input).toHaveValue('Hello Mira g');
});

test('mobile dialogue remains usable without shrinking the desktop composition', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoGame(page);
  await expect(page.getByRole('textbox', { name: 'Say something to Mira' })).toBeVisible();
  await chooseStory(page, 'What does your map say?');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'ferry-map');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('heading', { name: 'Before the storm' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'verification/visual/mobile-390x844.png', fullPage: true });
});


test.beforeEach(async({page})=>{await legacyCrossing(page);});
