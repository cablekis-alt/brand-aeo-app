/**
 * 손으로 쓴 실행 문서 — **생성된 실행 항목이 낼 수 없는 것만** 남긴다.
 *
 * 측정 상태 화면의 주 목록은 이제 /gap-actions가 계산한다(useGapActionPlan). 예전에는 이
 * 배열이 그 자리를 차지했는데, 브랜드가 늘 때마다 사람이 줄을 추가해야 했고 실제로 k-wonjin
 * 하나만 채워져 있었다.
 *
 * 그래도 이 파일을 지우지 않는 이유는 생성 로직에 **구조적인 사각지대**가 있어서다:
 *
 *   1) 생성은 **AI가 이미 인용한 도메인**에서만 나온다. 아직 한 번도 인용되지 않은 등재처는
 *      데이터에 없으니 영원히 제안되지 않는다. "외부 등재 점검"의 디렉터리 목록이 그 경우다.
 *   2) 생성은 **답변 본문**을 본다. 사이트 구조 감점(스키마·제목·내부 링크 등)은 Site AEO
 *      Checker가 내는 값이라 실행 항목에 들어오지 않는다.
 *
 * 새 줄을 추가하기 전에 생성 목록이 이미 그걸 내는지 먼저 확인한다. 겹치면 두 화면이 같은
 * 일을 두 번 시키게 된다.
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
    moves: 'AI 언급률 — 아직 인용된 적 없어 자동 생성되지 않는 디렉터리 10곳',
  },
]
