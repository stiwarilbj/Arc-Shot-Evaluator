// Rendered interaction regression. Inference workers are held idle deliberately:
// this tests prompt placement, not segmentation quality or completed exports.
// Browser plugin not available; use the existing Playwright dependency.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const browser = await chromium.launch({channel: 'chrome', headless: true});
const url = process.env.JUMPER_TEST_URL || 'http://127.0.0.1:5175/Arc-Shot-Evaluator/';
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? {width:390,height:844} : {width:1440,height:1000},
      hasTouch: mobile, isMobile: mobile,
    });
    await context.addInitScript(() => {
      window.aimWorkerCount = 0;
      window.Worker = class extends EventTarget {
        constructor() { super(); window.aimWorkerCount++; }
        postMessage() {}
        terminate() {}
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}#jumper/create`);
    await expect(page).toHaveTitle('ARCade Hoops · Create · Guess the Jumper');
    await expect(page.getByRole('heading',{name:'One shot. No clues.'})).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    if(mobile) await page.getByRole('button',{name:'Light',exact:true}).click();
    // Any decodable, nonempty video works; no footage is committed or published.
    await page.locator('.jumper-upload input').setInputFiles(process.env.JUMPER_TEST_VIDEO || new URL("../tests/fixtures/jumper/research-short.mp4", import.meta.url).pathname);
    const image=page.getByAltText('Selected video frame; click to aim a mask point');
    await image.waitFor().catch(async error => { console.error(await page.locator("body").innerText()); throw error; });
    const place=page.getByRole('button',{name:'Place point',exact:true});
    const dots=page.locator('.jumper-point-surface circle');
    const undo=page.getByRole('button',{name:'Undo correction',exact:true});
    const redo=page.getByRole('button',{name:'Redo correction',exact:true});
    await expect(place).toBeDisabled();
    const aimAt=async(x,y)=> {
      const box=await image.boundingBox();
      const options={position:{x:box.width*x,y:box.height*y}};
      if(mobile)await image.tap(options);else await image.click(options);
    };
    await aimAt(.4,.5);
    const crosshair = async () => {
      const d=await page.locator('.jumper-point-surface svg path').getAttribute('d');
      const values=/M([^,]+),([^ ]+)/.exec(d);
      return [Number(values[1])+2,Number(values[2])];
    };
    const originalAim=await crosshair();
    await expect(dots).toHaveCount(0);
    await expect(undo).toBeDisabled();
    await page.getByRole('button',{name:'Aim right',exact:true}).click();
    await page.getByRole('button',{name:'Aim up',exact:true}).click();
    await expect(dots).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.aimWorkerCount),0,'aiming must not initialize inference');
    await place.click();
    await expect(dots).toHaveCount(1);
    assert.ok(Math.abs(Number(await dots.first().getAttribute('cx'))-(originalAim[0]+.5))<.01);
    assert.ok(Math.abs(Number(await dots.first().getAttribute('cy'))-(originalAim[1]-.5))<.01);
    await expect(place).toBeDisabled();
    // Repeated confirmation without re-aiming must not add a second point.
    await image.focus();await image.press('Enter');await image.press('Space');
    await expect(dots).toHaveCount(1);
    await undo.click();await expect(dots).toHaveCount(0);
    await expect(undo).toBeDisabled();
    await redo.click();await expect(dots).toHaveCount(1);
    // Hovering after precision adjustment must not move the pending aim.
    await aimAt(.6,.6);
    const secondAim=await crosshair();
    await page.getByRole('button',{name:'Aim left',exact:true}).click();
    await image.hover({position:{x:5,y:5}});
    await place.click();await expect(dots).toHaveCount(2);
    assert.ok(Math.abs(Number(await dots.nth(1).getAttribute('cx'))-(secondAim[0]-.5))<.01);
    // Changing Include/Exclude or frame invalidates the unplaced aim.
    await aimAt(.2,.2);
    await page.locator('.jumper-corrections summary').click();
    await page.getByRole('button',{name:'Exclude',exact:true}).click();
    await expect(place).toBeDisabled();await expect(dots).toHaveCount(2);
    await image.focus();await image.press('ArrowRight');await image.press('Enter');
    await expect(dots).toHaveCount(3);
    await expect(dots.nth(2)).toHaveAttribute('fill','#49b4ee');
    await aimAt(.3,.3);
    await page.getByRole('slider',{name:'Correction frame'}).fill('1');
    await expect(place).toBeDisabled();await image.waitFor();
    await expect(dots).toHaveCount(0);
    await image.focus();await image.press('ArrowLeft');await image.press('Escape');
    await expect(place).toBeDisabled();
    await page.getByRole('button',{name:'Add player',exact:true}).click();
    await expect(place).toBeDisabled();
    await page.getByRole('button',{name:'Include',exact:true}).click();
    await image.focus();await image.press('ArrowRight');await image.press('Enter');
    await expect(dots).toHaveCount(1);
    await expect(place).toBeDisabled();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    if(process.env.JUMPER_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.JUMPER_SCREENSHOT_DIR}/aim-${mobile?'mobile':'desktop'}.png`,fullPage:true});
    console.log(`${mobile?'Touch/mobile':'Mouse/desktop'}: aim/nudge/place, no premature workers, single undo, duplicate confirmation, hover, keyboard, frame/track/mode changes and Escape passed`);
    await context.close();
  }
} finally { await browser.close(); }
