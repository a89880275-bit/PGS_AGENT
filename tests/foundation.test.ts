import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename } from '../apps/transfer-agent/filename.ts';
import { MockPatientProvider, type MockScenario } from '../apps/transfer-agent/patient.ts';
import { expiresAt } from '../packages/shared/policy.ts';

test('parses provisional format and validates real calendar dates', () => {
  assert.deepEqual(parseFilename('0100111120261124a01.pdf'), {
    patientNo: '01001111', createdDate: '20261124', suffix: 'a01', documentCode: null,
  });
  assert.equal(parseFilename('0000123420240229a01.pdf').patientNo, '00001234');
  for (const bad of ['100111120261124a01.pdf','0100111120260229a01.pdf','0100111120261124001.pdf','1111120261124a01.pdf','../0100111120261124a01.pdf','0100111120261124a01.pdf\n']) {
    assert.throws(() => parseFilename(bad), /INVALID_FILENAME/);
  }
});
test('allows configurable length, suffix, and explicit mapping', () => {
  assert.equal(parseFilename('00120261124TEST.PDF', {
    patientDigits: 3, suffix: '[A-Z]{4}', mapping: { test: 'G001' },
  }).documentCode, 'G001');
});
test('only synthetic patient lookup is available', async () => {
  assert.equal((await new MockPatientProvider().find('00001234')).birthDate, '19600229');
  await assert.rejects(new MockPatientProvider().find('99999999'), /PATIENT_NOT_FOUND/);
  const errors: [MockScenario, string][] = [
    ['outage','ORACLE_UNAVAILABLE'], ['duplicate','PATIENT_MATCH_AMBIGUOUS'],
    ['invalid_date','INVALID_BIRTH_DATE'], ['missing_date','INVALID_BIRTH_DATE'],
  ];
  for (const [scenario, code] of errors) await assert.rejects(new MockPatientProvider(scenario).find('01001111'), new RegExp(code));
});
test('retention is 720 hours across calendar transitions', () => {
  const registered = Date.parse('2026-03-07T23:00:00-05:00');
  assert.equal(expiresAt(registered), registered + 2592000000);
});