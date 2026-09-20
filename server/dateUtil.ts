/** ISO 8601 주차 문자열 (예: "2026-W36"). 스코어카드/저장 경로의 주간 키로 사용한다. */
export function getIsoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * 한 주 앞의 ISO 주차 키. "2026-W01"의 앞은 전년도 마지막 주(52 또는 53)라 문자열 계산으로는
 * 못 구한다 — 그 주의 목요일에서 7일을 빼 다시 주차를 낸다.
 */
export function previousIsoWeek(weekOf: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekOf);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO 주의 목요일 = 그 해 1월 4일이 속한 주의 목요일 + (week-1)주.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const thursday = new Date(jan4);
  thursday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 4) + (week - 1) * 7);
  thursday.setUTCDate(thursday.getUTCDate() - 7);
  return getIsoWeekString(new Date(thursday.getUTCFullYear(), thursday.getUTCMonth(), thursday.getUTCDate()));
}
