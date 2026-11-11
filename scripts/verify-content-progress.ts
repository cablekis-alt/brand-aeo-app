/**
 * 콘텐츠 생성 「작성자 진행판」 숫자(src/lib/contentProgress.ts)를 가짜 배정 · 발행 현황 줄로 확인한다. 화면 · 서버 없이 돈다.
 *
 *   npx tsx scripts/verify-content-progress.ts
 */
import {
  cellText,
  contentProgress,
  nextGoogleCheck,
  nextStepText,
  postedArticleIds,
  showsArticle,
  stageTone,
} from '../src/lib/contentProgress'
import { AUTO_LATE_DAY, AUTO_TURN_DAY } from '../src/lib/indexAuto'
import type { WriterPlan, WriterPlanArticle } from '../src/lib/probePlan'
import { addDays, type PublishStatusRow } from '../src/lib/publishStatus'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const art = (n: number, key: string): WriterPlanArticle => {
  const questionIds = [`c1-${String(n).padStart(3, '0')}`, `c1-${String(n + 50).padStart(3, '0')}`]
  return {
    id: `topic:${questionIds.join('+')}`,
    name: `가상 주제 ${n}`,
    angle: '가상 각도',
    writer: { key, name: key === 'w1' ? '가나다' : '라마바' },
    blog: '',
    questionIds,
    questionTexts: questionIds.map((q) => `가상시 질문 ${q}?`),
  }
}
const A = [art(1, 'w1'), art(2, 'w1'), art(3, 'w1'), art(4, 'w2'), art(5, 'w2'), art(6, 'w2')]
const plan: WriterPlan = {
  format: 'probe-plan/2',
  tenantId: 'vstay',
  bankVersion: 'v6',
  activeUntil: '2027-03-31',
  source: { writers: 'fake.json', seed: 1 },
  articles: A,
} as WriterPlan

const row = (articleId: string, over: Partial<PublishStatusRow> = {}): PublishStatusRow =>
  ({
    rowKey: `vstay|${articleId}|${over.url ?? 'x'}`,
    tenantId: 'vstay',
    brand: '가상 스테이',
    kind: 'posted',
    origin: 'app',
    postId: 'p-1',
    key: 'blog.example/1',
    articleId,
    title: null,
    writer: null,
    writerUnknown: null,
    postedUnknown: false,
    platform: null,
    url: 'https://blog.example/1',
    publishedOn: '2026-11-09',
    recheckFrom: '2026-11-09',
    trackedOn: null,
    removed: null,
    naver: null,
    google: null,
    checkFrom: null,
    ...over,
  }) as PublishStatusRow

const shownCheck = { state: 'shown' as const, checkedOn: '2026-11-10', checkedAt: '2026-11-10T01:00:00Z', source: 'manual' as const }
const notYetAuto = { state: 'not-yet' as const, checkedOn: '2026-11-23', checkedAt: '2026-11-23T01:00:00Z', source: 'auto' as const }

const statusRows: PublishStatusRow[] = [
  row(A[0]!.id, { google: shownCheck }),
  row(A[1]!.id, { publishedOn: '2026-11-10', recheckFrom: '2026-11-10' }),
  // 뺀 줄은 올림에 세지 않는다.
  row(A[2]!.id, { removed: { reason: 'manual' as never, at: '2026-11-10T00:00:00Z' } }),
  row(A[3]!.id, { publishedOn: '2026-11-08', recheckFrom: '2026-11-08' }),
  // 아직 안 올린 배정 글 줄은 올림이 아니다.
  row(A[4]!.id, { kind: 'unposted', postId: null, key: null, url: null, publishedOn: null, recheckFrom: null }),
]

const base = {
  plan,
  drafted: new Set([A[0]!.id, A[1]!.id, A[2]!.id, A[3]!.id, A[4]!.id]),
  gapsLeft: { [A[0]!.id]: 0, [A[1]!.id]: 2, [A[2]!.id]: 0, [A[3]!.id]: 1, [A[4]!.id]: 0 },
  photos: { w1: { slots: 4, filled: 4, empty: 0 }, w2: { slots: 3, filled: 2, empty: 1 } },
  statusRows,
  today: '2026-11-11',
}

