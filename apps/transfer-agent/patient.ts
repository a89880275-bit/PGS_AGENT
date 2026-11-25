import { isCalendarDate } from '../../packages/shared/policy.ts';

export interface Patient {
  patientNo: string;
  birthDate: string;
}
export interface PatientProvider {
  find(patientNo: string): Promise<Patient>;
}
export type MockScenario = 'default' | 'outage' | 'duplicate' | 'invalid_date' | 'missing_date';

const fixtures = new Map([['01001111', '19550203'], ['00001234', '19600229']]);

// These aliases cover only the two synthetic records registered before the change.
const oldFixtures = new Map([['1001111', '01001111'], ['0001234', '00001234']]);
export const legacyPatientNo = (current: string) =>
  [...oldFixtures].find(([, next]) => next === current)?.[0];
export const currentPatientNo = (previous: string) => oldFixtures.get(previous) ?? previous;

export class MockPatientProvider implements PatientProvider {
  constructor(privateScenario: MockScenario = 'default') { this.scenario = privateScenario; }
  private readonly scenario: MockScenario;

  async find(patientNo: string): Promise<Patient> {
    if (this.scenario === 'outage') throw new Error('ORACLE_UNAVAILABLE');
    const birthDate = fixtures.get(patientNo);
    if (!birthDate) throw new Error('PATIENT_NOT_FOUND');
    if (this.scenario === 'duplicate') throw new Error('PATIENT_MATCH_AMBIGUOUS');
    const value = this.scenario === 'invalid_date' ? '19550231' : this.scenario === 'missing_date' ? '' : birthDate;
    if (!isCalendarDate(value)) throw new Error('INVALID_BIRTH_DATE');
    return { patientNo, birthDate: value };
  }
}
