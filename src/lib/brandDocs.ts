/**
 * 브랜드별 실행 문서 — 측정 결과로 만든 작업 지시서 링크.
 *
 * 측정은 "무엇이 문제인가"까지만 알려준다. 실제로 고치는 일은 사람이 사이트와 외부 채널에서
 * 해야 하고, 그 목록이 이 문서들이다. 측정 상태 화면에서 바로 열 수 있게 여기 모아 둔다.
 *
 * 두 가지를 헷갈리지 않게 `moves`에 적어 둔다 — **사이트 구조 점수와 AI 언급률은 다른 지표다.**
 * 사이트를 100점으로 만들어도 언급률이 자동으로 오르지 않는다(언급률은 제3자 콘텐츠가 움직인다).
 *
 * 주의: 링크는 **비공개 페이지**다. 만든 계정 외에는 공유를 받아야 열린다.
 */
export interface BrandDoc {
  /** 어느 브랜드의 문서인지 — 화면에 브랜드명을 함께 보여 다른 브랜드 것으로 오해하지 않게 한다. */
  tenantId: string
  brandName: string
  title: string
  url: string
  /** 이 문서를 실행하면 움직이는 지표. */
  moves: string
}

export const BRAND_DOCS: BrandDoc[] = [
  {
    tenantId: 'k-wonjin',
    brandName: 'WJ 원진성형외과',
    title: '사이트 AEO 감점 수정',
    url: 'https://claude.ai/code/artifact/b7984471-b43e-42cc-8056-196f59f8c78d',
    moves: 'Site AEO 구조 점수 76 → 100 (감점 9건)',
  },
  {
    tenantId: 'k-wonjin',
    brandName: 'WJ 원진성형외과',
    title: '외부 등재 점검',
    url: 'https://claude.ai/code/artifact/d6b194ad-4070-40bb-a8fa-fb4974b930a2',
    moves: 'AI 언급률 (현재 1.5%) — 등재형 디렉터리 10곳',
  },
]
