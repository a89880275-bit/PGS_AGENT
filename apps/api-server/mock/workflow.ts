import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { parseFilename, defaultRules } from '../../transfer-agent/filename.ts';
import { MockPatientProvider } from '../../transfer-agent/patient.ts';
import { RETENTION_MS, expiresAt, isCalendarDate, type RequestResult, type RequestStatus } from '../../../packages/shared/policy.ts';

export const scenarios = ['normal','bad-name','missing','oracle','transfer','revision','expired'] as const;
export type Scenario = typeof scenarios[number];
export const types = [{ code: 'G001', name: '외래 안내문' }, { code: 'G002', name: '검사 안내문' }];
const mapping = { a01: 'G001', a02: 'G002' };
const minute = 60000;
export const settings = {
  folder: 'D:/PatientGuide/Incoming', format: '8자리 + YYYYMMDD + 영문 1자·숫자 2자리',
  mapping, api: '/mock/internal/v1/requests', retry: '수동 재시도 · 운영 최대 5회 제안',
};
export class MockError extends Error {
  constructor(code: string, publicStatus: number) { super(code); this.status = publicStatus; }
  readonly status: number;
}

interface Transfer {
  id: string; filename: string; scenario: Scenario; status: RequestStatus; stage: number; at: number;
  retried?: boolean; patientNo?: string; type?: string; error?: string; documentId?: string; file: Buffer;
}
interface Document {
  id: string; requestId: string; patientNo: string; birthDate: string; type: string; name: string;
  registeredAt: number; expiresAt: number; token: string; status: 'ACTIVE' | 'REVOKED' | 'DELETED';
  file?: Buffer; failCount: number; lockedUntil: number;
}
const mask = (value?: string) => value ? '••••' + value.slice(-3) : '—';
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (value: number) => new Date(value).toISOString();

