import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
process.env.PWDEBUG = '0'; process.env.PLAYWRIGHT_HTML_OPEN = 'never';
const output = process.argv[2];
assert(output?.startsWith('/') && process.env.STUDIO_PLAYWRIGHT_MODULE);
await fs.mkdir(output, {recursive: true});
const {chromium} = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({headless: true});
const results=[];
try {
 for (const [theme,width] of [['light',1280],['dark',390]]) {
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
  await context.tracing.start({sources:true,snapshots:false,screenshots:false});
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:5879/?timing&theme=${theme}`);
  for (const [scenario,label] of [['settled','Last turn 1m'],['live','Running · 2m elapsed'],['wait','Waiting · 2m elapsed'],['queued','Queued'],['watch','Watching'],['missing','Failed turn']]) {
   // DOM activation is explicit: this fixture verifies React rendering, not native pointer delivery.
   await page.getByRole('button',{name:scenario,exact:true}).evaluate(e=>e.click());
   const chip=page.locator('[data-thread-meta="duration"]');
   await chip.waitFor(); assert.equal(await chip.innerText().then(s=>s.trim()),label);
   await chip.evaluate(e=>e.click());
   const details=page.locator('[data-thread-timing-details]'); await details.waitFor();
   const text=await details.innerText();
   assert(text.includes('Recorded turn elapsed') && text.includes('not measured active work'));
   if(scenario==='settled'||scenario==='watch') assert(text.includes('6m'));
   if(scenario==='live'||scenario==='wait') assert(text.includes('7m'));
   if(scenario==='missing') assert(text.includes('Not recorded'));
   const bounds=await details.boundingBox(); assert(bounds && bounds.x>=-1 && bounds.x+bounds.width<=width+1);
   await page.screenshot({path:`${output}/${theme}-${scenario}.png`});
   await page.keyboard.press('Escape');
   results.push({theme,width,scenario,label,passed:true});
  }
  await page.goto(`http://127.0.0.1:5879/?timing&mobile&theme=${theme}`);
  const relay = page.locator('section button[aria-expanded="false"]');
  assert.equal(await relay.count(), 2);
  assert(!(await page.locator('body').innerText()).includes('Carry-forward mobile Connect acceptance gate'));
  assert((await page.locator('body').innerText()).includes('No admitted live relay receipt'));
  assert((await page.locator('body').innerText()).includes('Both R5 findings reproduced'));
  await relay.first().evaluate(e=>e.click());
  assert((await page.locator('body').innerText()).includes('Carry-forward mobile Connect acceptance gate'));
  await page.screenshot({path:`${output}/${theme}-0957.png`});
  results.push({theme,width,scenario:'0957 both relay directions and substantive results',passed:true});
  assert.deepEqual(errors,[]);
  await context.tracing.stop({path:`${output}/${theme}.zip`}); await context.close();
 }
 await fs.writeFile(`${output}/receipt.json`,JSON.stringify({results,limits:'Real shared metadata component; DOM activation, no installed/native pointer acceptance. Coordinator and worker thread pages use the same ChatView wiring.'},null,2));
} finally {await browser.close();}
