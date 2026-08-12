// Post-build normalization: rewrite `src/...` module specifiers in the compiled
// CommonJS output to paths relative to the emitting file inside dist/.
//
// `nest build` (tsc, nodenext) emits non-relative imports as-written. The
// compiled runtime cannot resolve `src/...` without the source tree and
// tsconfig baseUrl, and the production image ships dist/ only. Observed
// emission differs by platform (musl Bun emits aliased specifiers, glibc Bun
// emits relative ones), so the artifact is normalized here deterministically.
//
// Rewrites `require('src/<path>')` → relative path to dist/src/<path>, and
// fails if any `src/` specifier remains after the pass.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve(process.cwd(), 'dist');

const SPECIFIER_RE = /require\((['"])(src\/[^'"]+)\1\)/g;

const collectJsFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
};

const toPosix = (value) => value.split(path.sep).join('/');

const relativeTo = (fromFile, target) => {
  const rel = toPosix(path.relative(path.dirname(fromFile), target));
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const rewriteFile = (file) => {
  const source = readFileSync(file, 'utf8');
  const rewritten = source.replace(SPECIFIER_RE, (match, quote, spec) => {
    const target = path.resolve(distRoot, spec);
    if (!existsSync(`${target}.js`) && !existsSync(`${target}.d.ts`)) {
      return match;
    }
    return `require(${quote}${relativeTo(file, target)}${quote})`;
  });
  if (rewritten !== source) {
    writeFileSync(file, rewritten);
    return true;
  }
  return false;
};

const jsFiles = collectJsFiles(distRoot);
let rewrittenCount = 0;

for (const file of jsFiles) {
  if (rewriteFile(file)) {
    rewrittenCount += 1;
  }
}

const leftovers = jsFiles.filter((file) => SPECIFIER_RE.test(readFileSync(file, 'utf8')));

if (leftovers.length > 0) {
  throw new Error(`Post-build: unresolved src/ specifiers in ${leftovers.join(', ')}`);
}

process.stdout.write(`Post-build: rewrote ${rewrittenCount}/${jsFiles.length} files\n`);
