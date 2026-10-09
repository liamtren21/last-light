import {test,expect} from '@playwright/test';
import {initialState} from '../../src/game/story';
const code='qa_private_transfer_12345678901234';
const availability={llm:false,memory:true,durableSave:true,reasons:[]};
test('journal creates a private link and local QR without exposing token to external services',async({page})=>{
 await page.route(url=>url.pathname.startsWith('/api/'),route=>{
  const path=new URL(route.request().url()).pathname;
  return route.fulfill({json:path==='/api/recovery/create'?{code}:path==='/api/memories'?{jobs:[]}:path==='/api/onboarding'?{named:true,status:'confirmed',verified:true}:{state:{...initialState(),version:1},availability}});
 });
 await page.goto('/');await page.getByRole('button',{name:'Continue crossing',exact:true}).click();
 await page.getByRole('button',{name:/journal/i}).first().click();
 await page.getByRole('button',{name:'Create my private link'}).click();
 await expect(page.getByLabel('Your private link',{exact:true})).toHaveValue(new RegExp('#restore='+code));
 await expect(page.getByAltText('Scan to continue this crossing on another device')).toHaveAttribute('src',/^data:image\/png/);
});
test('private link is scrubbed and restores exact saved place only after confirmation',async({page})=>{
 let restored=0;const state={...initialState(),version:7,sceneId:'chapter-two'};
 await page.route(url=>url.pathname.startsWith('/api/'),async route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/recovery/restore'){restored++;expect(route.request().postDataJSON()).toEqual({code});return route.fulfill({json:{state,availability}});}
  return route.fulfill({json:{state:initialState(),availability}});
 });
 await page.goto('/#restore='+code);
 await expect(page.getByRole('button',{name:'Continue this story',exact:true})).toBeVisible();
 expect(new URL(page.url()).hash).toBe('');expect(restored).toBe(0);
 await page.getByRole('button',{name:'Continue this story',exact:true}).click();
 await expect(page.getByRole('button',{name:'Continue crossing',exact:true})).toBeVisible();expect(restored).toBe(1);
});
test('used link explains recovery without discarding current story',async({page})=>{
 await page.route(url=>url.pathname.startsWith('/api/'),route=>route.fulfill(new URL(route.request().url()).pathname==='/api/recovery/restore'?{status:401,json:{error:'INVALID_RECOVERY_CODE'}}:{json:{state:initialState(),availability}}));
 await page.goto('/#restore='+code);await page.getByRole('button',{name:'Continue this story',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('already have been used');
 await page.getByRole('button',{name:'Stay with this device’s story'}).click();
 await expect(page.getByRole('button',{name:'Begin crossing',exact:true})).toBeVisible();
});
