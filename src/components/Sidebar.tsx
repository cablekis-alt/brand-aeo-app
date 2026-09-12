import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'
import AppVersion from './AppVersion'
import ThemeToggle from './ThemeToggle'

/**
 * 메뉴는 **쓰는 사람의 질문** 순서로 묶는다 — 측정 → 어디가 비어 있나 → 그래서 뭘 하나 → 보고.
 *
 * 예전에는 파이프라인 단계(STAGE 1~4, B1~B9)로 묶고 줄마다 B-코드를 붙였다. 그건 만드는 사람의
 * 언어다. 쓰는 사람은 "측정 상태가 어디 있지"를 찾는데 "STAGE 2 · 엔진 연동 & 정규화"를 읽어야
 * 했고, 20개 줄 각각에 코드를 한 번씩 더 읽어야 했다. 코드는 코드 주석에만 남긴다.
 *
 * 가끔 여는 상세 화면(감성·URL·EEAT…)은 접어 둔다 — 격차 분석·실행 항목과 같은 무게로 나열하면
 * 핵심이 묻힌다. 현재 화면이 접힌 그룹 안이면 자동으로 펼친다.
 *
 * 배지 둘: 측정 상태에 진행 중 건수, 실행 항목에 남은 건수. 메뉴를 열기 전에 "지금 할 일이 있나"가
 * 보이게 — 대시보드까지 가지 않아도 된다.
 */
interface MenuItem {
  label: string
  to: string
  accent?: boolean
  badge?: 'measuring' | 'actions'
}
interface MenuGroup {
  id: string
  title?: string
  items: MenuItem[]
  /** 접히는 그룹. 기본은 닫힘, 현재 경로가 안에 있으면 열림. */
  foldable?: boolean
}

const MENU: MenuGroup[] = [
  {
    id: 'top',
    items: [
      { label: '브랜드 추가', to: '/brand-onboarding', accent: true },
      { label: '대시보드', to: '/' },
    ],
  },
  {
    id: 'measure',
    title: '측정',
    items: [
      { label: '브랜드·경쟁사 측정', to: '/measure-tenant' },
      { label: '측정 상태', to: '/measure-status', badge: 'measuring' },
    ],
  },
  {
    id: 'gaps',
    title: '어디가 비어 있나',
    items: [
      { label: '브랜드 종합 진단', to: '/diagnosis' },
      { label: '가시성 격차 분석', to: '/gap-analysis' },
      { label: '인용 갭 분석', to: '/citation-gap' },
      { label: '경쟁 순위', to: '/ranking' },
    ],
  },
  {
    id: 'act',
    title: '그래서 뭘 하나',
    items: [
      { label: '실행 항목', to: '/gap-actions', badge: 'actions' },
      { label: 'Site AEO Checker', to: '/site-diagnosis' },
    ],
  },
  {
    id: 'report',
    title: '보고',
    items: [
      { label: 'AEO 퍼포먼스', to: '/performance' },
      { label: '정기진단 보고서', to: '/report' },
    ],
  },
  {
    id: 'detail',
    title: '상세 분석',
    foldable: true,
    items: [
      { label: '질문별 승패', to: '/question-winloss' },
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
    items: [{ label: '질문 프롬프트 빌더', to: '/questions' }],
  },
]

const FOLD_KEY = (id: string) => `sidebar.open.${id}`
function readFold(id: string): boolean {
  try {
    return localStorage.getItem(FOLD_KEY(id)) === '1'
  } catch {
    return false
  }
}
function writeFold(id: string, open: boolean) {
  try {
    localStorage.setItem(FOLD_KEY(id), open ? '1' : '0')
  } catch {
    /* 저장 못 해도 동작에는 영향 없음 */
  }
}

/** 진행 중인 로컬 측정 수 — 측정 상태 화면과 같은 엔드포인트, 15초 폴링. */
function useMeasuringCount(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/measure-status')
        if (!r.ok) return
        const d = (await r.json()) as { active?: unknown[] }
        if (alive) setN(Array.isArray(d.active) ? d.active.length : 0)
      } catch {
        /* 서버 없음(웹) — 배지 없음 */
      }
    }
    void load()
    const t = window.setInterval(() => void load(), 15000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])
  return n
}

export default function Sidebar() {
  const { pathname } = useLocation()
  const { tenant } = useTenant()
  const measuring = useMeasuringCount()
  const { plan, loading } = useGapActionPlan(tenant?.tenantId ?? '')
  const openActions = !loading && tenant ? plan.actions.filter(isOpenAction).length : 0

  const [folds, setFolds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MENU.filter((g) => g.foldable).map((g) => [g.id, readFold(g.id)])),
  )
  const toggle = (id: string) =>
    setFolds((f) => {
      const next = !f[id]
      writeFold(id, next)
      return { ...f, [id]: next }
    })

  const badgeOf = (item: MenuItem): { text: string; cls: string } | null => {
    if (item.badge === 'measuring' && measuring > 0) return { text: `진행 ${measuring}`, cls: 'live' }
    if (item.badge === 'actions' && openActions > 0) return { text: `남은 ${openActions}`, cls: 'todo' }
    return null
  }

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

      {MENU.map((group) => {
        const inside = group.items.some((i) => i.to === pathname)
        const open = !group.foldable || folds[group.id] || inside
        return (
          <div className={`sidebar-group${group.foldable ? ' foldable' : ''}`} key={group.id}>
            {group.title &&
              (group.foldable ? (
                <button
                  type="button"
                  className="sidebar-fold"
                  aria-expanded={open}
                  onClick={() => toggle(group.id)}
                >
                  <span className={`chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
                  {group.title}
                  {!open && <span className="fold-count">{group.items.length}</span>}
                </button>
              ) : (
                <p className="sidebar-group-title">{group.title}</p>
              ))}
            {open && (
              <ul>
                {group.items.map((item) => {
                  const badge = badgeOf(item)
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        className={({ isActive }) =>
                          [item.accent ? 'accent' : undefined, isActive ? 'on' : undefined].filter(Boolean).join(' ') || undefined
                        }
                      >
                        <span className="label">{item.accent ? `＋ ${item.label}` : item.label}</span>
                        {badge && <span className={`sidebar-badge ${badge.cls}`}>{badge.text}</span>}
                      </NavLink>
                    </li>
                  )
                })}
                {group.id === 'settings' && (
                  <li className="sidebar-theme-row">
                    <span className="sidebar-group-title" style={{ margin: 0 }}>테마</span>
                    <ThemeToggle />
                  </li>
                )}
              </ul>
            )}
          </div>
        )
      })}
      <AppVersion />
    </nav>
  )
}
