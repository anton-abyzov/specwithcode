import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyModulePreloads } from './verify-module-preloads.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'studio-preload-'));
  try {
    mkdirSync(join(root, 'assets')); mkdirSync(join(root, '.vite'));
    const manifest = {
      'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['src/main.tsx'] },
      'src/main.tsx': { file: 'assets/main.js', isDynamicEntry: true,
        dynamicImports: ['src/routes/settings.tsx'], css: ['assets/main.css'] },
      'src/routes/settings.tsx': { file: 'assets/settings.js', isDynamicEntry: true },
    };
    const put = (file, value) => writeFileSync(join(root, file), value);
    put('.vite/manifest.json', JSON.stringify(manifest)); put('baseline.json', JSON.stringify(manifest));
    put('index.html', '<script type="module" src="/assets/index.js"></script>');
    put('assets/index.js', 'preload(()=>import("./main.js"),["assets/main.css"]);');
    put('assets/main.js', 'export const lazy = ()=>import("./settings.js");');
    put('assets/settings.js', 'export default 1;'); put('assets/main.css', 'body{color:black}');
    run({ root, put, manifest, check: () => verifyModulePreloads(root, join(root, 'baseline.json')) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('actual generated CSS hints, real imports and lazy graph pass', () => fixture(({ check }) => {
  const result = check(); assert.equal(result.relativeImportsVerified, 2);
  assert.equal(result.requiredCssPreserved, 1); assert.equal(result.speculativeJavaScriptHints, 0);
}));
test('the original transitive JavaScript preload table fails', () => fixture(({ put, check }) => {
  put('assets/index.js', 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/main.js","assets/main.css"])))=>i.map(i=>d[i]);preload(()=>import("./main.js"),__vite__mapDeps([0,1]));');
  assert.throws(check, /Speculative JavaScript preload remains/);
}));
test('inline JavaScript hints fail', () => fixture(({ put, check }) => {
  put('assets/index.js', 'preload(()=>import("./main.js"),["assets/main.css","assets/main.js"]);');
  assert.throws(check, /Speculative JavaScript preload remains/);
}));
test('omitting critical CSS fails', () => fixture(({ put, check }) => {
  put('assets/index.js', 'preload(()=>import("./main.js"),[]);');
  assert.throws(check, /Critical CSS preload removed/);
}));
test('missing actual bootstrap import fails', () => fixture(({ put, check }) => {
  put('assets/index.js', 'preload(()=>Promise.resolve(),["assets/main.css"]);');
  assert.throws(check, /Real bootstrap\/main ES import removed/);
}));
test('dropping a lazy route fails', () => fixture(({ put, manifest, check }) => {
  delete manifest['src/routes/settings.tsx']; put('.vite/manifest.json', JSON.stringify(manifest));
  assert.throws(check, /entry\/lazy-route graph changed/);
}));
test('a broken real ES import fails', () => fixture(({ put, check }) => {
  put('assets/main.js', 'export const lazy = ()=>import("./missing.js");');
  assert.throws(check, /Real ES import cannot resolve/);
}));
test('HTML JavaScript preloads fail', () => fixture(({ put, check }) => {
  put('index.html', '<script type="module" src="/assets/index.js"></script><link rel="modulepreload" href="/assets/main.js">');
  assert.throws(check, /Speculative HTML module preload remains/);
}));