// ── 칸 색 ──
ok('칸 색 — 끝남 · 진행 중 · 안 함 · 대상 없음', stageTone(3, 3) === 'done' && stageTone(1, 3) === 'partial' && stageTone(0, 3) === 'none' && stageTone(0, 0) === 'na')

// ── 작성자 w1 ──
const p = contentProgress(base)
const w1 = p.writers.find((w) => w.key === 'w1')!
const w2 = p.writers.find((w) => w.key === 'w2')!
ok('작성자 순서 — 배정 순서(w1 · w2)', p.writers.map((w) => w.key).join(',') === 'w1,w2')
ok('w1 초안 3/3 끝남', w1.draft.done === 3 && w1.draft.total === 3 && w1.draft.tone === 'done')
ok('w1 빈칸 처리 — 빈칸 0인 글 2/3(진행 중) · 남은 빈칸 2', w1.gaps.done === 2 && w1.gaps.total === 3 && w1.gaps.tone === 'partial' && w1.gaps.left === 2)
ok('w1 사진 4/4 끝남', w1.photo.done === 4 && w1.photo.total === 4 && w1.photo.tone === 'done' && w1.photo.empty === 0)
ok('w1 올림 — 뺀 줄은 세지 않아 2/3', w1.posted.done === 2 && w1.posted.total === 3 && w1.posted.tone === 'partial')
ok('w1 구글 색인 — 올린 2편 중 색인됨 1', w1.indexed.done === 1 && w1.indexed.total === 2)
ok('w1 다음 구글 자동 확인 — 색인 안 된 글의 14일째(11-10 + 14 = 11-24)', w1.indexed.nextCheck === '2026-11-24' && w1.indexed.due === false)
ok('w1 다음 할 일 — 1편 올리기', w1.next.kind === 'post' && nextStepText(w1.next) === '1편 올리기')

// ── 작성자 w2 ──
ok('w2 초안 2/3 — 다음 할 일은 초안 1편 만들기(사진 · 올림보다 먼저)', w2.draft.done === 2 && w2.next.kind === 'draft' && nextStepText(w2.next) === '초안 1편 만들기')
ok('w2 올림 — 아직 안 올린 배정 글 줄은 올림이 아님(1/3)', w2.posted.done === 1 && w2.posted.total === 3)
ok('w2 사진 2/3 · 빈자리 1', w2.photo.done === 2 && w2.photo.total === 3 && w2.photo.empty === 1 && w2.photo.tone === 'partial')

// ── 다음 할 일 차례 ──
const allDrafted = { ...base, drafted: new Set(A.map((a) => a.id)), gapsLeft: { ...base.gapsLeft, [A[5]!.id]: 0 } }
const p2 = contentProgress(allDrafted)
ok('초안이 다 있으면 사진 빈자리가 먼저(w2 사진 빈자리 1곳)', p2.writers[1]!.next.kind === 'photo' && nextStepText(p2.writers[1]!.next) === '사진 빈자리 1곳')

// ── 발행 현황을 못 읽음 ──
const pn = contentProgress({ ...base, statusRows: null })
const n1 = pn.writers[0]!
ok('발행 현황 못 읽음 — 올림 · 색인은 0이 아니라 확인 불가', n1.posted.tone === 'na' && cellText(n1.posted) === '확인 불가' && n1.indexed.tone === 'na' && n1.indexed.nextCheck === null)
ok('발행 현황 못 읽음 — 초안 · 사진이 끝났으면 다음 할 일은 「올림 확인 불가」', n1.next.kind === 'unknown' && nextStepText(n1.next) === '올림 확인 불가')
ok('발행 현황 못 읽음 — 합계 올림도 확인 불가 · 남은 작성자 목록 비움', pn.totals.posted.tone === 'na' && pn.totals.postLeft.length === 0)

