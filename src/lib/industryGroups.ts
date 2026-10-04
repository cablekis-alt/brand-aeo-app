/**
 * 업종군 — 브랜드 현황 화면과 브랜드 전환 목록이 업종을 크게 묶는 규칙.
 *
 * 업종 이름은 브랜드를 등록할 때 추론되거나 사람이 적은 자유 글이라(「셋톱박스·브로드밴드 단말」, 「AI 마케팅
 * 자동화」) 업종마다 묶으면 1곳짜리 묶음이 대부분이었다(2026-10-04: 고객 34곳 · 업종 25개). 낱말로 크게 묶는다.
 * 위에서부터 처음 맞는 묶음으로 간다 — 「반도체 제조」는 산업·제조보다 앞의 통신·전자로 간다.
 * 맞는 낱말이 없으면 「기타」. 묶음을 고치려면 여기 낱말만 고친다.
 */
export const INDUSTRY_GROUPS: { name: string; words: string[] }[] = [
  { name: '의료·뷰티', words: ['성형', '치과', '병원', '의원', '의료', '피부', '안과', '한의', '정형', '클리닉', '뷰티', '미용'] },
  { name: '통신·전자', words: ['통신', '브로드밴드', '셋톱', '전자', '반도체', '방송', '네트워크'] },
  { name: '금융', words: ['보험', '은행', '증권', '카드', '금융', '자산'] },
  { name: '관광·숙박', words: ['펜션', '호텔', '숙박', '관광', '여행', '리조트', '캠핑'] },
  { name: '산업·제조', words: ['화학', '부품', '제조', '소재', '기계', '자동차', '철강', '에너지'] },
  { name: '공공·연구·단체', words: ['공기업', '공사', '공단', '연구', '협회', '사단법인', '재단', '기관', '정부'] },
  { name: '미디어·서비스', words: ['신문', '언론', '미디어', '컨설팅', '마케팅', '오더', '플랫폼', '교육', '소프트웨어', '서비스'] },
]
export const OTHER_GROUP = '기타'

export function industryGroupOf(industry: string): string {
  return INDUSTRY_GROUPS.find((g) => g.words.some((w) => industry.includes(w)))?.name ?? OTHER_GROUP
}

/** 화면에 묶음을 늘어놓는 순서 — 규칙 순서, 기타는 맨 끝. */
export function groupOrder(name: string): number {
  const i = INDUSTRY_GROUPS.findIndex((g) => g.name === name)
  return i < 0 ? INDUSTRY_GROUPS.length : i
}

/** 묶음 색 — 규칙 순서대로 --grp-1…7(index.css), 기타는 회색. 브랜드 현황과 브랜드 바꾸기 패널이 같이 쓴다. */
export function groupColor(name: string): string {
  const i = INDUSTRY_GROUPS.findIndex((g) => g.name === name)
  return i < 0 ? 'var(--muted)' : `var(--grp-${i + 1})`
}
