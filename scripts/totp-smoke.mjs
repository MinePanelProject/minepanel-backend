import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateSync } = require('otplib');
const { generateSecret, generateURI, verifySync } = require('../dist/src/auth/totp.js');

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
