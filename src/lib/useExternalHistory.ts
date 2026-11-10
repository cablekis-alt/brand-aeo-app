import { useEffect, useState } from 'react'
import type { MovedPosting, RepostPosting } from '../components/PublishedHistoryTable'
import { loadExternalHistory, type ExternalHistory, type PublishedPost } from './api'
import { measuredBefore, repostBasis } from './externalPosts'
import { ownedBrandsOf } from './postImport'
import { kstDate } from './publishedUrl'

/**
 * 앱 밖 글 인용 이력을 불러온다(server/externalPosts.ts getExternalHistory — 앱 글 이력과 같은 계산, 그 브랜드 측정 답변 기준). 퍼포먼스
 * 「앱 밖 글 인용 추적」 절만 쓴다 — 집행 핀 · 「집행」 칸 · 올린 글 표 · 정기진단 보고서는 원장 이력(usePublishedHistory)만 읽는다
 * (scripts/verify-external-posts.ts 정적 검사).
 *
 * available이 false면 이 환경에 기능이 없다(웹 — 라우트가 없다) — 절을 숨긴다. 읽다가 실패하면 available은 true로 두고 error에 이유를
 * 싣는다(깨진 파일을 조용히 숨기지 않는다). 브랜드 · 주 수가 바뀌면 앞 결과를 쓰지 않는다(키로 가른다). 브랜드가 없으면(경쟁사 보기) 읽지 않는다.
 */
export function useExternalHistory(tenantId: string, weeks = 12) {
  const key = `${tenantId}|${weeks}`
  const [state, setState] = useState<{ key: string; value: ExternalHistory | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!tenantId) return
    let alive = true
    const k = `${tenantId}|${weeks}`
    void loadExternalHistory(tenantId, weeks).then(
      (value) => {
        if (alive) setState({ key: k, value, error: null })
      },
      (err: unknown) => {
        if (alive) setState({ key: k, value: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId, weeks])
  const fresh = state?.key === key ? state : null
  return {
    history: fresh?.value ?? null,
    loading: fresh === null,
    error: fresh?.error ?? null,
    /** 이 환경에서 이력을 볼 수 있는가(웹은 false). 읽기 실패여도 true — 이유는 error에 있다. */
    available: fresh !== null && (fresh.value !== null || fresh.error !== null),
  }
}

/**
 * 행 → 옮김(성과 표 movedOf). 칸을 끊은 까닭이 같은 브랜드에서 앱 글로 옮긴 것일 때만 준다 — 사람이 앱 글 표가 세기 시작하기 전에 「글을
 * 내림」으로 뺀 행은 내린 날부터 칸이 이미 비었으므로 「내림」 그대로다(서버는 앱 글 표가 세는 회차만 비운다 — server/externalPosts.ts).
 * 앱 글의 올린 날을 모르면(옛 기록) 옮긴 날로 견준다.
 */
export function externalMovedOf(history: ExternalHistory): (post: PublishedPost) => MovedPosting | null {
  const moved = new Map<string, MovedPosting>()
  for (const { post, external } of history.posts) {
    if (external.movedOn === null && external.appCountsFrom === null) continue
    const from = external.appCountsFrom ?? external.movedOn
    const removedOn = external.removedAt ? kstDate(external.removedAt) : null
    if (removedOn && from && removedOn < from) continue
    moved.set(post.id, { movedOn: external.movedOn, countsFrom: external.appCountsFrom })
  }
  return (post) => moved.get(post.id) ?? null
}

/**
 * 행 → 다시 올린 행(성과 표 repostOf). 같은 브랜드에서 같은 주소를 앞서 「글을 내림」으로 뺀 줄이 있는 행에만, 그 내린 날과 그 주 측정이 이 행이
 * 세기 시작하는 날보다 앞인지를 준다 — 서버가 칸을 비운 것과 같은 함수(src/lib/externalPosts.ts repostBasis · measuredBefore). 이력의 행에는
 * 「잘못 적음」 줄만 빠지고 내린 줄은 모두 있어(그 함수는 내린 줄만 본다) 서버와 같은 날이 나온다.
 */
export function externalRepostOf(history: ExternalHistory): (post: PublishedPost) => RepostPosting | null {
  const rows = history.posts.map((p) => p.external)
  const reposts = new Map<string, RepostPosting>()
  for (const { post, external } of history.posts) {
    const basis = repostBasis(rows, external)
    if (!basis) continue
    reposts.set(post.id, { downOn: basis.downOn, beforeRepost: (week) => measuredBefore(basis.countsFrom, week.window, week.weekOf) })
  }
  return (post) => reposts.get(post.id) ?? null
}

/**
 * 이 표의 글 가운데 이 브랜드의 자사 주소에 있는 글의 호스트(C1 문구를 붙일지). 미리 고르기와 같은 규칙이다(src/lib/postImport.ts
 * ownedBrandsOf — 자사 주소 칸으로 직접 맞추고, 여럿이 함께 쓰는 플랫폼 호스트는 자사 주소 칸에 있어도 뺀다 — C2).
 */
export function ownedExternalHosts(
  rows: readonly { post: { url: string } }[],
  tenant: { tenantId: string; brandName: string; ownedDomains: readonly string[] },
): string[] {
  const brands = [{ tenantId: tenant.tenantId, brand: tenant.brandName, ownedDomains: tenant.ownedDomains }]
  const hosts = new Set<string>()
  for (const { post } of rows) {
    if (ownedBrandsOf(post.url, brands).length === 0) continue
    hosts.add(new URL(post.url.trim()).hostname.toLowerCase().replace(/^www\./, ''))
  }
  return [...hosts]
}
