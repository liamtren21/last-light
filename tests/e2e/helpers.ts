import { expect, type Page } from '@playwright/test';

/** Seed a genuine pre-v2 QA save; never expose a downgrade API to players. */
export async function legacyCrossing(page:Page){
  const {config:loadEnv}=await import('dotenv');loadEnv({quiet:true});
  const {default:pg}=await import('pg');const {createHash}=await import('node:crypto');
  const {initialState}=await import('../../src/game/story');
  const url=new URL(process.env.DATABASE_URL??'');
  if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('LEGACY_BROWSER_FIXTURE_REQUIRES_LOCAL_DATABASE');
  const response=await page.request.post('http://127.0.0.1:4329/api/session',{data:{},headers:{origin:'http://127.0.0.1:4328'}});
  expect(response.ok()).toBe(true);const cookie=response.headers()['set-cookie']!.split(';')[0]!;
  const token=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));
  const db=new pg.Pool({connectionString:url.toString(),ssl:false,max:1});
  try{const result=await db.query('UPDATE campaigns c SET game_state=$2 FROM sessions s WHERE s.campaign_id=c.id AND s.token_hash=$1 AND c.version=0',[createHash('sha256').update(token).digest('hex'),initialState()]);expect(result.rowCount).toBe(1);}finally{await db.end();}
}

export async function enterSavedCrossing(page:Page){
  // These gameplay fixtures already have a named player; onboarding is covered
  // separately with its actual server endpoint and memory outbox assertions.
  await page.route('**/api/onboarding',route=>route.fulfill({json:{named:true,status:'confirmed',verified:true}}));
  const gate=page.getByRole('dialog');
  await expect(gate).toBeVisible();
  await gate.getByRole('button',{name:/^(Begin crossing|Continue crossing)/}).click();
  const skip=page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'});
  if(await skip.isVisible().catch(()=>false))await skip.click();
  await expect(page.getByRole('heading',{name:'LAST LIGHT',exact:true})).toHaveCount(0);
  const chapter=page.getByRole('button',{name:'Enter chapter'});
  if(await chapter.isVisible().catch(()=>false))await chapter.click();
}
export async function gotoGame(page:Page){await page.goto('/');await enterSavedCrossing(page);}
export async function finishChapterCard(page:Page){
  const button=page.getByRole('button',{name:'Enter chapter'});
  if(await button.isVisible().catch(()=>false))await button.click();
  await expect(page.locator('.game-shell')).toHaveAttribute('data-transition','idle');
}

/** Use the reader's real control so browser coverage exercises the required reading step. */
export async function revealDialogue(page: Page): Promise<void> {
  const reveal = page.getByRole('button', { name: 'Reveal full dialogue line', exact: true });
  if (await reveal.isVisible().catch(() => false)) {
    // The typewriter can finish during Playwright's actionability check.
    // A vanished Reveal control means the line completed naturally.
    try{await reveal.click({timeout:1500});}catch(error){if(await reveal.isVisible().catch(()=>false))throw error;}
  }
}

export async function chooseStory(page: Page, label: string): Promise<void> {
  await revealDialogue(page);
  const scene = page.locator('.scene-art');
  const before = await scene.getAttribute('data-scene');
  // Suggestion separators are supplied by CSS and may appear in the accessible name.
  const choice = page.getByRole('button', { name: label, exact: false });
  await expect(choice).toBeVisible();
  await choice.click();
  if (before) await expect(scene).not.toHaveAttribute('data-scene', before);
  await finishChapterCard(page);
}

export async function continueStory(page: Page, nextScene?: string): Promise<void> {
  await revealDialogue(page);
  await page.getByRole('button', { name: 'Continue story', exact: true }).click();
  if (nextScene) await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', nextScene);
  await finishChapterCard(page);
}

export async function reachFirstCheckpoint(page: Page): Promise<void> {
  await chooseStory(page, 'What does your map say?');
  await continueStory(page, 'ferry-board');
  await continueStory(page, 'ferry-plan');
  await chooseStory(page, 'Take the ridge. We’ll have a clear view.');
  await chooseStory(page, 'Mark the clear outer channel.');
  await chooseStory(page, 'Let’s meet back here if we get separated.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'first-pause');
}

export async function reachChapterTwo(page: Page): Promise<void> {
  await reachFirstCheckpoint(page);
  await continueStory(page, 'chapter-two');
}

export async function reachSignalRoom(page: Page): Promise<void> {
  await reachChapterTwo(page);
  await chooseStory(page, 'Let’s reach the signal room together.');
  await chooseStory(page, 'Check the handrail and the next few steps.');
  await chooseStory(page, 'We’ll go slowly. Stay close.');
  await continueStory(page, 'second-pause');
  await continueStory(page, 'signal-inspection');
  await chooseStory(page, 'Follow the cable to the lamp.');
  await continueStory(page, 'signal-tested');
  await chooseStory(page, 'Set the controller to the flood warning.');
  await expect(page.locator('.scene-art')).toHaveAttribute('data-scene', 'signal-room');
}
