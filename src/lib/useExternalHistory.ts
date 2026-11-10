import { useEffect, useState } from 'react'
import type { MovedPosting, RepostPosting } from '../components/PublishedHistoryTable'
import { loadExternalHistory, type ExternalHistory, type ExternalHistoryRow, type PublishedPost } from './api'
import { repostBasis } from './externalPosts'
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
 * 행 → 다시 올린 행(성과 표 repostOf). 같은 브랜드에서 같은 주소를 앞서 「글을 내림」으로 뺀 줄이 있는 행에만, 그 내린 날을 준다 — 서버가 칸을 비운
 * 것과 같은 함수(src/lib/externalPosts.ts repostBasis). 이력의 행에는 「잘못 적음」 줄만 빠지고 내린 줄은 모두 있어(그 함수는 내린 줄만 본다) 서버와
 * 같은 날이 나온다. 어느 칸을 「다시 올리기 전」으로 볼지는 서버가 비운 까닭(externalBlankedOf)으로 정한다.
 */
export function externalRepostOf(history: ExternalHistory): (post: PublishedPost) => RepostPosting | null {
  const rows = history.posts.map((p) => p.external)
  const reposts = new Map<string, RepostPosting>()
  for (const { post, external } of history.posts) {
    const basis = repostBasis(rows, external)
    if (basis) reposts.set(post.id, { downOn: basis.downOn })
  }
  return (post) => reposts.get(post.id) ?? null
}

/**
 * 행 → 서버가 비운 회차(성과 표 blankedOf — 주마다 까닭별 회차 수, server/externalPosts.ts getExternalHistory). 화면은 비운 칸의 이름 · 까닭을
 * 이 값으로만 고른다 — 주 카드 회차의 측정 기간으로 짐작하면 회차마다 까닭이 다른 주나, 날짜를 적은 다시 올린 줄을 앱 글로 옮긴 칸에서 서버와 다른
 * 까닭을 단다.
 */
export function externalBlankedOf(history: ExternalHistory): (post: PublishedPost) => ExternalHistoryRow['blanked'] | null {
  const byId = new Map(history.posts.map((p) => [p.post.id, p.blanked]))
  return (post) => byId.get(post.id) ?? null
}

const monthDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
/** 날짜 모름 칸 도움말(앱 밖 글 표) — 앱 글 표의 「옛 기록」과 달리 날짜를 적을 수 있는 글이다(발행 현황 「관리」). */
const EXTERNAL_UNDATED_NOTE = '올린 날을 모르는 앱 밖 글입니다 — 발행 현황 「관리」에서 날짜를 적으면 올리기 전 · 뒤를 가립니다'
/** 앱 글로 옮긴 줄 — 「관리」에 날짜 칸이 없다(쉬는 줄). */
const EXTERNAL_UNDATED_MOVED_NOTE = '올린 날을 모르는 앱 밖 글입니다 — 판단에는 넣지 않습니다'

/**
 * 행 → 날짜 모름 칸 도움말(성과 표 undatedNote). 날짜를 적을 수 있는 줄에만 발행 현황 「관리」를 안내한다 — 앱 글로 옮긴 줄은 「관리」에 날짜 칸이
 * 없고, 다시 올린 줄은 올린 날이 앞 줄을 내린 날 뒤(repostDayProblem)이면서 추적을 시작한 날까지(trackedDayProblem)여야 해 내린 날(또는 그 전)에
 * 다시 적은 줄은 고를 날이 없다(발행 현황 「관리」 날짜 칸과 같은 범위 — 내린 날은 서버와 같은 repostBasis).
 */
export function externalUndatedNote(history: ExternalHistory): (post: PublishedPost) => string {
  const rows = history.posts.map((p) => p.external)
  const notes = new Map<string, string>()
  for (const { post, external } of history.posts) {
    if (external.state === 'moved') {
      notes.set(post.id, EXTERNAL_UNDATED_MOVED_NOTE)
      continue
    }
    const downOn = repostBasis(rows, external)?.downOn ?? null
    const trackedOn = kstDate(external.trackedAt)
    if (downOn && trackedOn && trackedOn <= downOn) {
      notes.set(
        post.id,
        `올린 날을 모르는 앱 밖 글입니다 — 앞 글을 내린 날(${monthDay(downOn)}) 뒤이면서 추적을 시작한 날(${monthDay(trackedOn)})까지인 날이 없어 날짜를 적을 수 없습니다(판단에는 넣지 않습니다)`,
      )
    }
  }
  return (post) => notes.get(post.id) ?? EXTERNAL_UNDATED_NOTE
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
