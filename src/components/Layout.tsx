import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { clearDataSource, useDemoData } from '../lib/dataSource'
import { useTenant } from '../context/useTenant'
import EmptyBrands from './EmptyBrands'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

// 선택 브랜드와 무관한 관리·측정 화면 — 사이드바의 브랜드 바꾸기를 숨기고, 브랜드 0개여도 그대로 연다
// (브랜드 추가는 첫 등록 통로, 측정 대기열·상태는 전역, 테넌트 골라 측정은 자체 드롭다운, 브랜드 현황은 전체 목록).
const MANAGEMENT_ROUTES = new Set(['/brand-onboarding', '/measure-tenant', '/measure-status', '/brands'])

export default function Layout() {
  const { tenants, tenant, loading, error, reloadTenants } = useTenant()
  const { pathname, key: locationKey } = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const isManagement = MANAGEMENT_ROUTES.has(pathname)
  const noBrands = !loading && tenants.length === 0
  const loadingBrands = loading && tenants.length === 0
  const showBrandPicker = Boolean(tenant) && !isManagement
  // 데모 응답이 섞여 있으면 배너. 화면·브랜드가 바뀌면 이전 표시를 비운다(주차 변경은 useWeeklyData가 비운다).
  const demo = useDemoData()
  useEffect(() => {
    clearDataSource()
  }, [pathname, tenant?.tenantId])

  // 보고서 → 실행 계획 → 콘텐츠 생성처럼 화면을 건너간 뒤 돌아올 길. 앱 안에서 이동한 기록이
  // 있을 때만 보인다(첫 화면에서 누르면 앱 밖으로 나가므로). useLocation 덕에 이동마다 다시 그려진다.
  const historyIdx = (window.history.state as { idx?: number } | null)?.idx
  const canGoBack = typeof historyIdx === 'number' && historyIdx > 0
  // 데스크톱 창엔 브라우저 뒤로 버튼이 없어 Alt+← 와 마우스 뒤로 버튼(4번 버튼)도 받는다.
  useEffect(() => {
    if (!canGoBack) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        navigate(-1)
      }
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        navigate(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [canGoBack, navigate])

  // 새 화면은 맨 위에서 연다 — 아래쪽 링크를 눌러 넘어오면 스크롤이 그대로 남아 위의 「이전 화면」
  // 버튼과 제목이 가려졌다. 뒤로 오면 떠날 때 읽던 자리로 돌려 놓는다. 화면 데이터가 늦게 차면
  // 문서가 짧아 목표까지 못 내려가므로, 닿거나 사용자가 직접 스크롤할 때까지 잠깐 다시 시도한다.
  const scrollByKey = useRef(new Map<string, number>())
  const currentKey = useRef(locationKey)
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    // 이동은 클릭·키 입력에서 시작하므로 그 직전(캡처 단계)에 현재 위치를 적어 둔다. 스크롤 이벤트도 받는다.
    const remember = () => scrollByKey.current.set(currentKey.current, window.scrollY)
    window.addEventListener('scroll', remember, { passive: true })
    window.addEventListener('pointerdown', remember, true)
    window.addEventListener('keydown', remember, true)
    return () => {
      window.removeEventListener('scroll', remember)
      window.removeEventListener('pointerdown', remember, true)
      window.removeEventListener('keydown', remember, true)
    }
  }, [])
  useLayoutEffect(() => {
    currentKey.current = locationKey
    const target = navigationType === 'POP' ? scrollByKey.current.get(locationKey) ?? 0 : 0
    window.scrollTo(0, target)
    if (target === 0) return
    let timer = 0
    const stopAt = Date.now() + 2000
    const cancel = () => window.clearTimeout(timer)
    const retry = () => {
      if (Math.abs(window.scrollY - target) < 2 || Date.now() > stopAt) return
      window.scrollTo(0, target)
      timer = window.setTimeout(retry, 50)
    }
    timer = window.setTimeout(retry, 50)
    window.addEventListener('wheel', cancel, { once: true, passive: true })
    window.addEventListener('touchstart', cancel, { once: true, passive: true })
    window.addEventListener('keydown', cancel, { once: true })
    return () => {
      cancel()
      window.removeEventListener('wheel', cancel)
      window.removeEventListener('touchstart', cancel)
      window.removeEventListener('keydown', cancel)
    }
  }, [locationKey, navigationType])

  return (
    <div className="shell">
      <Sidebar showBrandPicker={showBrandPicker} />
      <div className="content">
        <TopBar showBrand={!isManagement} canGoBack={canGoBack} onBack={() => navigate(-1)} />
        {error && (
          <p className="error" role="alert">
            {error}{' '}
            <button type="button" className="ghost" onClick={() => void reloadTenants()}>
              다시 시도
            </button>
          </p>
        )}

        {demo && !isManagement && (
          <p className="notice" role="status">
            <b>측정 전 예시 데이터입니다.</b> 이 브랜드·주차는 아직 측정되지 않아 화면의 숫자는 데모입니다.{' '}
            <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 실제 값으로 바뀝니다.
          </p>
        )}

        {/*
          브랜드 목록을 불러오는 동안에는 화면을 비우지 않고 로딩임을 명시한다.
          이전에는 아무것도 렌더하지 않아, 목록 조회가 느리면 브랜드 드롭다운조차 없는 상태가
          되어 "눌러도 안 눌린다"로 보였다. 0개면 빈 상태, 관리·측정 화면은 브랜드와 무관하게 열린다.
        */}
        {isManagement ? (
          <Outlet />
        ) : loadingBrands ? (
          <p className="muted" style={{ marginTop: 24 }}>
            브랜드 목록을 불러오는 중…
          </p>
        ) : noBrands ? (
          <EmptyBrands />
        ) : (
          tenant && <Outlet />
        )}
      </div>
    </div>
  )
}
