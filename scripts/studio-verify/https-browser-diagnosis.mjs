import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
assert.equal(process.version,'v22.20.0');
process.env.PWDEBUG='0';process.env.PLAYWRIGHT_HTML_OPEN='never';
const arg=process.argv.indexOf('--report-dir');assert.ok(arg>=0);
const dir=resolve(process.argv[arg+1]);mkdirSync(dir,{recursive:true,mode:0o700});
const trusted=JSON.parse(readFileSync(join(homedir(),'.specweave-studio/m4/network/private-access.json')));
assert.equal(trusted.configuredPrivateOnly,true);const origin=trusted.origins.m4;
const target=new URL(origin);assert.equal(target.protocol,'https:');assert.equal(target.port,'');
assert.match(target.hostname,/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/);assert.equal(target.origin,origin);
const label='0885 T05 owned HTTPS diagnosis '+randomUUID();
const receipt={observedAt:new Date().toISOString(),runtime:process.version,node:process.execPath,
  browser:{headless:true,PWDEBUG:'0',PLAYWRIGHT_HTML_OPEN:'never'},strictTLS:true,nativeTurns:0,
  events:[],snapshots:[],credentialSaved:false};
const hash=s=>createHash('sha256').update(s).digest('hex');
const save=()=>writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
const cli=args=>{const r=spawnSync(join(homedir(),'.local/bin/specweave-studio'),args,{encoding:'utf8',timeout:20000});assert.equal(r.status,0,'Owned CLI operation failed; raw output omitted');return r.stdout;};
let browser,context,grant;const failedAssets=new Set(),bodyReads=[];
function urlMetadata(raw){const u=new URL(raw);const safeAsset=/^\/assets\/[A-Za-z0-9_.-]+$/.test(u.pathname);return {sameOrigin:u.origin===origin,scheme:u.protocol,port:u.port||'default',originHash:hash(u.origin),category:u.pathname.startsWith('/assets/')?'asset':u.pathname.startsWith('/api/auth/')?'auth':u.pathname.startsWith('/api/')?'api':u.pathname==='/ws'?'websocket':'document',pathHash:hash(u.pathname),...(safeAsset?{staticAssetPath:u.pathname}:{})};}
function errorMetadata(value){const s=String(value);return {hash:hash(s),certificate:/certificate|CERT_/i.test(s),websocket:/websocket|WSS|socket/i.test(s),authentication:/auth|unauthorized|401/i.test(s),network:/network|fetch|ERR_/i.test(s),script:/ReferenceError|TypeError|SyntaxError/i.test(s)};}
try{
  const {chromium}=createRequire(import.meta.url)(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  grant=JSON.parse(cli(['auth','pairing','create','--ttl','5m','--label',label,'--base-url',origin,'--json']));
  const exchange=await context.request.post(origin+'/api/auth/browser-session',{headers:{Origin:origin},data:{credential:grant.credential}});
  assert.equal(exchange.status(),200);grant.credential='';grant.pairUrl='';
  receipt.exchange200=true;receipt.cookies=(await context.cookies(origin)).filter(c=>c.httpOnly).map(c=>({secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite,domainHash:hash(c.domain),nameHash:hash(c.name)}));save();
  const page=await context.newPage();
  page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')receipt.events.push({type:'console-'+m.type(),...errorMetadata(m.text())});});
  page.on('pageerror',e=>receipt.events.push({type:'pageerror',...errorMetadata(e.message)}));
  page.on('requestfailed',r=>receipt.events.push({type:'requestfailed',...urlMetadata(r.url()),...errorMetadata(r.failure()?.errorText)}));
  page.on('response',r=>{const meta=urlMetadata(r.url());receipt.events.push({type:'response',status:r.status(),...meta});if(r.status()===502&&meta.staticAssetPath&&failedAssets.size<20){
    failedAssets.add(meta.staticAssetPath);bodyReads.push((async()=>{try{const text=await r.text();receipt.events.push({type:'asset-proxy-body',staticAssetPath:meta.staticAssetPath,length:text.length,hash:hash(text),badGateway:/bad gateway/i.test(text),connectionRefused:/refused/i.test(text),reset:/reset/i.test(text),unexpectedEOF:/unexpected EOF/i.test(text),proxy:/proxy/i.test(text)});}catch{}})());}});
  page.on('websocket',ws=>{receipt.events.push({type:'browser-websocket',...urlMetadata(ws.url())});ws.on('socketerror',e=>receipt.events.push({type:'browser-websocket-error',...errorMetadata(e)}));});
  await page.goto(origin+'/',{waitUntil:'networkidle'});
  for(let i=0;i<40;i++){
    const next=page.getByRole('button',{name:'Continue',exact:true}),skip=page.getByRole('button',{name:'Do not import projects',exact:true});
    if(await next.isVisible())await next.click();else if(await skip.isVisible())await skip.click();
    if(await page.locator('.studio-desk').isVisible())break;
    await page.waitForTimeout(500);
  }
  const safeSnapshot=async()=>await page.evaluate(()=>{
    const text=document.body.innerText;
    const known=['Still connecting','Could not read settings','Enter a pairing token','Connect to this environment','Invalid pairing token','Do not import projects','Continue','Control desk','Welcome'];
    return {path:location.pathname,secureContext:isSecureContext,titleMatchesStudio:document.title.includes('SpecWeave'),bodyCharacters:text.length,
      knownGateText:known.filter(s=>text.includes(s)),deskVisible:Boolean(document.querySelector('.studio-desk')),
      inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,filled:Boolean(e.value)})),scripts:document.scripts.length,
      readyState:document.readyState,settingsStored:localStorage.getItem('studio:client-settings:v1')!==null};
  });
  receipt.snapshots.push(await safeSnapshot());
  const snapshot=receipt.snapshots.at(-1);
  if(!snapshot.inputs.some(i=>i.filled)){
    // No full pairing URL, auth input or private value is exposed in this capture.
    const path=join(dir,'actual-private-root-gate.png');await page.screenshot({path});receipt.screenshot={path,credentialInputsEmpty:true};
  }
  receipt.browserAuthReadback=await page.evaluate(async()=>{const r=await fetch('/api/auth/session',{credentials:'include'});const text=await r.text();let v;try{v=JSON.parse(text);}catch{}return {status:r.status(),json:Boolean(v),authenticated:v?.authenticated===true,contentType:r.headers.get('content-type')};});
  await Promise.allSettled(bodyReads);receipt.failedStaticAssetComparison=[];
  for(const path of failedAssets){const direct=await context.request.get('http://127.0.0.1:8319'+path),https=await context.request.get(origin+path);receipt.failedStaticAssetComparison.push({path,directStatus:direct.status(),httpsStatus:https.status(),directContentType:direct.headers()['content-type'],httpsContentType:https.headers()['content-type']});}
  save();
}catch(error){receipt.failure={kind:error.name,...errorMetadata(error.message)};save();process.exitCode=1;}
finally{
  try{const sessions=JSON.parse(cli(['auth','session','list','--json']));const owned=sessions.filter(s=>s.client?.label===label);
    for(const session of owned)cli(['auth','session','revoke',session.sessionId]);if(grant)cli(['auth','pairing','revoke',grant.id]);
    receipt.cleanup={ownedSessionsRevoked:owned.length,ownedLinkRevokedOrConsumed:Boolean(grant),noOwnedSessionsReadback:!JSON.parse(cli(['auth','session','list','--json'])).some(s=>s.client?.label===label)};
    if(context)receipt.cleanup.afterRevokeStatus=(await context.request.get(origin+'/api/studio/capacity')).status();
  }catch{receipt.cleanupFailure=true;process.exitCode=1;}
  if(browser)await browser.close();receipt.completedAt=new Date().toISOString();save();
}
