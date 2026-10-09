import {test,expect} from '@playwright/test';
import {initialState} from '../../src/game/story';
async function fixture(page:import('@playwright/test').Page,saved=false){
 const requests:string[]=[];
 await page.route(url=>url.pathname.startsWith('/api/'),route=>{
  const path=new URL(route.request().url()).pathname;requests.push(`${route.request().method()} ${path}`);
  if(['/api/game','/api/session'].includes(path))return route.fulfill({json:{state:{...initialState(),version:saved?3:0,sceneId:saved?'ferry-map':'ferry-first'},availability:{llm:false,memory:false,durableSave:false,reasons:[]}}});
  if(path==='/api/onboarding')return route.fulfill({json:{named:true}});
  return route.fulfill({json:{jobs:[]}});
 });await page.goto('/');return requests;
}
test('opening plays real MP4 with voice, mute, mobile captions and skip without game mutation',async({page})=>{
 const requests=await fixture(page);await page.getByRole('button',{name:'Begin crossing',exact:true}).click();
 const film=page.getByRole('dialog',{name:'LAST LIGHT opening film'});await expect(film).toBeVisible();
 await expect.poll(()=>film.locator('video').evaluate(v=>(v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
 await expect.poll(()=>film.locator('video').evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
 await expect.poll(()=>film.locator('video').evaluate(v=>Math.round((v as HTMLVideoElement).duration*10))).toBe(302);
 await page.getByRole('button',{name:'MUTE',exact:true}).click();expect(await film.locator('video').evaluate(v=>(v as HTMLVideoElement).muted)).toBe(true);
 await page.getByRole('button',{name:'PAUSE',exact:true}).click();await expect(page.getByRole('button',{name:'PLAY FILM'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(film.locator('.trailer-mobile-caption')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'verification/visual/trailer-mobile.png'});
 await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).click();await expect(page.getByRole('button',{name:'Enter chapter'})).toBeVisible();
 expect(requests.filter(s=>s.startsWith('POST '))).toEqual([]);
});
test('saved crossing bypasses film; replay/end returns cover without changing progress',async({page})=>{
 const requests=await fixture(page,true);await page.getByRole('button',{name:'Watch the opening film'}).click();
 await page.locator('.opening-trailer video').evaluate(v=>v.dispatchEvent(new Event('ended')));
 await expect(page.getByRole('button',{name:'Continue crossing',exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Continue crossing',exact:false}).click();await expect(page.locator('.scene-art')).toHaveAttribute('data-scene','ferry-map');await expect(page.locator('.opening-trailer')).toHaveCount(0);
 expect(requests.filter(s=>s.startsWith('POST '))).toEqual([]);
});
test('film source error leaves safe skip and text; Escape and focus trap work',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Watch the opening film'}).click();
 await page.locator('.opening-trailer source').evaluate(source=>source.dispatchEvent(new Event('error')));
 await expect(page.getByRole('status')).toContainText('could not load');await page.getByText('Read the opening story',{exact:true}).click();
 await expect(page.getByText('The tide keeps moving. What will you ask her to remember?',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'SKIP · BEGIN CROSSING →'}).focus();await page.keyboard.press('Shift+Tab');await expect(page.locator('.trailer-transcript summary')).toBeFocused();
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Begin crossing',exact:true})).toBeVisible();
});

