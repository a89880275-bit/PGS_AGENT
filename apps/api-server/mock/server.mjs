import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { makeWorkflow, MockError, types, settings } from './workflow.ts';
import { samplePdf } from '../../../scripts/fixture.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Mock server is development only');
const root = new URL('../../../', import.meta.url);
const require = createRequire(import.meta.url);
const pdfDir = process.env.PGS_PDFJS_DIR || join(require.resolve('pdfjs-dist/package.json'), '..');
const phase2 = process.env.PGS_PHASE2 === '1';
if (process.env.PGS_PHASE3==='1' && !phase2) throw new Error('Phase 3 requires the isolated relay profile');
const sample = phase2 ? null : samplePdf();
const revised = phase2 ? null : samplePdf(true);
const workflow = phase2 ? null : makeWorkflow(sample, revised);
const port = Number(process.env.PGS_PORT ?? 4173);
const tlsWeb=phase2&&process.env.PGS_WEB_TLS==='1';
const origin=(tlsWeb?'https':'http')+'://127.0.0.1:'+port;
const phase = phase2 ? await (await import('../../phase2/service.mjs')).makePhase({origin}) : null;
const assets = new Map([
  ['/ui.js', [new URL('dist/mock/ui.js', root), 'text/javascript']],
  ['/style.css', [new URL('dist/mock/style.css', root), 'text/css']],
  ['/pdf.mjs', [join(pdfDir, 'build/pdf.mjs'), 'text/javascript']],
  ['/pdf.worker.mjs', [join(pdfDir, 'build/pdf.worker.mjs'), 'text/javascript']],
  ['/pdfjs/standard_fonts/FoxitSans.pfb', [join(pdfDir, 'standard_fonts/FoxitSans.pfb'), 'application/octet-stream']],
  ['/pdfjs/standard_fonts/LiberationSans-Regular.ttf', [join(pdfDir, 'standard_fonts/LiberationSans-Regular.ttf'), 'application/octet-stream']],
]);
const index = await readFile(new URL('dist/mock/index.html', root));
const scenarios = ['normal', 'expired'];
for (const scenario of phase2 ? [] : scenarios) {
  const id = workflow.start(scenario, 'PGS-DEMO-' + scenario.toUpperCase());
  for (let i = 0; i < 3; i++) await workflow.step(id);
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function pdf(res, bytes, attachment = false, filename = 'pgs-test.pdf') {
  if (!bytes) throw new MockError('DOCUMENT_NOT_FOUND', 404);
  res.writeHead(200, {
    'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
    'Content-Disposition': (attachment ? 'attachment' : 'inline') + '; filename="' + filename + '"',
  });
  res.end(bytes);
}
async function input(req) {
  if (req.headers['content-type'] !== 'application/json') throw new MockError('INVALID_INPUT', 400);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16000) throw new MockError('INVALID_INPUT', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new MockError('INVALID_INPUT', 400); }
}
const value = (data, field) => typeof data[field] === 'string' ? data[field] : '';
const session = req => req.headers.cookie?.match(/(?:^|; )pgs_mock=([\w-]+)/)?.[1] ?? '';

