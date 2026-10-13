/**
 * 경쟁사 편집 서랍의 작업 목록 규칙(src/lib/competitorEdit.ts)을 확인한다. 가짜 이름만 쓰고 서버·AI는 부르지 않는다.
 *
 * 왜: 줄마다 「되돌리기」는 그 작업 하나만 빼야 한다. 다른 바꾼 내용까지 지워지거나, 뺀 작업에 기대던 작업이
 * 남아 엉뚱한 목록이 저장되면 다음 측정의 경쟁사가 바뀐다.
 *
 *   npx tsx scripts/verify-competitor-edit.ts
 */
import { applyOps, baseItems, dropHint, pruneOps, revertOp, summarizeOps, toCompetitors, type EditOp } from '../src/lib/competitorEdit'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const c = (name: string) => ({ name, aliases: [name], domains: [] })
const base = baseItems(['가상 하나', '가상 둘', '가상 셋', '가상 넷', '가상 다섯', '가상 여섯'].map(c))
const names = (ops: EditOp[]) => toCompetitors(applyOps(base, ops).list).map((x) => x.name).join(',')

// 대기 줄(여섯)을 다섯 자리로 바꾸기 — 다섯은 빠지고 여섯이 그 자리로
{
  const ops: EditOp[] = [{ t: 'replace', key: 'b4', from: 'b5' }]
  const a = applyOps(base, ops)
  ok('대기 줄로 바꾸면 그 자리로 올라온다', names(ops) === '가상 하나,가상 둘,가상 셋,가상 넷,가상 여섯')
  ok('바뀐 줄은 빠진 줄로', a.removed.map((x) => x.key).join() === 'b4' && a.removedBy.get('b4') === 0)
  ok('올라온 줄은 그 작업이 둔 줄', a.placedBy.get('b5') === 0 && a.replaced.get('b5') === 'b4')
}

// 새 이름으로 바꾸기 · 빼기 · 측정에 넣기 · 추가
{
  const ops: EditOp[] = [
    { t: 'replace', key: 'b2', with: c('가상 새집'), source: 'typed' },
    { t: 'drop', key: 'b0' },
    { t: 'swap', a: 'b5', b: 'b1' },
    { t: 'add', with: c('가상 옛집'), source: 'past' },
  ]
  const a = applyOps(base, ops)
  ok('네 작업을 차례로 얹는다', names(ops) === '가상 여섯,가상 새집,가상 넷,가상 다섯,가상 둘,가상 옛집')
  ok('측정에 넣기로 내려간 줄', a.movedDown.has('b1') && a.placedBy.get('b5') === 2)
  ok('새로 들인 줄의 출처', a.list.find((x) => x.competitor.name === '가상 옛집')?.source === 'past')
  ok('요약 문구', summarizeOps(base, ops).join(' / ') === '바꿈 · 가상 셋 → 가상 새집 / 빼기 · 가상 하나 / 측정에 넣기 · 가상 여섯(가상 둘 대기로) / 다시 넣음 · 가상 옛집')

  // 하나만 되돌리기 — 빼기만 되돌리면 나머지는 그대로
  const r = revertOp(base, ops, 1)
  ok('빼기만 되돌린다', r.length === 3 && names(r) === '가상 하나,가상 여섯,가상 새집,가상 넷,가상 다섯,가상 둘,가상 옛집')
}

// 되돌린 작업에 기대던 작업은 같이 빠진다 — 새로 들인 곳을 측정에 넣은 뒤 들인 작업을 되돌리면
{
  const ops: EditOp[] = [
    { t: 'add', with: c('가상 새집'), source: 'typed' },
    { t: 'swap', a: 'n0', b: 'b0' },
  ]
  ok('추가 뒤 측정에 넣기', names(ops) === '가상 새집,가상 둘,가상 셋,가상 넷,가상 다섯,가상 여섯,가상 하나')
  const r = revertOp(base, ops, 0)
  ok('추가를 되돌리면 그 줄의 측정에 넣기도 빠진다', r.length === 0 && names(r) === '가상 하나,가상 둘,가상 셋,가상 넷,가상 다섯,가상 여섯')
}

// 성립하지 않는 작업
{
  ok('이미 있는 이름(띄어쓰기 무시)은 더하지 않는다', !applyOps(base, [{ t: 'add', with: c('가상하나'), source: 'typed' }]).valid[0])
  ok('없는 줄은 바꾸지 않는다', !applyOps(base, [{ t: 'replace', key: 'b9', with: c('가상 새집') }]).valid[0])
  const one = baseItems([c('가상 하나')])
  ok('마지막 한 곳은 뺄 수 없다', !applyOps(one, [{ t: 'drop', key: 'b0' }]).valid[0])
  ok('pruneOps가 깨진 작업을 뺀다', pruneOps(base, [{ t: 'drop', key: 'b0' }, { t: 'drop', key: 'b0' }]).length === 1)
}

ok('빼기 설명 — 대기 첫 줄이 올라온다', dropHint(['해오름펜션'], 5) === '대기 첫 줄 해오름펜션이 올라와요')
ok('빼기 설명 — 대기가 없으면', dropHint([], 4) === '4곳만 함께 측정해요')

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
