import { NavLink } from 'react-router-dom'
import AppVersion from './AppVersion'
import ThemeToggle from './ThemeToggle'

interface MenuItem {
  label: string
  to: string
  b?: string // 파이프라인 B-코드
  accent?: boolean // 진입점 강조(브랜드 추가)
}

interface MenuGroup {
  title: string
  range?: string // 그룹이 커버하는 B-범위
  items: MenuItem[]
}

// 측정 파이프라인(B1~B9)에 맞춰: 시작 → STAGE 1~4.
const MENU: MenuGroup[] = [
  {
    title: '시작',
    items: [
      { label: '브랜드 추가', to: '/brand-onboarding', accent: true },
      { label: '대시보드 · 파이프라인', to: '/' },
    ],
  },
  {
    title: 'STAGE 1 · 질문 생성 & 스케줄',
    range: 'B1–B3',
    items: [
      { label: '질문 프롬프트 빌더', to: '/questions', b: 'B1' },
      { label: '브랜드·경쟁사 측정', to: '/measure-tenant', b: 'B2' },
      { label: '사이트 종합 진단', to: '/site-diagnosis' },
    ],
  },
  {
    title: 'STAGE 2 · 엔진 연동 & 정규화',
    range: 'B4',
    items: [{ label: '측정 상태', to: '/measure-status', b: 'B4' }],
  },
  {
    title: 'STAGE 3 · 다각도 분석',
    range: 'B5–B7',
    items: [
      { label: '브랜드 종합 진단', to: '/diagnosis', b: 'B5' },
      { label: 'URL 상세 분석', to: '/citations', b: 'B5' },
      { label: 'AI 인용출처 분석', to: '/citation-sources', b: 'B7' },
      { label: 'EEAT 분석', to: '/eeat', b: 'B6' },
    ],
  },
  {
    title: 'STAGE 4 · 스코어 & 리포트',
    range: 'B8–B9',
    items: [
      { label: '브랜드 AEO 퍼포먼스', to: '/performance', b: 'B8' },
      { label: '랭킹 분석', to: '/ranking', b: 'B8' },
      { label: '정기진단 보고서', to: '/report', b: 'B9' },
    ],
  },
]

export default function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Web4AI Brand AEO 메뉴">
      <header className="sidebar-brand">
        <div className="brand-lockup">
          <span className="brand-monogram" aria-hidden="true">AIO2O</span>
          <span className="brand-names">
            <span className="brand-eyebrow">Web4AI</span>
            <span className="brand-title">Brand AEO</span>
          </span>
        </div>
        <p className="sidebar-scope">Site SEO와 별도로 운영되는 답변엔진 가시성 콘솔</p>
      </header>
      {MENU.map((group) => (
        <div className="sidebar-group" key={group.title}>
          <p className="sidebar-group-title">
            {group.title}
            {group.range && <span className="range">{group.range}</span>}
          </p>
          <ul>
            {group.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => [item.accent ? 'accent' : undefined, isActive ? 'on' : undefined].filter(Boolean).join(' ') || undefined}
                >
                  <span className="label">{item.accent ? `＋ ${item.label}` : item.label}</span>
                  {item.b && <span className="bstage">{item.b}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="sidebar-theme">
        <p className="sidebar-group-title">테마</p>
        <ThemeToggle />
      </div>
      <AppVersion />
    </nav>
  )
}
