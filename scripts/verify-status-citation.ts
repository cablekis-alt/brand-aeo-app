/**
 * 발행 현황 「AI 인용」 칸(src/lib/statusCitation.ts)을 가짜 인용 이력 · 발행 현황 줄로 확인한다. 화면 · 서버 없이 돈다.
 *
 *   npx tsx scripts/verify-status-citation.ts
 */
import type { ExternalHistory, HistoryCell, HistoryWeek, PostHistory, PublishedHistory, PublishedPost } from '../src/lib/api'
import { publishStatusCsv, type PublishStatusRow } from '../src/lib/publishStatus'
import { summarizePost, TIER_LABEL } from '../src/lib/publishTracking'
import {
  CITATION_FILTER_OPTIONS,
  CITATION_LABEL,
  citationCellOf,
  citationFilterMatches,
  citationTargets,
  summarizeCitation,
  type CitationKind,
  type TenantCitationSource,
} from '../src/lib/statusCitation'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const week = (weekOf: string, changes: string[] = []): HistoryWeek =>
  ({ weekOf, analysed: true, window: null, engines: ['openai', 'gemini', 'perplexity'], bankVersion: 'v6', responses: { all: 90, unnamed: 60, named: 30, probe: 0, unknown: 0 }, changes }) as HistoryWeek
const WEEKS = [week('2026-W43'), week('2026-W44'), week('2026-W45'), week('2026-W46')]

const tally = (cited: number) => ({
  all: { cited, supporting: 0, mentioned: cited },
  unnamed: { cited: 0, supporting: 0, mentioned: 0 },
  named: { cited, supporting: 0, mentioned: cited },
  probe: { cited: 0, supporting: 0, mentioned: 0 },
  unknown: { cited: 0, supporting: 0, mentioned: 0 },
})
const cell = (timing: HistoryCell['timing'], cited: number, days = 20): HistoryCell =>
  ({ timing, afterRemoval: false, tally: cited > 0 ? tally(cited) : null, variantCited: 0, ...(timing === 'after' ? { daysAfterPublish: days } : {}) }) as HistoryCell

const post = (id: string, over: Partial<PublishedPost> = {}): PublishedPost =>
  ({
    id,
    url: `https://blog.example/${id}`,
    key: `blog.example/${id}`,
    publishedOn: '2026-10-21',
    publishedOnSource: 'user',
    recordedAt: '2026-10-21T01:00:00Z',
    articleId: `topic:${id}`,
    targetActionId: `topic:${id}`,
    via: 'gap-actions',
    ...over,
  }) as PublishedPost
const ph = (p: PublishedPost, cells: (HistoryCell | null)[]): PostHistory => ({ post: p, cells })

const row = (postId: string | null, over: Partial<PublishStatusRow> = {}): PublishStatusRow =>
  ({
    rowKey: `vstay|${postId}`,
    tenantId: 'vstay',
    brand: '가상 스테이',
    kind: 'posted',
    origin: 'app',
    postId,
    key: postId ? `blog.example/${postId}` : null,
    articleId: `topic:${postId}`,
    title: '가상 글',
    writer: null,
    writerUnknown: null,
    postedUnknown: false,
    platform: null,
    url: postId ? `https://blog.example/${postId}` : null,
    publishedOn: '2026-10-21',
    recheckFrom: '2026-10-21',
    trackedOn: null,
    removed: null,
    naver: null,
    google: null,
    checkFrom: null,
    ...over,
  }) as PublishStatusRow

// 앱 글 이력 — 글마다 한 가지 경우.
const appPosts: PostHistory[] = [
  ph(post('rep'), [cell('before', 0), cell('after', 9, 13), cell('after', 16, 20), cell('after', 2, 27)]), // 여러 주
  ph(post('once'), [null, cell('after', 0, 8), cell('after', 1, 15), cell('after', 0, 22)]), // 한 주(최근 없음)
  ph(post('none', { publishedOn: '2026-10-09' }), [cell('after', 0, 15), cell('after', 0, 22), cell('after', 0, 29), cell('after', 0, 36)]), // 인용 없음
  ph(post('fresh', { publishedOn: '2026-11-03' }), [cell('before', 0), cell('before', 0), cell('before', 0), cell('after', 0, 6)]), // 판단 전
  ph(post('wait', { publishedOn: '2026-11-11' }), [cell('before', 0), cell('before', 0), cell('before', 0), cell('before', 0)]), // 올린 뒤 측정 없음
  ph(post('undated', { publishedOn: null }), [cell('unknown', 0), cell('unknown', 0), null, null]), // 올린 날 모름
  ph(post('early', { publishedOn: '2026-10-28' }), [cell('before', 0), cell('before', 3), cell('after', 4, 14), cell('after', 2, 21)]), // 올리기 전 인용
]
const appHistory: PublishedHistory = { weeks: WEEKS, posts: appPosts }

