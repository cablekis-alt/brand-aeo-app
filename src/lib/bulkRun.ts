/**
 * 콘텐츠 생성 화면(src/pages/GapActions.tsx)의 일괄 실행 — 「초안 없는 글 한꺼번에」(all)와 작성자 단추(writer).
 *
 * 화면은 브랜드를 바꿔도 다시 그려지지 않는다(Layout은 측정 결과를 새로 고칠 때만 페이지를 갈아 끼운다). 그런데 앞 브랜드에서 누른
 * 실행은 몇 분 동안 계속 돌며 시작 · 끝과 브리프 · 초안을 화면에 넘긴다. 그래서 둘 다 브랜드로 가른다 — 앞 브랜드의 실행이 지금
 * 브랜드를 잠그지 않고, 그 실행이 만든 브리프 · 초안이 지금 브랜드의 목록에 섞이지 않는다(서버에는 제 브랜드로 저장된다).
 */
export type BulkKind = 'all' | 'writer'

/** 브랜드마다 도는 일괄 실행. 키가 없으면 그 브랜드는 돌고 있지 않다. */
export type BulkRuns = Readonly<Record<string, BulkKind>>

/** 한 브랜드의 실행이 시작하거나(busy) 끝난 뒤의 표 — 다른 브랜드 칸은 건드리지 않는다. */
export function bulkRunsAfter(runs: BulkRuns, tenantId: string, kind: BulkKind, busy: boolean): BulkRuns {
  if (busy) return { ...runs, [tenantId]: kind }
  if (!(tenantId in runs)) return runs
  const next = { ...runs }
  delete next[tenantId]
  return next
}

/** 실행을 시작한 브랜드(started)가 지금 화면의 브랜드(current)와 같을 때만 value를 f에 넘긴다 — 브랜드를 바꾼 뒤 앞 브랜드의 실행이 넘긴 것은 버린다. */
export function passForTenant<T>(current: string, started: string, value: T, f: (value: T) => void): void {
  if (current === started) f(value)
}
