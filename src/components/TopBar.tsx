import { Link, useLocation } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { routeMeta } from '../lib/menu'

/**
 * 상단 작업 막대(상용화 UI 2차) — 왼쪽은 「이전 화면」과 경로(브랜드 / 묶음 / 화면), 오른쪽은 이 화면에서
 * 자주 하는 일 하나. 화면마다 큰 제목이 따로 있어도, 경로가 있으면 메뉴에서 몇 단계 들어왔는지와
 * 지금 어느 브랜드를 보고 있는지가 한 줄에 보인다.
 *
 * 기간(주차)은 여기서 고르지 않는다 — 화면마다 주차 선택이 있고, 이를 한 곳으로 모으는 일은 별도
 * 변경이다. 「공유」는 두지 않는다 — 데스크톱 앱에는 링크 공유 기능이 없다. 오른쪽 단추는 정기진단
 * 보고서로 간다 — 내보내기(인쇄·PDF, 검토 리포트 HTML)가 거기 있다. 단추 이름을 「내보내기」로 하면 누르는
 * 순간 파일이 나올 것처럼 읽혀 「정기진단 보고서」로 둔다.
 */
export default function TopBar({
  showBrand,
  canGoBack,
  onBack,
}: {
  /** 관리·측정 화면(브랜드와 무관)에서는 경로에 브랜드를 넣지 않는다. */
  showBrand: boolean
  canGoBack: boolean
  onBack: () => void
}) {
  const { pathname } = useLocation()
  const { tenant } = useTenant()
  const meta = routeMeta(pathname)
  const crumbs = [showBrand && tenant ? tenant.brandName : null, meta?.group ?? null].filter((c): c is string => Boolean(c))

  return (
    <header className="topbar">
      {canGoBack && (
        <button type="button" className="topbar-back" onClick={onBack} title="이전 화면으로 (Alt+←)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          이전 화면
        </button>
      )}
      {meta && (
        <nav className="topbar-crumbs" aria-label="현재 위치">
          {crumbs.map((c) => (
            <span key={c} className="topbar-crumb">
              {c}
              <span className="topbar-sep" aria-hidden="true">
                /
              </span>
            </span>
          ))}
          <span className="topbar-here" aria-current="page">
            {meta.label}
          </span>
        </nav>
      )}
      {showBrand && tenant && pathname !== '/report' && (
        <div className="topbar-actions">
          <Link to="/report" className="btn primary">
            정기진단 보고서
          </Link>
        </div>
      )}
    </header>
  )
}