// 앱 밖 글 이력 — 옮긴 줄(옮기기 전 판단할 측정 없음) · 그대로인 줄.
const extView = (id: string, movedOn: string | null) => ({ id, movedOn, appCountsFrom: movedOn, removedAt: movedOn ? `${movedOn}T03:00:00Z` : null })
const externalHistory = {
  weeks: WEEKS,
  posts: [
    {
      ...ph(post('x-moved', { publishedOn: '2026-11-08', removedAt: '2026-11-09T03:00:00Z', removedReason: 'taken-down' }), [cell('before', 0), cell('before', 0), cell('before', 0), null]),
      external: extView('x-moved', '2026-11-09'),
      blanked: [null, null, null, { repost: 0, moved: 1 }],
    },
    { ...ph(post('x-live', { publishedOn: '2026-10-20' }), [cell('after', 0, 14), cell('after', 2, 21), cell('after', 1, 28), cell('after', 0, 35)]), external: extView('x-live', null), blanked: [null, null, null, null] },
  ],
} as unknown as ExternalHistory

const ready: TenantCitationSource = { app: { state: 'ok', value: appHistory }, external: { state: 'ok', value: externalHistory } }
const of = (id: string, over: Partial<PublishStatusRow> = {}, source: TenantCitationSource | undefined = ready) => citationCellOf(row(id, over), source)

// ── 단계 — 퍼포먼스 「올린 글 인용 추적」과 같은 판단 ──
const rep = of('rep')
ok('여러 주 인용 — 칩 good · 「올린 뒤 측정 3주 중 3주 인용」', rep.kind === 'repeated' && rep.label === '여러 주 인용' && rep.tone === 'good' && rep.sub[0] === '올린 뒤 측정 3주 중 3주 인용')
ok('여러 주 인용 — CSV 「여러 주 인용 (3/3주)」', rep.csv === '여러 주 인용 (3/3주)')
const once = of('once')
ok('한 주 인용 — 판단 보류 · 칩 info · 최근 측정에는 인용 없음', once.kind === 'once' && once.tone === 'info' && once.label === '한 주 인용 · 판단 보류' && once.sub.includes('최근 측정에는 인용 없음'))
const none = of('none')
ok('인용 없음 — 칩 없음 · 「4주 중 0주」', none.kind === 'none' && none.tone === null && none.sub[0] === '올린 뒤 측정 4주 중 0주 인용')
const fresh = of('fresh')
ok('올린 지 14일 안 측정만 — 「색인 대기」가 아니라 「판단 전」(구글 색인 칸과 헷갈리지 않게)', fresh.kind === 'indexing' && fresh.label === '판단 전' && !fresh.label.includes('색인') && fresh.sub.some((s) => s.includes('14일')))
ok('올린 뒤 측정이 없으면 「올린 뒤 측정 없음」', of('wait').kind === 'waiting' && of('wait').label === '올린 뒤 측정 없음' && of('wait').csv === '올린 뒤 측정 없음')
ok('발행일을 모르면 「올린 날 모름」', of('undated').kind === 'undated')
ok('올리기 전 측정에서 이미 인용됐으면 발행일 확인 안내', of('early').sub.some((s) => s.includes('올리기 전 측정에서 이미 인용됨')))
// 퍼포먼스 표와 같은 판단인지 — 단계는 summarizePost 그대로(이름만 이 표에 맞게).
ok('단계는 퍼포먼스 표(summarizePost)와 같음', appPosts.every((p) => of(p.post.id).kind === summarizePost(p.cells, WEEKS).tier))
ok(
  '인용된 단계 이름은 퍼포먼스 표와 같은 말(여러 주 인용 · 한 주 인용 · 판단 보류 · 인용 없음)',
  (['repeated', 'once', 'none'] as const).every((t) => CITATION_LABEL[t] === TIER_LABEL[t]) && TIER_LABEL.indexing.includes('색인'),
)

