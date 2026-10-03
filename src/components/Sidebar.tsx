import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, weekLabel } from '../lib/format'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'
import { useScorecards } from '../lib/useScorecards'
import AppVersion from './AppVersion'
import { MENU, type MenuItem } from '../lib/menu'
import NavIcon from './NavIcon'
import ThemeToggle from './ThemeToggle'

/*
 * 메뉴 정의와 묶는 기준은 lib/menu.ts — 상단 작업 막대의 경로 표시도 같은 정의를 쓴다.
 *
 * 예전에는 파이프라인 단계(STAGE 1~4, B1~B9)로 묶고 줄마다 B-코드를 붙였다. 그건 만드는 사람의
 * 언어다. 쓰는 사람은 "측정 상태가 어디 있지"를 찾는데 "STAGE 2 · 엔진 연동 & 정규화"를 읽어야
 * 했고, 20개 줄 각각에 코드를 한 번씩 더 읽어야 했다. 코드는 코드 주석에만 남긴다.
 *
 * 가끔 여는 상세 화면(감성·URL·EEAT…)은 접어 둔다 — 매주 보는 화면과 같은 무게로 나열하면
 * 핵심이 묻힌다. 현재 화면이 접힌 그룹 안이면 자동으로 펼친다.
 */
const FOLD_KEY = (id: string) => `sidebar.open.${id}`

/**
 * 접기 상태는 **세 가지**다 — 폄(true) · 접음(false) · 정한 적 없음(null).
 *
 * 둘로만 두면 "정한 적 없음"과 "접음"이 구분되지 않아, 기본값을 접음으로 두든 폄으로 두든
 * 한쪽이 틀린다. 실측으로 걸린 버그가 그것이다: 현재 페이지가 묶음 안에 있으면 무조건 펴도록
 * 해 둬서(`folds[id] || inside`), 질문별 승패에서 「상세 분석」을 눌러도 접히지 않았다.
 * 사용자가 고른 것이 자동 펼침을 이겨야 한다.
 */
