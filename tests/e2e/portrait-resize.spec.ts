import {test,expect} from '@playwright/test';
test('Mira keeps crown in scene and waist behind paper through live window resizing',async({page})=>{
 await page.route(url=>url.pathname.startsWith('/api/'),r=>{const path=new URL(r.request().url()).pathname;if(path==='/api/game')return r.fulfill({json:{state:{schemaVersion:2,sceneId:'ferry-first',version:3,flags:[],history:[],unlockedChapters:[1],inventory:[],completedEndings:[]},availability:{llm:false,memory:false,durableSave:false,reasons:[]}}});if(path==='/api/onboarding')return r.fulfill({json:{named:true}});return r.fulfill({json:{jobs:[]}});});
 await page.goto('/');await page.getByRole('button',{name:/^Continue crossing/}).click();
 const bounds=await page.evaluate(async()=>{
  const rows=[];for(const sheet of ['map','radio','signal'])for(let frame=0;frame<(sheet==='signal'?8:4);frame++){
   const image=new Image();image.src=`/assets/sprites/mira-${sheet}-v4/frame-${frame}.png`;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);const {data}=ctx.getImageData(0,0,canvas.width,canvas.height);let top=canvas.height,bottom=0;
   for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(data[(y*canvas.width+x)*4+3]>80){top=Math.min(top,y);bottom=Math.max(bottom,y)}
   rows.push({sheet,frame,top:top/canvas.height,bottom:bottom/canvas.height});
  }return rows;
 });
 for(const [width,height] of [[1672,941],[1440,900],[1024,768],[900,600],[700,900],[390,844],[844,390],[1920,600],[600,900]]){
  await page.setViewportSize({width,height});await expect(page.locator('.mira-stage')).toBeVisible();
  const scene=(await page.locator('.scene-art').boundingBox())!,stage=(await page.locator('.mira-stage').boundingBox())!;
  for(const pose of bounds){
   const crown=stage.y+stage.height*pose.top,waist=stage.y+stage.height*pose.bottom;
   expect(crown,`${width}x${height} ${pose.sheet}${pose.frame} crown`).toBeGreaterThanOrEqual(scene.y+5);
   expect(waist,`${width}x${height} ${pose.sheet}${pose.frame} lower cut`).toBeGreaterThanOrEqual(scene.y+scene.height-2);
  }
  expect(Math.abs(stage.width-stage.height)).toBeLessThan(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`verification/visual/portrait-resize-${width}x${height}.png`});
 }
 await page.reload();const cover=page.getByRole('dialog');await expect(cover).toBeVisible();
 const restore=(await page.getByRole('button',{name:'Restore a saved crossing'}).boundingBox())!,watch=(await page.getByRole('button',{name:'Watch the opening film'}).boundingBox())!;
 expect(watch.y).toBeGreaterThanOrEqual(restore.y+restore.height);
 await page.screenshot({path:'verification/visual/paper-cover-v3.png'});
 console.log(JSON.stringify({resizes:9,framesPerResize:bounds.length}));
});
