import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkflow, type Scenario } from '../apps/api-server/mock/workflow.ts';
import { RETENTION_MS } from '../packages/shared/policy.ts';

function fixture() {
  let now = Date.parse('2026-11-24T00:00:00Z');
  const store = makeWorkflow(Buffer.from('original'), Buffer.from('revision'), () => now);
  async function finish(request: string) {
    for (let i = 0; i < 3; i++) await store.step(request);
  }
  async function register(scenario: Scenario) {
    const id = store.start(scenario);
    await finish(id);
    const result = store.result(id);
    assert.equal(result.status, 'READY');
    return { ...result, token:result.viewUrl.slice(3) };
  }
  return { store, finish, register, advance: (duration: number) => { now += duration; } };
}
test('only exposes READY URL after processing, and maintains idempotency and revision independence', async () => {
  const { store, register, advance } = fixture();
  const id = store.start('normal', 'his-1');
  for (let step = 0; step < 3; step++) {
    assert.equal('viewUrl' in store.result(id), false);
    await store.step(id);
  }
  const prior = store.result(id);
  assert.equal(prior.status, 'READY');
  assert.equal(store.start('normal', 'his-1'), id);
  assert.deepEqual(store.result(id), prior);
  assert.throws(() => store.start('revision', 'his-1'), /REQUEST_CONFLICT/);
  advance(1000);
  const revised = await register('revision');
  assert.notEqual(prior.documentId, revised.documentId);
  assert.notEqual(prior.viewUrl, revised.viewUrl);
  assert.equal(Date.parse(revised.expiresAt) - Date.parse(prior.expiresAt), 1000);
  assert.equal(store.document(prior.documentId).file?.toString(), 'original');
  assert.equal(store.document(revised.documentId).file?.toString(), 'revision');
  assert.doesNotThrow(() => store.verify(prior.viewUrl.slice(3), '19550203'));
});
test('invalid filename and no patient fail; transient failures retry under the same ID', async () => {
  const {store, finish} = fixture();
  const cases: [Scenario, string][] = [['bad-name','INVALID_FILENAME'],['missing','PATIENT_NOT_FOUND']];
  for (const [scenario,errorCode] of cases) {
    const id = store.start(scenario);
    await finish(id);
    assert.deepEqual(store.result(id), { requestId:id, status:'FAILED', errorCode });
  }
  for (const scenario of ['oracle','transfer'] as const) {
    const id = store.start(scenario);
    await finish(id);
    assert.deepEqual(store.result(id), { requestId:id, status:'RETRY_WAIT' });
    store.retry(id);
    await finish(id);
    assert.equal(store.start(scenario,id), id);
    assert.equal(store.result(id).status,'READY');
  }
  assert.throws(() => store.start('normal', 'foreign', {filename:'test.pdf',pdf:'AAAA'}), /USE_SYNTHETIC_PDF/);
});
test('replacement and revoke invalidate prior sessions, expiry is exact and purge removes bytes', async () => {
  const {store, register, advance} = fixture();
  const original = await register('normal');
  const initialSession = store.verify(original.token,'19550203');
  assert.equal(store.patient(initialSession).id, original.documentId);
  store.action(original.documentId, 'replace');
  const replaced = store.result(original.requestId);
  assert.equal(replaced.status,'READY');
  assert.equal(replaced.expiresAt, original.expiresAt);
  assert.throws(() => store.patient(initialSession), /SESSION_REQUIRED/);
  assert.throws(() => store.verify(original.token,'19550203'), /LINK_UNAVAILABLE/);
  const active = await register('normal');
  store.action(active.documentId,'revoke');
  assert.throws(() => store.verify(active.token,'19550203'), /LINK_UNAVAILABLE/);
  advance(RETENTION_MS - 1);
  const session = store.verify(replaced.viewUrl.slice(3),'19550203');
  assert.equal(store.purge(),0);
  advance(1);
  assert.throws(() => store.patient(session), /LINK_UNAVAILABLE/);
  assert.equal(store.purge(),2);
  assert.equal(store.document(original.documentId).file,undefined);
  assert.equal(store.document(original.documentId).birthDate,'');
  assert.equal(store.purge(),0);
});
test('5 failures lock the token, and the lock and session time out independently', async () => {
  const {store,register,advance} = fixture();
  const {token} = await register('normal');
  for (let i = 0; i < 4; i++) assert.throws(() => store.verify(token,'19550204'), /DATE_MISMATCH/);
  assert.throws(() => store.verify(token,'19550204'), /LOCKED/);
  assert.throws(() => store.verify(token,'19550203'), /LOCKED/);
  advance(30 * 60000);
  const session = store.verify(token,'19550203');
  assert.doesNotThrow(() => store.patient(session));
  advance(15 * 60000);
  assert.throws(() => store.patient(session), /SESSION_REQUIRED/);
});