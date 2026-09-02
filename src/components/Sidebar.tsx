import { NavLink } from 'react-router-dom'

interface MenuItem {
  code: string
  label: string
  to: string
}

interface MenuGroup {
  title: string
  items: MenuItem[]
}

const MENU: MenuGroup[] = [
  {
    title: '브랜드 진단 및 분석',
    items: [
      { code: 'S-01', label: '홈 · 대시보드', to: '/' },
      { code: 'S-02', label: '브랜드 종합 진단', to: '/diagnosis' },
      { code: 'S-03', label: '사이트 종합 진단', to: '/site-diagnosis' },
    ],
  },
  {
    title: 'AEO 최적화',
    items: [
      { code: 'S-04', label: '질문 프롬프트 빌더', to: '/questions' },
      { code: 'S-05', label: 'URL 상세 분석', to: '/citations' },
    ],
  },
  {
    title: '브랜드 퍼포먼스',
    items: [
      { code: 'S-06', label: '브랜드 AEO 퍼포먼스', to: '/performance' },
      { code: 'S-07', label: '랭킹 분석', to: '/ranking' },
    ],
  },
  {
    title: '브랜드 관리',
    items: [{ code: 'S-08', label: '브랜드 추가', to: '/brand-onboarding' }],
  },
]

export default function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Brand AEO 메뉴">
      <p className="sidebar-mark">Brand AEO</p>
      <p className="sidebar-scope">Site SEO와 별도로 운영되는 답변엔진 가시성 콘솔</p>
      {MENU.map((group) => (
        <div className="sidebar-group" key={group.title}>
          <p className="sidebar-group-title">{group.title}</p>
          <ul>
            {group.items.map((item) => (
              <li key={item.code}>
                <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'on' : undefined)}>
                  <span className="code">{item.code}</span>
                  <span>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
