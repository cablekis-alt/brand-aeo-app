import type { GapFactHit } from '../prompts/b5f-fact-for-gaps'
import { MEDICAL_INDUSTRY } from './answerEvidence'
import type { FactNode } from './api'
import { claimOf } from './draftGaps'

/**
 * 초안 쓰기 전 사실 채우기 — 브리프가 「확인 필요」로 남긴 사실을 브랜드 페이지에서 찾아(server/factForGaps.ts) 사람이 고른 값만
 * 브랜드 사실에 넣는다. 그러면 초안이 그 자리를 빈칸 대신 문장으로 쓴다(b9c — 팩트 그래프에 값이 있으면 doNotClaim도 문장으로).
 *
 * 실측: 설치본 초안 19편의 빈칸 79곳 중 값을 넣은 곳이 0곳이었다 — 초안을 다 쓴 뒤 빈칸마다 찾으러 가지 않는다. 그래서 초안
 * 앞에서 한 번에 찾는다. 값이 페이지에 글자 그대로 있어야 하는 가드와 사람 승인은 그대로 둔다.
 */

/** 한 번에 찾을 항목 수 상한 — 판정 프롬프트가 길어지면 찾는 정확도가 떨어진다. */
const MAX_NEEDS = 12

/** 브리프의 「확인 필요」 항목 → 브랜드 페이지에서 찾을 말. 앞의 「확인 필요:」를 걷고, 같은 말은 한 번만. */
export function needsFromBrief(doNotClaim: string[]): string[] {
  const out: string[] = []
  for (const raw of doNotClaim) {
    const need = raw.replace(/^\s*확인\s*필요\s*[:：]\s*/, '').replace(/\s+/g, ' ').trim()
    if (need && !out.includes(need)) out.push(need)
    if (out.length >= MAX_NEEDS) break
  }
  return out
}

/**
 * 승인 시트에서 처음부터 체크해 둘지. 가격 · 인증은 틀리면 바로 문제가 되는 값이라 하나씩 확인하게 끈다. 의료 업종은
 * 숫자가 든 값(시술 횟수 · 경력 · 가격 등)을 모두 끈다 — 의료광고 규정이 수치 표현을 따로 본다. 브랜드 사실의 값을 바꾸는 줄도 끈다.
 */
export function preChecked(hit: Pick<SheetHit, 'type' | 'value' | 'replaces'>, industry: string): boolean {
  // 이미 있는 값을 바꾸는 줄은 사람이 두 값을 보고 고른다.
  if (hit.replaces) return false
  if (hit.type === 'price' || hit.type === 'certification') return false
  if (MEDICAL_INDUSTRY.test(industry) && /\d/.test(hit.value)) return false
  return true
}

/** 승인 시트의 한 줄 — 같은 항목이 브랜드 사실에 다른 값으로 이미 있으면 그 사실(승인하면 덧붙이지 않고 값을 바꾼다). */
export interface SheetHit extends GapFactHit {
  replaces?: { id: string; value: string }
}

/** 항목 이름 비교용 — 띄어쓰기만 다른 이름은 같은 항목이다. */
const claimKey = (claim: string): string => claim.replace(/\s+/g, '')

/**
 * 브랜드 사실이 아직 답하지 않은 「확인 필요」만 남긴다. 빈칸에 직접 넣은 값은 claimOf(need)를 항목 이름으로 저장되므로,
 * 같은 이름의 사실이 있으면 다시 찾지 않는다 — 브리프는 다시 만들지 않아 「확인 필요」가 사실을 넣은 뒤에도 그대로 남는다.
 */
export function unansweredNeeds(needs: string[], graph: FactNode[]): string[] {
  const known = new Set(graph.map((f) => claimKey(f.claim)))
  return needs.filter((need) => !known.has(claimKey(claimOf(need))))
}

/**
 * 찾은 값을 지금 브랜드 사실과 맞춘다. 같은 항목(찾은 이름 또는 claimOf(need))에 같은 값이 있으면 빼고, 다른 값이 있으면
 * 그 값을 붙여 사람이 바꿀지 정하게 한다 — 덧붙이면 한 항목에 값이 둘이 되어 초안과 사실 검사가 둘 다 받는다.
 */
export function reconcileHits(hits: GapFactHit[], graph: FactNode[]): SheetHit[] {
  const out: SheetHit[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    const names = new Set([claimKey(h.claim), claimKey(claimOf(h.need))])
    const same = graph.filter((f) => names.has(claimKey(f.claim)))
    if (same.some((f) => f.value === h.value)) continue
    const key = `${claimKey(h.claim)}|${h.value}`
    if (seen.has(key)) continue
    seen.add(key)
    const old = same[0]
    out.push(old ? { ...h, replaces: { id: old.id, value: old.value } } : h)
  }
  return out
}

/**
 * 승인한 값을 브랜드 사실에 합친다 — 같은 항목 · 값은 한 번만, 바꾸기로 한 값은 그 사실 자리에서 바꾼다(항목 이름 · id는
 * 그대로). id · 갱신 시각은 서버가 채운다.
 */
export function mergeApproved(current: FactNode[], approved: SheetHit[]): FactNode[] {
  const next = [...current]
  const seen = new Set(current.map((f) => `${f.claim}|${f.value}`))
  for (const h of approved) {
    const at = h.replaces ? next.findIndex((f) => f.id === h.replaces?.id) : -1
    if (at >= 0) {
      const old = next[at]!
      // 출처는 새 값의 것으로 — 옛 값의 출처를 남기면 새 값의 근거처럼 보인다.
      next[at] = { id: old.id, type: old.type, claim: old.claim, value: h.value, updatedAt: '', ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}) }
      seen.add(`${old.claim}|${h.value}`)
      continue
    }
    const key = `${h.claim}|${h.value}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push({ id: '', updatedAt: '', type: h.type, claim: h.claim, value: h.value, ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}) })
  }
  return next
}
