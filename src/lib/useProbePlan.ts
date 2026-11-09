import { useEffect, useState } from 'react'
import { loadProbePlan } from './api'
import { isActive, type WriterPlan } from './probePlan'
import { todayKst } from './publishedUrl'

/**
 * 작성자 배정(server/probePlanStore.ts · src/lib/probePlan.ts)을 불러온다 — 글을 만드는 화면(콘텐츠 생성 · 질문 은행)과 글을 작성자별로
 * 묶어 보이는 콘텐츠 보관함만 쓴다.
 * useGapActionPlan(사이드바 · 대시보드도 씀)에는 넣지 않는다 — 배정은 글 만들기의 잠금이지 할 일 수가 아니다.
 *
 * available이 false면 이 환경에 기능이 없거나(웹 — 라우트 404) 아직 읽는 중이다 — 화면은 배정 파일이 없을 때와 똑같이 그린다.
 * 읽다가 실패하면 error에 이유를 싣는다(서버는 그래도 글 만들기를 막는다). 브랜드를 바꾸면 앞 브랜드의 배정을 쓰지 않고(키로 가른다)
 * 늦게 온 응답은 버린다. active는 운영 기간 안의 배정 — 마지막 날(KST)이 지나면 null이라 화면이 지금처럼 그린다.
 */
export function useProbePlan(tenantId: string) {
  const [state, setState] = useState<{
    key: string
    plan: WriterPlan | null
    corrupt: boolean
    available: boolean
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!tenantId) return
    let alive = true
    void loadProbePlan(tenantId).then(
      (r) => {
        if (alive) setState({ key: tenantId, plan: r?.plan ?? null, corrupt: r?.corrupt ?? false, available: r !== null, error: null })
      },
      (err: unknown) => {
        if (alive) setState({ key: tenantId, plan: null, corrupt: false, available: true, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])
  const fresh = state?.key === tenantId ? state : null
  const plan = fresh?.plan ?? null
  return {
    plan,
    /** 운영 기간 안의 배정 — 없거나 지났으면 null. */
    active: isActive(plan, todayKst()) ? plan : null,
    /** 파일이 깨졌다 — 서버가 작성자 배정 글 만들기를 모두 막는다. */
    corrupt: fresh?.corrupt ?? false,
    error: fresh?.error ?? null,
    available: fresh?.available ?? false,
    /** 이 브랜드의 응답을 받았다(파일 없음 · 기능 없음 · 실패 포함) — 콘텐츠 보관함이 배정을 받기 전에 한 목록으로 그렸다가 묶지 않게. */
    loaded: fresh !== null,
  }
}
