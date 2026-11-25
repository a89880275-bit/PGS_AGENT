export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const expiresAt = (registeredAt: number): number => registeredAt + RETENTION_MS;

export function isCalendarDate(value: string): boolean {
  if (!/^\d{8}$/.test(value) || value.startsWith('0000')) return false;
  const iso = value.replace(/^(....)(..)(..)$/, '$1-$2-$3');
  const date = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

export type RequestStatus = 'PENDING' | 'PROCESSING' | 'RETRY_WAIT' | 'READY' | 'FAILED';
export type RequestResult =
  | { requestId: string; status: 'PENDING' | 'PROCESSING' | 'RETRY_WAIT' }
  | { requestId: string; status: 'FAILED'; errorCode: string }
  | { requestId: string; status: 'READY'; documentId: string; viewUrl: string; expiresAt: string };