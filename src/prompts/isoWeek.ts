/**
 * ISO 8601 주차 유틸 — **server와 화면이 같은 것을 쓴다**.
 *
 * 원래 server/dateUtil.ts에만 있었다. 화면에서도 주차를 달로 묶어야 해서 옮겼다.
 * 복사해 두 벌로 만들면 "서버가 W38이라 부른 주를 화면이 다른 달에 넣는" 종류의
 * 어긋남이 생긴다 — 가중치 표에서 이미 겪은 일이다. server/dateUtil.ts는 이제
 * 여기를 다시 내보내기만 한다.
 */

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
 * 그 주의 **목요일**. ISO에서 주가 어느 해에 속하는지를 목요일이 정하므로, 어느 달에
 * 속하는지도 같은 기준으로 본다 — 한 주가 두 달에 걸칠 때 규칙 없이 나누지 않기 위해서다.
 */
export function isoWeekThursday(weekOf: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekOf);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const thursday = new Date(jan4);
  thursday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 4) + (week - 1) * 7);
  return thursday;
}

/**
 * 한 주 앞의 ISO 주차 키. "2026-W01"의 앞은 전년도 마지막 주(52 또는 53)라 문자열 계산으로는
 * 못 구한다 — 그 주의 목요일에서 7일을 빼 다시 주차를 낸다.
 */
export function previousIsoWeek(weekOf: string): string | null {
  const thursday = isoWeekThursday(weekOf);
  if (!thursday) return null;
  thursday.setUTCDate(thursday.getUTCDate() - 7);
  return getIsoWeekString(new Date(thursday.getUTCFullYear(), thursday.getUTCMonth(), thursday.getUTCDate()));
}

/** 그 주차가 속한 달 키("2026-09"). 목요일이 든 달을 그 주의 달로 본다. */
export function isoWeekMonth(weekOf: string): string | null {
  const t = isoWeekThursday(weekOf);
  if (!t) return null;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2026-09" → "2026년 9월". */
export function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  return m ? `${m[1]}년 ${Number(m[2])}월` : monthKey;
}
