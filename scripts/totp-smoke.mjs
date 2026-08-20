#!/usr/bin/env bun

// Post-build smoke test for the compiled TOTP seam. This intentionally loads the
// compiled production seam (dist/src/auth/totp.js) and the real installed otplib
// package so unit tests cannot hide a build/packaging regression. Run it AFTER
// `bun run build`; CI enforces that ordering.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const seamRelative = '../dist/src/auth/totp.js';
const seamAbsolute = path.resolve(import.meta.dirname, seamRelative);
if (!existsSync(seamAbsolute)) {
  process.stderr.write(
    `TOTP smoke requires a build first: ${seamRelative} not found. Run \`bun run build\` before \`bun run smoke:totp\`.\n`,
  );
  process.exit(1);
}

const { generateSync } = require('otplib');
const { generateSecret, generateURI, verifySync } = require(seamAbsolute);

const secret = generateSecret();
const uri = generateURI({ issuer: 'MinePanel', label: 'smoke@example.test', secret });
const token = generateSync({ secret });
const invalidToken = token === '000000' ? '000001' : '000000';
const valid = verifySync({ secret, token, epochTolerance: 30 });
const invalid = verifySync({ secret, token: invalidToken, epochTolerance: 30 });

if (!uri.startsWith('otpauth://totp/') || !valid.valid || invalid.valid) {
  throw new Error('Compiled TOTP seam failed runtime smoke');
}

process.stdout.write('TOTP runtime smoke passed\n');
