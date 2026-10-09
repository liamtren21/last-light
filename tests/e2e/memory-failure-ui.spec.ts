import {test,expect} from '@playwright/test';
import {gotoGame} from './helpers';

test('provider quota keeps the draft and never fabricates a reply',async({page})=>{
  await gotoGame(page);await page.route('**/api/chat',route=>route.fulfill({status:503,json:{error:'LLM_RATE_LIMITED',retryAfterSeconds:60}}));
  const input=page.getByRole('textbox',{name:'Say something to Mira'});await input.fill('Please remember my name.');
  await page.getByRole('button',{name:'Send message to Mira'}).click();
  await expect(input).toHaveValue('Please remember my name.');await expect(page.getByRole('status')).toContainText('Conversation is temporarily busy');
  await expect(page.locator('.live-reply')).toHaveCount(0);await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-first');
});

test('unavailable recall keeps the draft and journal never offers unsafe retry (mock relayer)',async({page})=>{
  await gotoGame(page);
  await page.route('**/api/chat',route=>route.fulfill({status:503,json:{error:'MEMORY_UNAVAILABLE'}}));
  const input=page.getByRole('textbox',{name:'Say something to Mira'});
  await input.fill('Our fictional meeting point is the old red marker.');
  await page.getByRole('button',{name:'Send message to Mira'}).click();
  await expect(input).toHaveValue('Our fictional meeting point is the old red marker.');
  await expect(page.getByRole('status')).toContainText('Mira could not reach her earlier notes');
  await expect(page.locator('.live-reply')).toHaveCount(0);
  await page.route('**/api/memories',route=>route.fulfill({json:{jobs:[
    {memory_id:'00000000-0000-4000-8000-000000000001',status:'pending_unknown',error_code:'RECONCILIATION_REQUIRED',recall_verified:false,retryable:false,forgotten:false},
    {memory_id:'00000000-0000-4000-8000-000000000002',status:'failed',error_code:'poll timeout',recall_verified:false,retryable:true,forgotten:false},
    {memory_id:'00000000-0000-4000-8000-000000000003',status:'confirmed',error_code:null,recall_verified:true,retryable:false,forgotten:true},
  ]}}));
  await page.getByRole('button',{name:'Open journal'}).click();
  const rows=page.locator('.memory-job');
  await expect(rows.nth(0)).toContainText('PENDING_UNKNOWN');
  await expect(rows.nth(0).getByRole('button',{name:'RETRY',exact:true})).toHaveCount(0);
  await expect(rows.nth(1).getByRole('button',{name:'RETRY',exact:true})).toBeVisible();
  await expect(rows.nth(2)).toContainText('FORGOTTEN');
  await expect(rows.nth(2).getByRole('button',{name:'RETRY',exact:true})).toHaveCount(0);
  await page.screenshot({path:'verification/visual/memory-failure-journal-mock.png'});
  await page.getByRole('button',{name:'Close journal'}).click();
  await expect(input).toHaveValue('Our fictional meeting point is the old red marker.');
});
