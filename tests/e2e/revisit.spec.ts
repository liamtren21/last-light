import {test,expect} from '@playwright/test';
import {gotoGame,chooseStory,legacyCrossing} from './helpers';
test('a saved memory can greet at the first scene before any story choice (mock provider)',async({page})=>{
  await legacyCrossing(page);
  let calls=0;
  await page.route('**/api/game',async route=>{const response=await route.fetch();if(!response.ok()){await route.fulfill({response});return;}const data=await response.json();data.availability.llm=true;data.availability.memory=true;await route.fulfill({json:data});});
  await page.route('**/api/revisit',async route=>{calls++;await route.fulfill({json:{dialogue:'Rowan, welcome back to the ferry.',expression:'attentive',proposedAction:null,memoryStatus:'recalled'}});});
  await gotoGame(page);
  await expect(page.locator('.live-reply .reader-ink')).toHaveText('Rowan, welcome back to the ferry.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-first');
  expect(calls).toBe(1);
});
test('Continue greets from verified recall once and preserves saved state (mock provider)',async({page})=>{
  await gotoGame(page);await chooseStory(page,'What does your map say?');
  await page.reload();
  let calls=0;
  await page.route('**/api/game',async route=>{const response=await route.fetch();const data=await response.json();data.availability.llm=true;data.availability.memory=true;await route.fulfill({json:data});});
  await page.route('**/api/revisit',async route=>{calls++;await route.fulfill({json:{dialogue:'Rowan, you came back. Is our meeting still by the ferry?',expression:'attentive',proposedAction:null,memoryStatus:'recalled'}});});
  await page.reload();
  await page.getByRole('button',{name:'Continue crossing',exact:true}).click();
  await expect(page.locator('.live-reply .reader-ink')).toHaveText('Rowan, you came back. Is our meeting still by the ferry?');
  expect(calls).toBe(1);
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-map');
});
