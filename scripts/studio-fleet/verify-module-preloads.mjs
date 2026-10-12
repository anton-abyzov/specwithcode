#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-legacy';

/** Inspect actual generated chunks, not a resolver fixture or intercepted response. */
export function verifyModulePreloads(clientPath, baselinePath) {
  const root = realpathSync(clientPath);
  const manifestBytes = readFileSync(resolve(root, '.vite/manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const baseline = JSON.parse(readFileSync(baselinePath));
  const sourceEntries = value => Object.keys(value).filter(key => value[key].isEntry || value[key].isDynamicEntry).sort();
  assert.deepEqual(sourceEntries(manifest), sourceEntries(baseline), 'Actual entry/lazy-route graph changed');
  assert.ok(manifest['index.html']?.isEntry && manifest['src/main.tsx']?.isDynamicEntry);
  assert.ok(manifest['index.html'].dynamicImports.includes('src/main.tsx'), 'Real bootstrap import removed');
  const asset = path => {
    const absolute = resolve(root, path);
    assert.ok(absolute.startsWith(root + sep) && existsSync(absolute), 'Missing or unsafe generated asset');
    assert.ok(realpathSync(absolute).startsWith(root + sep), 'Generated asset escapes output');
    return absolute;
  };
  const files = new Set();
  for (const entry of Object.values(manifest)) {
    files.add(entry.file); asset(entry.file);
    for (const path of [...(entry.css ?? []), ...(entry.assets ?? [])]) asset(path);
    for (const key of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      assert.ok(manifest[key], 'Manifest module edge is unresolved');
    }
  }
  const entryFile = manifest['index.html'].file;
  const expectedMain = manifest['src/main.tsx'].file;
  const cssHints = new Set();
  let importCount = 0, entryImportsMain = false, hintArrays = 0;
  for (const file of files) {
    if (!/\.[cm]?js$/.test(file)) continue;
    const source = readFileSync(asset(file), 'utf8');
    const module = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    assert.equal(module.parseDiagnostics.length, 0, 'Generated module has invalid syntax');
    function hints(node) {
      if (!ts.isArrayLiteralExpression(node)) return;
      const paths = node.elements.filter(ts.isStringLiteralLike).map(element => element.text);
      assert.ok(paths.every(path => !/\.[cm]?js$/.test(path)), 'Speculative JavaScript preload remains');
      for (const path of paths) { asset(path); if (path.endsWith('.css')) cssHints.add(path); }
      hintArrays++;
    }
    function visit(node) {
      const dynamic = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier : dynamic ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = resolve(dirname(asset(file)), specifier.text);
        assert.ok(target.startsWith(root + sep) && existsSync(target), 'Real ES import cannot resolve');
        importCount++;
        if (file === entryFile && dynamic && target === asset(expectedMain)) entryImportsMain = true;
      }
      // Vite's generated dependency table, or an inline preload call whose
      // first argument is the real dynamic-import closure. Never evaluate JS.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'f' &&
          ts.isIdentifier(node.left.expression) && node.left.expression.text === 'm') hints(node.right);
      function importsModule(value) {
        if (ts.isCallExpression(value) && value.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
        return ts.forEachChild(value, importsModule) === true;
      }
      if (ts.isCallExpression(node) && node.arguments[0] &&
          (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0])) && node.arguments[1]) {
        if (importsModule(node.arguments[0])) hints(node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    }
    visit(module);
  }
  assert.ok(entryImportsMain && importCount > 0, 'Real bootstrap/main ES import removed');
  const requiredCss = manifest['src/main.tsx'].css ?? [];
  assert.ok(requiredCss.length > 0 && requiredCss.every(path => cssHints.has(path)), 'Critical CSS preload removed');
  const html = readFileSync(asset('index.html'), 'utf8');
  for (const tag of html.matchAll(/<link\b[^>]*>/g)) {
    assert.ok(!/rel=["']modulepreload["']/.test(tag[0]), 'Speculative HTML module preload remains');
  }
  assert.ok(html.includes(entryFile), 'Actual module script removed');
  return { schemaVersion: 1, result: 'passed', generatedAssets: files.size,
    manifestEntries: Object.keys(manifest).length, dynamicEntries: sourceEntries(manifest).length - 1,
    relativeImportsVerified: importCount, hintArrays, cssHints: cssHints.size,
    requiredCssPreserved: requiredCss.length, actualBootstrapImportPreserved: true,
    lazyEntryGraphPreserved: true, speculativeJavaScriptHints: 0,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.versions.node, '22.20.0', 'Use the supported production Node22');
  console.log(JSON.stringify(verifyModulePreloads(resolve(process.argv[2]), resolve(process.argv[3]))));
}