// ── 확인 불가 · 읽는 중 — 0으로 채우지 않는다 ──
ok('이력을 읽는 중이면 「읽는 중」(CSV 빈칸)', of('rep', {}, { ...ready, app: { state: 'loading' } }).label === '읽는 중' && citationCellOf(row('rep'), undefined).kind === 'loading')
const err = of('rep', {}, { ...ready, app: { state: 'error', error: 'HTTP 500' } })
ok('이력을 못 읽으면 「확인 불가」와 까닭', err.kind === 'unknown' && err.label === '확인 불가' && err.sub[0]!.includes('HTTP 500'))
ok('이 환경에 이력이 없으면(웹) 「확인 불가」', of('rep', {}, { ...ready, app: { state: 'ok', value: null } }).label === '확인 불가')
ok('이력에 그 글이 없으면 「확인 불가」(인용 없음이 아님)', of('ghost').kind === 'unknown')

// ── 줄 종류 ──
ok('아직 안 올린 줄은 「-」', citationCellOf(row(null, { kind: 'unposted' }), ready).label === '-')
ok('잘못 적은 주소로 뺀 줄은 「-」', of('rep', { removed: { reason: 'mistake', at: '2026-11-01T00:00:00Z' } }).kind === 'na')
ok('앱 밖 글 줄은 앱 밖 글 이력으로 셈(앱 글 이력을 못 읽어도)', of('x-live', { origin: 'external' }, { ...ready, app: { state: 'error', error: 'x' } }).kind === 'repeated')
ok('앱 글 줄은 앱 밖 글 이력을 보지 않음', of('x-live').kind === 'unknown')
const moved = of('x-moved', { origin: 'external', removed: { reason: 'moved', at: '2026-11-09T03:00:00Z' } })
ok('앱 글로 옮긴 앱 밖 글 — 「앱 글 줄에서 셈」(두 번 세지 않음)', moved.kind === 'moved' && moved.label === '앱 글 줄에서 셈')

// ── 읽을 브랜드 ──
const targets = citationTargets([row('rep'), row('x-live', { origin: 'external' }), row(null, { kind: 'unposted', tenantId: 'other' }), row('a', { tenantId: 'other2' })])
ok(
  '읽을 브랜드 — 올린 줄이 있는 브랜드만, 앱 글 · 앱 밖 글 줄이 있는 쪽만',
  JSON.stringify(targets) === JSON.stringify([{ tenantId: 'vstay', app: true, external: true }, { tenantId: 'other2', app: true, external: false }]),
)

// ── 측정 조건이 바뀐 사이 ──
// 「rep」의 올린 뒤 첫 측정은 W44 — 그 뒤(W45)에 조건이 바뀌었다.
const mixedWeeks = [week('2026-W43'), week('2026-W44'), week('2026-W45', ['엔진']), week('2026-W46')]
const mixed = citationCellOf(row('rep'), { ...ready, app: { state: 'ok', value: { weeks: mixedWeeks, posts: appPosts } } })
ok('그사이 측정 조건이 바뀌었으면 알림(보정하지 않음)', mixed.sub.some((s) => s.includes('측정 조건')))

// ── CSV — 「다시 볼 날」 뒤 · 확인 방법 두 열 앞(앞 11열 · 끝 두 열 그대로) ──
const headOf = (csv: string) => (csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv).split('\r\n')[0]!.split(',')
const plain = headOf(publishStatusCsv([row('rep')], '2026-11-11', { checkMethods: true }))
const withCite = publishStatusCsv([row('rep')], '2026-11-11', { checkMethods: true, citation: (r) => citationCellOf(r, ready).csv })
ok(
  'CSV — 「AI 인용」은 「다시 볼 날」 바로 뒤, 확인 방법 두 열은 끝 그대로 · 주지 않으면 열 그대로',
  !plain.includes('AI 인용') &&
    headOf(withCite).join(',') === [...plain.slice(0, 11), 'AI 인용', ...plain.slice(11)].join(',') &&
    plain.slice(-2).join(',') === '네이버 확인 방법,구글 확인 방법' &&
    withCite.split('\r\n')[1]!.includes(',여러 주 인용 (3/3주),'),
)

