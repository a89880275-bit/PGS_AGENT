import { isCalendarDate } from '../../packages/shared/policy.ts';

export interface FilenameRules {
  patientDigits: number;
  suffix: string;
  mapping: Readonly<Record<string, string>>;
}

export const defaultRules: FilenameRules = { patientDigits: 8, suffix: '[A-Za-z]\\d{2}', mapping: {} };

export function parseFilename(filename: string, rules: FilenameRules = defaultRules) {
  if (filename.length > 255 || /[/\\\u0000-\u001f]/.test(filename)) throw new Error('INVALID_FILENAME');
  if (!Number.isInteger(rules.patientDigits) || rules.patientDigits < 1 || rules.patientDigits > 32) {
    throw new Error('INVALID_RULE');
  }
  const expression = new RegExp(`^(?<patientNo>\\d{${rules.patientDigits}})(?<createdDate>\\d{8})(?<suffix>(?:${rules.suffix}))\\.pdf$`, 'i');
  const groups = expression.exec(filename)?.groups;
  if (!groups || !isCalendarDate(groups.createdDate)) throw new Error('INVALID_FILENAME');
  const suffix = groups.suffix.toLowerCase();
  return {
    patientNo: groups.patientNo,
    createdDate: groups.createdDate,
    suffix,
    documentCode: Object.hasOwn(rules.mapping, suffix) ? rules.mapping[suffix] : null,
  };
}