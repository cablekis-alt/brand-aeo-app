import type { NavIconName } from '../components/NavIcon'

/**
 * 메뉴 정의 — 사이드바와 상단 작업 막대(경로 표시)가 함께 쓴다.
 *
 * 메뉴는 **쓰는 사람의 일** 순서로 묶는다 — 개요 → 진단 → 실행 → 보고·측정.
 *
 * 상용화 UI 2차(2026-10)에서 묶음을 줄였다. 매주 여는 화면만 위에 두고, 가끔 여는 상세 화면은
 * 「상세 분석」에 접는다. 측정(브랜드·경쟁사 측정·측정 상태)은 보고 옆으로 옮겼다 — 측정은 한 번 걸어
 * 두면 매주 돌아가는 일이라, 매주 읽는 보고와 같은 자리에 있는 편이 찾기 쉽다.
 * 항목 이름은 각 화면의 이름을 그대로 쓴다(메뉴와 화면 제목이 다르면 사람이 같은 곳인지 헷갈린다).
 *
 * 그룹 이름은 처음엔 질문(어디가 비어 있나 / 그래서 뭘 하나)이었다. 처음 쓰는 사람에겐 안내가 되지만
 * 매일 쓰는 화면에서는 훑어 읽기 어렵고 줄도 길어 짧은 명사로 바꿨다.
 *
 * 배지 둘: 측정 상태에 진행 중 건수, 콘텐츠 생성에 남은 건수. 메뉴를 열기 전에 "지금 할 일이 있나"가
 * 보이게 — 개요까지 가지 않아도 된다.
 */
export interface MenuItem {
  label: string
  to: string
  badge?: 'measuring' | 'actions'
  /** 주 메뉴만 아이콘을 단다. 접히는 상세·설정 항목은 글자만 두고 아이콘 자리만큼 들여 맞춘다. */
  icon?: NavIconName
}
export interface MenuGroup {
  id: string
  title?: string
  items: MenuItem[]
  /** 접히는 그룹. 기본은 닫힘, 현재 경로가 안에 있으면 열림. */
  foldable?: boolean
}

export const MENU: MenuGroup[] = [
  {
    id: 'home',
    items: [{ label: '개요', to: '/', icon: 'dashboard' }],
  },
  {
    id: 'diagnose',
    title: '진단',
    items: [
      { label: '경쟁 순위', to: '/ranking', icon: 'ranking' },
      { label: '질문별 승패', to: '/question-winloss', icon: 'gap' },
      { label: '인용 갭 분석', to: '/citation-gap', icon: 'citation' },
      { label: '브랜드 종합 진단', to: '/diagnosis', icon: 'diagnosis' },
    ],
  },
  {
    id: 'act',
    title: '실행',
    items: [
      // 「실행 항목」에서 이름을 바꿨다. 이 화면이 실제로 하는 일은 쓸 글을 정하고 만들어
      // 내보내는 것이고, 고객이 찾는 말도 그쪽이다. 배지(남은 건수)는 그대로 쓴다.
      { label: '콘텐츠 생성', to: '/gap-actions', badge: 'actions', icon: 'content' },
      { label: '콘텐츠 보관함', to: '/content-library', icon: 'library' },
      { label: 'Site AEO Checker', to: '/site-diagnosis', icon: 'site' },
    ],
  },
  {
    id: 'report',
    title: '보고·측정',
    items: [
      { label: '정기진단 보고서', to: '/report', icon: 'report' },
      { label: 'AEO 퍼포먼스', to: '/performance', icon: 'performance' },
      { label: '브랜드·경쟁사 측정', to: '/measure-tenant', icon: 'measure' },
      { label: '측정 상태', to: '/measure-status', badge: 'measuring', icon: 'status' },
    ],
  },
  {
    id: 'detail',
    title: '상세 분석',
    foldable: true,
    items: [
      { label: '가시성 격차 분석', to: '/gap-analysis' },
      { label: '감성 분석', to: '/sentiment' },
      { label: 'URL 상세 분석', to: '/citations' },
      { label: 'AI 인용출처 분석', to: '/citation-sources' },
      { label: 'EEAT 분석', to: '/eeat' },
      { label: '경쟁 시계열', to: '/competitor-trends' },
      { label: 'AI 리퍼럴 트래픽', to: '/ai-referrals' },
    ],
  },
  {
    id: 'settings',
    title: '설정',
    foldable: true,
    items: [
      { label: '브랜드 사실', to: '/brand-facts' },
      { label: '질문 프롬프트 빌더', to: '/questions' },
    ],
  },
]

/** 메뉴에 없는 화면의 이름 — 사이드바의 「브랜드 추가」 단추로만 들어간다. */
const EXTRA: Record<string, string> = { '/brand-onboarding': '브랜드 추가' }

/** 경로 표시용 — 지금 화면이 어느 묶음의 무엇인지. 메뉴에 없는 경로면 null. */
export function routeMeta(pathname: string): { group: string | null; label: string } | null {
  for (const g of MENU) {
    const item = g.items.find((i) => i.to === pathname)
    if (item) return { group: g.title ?? null, label: item.label }
  }
  return EXTRA[pathname] ? { group: null, label: EXTRA[pathname] } : null
}