export function makeWorkflow(sample: Buffer, revised: Buffer, clock = Date.now) {
  const requests = new Map<string, Transfer>();
  const documents = new Map<string, Document>();
  const tokens = new Map<string, string>();
  const sessions = new Map<string, { id: string; tokenHash: string; expires: number }>();
  const knownFiles = new Map([[sample.toString('base64'), sample], [revised.toString('base64'), revised]]);
  const view = (doc: Document) => '/v/' + doc.token;
  const docStatus = (doc: Document) => doc.status === 'ACTIVE' && clock() >= doc.expiresAt ? 'EXPIRED' : doc.status;
  const alive = (doc?: Document): Document => {
    if (!doc || docStatus(doc) !== 'ACTIVE') throw new MockError('LINK_UNAVAILABLE', 410);
    return doc;
  };
  function start(scenario: Scenario, requestId: string = randomUUID(), selection?: { filename: string; pdf: string }) {
    if (!scenarios.includes(scenario)) throw new MockError('INVALID_SCENARIO', 400);
    if (!/^[\w-]{1,100}$/.test(requestId)) throw new MockError('INVALID_REQUEST', 400);
    const filename = selection?.filename ?? (scenario === 'bad-name' ? 'invalid.pdf' :
      scenario === 'missing' ? '9999999920261124a01.pdf' : '0100111120261124a01.pdf');
    const file = selection ? knownFiles.get(selection.pdf) : scenario === 'revision' ? revised : sample;
    if (!file) throw new MockError('USE_SYNTHETIC_PDF', 415);
    const prior = requests.get(requestId);
    if (prior) {
      if (prior.filename !== filename || prior.scenario !== scenario || prior.file !== file) throw new MockError('REQUEST_CONFLICT', 409);
      return prior.id;
    }
    requests.set(requestId, { id: requestId, scenario, filename, file, status: 'PENDING', stage: 0, at: clock() });
    return requestId;
  }
  function getRequest(id: string) {
    const item = requests.get(id);
    if (!item) throw new MockError('REQUEST_NOT_FOUND', 404);
    return item;
  }
  async function inspect(filename: string) {
    const parsed = parseFilename(filename, { ...defaultRules, mapping });
    const patient = await new MockPatientProvider().find(parsed.patientNo);
    if (!parsed.documentCode) throw new MockError('UNMAPPED_SUFFIX', 400);
    return { ...parsed, ...patient };
  }
  async function step(id: string) {
    const item = getRequest(id);
    if (!['PENDING','PROCESSING'].includes(item.status)) return;
    if (item.status === 'PROCESSING') return;
    try {
      if (item.stage === 0) {
        const parsed = parseFilename(item.filename, { ...defaultRules, mapping });
        item.patientNo = parsed.patientNo;
        if (!parsed.documentCode) throw new Error('UNMAPPED_SUFFIX');
        item.type = parsed.documentCode;
        item.status = 'PENDING';
        item.stage = 1;
      } else if (item.stage === 1) {
        item.status = 'PROCESSING';
        await new MockPatientProvider(item.scenario === 'oracle' && !item.retried ? 'outage' : 'default').find(item.patientNo!);
        item.stage = 2;
        item.status = 'PENDING';
      } else {
        if (item.scenario === 'transfer' && !item.retried) throw new Error('TRANSFER_UNAVAILABLE');
        item.status = 'PROCESSING';
        item.stage = 3;
        const { birthDate } = await new MockPatientProvider().find(item.patientNo!);
        const registeredAt = item.scenario === 'expired' ? clock() - RETENTION_MS : clock();
        const doc: Document = {
          id: randomUUID(), requestId: item.id, patientNo: item.patientNo!, birthDate, type: item.type!,
          name: types.find(type => type.code === item.type)?.name ?? '합성 안내문',
          registeredAt, expiresAt: expiresAt(registeredAt), token: secret(), status: 'ACTIVE',
          file: item.file, failCount: 0, lockedUntil: 0,
        };
        documents.set(doc.id, doc);
        tokens.set(hash(doc.token), doc.id);
        item.documentId = doc.id;
        item.stage = 4;
        item.status = 'READY';
      }
    } catch (error) {
      item.error = (error as Error).message;
      item.status = /UNAVAILABLE$/.test(item.error) ? 'RETRY_WAIT' : 'FAILED';
    }
  }
  function retry(id: string) {
    const item = getRequest(id);
    if (item.status !== 'RETRY_WAIT') throw new MockError('NOT_RETRYABLE', 409);
    item.status = 'PENDING';
    item.error = undefined;
    item.retried = true;
  }
  function result(id: string): RequestResult {
    const item = getRequest(id);
    if (item.status === 'READY') {
      const doc = documents.get(item.documentId!)!;
      if (!doc.token || doc.status !== 'ACTIVE') return { requestId: id, status: 'FAILED', errorCode: 'LINK_UNAVAILABLE' };
      return { requestId: id, status: 'READY', documentId: doc.id, viewUrl: view(doc), expiresAt: iso(doc.expiresAt) };
    }
    if (item.status === 'FAILED') return { requestId: id, status: 'FAILED', errorCode: item.error! };
    return { requestId: id, status: item.status };
  }
  function list() {
    return {
      requests: [...requests.values()].reverse().map(({ id, patientNo, stage, type, status, error, at }) =>
        ({ id, stage, type, status, error, patientNo: mask(patientNo), at: iso(at), ...('viewUrl' in result(id) ? { urlReady: true } : {}) })),
      documents: [...documents.values()].reverse().map(doc => ({
        id: doc.id, requestId: doc.requestId, name: doc.name, type: doc.type, patientNo: mask(doc.patientNo),
        registeredAt: iso(doc.registeredAt), expiresAt: iso(doc.expiresAt), status: docStatus(doc),
        viewUrl: doc.status === 'ACTIVE' && doc.token ? view(doc) : undefined,
      })),
    };
  }
  function document(id: string) {
    const found = documents.get(id);
    if (!found) throw new MockError('DOCUMENT_NOT_FOUND', 404);
    return found;
  }
  function clearAccess(doc: Document) {
    if (doc.token) tokens.delete(hash(doc.token));
    doc.token = '';
    for (const [key, session] of sessions) if (session.id === doc.id) sessions.delete(key);
  }
  function action(id: string, action: string) {
    const doc = document(id);
    if (action === 'replace') {
      alive(doc);
      clearAccess(doc);
      doc.token = secret();
      doc.failCount = 0;
      doc.lockedUntil = 0;
      tokens.set(hash(doc.token), doc.id);
    } else if (action === 'revoke') {
      alive(doc);
      clearAccess(doc);
      doc.status = 'REVOKED';
    } else throw new MockError('INVALID_ACTION', 400);
  }
  function purge() {
    let count = 0;
    for (const doc of documents.values()) {
      if (clock() < doc.expiresAt || doc.status === 'DELETED') continue;
      clearAccess(doc);
      doc.file = undefined;
      doc.patientNo = '';
      doc.birthDate = '';
      doc.name = '삭제된 안내문';
      doc.status = 'DELETED';
      count++;
    }
    return count;
  }
  function verify(token: string, birthDate: string) {
    const key = hash(token);
    const doc = alive(documents.get(tokens.get(key) ?? ''));
    if (doc.lockedUntil > clock()) throw new MockError('LOCKED', 429);
    if (doc.lockedUntil) { doc.lockedUntil = 0; doc.failCount = 0; }
    if (!isCalendarDate(birthDate) || doc.birthDate !== birthDate) {
      if (++doc.failCount >= 5) {
        doc.lockedUntil = clock() + 30 * minute;
        throw new MockError('LOCKED', 429);
      }
      throw new MockError('DATE_MISMATCH', 401);
    }
    doc.failCount = 0;
    const session = secret();
    sessions.set(hash(session), { id: doc.id, tokenHash: key, expires: clock() + 15 * minute });
    return session;
  }
  function patient(session: string) {
    const data = sessions.get(hash(session));
    if (!data || data.expires <= clock()) throw new MockError('SESSION_REQUIRED', 401);
    const doc = alive(documents.get(data.id));
    if (hash(doc.token) !== data.tokenHash) throw new MockError('SESSION_REQUIRED', 401);
    return doc;
  }
  const search = (patientNo: string) => [...documents.values()].filter(doc => doc.patientNo === patientNo).map(doc => doc.id);
  return { search, start, step, retry, result, list, inspect, document, action, purge, verify, patient };
}