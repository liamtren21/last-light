import {legacyCrossing} from './helpers';
import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{await page.route('**/api/onboarding',route=>route.fulfill({json:{named:true,status:'confirmed',verified:true}}));});
import {gotoGame,chooseStory,reachChapterTwo,enterSavedCrossing} from './helpers';

test('cover begins chapter one, traps focus, and Continue preserves the saved choice',async({page})=>{
  await page.goto('/');
  const gate=page.getByRole('dialog');await expect(gate).toBeVisible();
  await expect(gate.getByRole('heading',{name:'LAST LIGHT'})).toBeVisible();
  await expect(gate.getByRole('button',{name:'Begin crossing'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(gate.getByRole('button',{name:'Restore a saved crossing'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(gate.getByRole('button',{name:'Watch the opening film'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(gate.getByRole('button',{name:'Begin crossing'})).toBeFocused();
  await page.screenshot({path:'verification/visual/title-cover.png'});
  await gate.getByRole('button',{name:'Begin crossing'}).click();
  await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).click();
  await expect(gate.getByRole('heading',{name:'First Contact'})).toBeVisible();
  await gate.getByRole('button',{name:'Enter chapter'}).click();
  await chooseStory(page,'What does your map say?');
  await page.reload();await expect(gate.getByRole('button',{name:'Continue crossing'})).toBeVisible();
  await enterSavedCrossing(page);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-map');
  const state=await page.evaluate(async()=> (await (await fetch('/api/game')).json()).state);
  expect(state.version).toBe(1);expect(state.history).toEqual(['ask-map']);
});

test('chapter card does not advance the story and chapter recap reveals only the chosen path',async({page})=>{
  await gotoGame(page);await reachChapterTwo(page);
  const input=page.getByRole('textbox',{name:'Say something to Mira'});await input.fill('Keep this draft while I read.');
  await page.getByRole('button',{name:'Open journal'}).click();
  await expect(page.getByRole('region',{name:'Read witnessed chapters'})).toBeVisible();
  await page.getByText('01 / First Contact',{exact:true}).click();
  const recap=page.locator('.recap-panel');
  await expect(recap.getByText('ABOVE THE LANDING',{exact:true})).toBeVisible();
  await expect(recap.getByText('THE WATERLINE',{exact:true})).toHaveCount(0);
  await expect(recap.getByText('ONE CHARGE',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Close journal'}).click();
  await expect(input).toHaveValue('Keep this draft while I read.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','chapter-two');
});

test('new crossing from cover makes a fresh save and uses the chapter-one card',async({page})=>{
  await gotoGame(page);await chooseStory(page,'What changed out there?');
  await page.reload();await page.getByRole('dialog').getByRole('button',{name:'Begin a new crossing'}).click();
  await page.getByRole('button',{name:'Begin crossing',exact:true}).click();
  await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'First Contact'})).toBeVisible();
  const state=await page.evaluate(async()=> (await (await fetch('/api/game')).json()).state);
  expect(state.version).toBe(0);expect(state.sceneId).toBe('ferry-first');expect(state.history).toEqual([]);
});

test.beforeEach(async({page})=>{await legacyCrossing(page);});
