import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { birthProof } from '../apps/phase3/crypto.mjs';

const vector = JSON.parse(await readFile(new URL('../fixtures/delphi-crypto-v2.json', import.meta.url), 'utf8'));
const fixture = await readFile(new URL('../fixtures/delphi-test.pdf', import.meta.url));
const digest = createHash('sha256').update(fixture).digest('hex');
const input = JSON.stringify(['pgs-birth-v2', vector.documentId, vector.salt, vector.birthDate]);
const nodeValue = birthProof(vector.key, vector.documentId, vector.salt, vector.birthDate);
if (input !== vector.canonicalJson || Buffer.from(input, 'utf8').toString('hex') !== vector.utf8Hex ||
    nodeValue !== vector.expectedHmac || digest !== vector.pdfSha256) {
  console.error('Fixture verification failed');
  process.exit(1);
}
const candidate = process.argv[2];
if (process.argv.length > 3 || (candidate !== undefined && !/^[0-9a-fA-F]{64}$/.test(candidate))) {
  console.error('Usage: node scripts/verify-delphi-vector.mjs [64-digit hexadecimal result]');
  process.exit(2);
}
if (candidate !== undefined && !timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(nodeValue,'hex'))) {
  console.error('Delphi HMAC does not match the Node.js verifier for this test vector.');
  process.exit(1);
}
console.log(candidate===undefined?'Node.js vector and PDF: PASS':'Delphi result matches the Node.js verifier: PASS');
console.log('HMAC-SHA256:',nodeValue);
console.log('PDF SHA-256:',digest);
