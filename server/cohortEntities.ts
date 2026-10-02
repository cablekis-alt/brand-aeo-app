import type { TenantConfig } from './types.js';

/**
 * 추천 순위 판정에 넘기는 병원 목록 — 같은 코호트(업종·지역·질문 언어)는 모두 같은 목록을 쓴다.
 *
 * 전에는 "이 브랜드 + 이 브랜드가 등록한 경쟁사"끼리만 순위를 매겼다. 경쟁사 목록이 없는 비교용
 * 브랜드(cohortOnly)는 비교 대상이 자기뿐이라 추천되기만 하면 1위였다 — 실측 W40 성동구 1차에서
 * 왕십리본은 순위가 매겨진 답변 6건이 모두 1위(평균 1.00)로 판정돼 35점의 상당 부분을 여기서 받았다.
 * 반대로 경쟁사 목록이 있는 고객 브랜드는 경쟁사 뒤에 추천되면 2·3위로 깎였다. SoM을 점수에서 뺀 것
 * (b8-report.ts 가중치 주석)과 같은 종류의 비대칭이다.
 *
 * 목록 = 코호트 구성원 전원의 이름 + 그들이 등록한 경쟁사 이름의 합집합. 코호트 안 누구를 재든 같은
 * 목록이 나오도록 정렬해 돌려준다(판정 프롬프트에 나열 순서가 영향을 줄 수 있다).
 */
export function cohortRankingEntities(tenant: TenantConfig, runtime: TenantConfig[]): string[] {
  const language = (t: TenantConfig) => t.questionLanguage ?? 'ko';
  const members = runtime.filter(
    (t) => t.industry === tenant.industry && t.region === tenant.region && language(t) === language(tenant),
  );
  const names = new Set<string>();
  // 측정 중인 브랜드는 아직 런타임 목록에 없을 수 있다(등록 직후 측정) — 항상 넣는다.
  for (const t of [tenant, ...members]) {
    if (t.brandName.trim()) names.add(t.brandName.trim());
    for (const c of t.competitors) if (c.name.trim()) names.add(c.name.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ko'));
}