function readFold(id: string): boolean | null {
  try {
    const v = localStorage.getItem(FOLD_KEY(id))
    return v === null ? null : v === '1'
  } catch {
    return null
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

/**
 * 브랜드 바꾸기 — 상단 헤더에서 사이드바 머리로 옮겼다. 보이는 것은 이니셜·이름·업종·지역 카드이고,
 * 실제 선택은 그 위에 투명하게 겹친 기본 select가 받는다(키보드·스크린리더·긴 목록 스크롤을 그대로 쓴다).
 */
function BrandSwitch() {
  const { tenants, tenant, setTenantId } = useTenant()
  if (!tenant) return null
  const initial = Array.from(tenant.brandName.trim())[0] ?? '?'
  return (
    <div className="brand-switch">
      <span className="brand-switch-initial" aria-hidden="true">
        {initial}
      </span>
      <span className="brand-switch-text" aria-hidden="true">
        <span className="brand-switch-name">{tenant.brandName}</span>
        <span className="brand-switch-meta">
          {tenant.industry} · {tenant.region}
        </span>
      </span>
      <NavIcon name="updown" size={16} />
      <select aria-label="브랜드 바꾸기" value={tenant.tenantId} onChange={(e) => setTenantId(e.target.value)}>
        {tenants.map((item) => (
          <option key={item.tenantId} value={item.tenantId}>
            {item.brandName} · {item.industry} · {item.region}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * 사이드바 바닥의 측정 상태 — 진행 중인 측정이 있으면 그 건수, 없으면 이 브랜드의 마지막 측정 주차와 엔진.
 * 측정 상태 화면으로 가는 지름길이기도 하다.
 */
function MeasureStatusCard({ measuring }: { measuring: number }) {
  const { tenant } = useTenant()
  const { history } = useScorecards(tenant?.tenantId ?? '')
  const latest = history.length > 0 ? history[history.length - 1] : null
  if (measuring === 0 && latest === null) return null
  const engines = (latest?.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ')
  const head = measuring > 0 || latest === null ? `측정 중 ${measuring}건` : `최근 측정 · ${weekLabel(latest.weekOf)}`
  return (
    <NavLink to="/measure-status" className="sidebar-status">
      <span className="sidebar-status-head">
        <span className={`sidebar-status-dot${measuring > 0 ? ' live' : ''}`} aria-hidden="true" />
        {head}
      </span>
      {measuring === 0 && engines && <span className="sidebar-status-meta">{engines}</span>}
    </NavLink>
  )
}

export default function Sidebar({ showBrandPicker }: { showBrandPicker: boolean }) {
  const { pathname } = useLocation()
  const { tenant } = useTenant()
  const measuring = useMeasuringCount()
  const { plan, loading } = useGapActionPlan(tenant?.tenantId ?? '')
  const openActions = !loading && tenant ? plan.actions.filter(isOpenAction).length : 0

  // 창이 낮아 메뉴가 넘치면 현재 화면 항목을 메뉴 스크롤 안에서만 보이게 맞춘다(창 스크롤은 건드리지
  // 않는다 — scrollIntoView는 바깥 창까지 움직여 Layout의 스크롤 복원과 다툰다).
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = scrollRef.current
    const on = box?.querySelector<HTMLElement>('a.on')
    if (!box || !on) return
    const top = on.offsetTop - box.offsetTop
    if (top < box.scrollTop) box.scrollTop = top - 8
    else if (top + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + on.offsetHeight - box.clientHeight + 8
  }, [pathname])

  /*
   * 좁은 화면(760px 이하)에서는 메뉴를 접어 둔다 — 펼친 채로 두면 메뉴 800px를 지나야 본문이 나온다.
   * 연 경로를 기억해 두고 그 경로에서만 열린 것으로 본다. 메뉴를 눌러 이동하면 경로가 바뀌어 저절로
   * 닫힌다(effect로 상태를 되돌리지 않는다). 넓은 화면에서는 CSS가 이 상태를 무시하고 늘 펼친다.
   */
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname

  const [folds, setFolds] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(MENU.filter((g) => g.foldable).map((g) => [g.id, readFold(g.id)])),
  )
  /** 지금 보이는 상태의 반대로 뒤집는다 — 자동으로 펴져 있었다면 첫 번째 누름이 접는다. */
  const toggle = (id: string, shown: boolean) =>
    setFolds((f) => {
      writeFold(id, !shown)
      return { ...f, [id]: !shown }
    })

  const badgeOf = (item: MenuItem): { text: string; cls: string } | null => {
    if (item.badge === 'measuring' && measuring > 0) return { text: String(measuring), cls: 'live' }
    if (item.badge === 'actions' && openActions > 0) return { text: String(openActions), cls: 'todo' }
    return null
  }

  return (
    <nav className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Web4AI Brand AEO 메뉴">
      <header className="sidebar-brand">
        <div className="brand-lockup">
          <span className="brand-monogram" aria-hidden="true">
            AI O2O
          </span>
          <span className="brand-names">
            <span className="brand-title">Brand AEO</span>
            <span className="brand-eyebrow">Web4AI · AI 답변 가시성</span>
          </span>
          <button
            type="button"
            className="sidebar-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="sidebar-menu"
            aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'}
            onClick={() => setMenuOpenAt(menuOpen ? null : pathname)}
          >
            <NavIcon name={menuOpen ? 'close' : 'menu'} size={20} />
          </button>
        </div>
      </header>

      {showBrandPicker && <BrandSwitch />}

      {/* 스크롤 영역 밖에 둔다 — 안에 있으면 창이 낮아 메뉴가 넘칠 때 목록과 함께 밀려 상단이 잘린다. */}
      <NavLink
        to="/brand-onboarding"
        className={({ isActive }) => `sidebar-cta${isActive ? ' on' : ''}`}
      >
        <NavIcon name="plus" size={16} />
        브랜드 추가
      </NavLink>

      <div className="sidebar-scroll" id="sidebar-menu" ref={scrollRef}>
        {MENU.map((group) => {
          const inside = group.items.some((i) => i.to === pathname)
          // 사용자가 정한 적 없으면 현재 페이지를 따라 펴고, 정했으면 그 선택을 따른다.
          const open = !group.foldable || (folds[group.id] ?? inside)
          return (
            <div className={`sidebar-group${group.foldable ? ' foldable' : ''}${group.id === 'home' ? ' is-home' : ''}`} key={group.id}>
              {group.title &&
                (group.foldable ? (
                  <button
                    type="button"
                    // 접은 채로 그 안의 페이지를 보고 있으면 머리글이 현재 위치를 대신 알린다.
                    className={`sidebar-fold${inside && !open ? ' has-current' : ''}`}
                    aria-expanded={open}
                    onClick={() => toggle(group.id, open)}
                  >
                    <span className="sidebar-group-label">{group.title}</span>
                    {!open && <span className="fold-count">{group.items.length}</span>}
                    <span className={`chev${open ? ' open' : ''}`} aria-hidden="true" />
                  </button>
                ) : (
                  <p className="sidebar-group-title">
                    <span className="sidebar-group-label">{group.title}</span>
                  </p>
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
                          className={({ isActive }) => (isActive ? 'on' : undefined)}
                        >
                          {item.icon && <NavIcon name={item.icon} />}
                          <span className="label">{item.label}</span>
                          {badge && <span className={`sidebar-badge ${badge.cls}`}>{badge.text}</span>}
                        </NavLink>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <MeasureStatusCard measuring={measuring} />

      <footer className="sidebar-foot">
        <div className="sidebar-theme-row">
          <span className="sidebar-foot-label">테마</span>
          <ThemeToggle />
        </div>
        <AppVersion />
      </footer>
    </nav>
  )
}
