/**
 * 경쟁사 편집 서랍의 바꾼 내용 — 작업 목록(ops)을 지금 목록 위에 차례로 얹는다(상용화 UI 11차).
 *
 * 바꾼 결과를 통째로 들고 있지 않고 작업 목록으로 드는 이유: 줄마다 「되돌리기」가 그 작업 하나만 빼야 한다.
 * 작업 하나를 빼면 그 작업이 들인 줄을 쓰던 뒤 작업도 성립하지 않을 수 있다 — 그런 작업은 같이 빠진다(prune).
 *
 * 새로 들인 줄의 key는 작업마다 고정된 id에서 만든다(`n${id}`). 작업 번호로 만들면 앞 작업을 되돌릴 때 번호가
 * 당겨져, 뒤 작업이 가리키던 줄이 다른 줄로 바뀐다(고르지 않은 곳이 측정 칸에 올라갔다).
 *
 * 몇 곳을 함께 재고 몇 곳이 대기인지는 여기서 세지 않는다. 서버가 측정과 같은 함수로 계산한다
 * (POST /api/tenants/:id/competitors/plan → server/cohortPlan.ts).
 */
import type { ExclusionPreview, HandoffHint, RankLite } from './api'
import { subjectParticle } from './korean'

export interface CompetitorInput {
  name: string
  aliases: string[]
  domains: string[]
}

/** 새로 들인 곳이 어디서 왔는가 — 줄의 칩(「다시 넣음」·「새로」)과 요약 문구가 다르다. */
export type InputSource = 'past' | 'cohort' | 'answers' | 'typed'

export type EditOp = { id: string } & (
  /** key 줄을 다른 곳으로 바꾼다. from이 있으면 목록에 이미 있던 그 줄(대기 중)을 그 자리로 올린다. */
  | { t: 'replace'; key: string; from?: string; with?: CompetitorInput; source?: InputSource }
  /** key 줄을 바꾸지 않고 뺀다. */
  | { t: 'drop'; key: string }
  /** 대기 줄 a를 측정 줄 b와 자리 바꾼다(「측정에 넣기」). */
  | { t: 'swap'; a: string; b: string }
  /** 맨 뒤에 더한다. */
  | { t: 'add'; with: CompetitorInput; source: InputSource }
  /** key 줄의 홈페이지만 바꾼다(이름·자리는 그대로). 서버가 주소를 정리한다(주소 전체 → 도메인). */
  | { t: 'homepage'; key: string; domains: string[] }
)

/** 새로 들인 줄의 key — 작업 id에서 만든다(번호가 아니라). */
export const newKey = (op: { id: string }) => `n${op.id}`

export interface EditItem {
  key: string
  competitor: CompetitorInput
  /** 이번 편집에서 새로 들인 곳이면 어디서 왔는지. 원래 목록의 줄이면 없다. */
  source?: InputSource
}

export interface AppliedEdit {
  /** 바꾼 뒤 목록(측정 순서). */
  list: EditItem[]
  /** 이번 편집에서 빠진 원래 줄. */
  removed: EditItem[]
  /** 줄 key → 그 줄을 지금 자리에 둔 작업 번호(되돌리기 대상). */
  placedBy: Map<string, number>
  /** 빠진 줄 key → 그 줄을 뺀 작업 번호. */
  removedBy: Map<string, number>
  /** 바꿈으로 들어온 줄 key → 바뀐 원래 줄 key. */
  replaced: Map<string, string>
  /** 자리 바꾸기로 대기로 내려간 줄. */
  movedDown: Set<string>
  /**
   * 줄 key → 그 줄이 지금 차지한 원래 줄의 자리(원래 줄 key). 바꿈은 바뀐 줄의 자리를, 자리 바꾸기는 상대의 자리를 넘겨받는다.
   * 질문 넘겨받기 힌트가 이 값으로 「누가 누구 자리에 들었나」를 보낸다(handoffHints).
   */
  slotOf: Map<string, string>
  /** 홈페이지만 바꾼 줄 key → 바꾸기 전 주소. */
  rehomed: Map<string, string[]>
  /** 작업마다 성립했는지. */
  valid: boolean[]
}

export function baseItems(competitors: CompetitorInput[]): EditItem[] {
  return competitors.map((competitor, i) => ({ key: `b${i}`, competitor }))
}

const squash = (s: string) => s.replace(/\s+/g, '')

