import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const day = 86400000;
export function localClock() {
  if (!process.env.PGS_TEST_CLOCK_FILE) return Date.now();
  localGuard();
  const value=Number(readFileSync(process.env.PGS_TEST_CLOCK_FILE,'utf8'));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid test clock');
  return value;
}
export const maxPdf = integer('PGS_MAX_PDF_MB',10,1,50) * 1024 * 1024;
export const agentId = process.env.PGS_AGENT_ID??'6b9baf97-1293-4bc9-9ff8-cd41eefd659a';
export const clientId = 'bc22256d-2137-4c98-8317-678c8c6cd478';
export const webPort = integer('PGS_PORT', 4180);
export const agentPort = integer('PGS_AGENT_PORT', 4181);
export const tlsPort = integer('PGS_TLS_PORT', 4443);
export const webOrigin = (process.env.PGS_WEB_TLS==='1'?'https':'http')+'://127.0.0.1:' + webPort;
export const agentOrigin = 'http://127.0.0.1:' + agentPort;
function configuredOrigin(key,fallback) {
  if(process.env.PGS_PHASE5B!=='1'||!process.env[key])return fallback;
  const url=new URL(process.env[key]);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    ['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(url.hostname))throw new Error('Invalid HTTPS origin: '+key);
  return url.origin;
}
export const relayOrigin = configuredOrigin('PGS_RELAY_ORIGIN','https://127.0.0.1:' + tlsPort);
export const publicOrigin = configuredOrigin('PGS_PUBLIC_ORIGIN',webOrigin);
export const types = [{code:'G001',name:'외래 안내문'},{code:'G002',name:'검사 안내문'}];
export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
if(!uuid.test(agentId))throw new Error('INVALID_AGENT_ID');
export const requestPattern = /^[\w-]{1,100}$/;
export const hashPattern = /^[a-f0-9]{64}$/;
export const sha = value => createHash('sha256').update(value).digest('hex');
export const mac = (key, value) => createHmac('sha256',key).update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const iso = time => new Date(time).toISOString();
export const epoch = value => value instanceof Date ? value.getTime() : Date.parse(value);
export const equal = (left,right) => {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a,b);
};
export class PhaseError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
export function assert(ok,code,status) { if (!ok) throw new PhaseError(code,status); }
export function integer(key,fallback,min=1,max=65535) {
  const num = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(num) || num < min || num > max) throw new Error('Invalid local setting: '+key);
  return num;
}
export function localGuard() {
  if (process.env.NODE_ENV === 'production' || process.env.PGS_TEST_AUTH !== '1') {
    throw new Error('Phase 2 test authentication requires local development and PGS_TEST_AUTH=1');
  }
}
export function requireLocal(name, variable = 'PGS_RUNTIME_MODULES') {
  return createRequire(process.env[variable] ? resolve(process.env[variable], 'package.json') : import.meta.url)(name);
}
export async function body(req, limit = 16_000) {
  const contentType=req.headers['content-type']??'';
  assert(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType),'JSON_ONLY',415);
  assert(Number(req.headers['content-length'] ?? 0) <= limit,'TOO_LARGE',413);
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= limit,'TOO_LARGE',413);
    parts.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new PhaseError('INVALID_JSON'); }
  assert(value && typeof value === 'object' && !Array.isArray(value),'INVALID_JSON');
  return value;
}
export function json(res,data,status=200) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}
export function headers(res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
}
export function errorResponse(res,error) {
  if (res.headersSent) { res.destroy(); return; }
  if (res.destroyed) return;
  const known = error instanceof PhaseError;
  json(res,{code:known ? error.message : 'SERVICE_UNAVAILABLE'},known ? error.status : 503);
}
export const secret = name => {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error('Set local secret ' + name);
  return value;
};
export const getCookie = (req,name) => req.headers.cookie?.split(';').map(pair => pair.trim()).find(pair => pair.startsWith(name+'='))?.slice(name.length+1) ?? '';
export const bearer = req => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