// ── 거르기 — 표 위 「AI 인용」 선택 ──
const ALL_KINDS: CitationKind[] = ['na', 'loading', 'unknown', 'moved', 'repeated', 'once', 'none', 'indexing', 'waiting', 'undated', 'removed']
const matching = (f: Parameters<typeof citationFilterMatches>[0]) => ALL_KINDS.filter((k) => citationFilterMatches(f, k)).join(',')
ok(
  '거르기 — 인용됨은 여러 주 · 한 주, 아직 판단 전은 판단 전 · 올린 뒤 측정 없음 · 올린 날 모름, 나머지는 그 단계만, 전체는 모두',
  matching('cited') === 'repeated,once' &&
    matching('repeated') === 'repeated' &&
    matching('once') === 'once' &&
    matching('none') === 'none' &&
    matching('pending') === 'indexing,waiting,undated' &&
    matching('unknown') === 'unknown' &&
    matching('') === ALL_KINDS.join(','),
)
ok('거르기 — 읽는 중인 줄은 「확인 불가」에도 들지 않음(읽고 나서 제 단계로)', !CITATION_FILTER_OPTIONS.some((o) => o.value !== '' && citationFilterMatches(o.value, 'loading')))
ok(
  '거르기 선택지 — 전체가 먼저 · 값이 겹치지 않음 · 단계 이름은 칸과 같은 말',
  CITATION_FILTER_OPTIONS[0]!.value === '' &&
    new Set(CITATION_FILTER_OPTIONS.map((o) => o.value)).size === CITATION_FILTER_OPTIONS.length &&
    CITATION_FILTER_OPTIONS.find((o) => o.value === 'repeated')!.label === CITATION_LABEL.repeated &&
    CITATION_FILTER_OPTIONS.find((o) => o.value === 'none')!.label === CITATION_LABEL.none,
)

// ── 맨 위 요약 칸 — 살아 있는 올린 글을 서로 다른 주소로 ──
const sumOf = (rows: PublishStatusRow[], source: TenantCitationSource | undefined = ready) => summarizeCitation(rows, (r) => citationCellOf(r, source))
const s1 = sumOf([row('rep'), row('once'), row('none'), row('fresh'), row('wait'), row('ghost'), row(null, { kind: 'unposted' })])
ok(
  '요약 — 인용된 글 = 여러 주 + 한 주, 확인 불가는 따로(0으로 세지 않음), 안 올린 줄은 세지 않음',
  s1.posts === 6 && s1.cited === 2 && s1.repeated === 1 && s1.once === 1 && s1.unknown === 1 && !s1.loading,
)
const s2 = sumOf([row('rep'), row('once', { removed: { reason: 'taken-down', at: '2026-11-01T00:00:00Z' } }), row('none', { removed: { reason: 'mistake', at: '2026-11-01T00:00:00Z' } })])
ok('요약 — 내린 글 · 잘못 적은 주소로 뺀 줄은 세지 않음(올린 글 칸과 같은 범위)', s2.posts === 1 && s2.cited === 1)
// 범위 변형 두 브랜드에 같은 주소 — 한 브랜드에서라도 여러 주면 여러 주 한 편.
const twin = [row('once', { key: 'blog.example/same' }), row('rep', { key: 'blog.example/same', rowKey: 'vstay2|rep', tenantId: 'vstay2' })]
const s3 = sumOf(twin)
ok('요약 — 같은 주소의 두 줄은 한 편, 더 높은 단계(여러 주)로', s3.posts === 1 && s3.repeated === 1 && s3.once === 0 && s3.cited === 1)
ok(
  '요약 — 같은 주소에 인용된 줄이 있으면 다른 줄을 못 읽어도 확인 불가로 세지 않음',
  (() => {
    const s = sumOf([row('once', { key: 'blog.example/same' }), row('ghost', { key: 'blog.example/same', rowKey: 'vstay2|ghost' })])
    return s.posts === 1 && s.once === 1 && s.unknown === 0
  })(),
)
const s4 = sumOf([row('rep'), row('once')], { ...ready, app: { state: 'loading' } })
ok('요약 — 읽는 중인 줄이 있으면 loading(화면은 숫자 대신 「…」)', s4.loading && s4.cited === 0)
const s5 = sumOf([row('rep'), row('once')], { ...ready, app: { state: 'error', error: 'HTTP 500' } })
ok('요약 — 모두 못 읽으면 인용 0이 아니라 확인 불가 전부(화면은 「확인 불가」)', !s5.loading && s5.cited === 0 && s5.unknown === s5.posts && s5.posts === 2)
ok('요약 — 줄이 없으면 모두 0', JSON.stringify(sumOf([])) === JSON.stringify({ posts: 0, cited: 0, repeated: 0, once: 0, unknown: 0, loading: false }))

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