// ── 합계 ──
ok('합계 — 글 6 · 초안 5/6 · 사진 6/7 · 올림 3/6', p.totals.articles === 6 && p.totals.draft.done === 5 && p.totals.photo.done === 6 && p.totals.photo.total === 7 && p.totals.posted.done === 3 && p.totals.posted.total === 6)
ok('합계 — 안 올린 글이 남은 작성자(w1 1 · w2 2)', JSON.stringify(p.totals.postLeft) === JSON.stringify([{ key: 'w1', count: 1 }, { key: 'w2', count: 2 }]))
ok('합계 — 다음 구글 자동 확인은 가장 이른 날(w2 11-08 + 14 = 11-22)', p.totals.indexed.nextCheck === '2026-11-22')
ok('합계 — 그날이 오늘이거나 지났으면 due', contentProgress({ ...base, today: '2026-11-22' }).totals.indexed.due === true)

// ── 다음 구글 자동 확인 날 ──
ok('다음 확인 — 색인됨이면 없음', nextGoogleCheck(row('x', { google: shownCheck })) === null)
ok('다음 확인 — 확인 전이면 14일째', nextGoogleCheck(row('x', { recheckFrom: '2026-11-01' })) === '2026-11-15')
ok('다음 확인 — 자동 「아직」(14일째에 봄)이면 30일째', nextGoogleCheck(row('x', { recheckFrom: '2026-11-09', google: notYetAuto })) === '2026-12-09')
ok('다음 확인 — 30일째 넘어 이미 봤으면 없음', nextGoogleCheck(row('x', { recheckFrom: '2026-10-01', google: notYetAuto })) === null)
ok('다음 확인 — 올린 날 · 추적 시작일을 모르면 없음', nextGoogleCheck(row('x', { recheckFrom: null, publishedOn: null })) === null)
// 진행판은 실행 계획 화면이 불러오므로 indexAuto · publishStatus를 런타임에 불러오지 않고 날짜 규칙을 따로 둔다 — 둘이 어긋나지 않는지 본다.
ok(
  '다음 확인 — 14일째 · 30일째가 indexAuto.ts(AUTO_TURN_DAY · AUTO_LATE_DAY) · publishStatus.ts addDays와 같음',
  ['2026-01-31', '2026-02-20', '2026-12-25'].every(
    (d) =>
      nextGoogleCheck(row('x', { recheckFrom: d })) === addDays(d, AUTO_TURN_DAY) &&
      nextGoogleCheck(row('x', { recheckFrom: d, google: { ...notYetAuto, checkedOn: addDays(d, AUTO_TURN_DAY) } })) === addDays(d, AUTO_LATE_DAY),
  ),
)

// ── 거르기 ──
const posted = postedArticleIds(statusRows)!
const writerOf = (id: string) => plan.articles.find((a) => a.id === id)?.writer.key ?? null
ok('올린 글 id — 뺀 줄 · 안 올린 줄은 빼고 3편', posted.size === 3 && posted.has(A[0]!.id) && !posted.has(A[2]!.id) && !posted.has(A[4]!.id))
ok('올린 글 id — 줄을 못 읽었으면 null', postedArticleIds(null) === null)
ok('거르기 — 할 일만이면 안 올린 글만', showsArticle(A[2]!.id, writerOf, { writer: null, mode: 'todo' }, posted) && !showsArticle(A[0]!.id, writerOf, { writer: null, mode: 'todo' }, posted))
ok('거르기 — 전체면 올린 글도', showsArticle(A[0]!.id, writerOf, { writer: null, mode: 'all' }, posted))
ok('거르기 — 작성자를 고르면 그 작성자 글만', !showsArticle(A[3]!.id, writerOf, { writer: 'w1', mode: 'all' }, posted) && showsArticle(A[1]!.id, writerOf, { writer: 'w1', mode: 'all' }, posted))
ok('거르기 — 발행 현황을 못 읽었으면 할 일만에서도 모두 보임(숨기지 않음)', showsArticle(A[0]!.id, writerOf, { writer: null, mode: 'todo' }, null))
ok('칸 글자 — 대상이 없으면 「-」', cellText({ done: 0, total: 0, tone: 'na' }) === '-')

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