export function applyOps(base: EditItem[], ops: EditOp[]): AppliedEdit {
  const list = base.slice()
  const removed: EditItem[] = []
  const placedBy = new Map<string, number>()
  const removedBy = new Map<string, number>()
  const replaced = new Map<string, string>()
  const movedDown = new Set<string>()
  const slotOf = new Map(base.map((x) => [x.key, x.key]))
  // 자리를 넘긴다 — to가 from의 자리를 차지한다(from의 자리가 없으면 to도 자리가 없다).
  const takeSlot = (to: string, from: string) => {
    const slot = slotOf.get(from)
    if (slot) slotOf.set(to, slot)
    else slotOf.delete(to)
  }
  const rehomed = new Map<string, string[]>()
  const valid: boolean[] = []
  const at = (key: string) => list.findIndex((x) => x.key === key)
  const nameTaken = (name: string) => list.some((x) => squash(x.competitor.name) === squash(name))

  ops.forEach((op, i) => {
    let okOp = false
    if (op.t === 'replace') {
      const pos = at(op.key)
      if (pos >= 0) {
        if (op.from) {
          const from = at(op.from)
          if (from >= 0 && from !== pos) {
            const [moved] = list.splice(from, 1)
            const target = at(op.key)
            const [out] = list.splice(target, 1, moved!)
            removed.push(out!)
            removedBy.set(out!.key, i)
            placedBy.set(moved!.key, i)
            replaced.set(moved!.key, out!.key)
            takeSlot(moved!.key, out!.key)
            slotOf.delete(out!.key)
            okOp = true
          }
        } else if (op.with && !nameTaken(op.with.name)) {
          const item: EditItem = { key: newKey(op), competitor: op.with, source: op.source ?? 'typed' }
          const [out] = list.splice(pos, 1, item)
          removed.push(out!)
          removedBy.set(out!.key, i)
          placedBy.set(item.key, i)
          replaced.set(item.key, out!.key)
          takeSlot(item.key, out!.key)
          slotOf.delete(out!.key)
          okOp = true
        }
      }
    } else if (op.t === 'drop') {
      const pos = at(op.key)
      // 마지막 한 곳은 뺄 수 없다 — 모두 빼면 측정할 때마다 AI가 경쟁사를 새로 고른다(서버도 거절한다).
      if (pos >= 0 && list.length > 1) {
        const [out] = list.splice(pos, 1)
        removed.push(out!)
        removedBy.set(out!.key, i)
        slotOf.delete(out!.key)
        okOp = true
      }
    } else if (op.t === 'swap') {
      const a = at(op.a)
      const b = at(op.b)
      if (a >= 0 && b >= 0 && a !== b) {
        ;[list[a], list[b]] = [list[b]!, list[a]!]
        placedBy.set(op.a, i)
        movedDown.add(op.b)
        const slotA = slotOf.get(op.a)
        takeSlot(op.a, op.b)
        if (slotA) slotOf.set(op.b, slotA)
        else slotOf.delete(op.b)
        okOp = true
      }
    } else if (op.t === 'add') {
      if (!nameTaken(op.with.name)) {
        const item: EditItem = { key: newKey(op), competitor: op.with, source: op.source }
        list.push(item)
        placedBy.set(item.key, i)
        okOp = true
      }
    } else if (op.t === 'homepage') {
      const pos = at(op.key)
      const cur = pos >= 0 ? list[pos]! : null
      // 지금 주소와 같으면 바꾼 것이 없다.
      if (cur && hostsOf(cur.competitor.domains).join() !== hostsOf(op.domains).join()) {
        if (!rehomed.has(op.key)) rehomed.set(op.key, cur.competitor.domains)
        list[pos] = { ...cur, competitor: { ...cur.competitor, domains: op.domains } }
        placedBy.set(op.key, i)
        okOp = true
      }
    }
    valid.push(okOp)
  })
  return { list, removed, placedBy, removedBy, replaced, movedDown, slotOf, rehomed, valid }
}

/** 화면에 보일 주소 — 'https://www.x.com/a' → 'x.com'. 저장할 때는 서버가 같은 규칙으로 정리한다. */
export function displayHost(raw: string): string {
  return raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/^www\./i, '').toLowerCase()
}

function hostsOf(domains: string[]): string[] {
  return domains.map(displayHost).filter(Boolean)
}

/** 성립하지 않는 작업을 뺀다. 한 번 빼면 뒤 작업이 또 깨질 수 있어 더 줄지 않을 때까지 반복한다. */
export function pruneOps(base: EditItem[], ops: EditOp[]): EditOp[] {
  let cur = ops
  for (;;) {
    const { valid } = applyOps(base, cur)
    const next = cur.filter((_, i) => valid[i])
    if (next.length === cur.length) return cur
    cur = next
  }
}

