import {test,expect} from '@playwright/test';
test('arrival retains name on failure, queues once and enters chapter without fake recall',async({page})=>{
  await page.route('**/api/onboarding',r=>r.fulfill({json:{named:false,status:'empty',verified:false}}));
  let attempts=0;
  await page.route('**/api/onboarding/name',r=>{attempts++;return r.fulfill(attempts===1?{status:503,json:{error:'MEMORY_UNAVAILABLE'}}:{json:{named:true,status:'queued',verified:false,memoryId:'fixture'}});});
  await page.goto('/');await page.getByRole('button',{name:'Begin crossing',exact:true}).click();await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).click();
  const input=page.getByRole('textbox',{name:'Your name'});await expect(input).toBeFocused();
  await input.fill('Nora Finch');await page.getByRole('button',{name:'Begin my crossing'}).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');await expect(input).toHaveValue('Nora Finch');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'verification/visual/arrival-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Begin my crossing'}).click();await expect(page.getByRole('button',{name:'Enter chapter'})).toBeVisible();
  await page.getByRole('button',{name:'Enter chapter'}).click();await expect(page.getByRole('status')).toContainText('waiting to be saved');
  expect(attempts).toBe(2);await expect(page.locator('.live-reply')).toHaveCount(0);
});
test('recovery is offered before gameplay and invalid code stays editable',async({page})=>{
  await page.route('**/api/onboarding',r=>r.fulfill({json:{named:false,status:'empty',verified:false}}));
  await page.route('**/api/recovery/restore',r=>r.fulfill({status:401,json:{error:'INVALID_RECOVERY_CODE'}}));
  await page.goto('/');await page.getByRole('button',{name:'Begin crossing',exact:true}).click();await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).click();
  await page.getByRole('button',{name:'I have a recovery code'}).click();
  const input=page.getByRole('textbox',{name:'Recovery code'});await input.fill('invalid-private-code');
  await page.getByRole('button',{name:'Restore my crossing'}).click();await expect(page.getByRole('alert')).toContainText('could not be used');
  await expect(input).toHaveValue('invalid-private-code');
  await page.setViewportSize({width:1672,height:941});await page.screenshot({path:'verification/visual/arrival-recovery-desktop.png'});
});