async function handle(req,res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; connect-src 'self' " + (phase ? phase.agentOrigin : '') + "; base-uri 'none'; form-action 'self'");
  try {
    if (req.headers.host !== '127.0.0.1:' + port || (req.headers.origin && req.headers.origin !== origin)) {
      throw new MockError('LOCAL_ONLY', 403);
    }
    const path = new URL(req.url, origin).pathname;
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    if ((get || req.method==='HEAD') && (['/','/agent','/admin','/patient','/patient/view','/patient/reauth'].includes(path) || /^\/(v|g)\/[\w-]+$/.test(path))) {
      if (get && phase?.adminCookie && path === '/admin') res.setHeader('Set-Cookie',phase.adminCookie);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(get?index:undefined);
    }
    if (get && assets.has(path)) {
      const [file, type] = assets.get(path);
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(bytes);
    }
    if (phase) {
      try { if (await phase.route(req,res,path)) return; } catch (error) {
        if (res.headersSent) {res.destroy(); return;}
        if (!res.destroyed) json(res,{code:error.status ? error.message : 'SERVICE_UNAVAILABLE'},error.status || 503);
        return;
      }
      return json(res,{code:'NOT_FOUND'},404);
    }
    if (get && path === '/mock/health') return json(res, { mode: 'mock' });
    if (get && path === '/mock/state') return json(res, { ...workflow.list(), types, settings });
    if (get && path === '/mock/sample') return pdf(res, sample, true, '0100111120261124a01.pdf');
    if (get && path === '/mock/sample-revision') return pdf(res, revised, true, '0100111120261124a01.pdf');
    if (post && path === '/mock/search') {
      const patientNo = value(await input(req), 'patientNo');
      if (!/^\d{8}$/.test(patientNo)) throw new MockError('INVALID_INPUT', 400);
      return json(res, { ids: workflow.search(patientNo) });
    }
    if (post && path === '/mock/inspect') {
      const data = await input(req);
      const encoded = value(data, 'pdf');
      if (encoded !== sample.toString('base64') && encoded !== revised.toString('base64')) throw new MockError('USE_SYNTHETIC_PDF', 415);
      return json(res, await workflow.inspect(value(data, 'filename')));
    }
    const base = '/mock/internal/v1/requests';
    if (post && path === base) {
      const data = await input(req);
      const selection = data.filename === undefined ? undefined : { filename: value(data, 'filename'), pdf: value(data, 'pdf') };
      const id = workflow.start(value(data, 'scenario'), value(data, 'requestId') || undefined, selection);
      const result = workflow.result(id);
      return json(res, 'viewUrl' in result ? { ...result, viewUrl: origin + result.viewUrl } : result, 202);
    }
    const job = /^\/mock\/internal\/v1\/requests\/([\w-]+)(?:\/(step|retry))?$/.exec(path);
    if (job) {
      const [, id, action] = job;
      if (post && action === 'step') await workflow.step(id);
      else if (post && action === 'retry') workflow.retry(id);
      else if (!(get && !action)) throw new MockError('NOT_FOUND', 404);
      const result = workflow.result(id);
      const pending = ['PENDING','PROCESSING','RETRY_WAIT'].includes(result.status);
      return json(res, 'viewUrl' in result ? { ...result, viewUrl: origin + result.viewUrl } : result, pending ? 202 : 200);
    }
    const doc = /^\/mock\/documents\/([\w-]+)\/(pdf|replace|revoke)$/.exec(path);
    if (doc) {
      const [, id, action] = doc;
      if (get && action === 'pdf') return pdf(res, workflow.document(id).file);
      if (post && action !== 'pdf') { workflow.action(id, action); return json(res, { status: 'OK' }); }
    }
    if (post && path === '/mock/purge') return json(res, { deleted: workflow.purge() });
    if (post && path === '/mock/patient/verify') {
      const data = await input(req);
      const key = workflow.verify(value(data, 'token'), value(data, 'birthDate'));
      res.setHeader('Set-Cookie', 'pgs_mock=' + key + '; HttpOnly; SameSite=Strict; Path=/mock/patient; Max-Age=900');
      return json(res, { status: 'VERIFIED' });
    }
    if (get && path === '/mock/patient/outage') throw new MockError('SERVICE_UNAVAILABLE', 503);
    if (get && ['/mock/patient/detail','/mock/patient/pdf','/mock/patient/download'].includes(path)) {
      const document = workflow.patient(session(req));
      if (path.endsWith('/detail')) return json(res, { name: document.name, expiresAt: new Date(document.expiresAt).toISOString() });
      return pdf(res, document.file, path.endsWith('/download'));
    }
    throw new MockError('NOT_FOUND', 404);
  } catch (error) {
    const inspectErrors = ['INVALID_FILENAME','PATIENT_NOT_FOUND','UNMAPPED_SUFFIX'];
    const status = error instanceof MockError ? error.status : inspectErrors.includes(error.message) ? 400 : 500;
    if (status === 500) console.error('Mock request failed');
    if (!res.headersSent) json(res, { code: status === 500 ? 'SERVICE_UNAVAILABLE' : error.message }, status);
  }
}
const server=tlsWeb?createSecureServer({cert:await readFile(process.env.PGS_TLS_CERT),key:await readFile(process.env.PGS_TLS_KEY)},handle):createServer(handle);
server.listen(port, '127.0.0.1', () => console.log((process.env.PGS_PHASE3==='1' ? 'PGS Phase 3: ' : phase ? 'PGS Phase 2: ' : 'PGS Mock: ') + origin + '/agent'));