/** 작업 하나만 되돌린다. 그 작업에 기대던 뒤 작업도 함께 빠진다. */
export function revertOp(base: EditItem[], ops: EditOp[], index: number): EditOp[] {
  return pruneOps(
    base,
    ops.filter((_, i) => i !== index),
  )
}

/** 바꾼 내용 요약 — 저장 막대와 저장 기록(브랜드 현황 칩)에 쓴다. 성립하지 않는 작업은 말하지 않는다. */
export function summarizeOps(base: EditItem[], ops: EditOp[]): string[] {
  const { valid } = applyOps(base, ops)
  const names = new Map(base.map((x) => [x.key, x.competitor.name]))
  const lines: string[] = []
  ops.forEach((op) => {
    if (op.t === 'add') names.set(newKey(op), op.with.name)
    if (op.t === 'replace' && op.with) names.set(newKey(op), op.with.name)
  })
  const name = (key: string) => names.get(key) ?? key
  ops.forEach((op, i) => {
    if (!valid[i]) return
    if (op.t === 'replace') lines.push(`바꿈 · ${name(op.key)} → ${op.from ? name(op.from) : name(newKey(op))}`)
    else if (op.t === 'drop') lines.push(`빼기 · ${name(op.key)}`)
    else if (op.t === 'swap') lines.push(`측정에 넣기 · ${name(op.a)}(${name(op.b)} 대기로)`)
    else if (op.t === 'homepage') {
      const before = base.find((x) => x.key === op.key)?.competitor.domains ?? []
      lines.push(`주소 바꿈 · ${name(op.key)} (${hostsOf(before).join(', ') || '없음'} → ${hostsOf(op.domains).join(', ') || '없음'})`)
    } else lines.push(`${op.source === 'past' ? '다시 넣음' : '추가'} · ${op.with.name}`)
  })
  return lines
}

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

/** 「W36~W42」 — 한 주면 「W42」. */
export function weekRange(first: string, until: string): string {
  return first === until ? shortWeek(until) : `${shortWeek(first)}~${shortWeek(until)}`
}

/** 「3위 / 6」(동점이면 「 (동점 2)」). */
export function rankText(r: RankLite): string {
  return `${r.position}위 / ${r.totalTenants}${r.tiedCount > 1 ? ` (동점 ${r.tiedCount})` : ''}`
}

/** 지난 기록 바꾸기 요약 — 저장 막대 · 저장 기록에 쓴다. 서버 미리보기 값으로만 만든다. */
export function summarizePastOut(preview: ExclusionPreview | null): string[] {
  return (preview?.items ?? []).map(
    (it) => `${it.action === 'exclude' ? '지난 기록에서 빼기' : '다시 세기'} · ${it.brandName} ${weekRange(it.fromWeek ?? it.firstWeek, it.untilWeek)}`,
  )
}

/** 저장할 목록. */
export function toCompetitors(list: EditItem[]): CompetitorInput[] {
  return list.map((x) => x.competitor)
}

/**
 * 질문 넘겨받기 힌트 — 누가 누구 자리에 들었나(이름). 서버는 바꾼 목록만 받아서 이 힌트가 없으면 받는 곳을 목록 순서로 짐작한다
 * (여러 작업을 섞으면 뒤바뀐다). 원래 줄마다 그 자리를 지금 차지한 줄을 하나 보낸다(slotOf) — 바꾼 줄을 다시 바꾸거나, 바꿔
 * 넣은 줄을 다시 자리 바꾸기로 내려도 원래 줄에서 지금 주인까지 바로 잇는다. 자기 자리에 있는 줄은 보내지 않는다.
 */
export function handoffHints(base: EditItem[], applied: Pick<AppliedEdit, 'list' | 'slotOf'>): HandoffHint[] {
  const names = new Map(base.map((x) => [x.key, x.competitor.name]))
  const hints: HandoffHint[] = []
  for (const item of applied.list) {
    const slot = applied.slotOf.get(item.key)
    const from = slot && slot !== item.key ? names.get(slot) : undefined
    if (from && from !== item.competitor.name) hints.push({ from, to: item.competitor.name })
  }
  return hints
}

/** 「바꾸지 않고 빼기」의 설명 — 대기 첫 줄이 올라오는지. */
export function dropHint(waitingNames: string[], measuredAfter: number): string {
  return waitingNames.length ? `대기 첫 줄 ${subjectParticle(waitingNames[0]!)} 올라와요` : `${measuredAfter}곳만 함께 측정해요`
}
