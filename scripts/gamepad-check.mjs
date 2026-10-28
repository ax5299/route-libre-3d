/** Régression manettes : lancer le serveur local avant npm run test:gamepad. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const out = '.smoke/gamepad';
fs.mkdirSync(out, {recursive:true});
(async () => {
 const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
 const browser = await chromium.launch({ executablePath, headless:true, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio'] });
 try {
 const page = await browser.newPage({ viewport:{width:1280,height:900} });
 const errors=[];
 page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript(() => {
   window.testPad = { id:'Generic USB Test', index:0, mapping:'', connected:true, axes:[0,0,0,0,-1,1], buttons:Array.from({length:20},()=>({value:0,pressed:false,touched:false})) };
   window.testPads = [window.testPad];
   Object.defineProperty(navigator,'getGamepads',{value:()=>window.testPads});
 });
 await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/');
 await page.waitForFunction(()=>window.game?.input);
 await page.locator('#screen-home [data-action=controller]').click();
 await page.locator('#pad-start').click();
 async function axis(index, value) { await page.evaluate(({index,value})=>window.testPad.axes[index]=value,{index,value}); }
 async function button(index, value) { await page.evaluate(({index,value})=>window.testPad.buttons[index]={value,pressed:value>.5,touched:value>0},{index,value}); }
 async function capture(kind,index,value) {
   await page.locator('#pad-arm').click();
   if(kind==='axis') await axis(index,value); else await button(index,value);
   await page.waitForFunction(()=>!document.querySelector('#pad-arm').disabled);
   if(kind==='axis') await axis(index, index===4?-1:index===5?1:0); else await button(index,0);
   await page.waitForTimeout(80);
 }
 // Nonstandard axis 3, reversed steering. Full-range trigger at -1, reversed trigger at +1.
 await capture('axis',3,1);
 await capture('axis',3,-1);
 await capture('axis',4,1);
 await capture('axis',5,-1);
 // Configure all optional buttons, deliberately different from standard.
 for(const i of [4,5,6,7,8,9]) await capture('button',i,1);
 await page.locator('#pad-save').click();
 await page.waitForFunction(()=>document.querySelector('#pad-status').textContent.includes('Configuration enregistrée'));
 await page.screenshot({path:out+'/pad-setup.png',fullPage:true});
 console.log('PASS wizard, reversed steering, two trigger axis ranges, optional actions, explicit save');
 await page.locator('#screen-controller [data-action=back]').click();
 await page.locator('#screen-home [data-action=play]').click();
 await axis(3,-1); await axis(4,1); await page.waitForTimeout(100);
 let frame=await page.evaluate(()=>({...window.game.input.frame}));
 await page.waitForFunction(()=>window.game.input.frame.steer===0.25 && window.game.input.frame.throttle===1);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 assert.equal(frame.steer,0.25); assert.equal(frame.throttle,1); assert.equal(frame.brake,0);
 await axis(3,1); await axis(4,-1); await axis(5,-1); await page.waitForTimeout(100);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 await page.waitForFunction(()=>window.game.input.frame.steer===-0.25 && window.game.input.frame.brake===1);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 assert.equal(frame.steer,-0.25); assert.equal(frame.throttle,0); assert.equal(frame.brake,1);
 await axis(3,0); await axis(5,1); await page.waitForTimeout(100);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 await page.waitForFunction(()=>window.game.input.frame.steer===0 && window.game.input.frame.brake===0);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 assert.equal(frame.steer,0); assert.equal(frame.brake,0);
 console.log('PASS actual driving frame: left/right, throttle/brake, neutral');
 await page.reload(); await page.waitForFunction(()=>window.game?.input);
 assert(await page.evaluate(()=>!!window.game.input.profiles.get(window.testPad)));
 console.log('PASS profile persists after reload');
 // Cancellation preserves saved profile and connection loss invalidates a draft.
 await page.locator('#screen-home [data-action=controller]').click();
 await page.locator('#pad-start').click();
 await page.locator('#pad-arm').click();
 await page.evaluate(()=>window.testPads=[]);
 await page.waitForFunction(()=>document.querySelector('#pad-status').textContent.includes('débranchée'));
 assert(await page.locator('#pad-save').isHidden());
 await page.evaluate(()=>window.testPads=[window.testPad]); await page.waitForTimeout(100);
 assert(await page.evaluate(()=>!!window.game.input.profiles.get(window.testPad)));
 console.log('PASS disconnect cancels wizard and preserves previous profile');
 await page.locator('#pad-reset').click();
 assert.equal(await page.evaluate(()=>window.game.input.profiles.get(window.testPad)),null);
 // Button-only generic device: supports steering via D-pad and no axes at all.
 await page.evaluate(()=>{window.testPad.id='Button only';window.testPad.axes=[];});
 await page.waitForTimeout(100); await page.locator('#pad-start').click();
 for(const i of [12,13,0,1]) await capture('button',i,1);
 for(let i=0;i<6;i++) await page.locator('#pad-skip').click();
 await page.locator('#pad-save').click();
 await page.locator('#screen-controller [data-action=back]').click();
 await page.locator('#screen-home [data-action=play]').click();
 await button(13,1); await button(0,1); await page.waitForTimeout(100);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 await page.waitForFunction(()=>window.game.input.frame.steer===0.25 && window.game.input.frame.throttle===1);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 assert.equal(frame.steer,0.25); assert.equal(frame.throttle,1);
 await button(13,0);await button(0,0);
 console.log('PASS button-only generic, optional skip, digital steering');
 // Standard Xbox behavior stays unchanged without calibration.
 await page.evaluate(()=>{window.testPad.id='Xbox Standard Test';window.testPad.mapping='standard';window.testPad.axes=[0,0,0,0];});
 await axis(0,-1); await button(7,1); await page.waitForTimeout(100);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 await page.waitForFunction(()=>window.game.input.frame.steer===-0.25 && window.game.input.frame.throttle===1);
 frame=await page.evaluate(()=>({...window.game.input.frame}));
 assert.equal(frame.steer,-0.25);assert.equal(frame.throttle,1);
 console.log('PASS standard Xbox without profile');
 // Storage corruption is ignored.
 assert(await page.evaluate(async()=>{ const {PadProfiles,padKey}=await import('/src/game/pad-profile.ts');localStorage.setItem('route-libre-pad-v1:'+padKey(window.testPad),'{broken');return new PadProfiles().get(window.testPad)===null; }));
 // Storage unavailable: in-memory profile remains functional.
 assert(await page.evaluate(async()=>{ const {PadProfiles}=await import('/src/game/pad-profile.ts');const store=new PadProfiles();const p={};for(const a of ['left','right','throttle','brake','handbrake','camera','reset','pause','confirm','back'])p[a]=['left','right','throttle','brake'].includes(a)?{kind:'button',index:0,rest:0,end:1}:null;const orig=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error('blocked')};try{return !store.save(window.testPad,p)&&!!store.get(window.testPad);}finally{Storage.prototype.setItem=orig;} }));
 console.log('PASS corrupt and blocked storage');
 const direct = await page.evaluate(async()=>{
   const { InputManager } = await import('/src/game/input.ts');
   const input = new InputManager();
   const original = window.testPads;
   const pad = {id:'Isolated digital pad',index:0,mapping:'',connected:true,axes:[],buttons:Array.from({length:20},()=>({pressed:false,value:0}))};
   window.testPads=[pad];
   const binding=i=>({kind:'button',index:i,rest:0,end:1});
   input.profiles.save(pad,{left:binding(12),right:binding(13),throttle:binding(0),brake:binding(1),handbrake:binding(4),camera:binding(5),reset:binding(6),pause:binding(7),confirm:binding(8),back:binding(9)});
   const tests=[];
   try {
     pad.buttons[0]={pressed:true,value:1};
     input.update(false); tests.push(input.update(false).throttle===1);
     pad.buttons[0]={pressed:false,value:0}; input.update(false);
     for(const [index,field] of [[4,'handbrake'],[5,'switchCamera'],[6,'resetCar'],[7,'pause'],[8,'confirm'],[9,'back']]) {
       pad.buttons[index]={pressed:true,value:1};
       const f={...input.update(false)};
       tests.push(f[field]===true);
       if(field!=='handbrake') tests.push(input.update(false)[field]===false);
       pad.buttons[index]={pressed:false,value:0};input.update(false);
     }
     input.configuring=true;
     pad.buttons[7]={pressed:true,value:1}; pad.buttons[13]={pressed:true,value:1};
     const f=input.update(true);tests.push(!f.pause&&!f.confirm&&!f.menuRight&&f.steer===0);
     window.testPads=[];tests.push(input.update(false).padLost===true);
     window.testPads=[pad];tests.push(input.update(false).padConnected===true);
   }finally{input.dispose();window.testPads=original;}
   return tests;
 });
 assert(direct.every(Boolean),JSON.stringify(direct));
 console.log('PASS digital activation, all optional actions and edges, input suppression, reconnect');
 // The assistant must retain native keyboard activation and reject duplicate bindings.
 await page.evaluate(()=>window.game.hud.setScreen('controller'));
 await page.waitForTimeout(100);
 await page.locator('#pad-start').focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('#pad-arm').hidden);
 await button(7,0);await axis(0,0);await page.waitForTimeout(100);
 await capture('axis',0,-1);
 await page.locator('#pad-arm').click();await axis(0,-1);
 await page.waitForFunction(()=>document.querySelector('#pad-instruction').textContent.includes('déjà utilisée'));
 await axis(0,0);await page.locator('#pad-arm').click();
 await page.evaluate(()=>window.game.padSetup.armedAt=performance.now()-13000);
 await page.waitForFunction(()=>document.querySelector('#pad-instruction').textContent.includes('Aucun mouvement reçu'));
 await page.keyboard.press('Escape');await page.waitForFunction(()=>window.game.hud.screen==='home');
 console.log('PASS keyboard, duplicate rejection, missing-signal guidance, cancel');
 assert.deepEqual(errors,[]);
 console.log('PASS browser: no page errors');
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>window.game.hud.setScreen('controller'));
 await page.waitForTimeout(300);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:out+'/pad-mobile.png',fullPage:true});
 console.log('PASS mobile viewport: no horizontal overflow');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});


