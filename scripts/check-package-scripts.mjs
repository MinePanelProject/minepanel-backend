#!/usr/bin/env bun

// Repository contract: protects critical developer/CI scripts from accidental
// deletion or replacement during automated refactors. Run in CI; fail loudly if
// any required script disappears.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const requiredScripts = [
  'build',
  'format',
  'smoke:totp',
  'docker:lifecycle',
  'typecheck',
  'lint',
  'lint:ci',
  'test',
  'test:ci',
  'test:e2e',
  'db:migrate',
];

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};

const missing = requiredScripts.filter((name) => typeof scripts[name] !== 'string');
const empty = requiredScripts.filter((name) => typeof scripts[name] === 'string' && scripts[name].trim().length === 0);

if (missing.length > 0 || empty.length > 0) {
  for (const name of missing) process.stderr.write(`Missing required package script: ${name}\n`);
  for (const name of empty) process.stderr.write(`Empty required package script: ${name}\n`);
  process.exit(1);
}

process.stdout.write('package.json script contract satisfied\n');
