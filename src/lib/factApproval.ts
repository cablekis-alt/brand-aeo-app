import type { GapFactHit } from '../prompts/b5f-fact-for-gaps'
import { MEDICAL_INDUSTRY } from './answerEvidence'
import type { FactNode } from './api'

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
 * 숫자가 든 값(시술 횟수 · 경력 · 가격 등)을 모두 끈다 — 의료광고 규정이 수치 표현을 따로 본다.
 */
export function preChecked(hit: Pick<GapFactHit, 'type' | 'value'>, industry: string): boolean {
  if (hit.type === 'price' || hit.type === 'certification') return false
  if (MEDICAL_INDUSTRY.test(industry) && /\d/.test(hit.value)) return false
  return true
}

/** 승인한 값을 브랜드 사실에 합친다 — 같은 항목 · 값은 한 번만. id · 갱신 시각은 서버가 채운다. */
export function mergeApproved(current: FactNode[], approved: GapFactHit[]): FactNode[] {
  const seen = new Set(current.map((f) => `${f.claim}|${f.value}`))
  const added: FactNode[] = []
  for (const h of approved) {
    const key = `${h.claim}|${h.value}`
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ id: '', updatedAt: '', type: h.type, claim: h.claim, value: h.value, ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}) })
  }
  return [...current, ...added]
}
