/**
 * 발행 현황(src/lib/publishStatus.ts · server/publishStatus.ts · server/indexChecks.ts, 2026-11-09)을 확인한다 — 고객 브랜드 전체의 올린 글
 * 한 줄 = 한 편(같은 주소 · 같은 올린 날), 작성자 배정 붙이기, 아직 안 올린 배정 글, 플랫폼, 다시 볼 날(3 · 7 · 14일), CSV(BOM · 따옴표 ·
 * 수식 막기), 검색 주소, 색인 확인 저장(PUT 검사 · 표시 · 지우기 · 동시 저장). 임시 데이터 폴더 · 모의 엔진으로 서버(server/index.ts)를
 * 포트 4171에 띄워 HTTP로 부른다. 바깥 사이트 · AI는 부르지 않는다. 작성자 이름 · 브랜드 · 주소는 모두 가짜다.
 *
 * 왜:
 * - 작성자 8명이 브랜드마다 10편씩 올린다. 누가 몇 편을 올렸는지 · 어느 글이 네이버 · 구글에 나오는지를 브랜드마다 화면을 옮겨 다니며 볼 수 없다.
 * - 확인하지 않은 상태를 「아직」으로 채우면 안 된다 — 모르면 「미확인」이다.
 * - 확인 기록은 원장(published-posts.json)과 따로 둔다 — 원장 모양은 바꾸지 않는다. 같은 쓰기 줄에 서야 윈도우에서 rename이 막히지 않고,
 *   동시에 눌러도 기록이 사라지지 않는다.
 * - 한 브랜드의 파일이 깨져도 다른 브랜드는 보여야 한다. 깨진 확인 파일 위로 쓰면 기록이 통째로 사라진다.
 * - 엑셀로 열면 한글이 깨지지 않아야 하고, 「=」로 시작하는 제목이 수식으로 돌지 않아야 한다.
 *
 *   npx tsx scripts/verify-publish-status.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseWriterPlan } from '../src/lib/probePlan'
import { todayKst, trackingKey } from '../src/lib/publishedUrl'
import {
  addDays,
  applyIndexCheck,
  buildTenantStatus,
  csvCell,
  emptyStateOf,
  filterRows,
  findIndexRecord,
  googleSearchUrl,
  INDEX_CHECKS_FORMAT,
  markLabel,
  naverSearchUrl,
  orderRows,
  parseIndexCheckInput,
  parseIndexChecksFile,
  platformOf,
  postingsOf,
  publishStatusCsv,
  publishStatusFileName,
  recheckOf,
  rowRecheck,
  sameUrlBrands,
  searchLabel,
  summarizeStatus,
  toggleWriterChip,
  unpostedLabel,
  validFilter,
  withIndexRecord,
  writerLabel,
  type IndexCheck,
  type IndexCheckRecord,
  type LedgerPostLike,
  type PublishStatus,
  type PublishStatusRow,
  type StatusFilter,
} from '../src/lib/publishStatus'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// ── 가짜 배정 · 원장 ───────────────────────────────────────────────────────────
const Q: Record<string, string> = {
  'c1-001': '가상시 숙소 질문 1번은 어때?',
  'c1-002': '가상시 숙소 질문 2번은 어때?',
  'c1-003': '가상시 숙소 질문 3번은 어때?',
  'c1-004': '가상시 숙소 질문 4번은 어때?',
}
const W1 = { key: 'w1', name: '김가상' }
const W2 = { key: 'w2', name: '이가상' }
const planArticle = (writer: { key: string; name: string }, ids: string[], name: string) => ({
  id: `topic:${[...ids].sort().join('+')}`,
  name,
  angle: '처음 가는 사람의 눈으로',
  writer,
  blog: '',
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => Q[id]!),
})
const planOf = (tenantId: string) => ({
  format: 'probe-plan/2',
  tenantId,
  bankVersion: 'v1',
  activeUntil: '2027-03-31',
  source: { writers: 'docs/writers.json', seed: 1 },
  articles: [
    planArticle(W1, ['c1-001', 'c1-002'], '가상시 숙소 고르는 법'),
    planArticle(W1, ['c1-003', 'c1-004'], '가상시 조용한 숙소'),
    planArticle(W2, ['c1-001', 'c1-003'], '가상시 가족 여행 숙소'),
    planArticle(W2, ['c1-002', 'c1-004'], '가상시 바다 보이는 숙소'),
  ],
})
const parsedPlan = parseWriterPlan(planOf('vpub-a'))
ok('가짜 배정 파일은 앱의 검사를 통과한다(시험 준비)', parsedPlan.plan !== undefined)
const plan = parsedPlan.plan!
const A1 = plan.articles[0]!.id
const A3 = plan.articles[2]!.id

const post = (id: string, url: string, over: Partial<LedgerPostLike> & Record<string, unknown> = {}): LedgerPostLike & Record<string, unknown> => ({
  id,
  url,
  key: trackingKey(url) ?? url,
  publishedOn: '2026-10-20',
  publishedOnSource: 'user',
  recordedAt: '2026-10-20T03:00:00.000Z',
  articleId: 'content:category-agnostic',
  targetActionId: 'content:category-agnostic',
  via: 'own',
  ...over,
})
/** topic: 글의 질문 스냅샷 — 원장이 글을 올릴 때 남기는 그 판(bankVersion). 판을 모르면 null. */
const topicOf = (articleId: string, bankVersion: string | null = 'v1') => {
  const ids = articleId.slice('topic:'.length).split('+')
  return { bankVersion, questionIds: ids, questionTexts: bankVersion ? ids.map((id) => Q[id]!) : [] }
}
const NAVER = 'https://blog.naver.com/fakeid/224000000001'
const TISTORY = 'https://fake.tistory.com/12'
const OWN = 'https://stay.example/blog/1'
const DOWN = 'https://fake.tistory.com/50'
const ledgerA = [
  post('p-aaaaaaaaaaa1', NAVER, { articleId: A1, topic: topicOf(A1), targetActionId: 'listing:platform:blog.naver.com', via: 'channel', articleTitle: '가상시 숙소, 처음이라면 이렇게 고르세요' }),
  post('p-aaaaaaaaaaa2', TISTORY, { articleId: A1, topic: topicOf(A1), targetActionId: 'listing:platform:tistory.com', via: 'channel', articleTitle: '가상시 숙소, 처음이라면 이렇게 고르세요' }),
  post('p-aaaaaaaaaaa3', OWN, { articleTitle: '가상스테이 이용 안내', publishedOn: '2026-10-25', recordedAt: '2026-10-25T01:00:00.000Z' }),
  post('p-aaaaaaaaaaa4', OWN, { articleTitle: '가상스테이 이용 안내', publishedOn: '2026-10-25', recordedAt: '2026-10-25T02:00:00.000Z', via: 'channel', targetActionId: 'listing:platform:stay.example' }),
  post('p-aaaaaaaaaaa5', DOWN, { articleId: A3, topic: topicOf(A3), articleTitle: '가상시 가족 여행 숙소 이야기', removedAt: '2026-10-28T00:00:00.000Z', removedReason: 'taken-down' }),
  ...Array.from({ length: 8 }, (_, i) =>
    post(`p-bbbbbbbbbb${String(i).padStart(2, '0')}`, `https://fake.tistory.com/${100 + i}`, { articleTitle: `가상 글 ${i}`, articleId: `content:extra-${i}`, targetActionId: `content:extra-${i}` }),
  ),
]

// ── 1) 플랫폼 ───────────────────────────────────────────────────────────────
const owned = ['stay.example']
const label = (u: string) => platformOf(u, owned)?.label ?? null
ok(
  '플랫폼 — 네이버 블로그 · 티스토리 · 브런치 · 벨로그 · 미디엄 · 인스타그램 · 유튜브 · 블로거',
  label(NAVER) === '네이버 블로그' && label('https://m.blog.naver.com/fakeid/1') === '네이버 블로그' && label(TISTORY) === '티스토리' &&
    label('https://brunch.co.kr/@fake/3') === '브런치' && label('https://velog.io/@fake/post') === '벨로그' && label('https://medium.com/@fake/x-1') === '미디엄' &&
    label('https://fake.medium.com/x-1') === '미디엄' && label('https://www.instagram.com/p/AbC/') === '인스타그램' && label('https://youtu.be/AbC') === '유튜브' &&
    label('https://www.youtube.com/watch?v=AbC') === '유튜브' && label('https://fake.blogspot.com/2026/10/x.html') === '블로거',
)
ok(
  '플랫폼 — 자사 사이트(하위 도메인 포함) · 그 밖은 호스트(www 뗌) · 주소가 아니면 null',
  label(OWN) === '자사 사이트' && platformOf('https://news.stay.example/1', owned)?.key === 'owned' && label('https://www.news.example.com/a/1') === 'news.example.com' &&
    platformOf('https://www.news.example.com/a/1', owned)?.key === 'other' && platformOf('아무 글자', owned) === null && platformOf('ftp://x.example/1', owned) === null,
)
ok('플랫폼 — 알려진 플랫폼이 자사 주소 목록에 있어도 플랫폼 이름(네이버에서 블로그 검색으로 본다)', platformOf(NAVER, ['blog.naver.com'])?.key === 'naver-blog')

// ── 2) 한 편으로 묶기 ───────────────────────────────────────────────────────
const postings = postingsOf(ledgerA)
const ownPosting = postings.find((p) => p.post.key === trackingKey(OWN))
ok('같은 주소 · 같은 올린 날의 여러 줄(자사 · 채널)은 한 편 — 먼저 적은 줄이 대표, 줄 id를 모두 가진다', postings.length === 12 && ownPosting?.post.id === 'p-aaaaaaaaaaa3' && ownPosting.ids.length === 2 && ownPosting.removed === null)
ok('내린 글은 내린 표시(이유 · 때)를 단다', postings.find((p) => p.post.id === 'p-aaaaaaaaaaa5')?.removed?.reason === 'taken-down')
const mixed = postingsOf([
  post('p-m1', 'https://x.example/1', { removedAt: '2026-10-21T00:00:00.000Z', removedReason: 'mistake' }),
  post('p-t1', 'https://x.example/2', { removedAt: '2026-10-22T00:00:00.000Z', removedReason: 'taken-down' }),
  post('p-t2', 'https://x.example/2', { recordedAt: '2026-10-23T00:00:00.000Z' }),
  post('p-l1', 'https://x.example/3', { publishedOn: null, publishedOnSource: 'legacy' }),
  post('p-l2', 'https://x.example/3', { publishedOn: '2026-10-19' }),
  post('p-k1', 'https://x.example/4', { removedAt: '2026-10-22T00:00:00.000Z', removedReason: 'mistake' }),
  post('p-k2', 'https://x.example/4'),
])
ok(
  '묶기 — 잘못 적은 주소만 있으면 뺀 글(mistake) · 내린 뒤 다시 적으면 올린 글 · 날짜 있는 줄이 있으면 날짜 없는 옛 줄은 뺀다 · 잘못 적은 줄 옆의 살아 있는 줄이 대표',
  mixed.length === 4 && mixed.find((p) => p.post.id === 'p-m1')?.removed?.reason === 'mistake' && mixed.find((p) => p.ids.includes('p-t1'))?.post.id === 'p-t2' &&
    mixed.find((p) => p.ids.includes('p-t1'))?.removed === null && !mixed.some((p) => p.ids.includes('p-l1')) &&
    mixed.find((p) => p.ids.includes('p-k1'))?.post.id === 'p-k2' && mixed.find((p) => p.ids.includes('p-k1'))?.removed === null,
)

// ── 3) 줄 · 작성자 · 아직 안 올린 글 ─────────────────────────────────────────
const NOW = Date.parse('2026-11-09T03:00:00.000Z')
const shown = (on: string, source: IndexCheck['source'] = 'manual'): IndexCheck => ({ state: 'shown', checkedOn: on, checkedAt: `${on}T01:00:00.000Z`, source })
const notYet = (on: string): IndexCheck => ({ state: 'not-yet', checkedOn: on, checkedAt: `${on}T01:00:00.000Z`, source: 'manual' })
const rec = (postId: string, url: string, over: Partial<IndexCheckRecord> = {}): IndexCheckRecord => ({
  postId,
  key: trackingKey(url) ?? url,
  url,
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
})
const built = buildTenantStatus({
  tenantId: 'vpub-a',
  brand: '가상스테이',
  ownedDomains: owned,
  posts: ledgerA,
  plan,
  planUnreadable: false,
  checks: {
    'p-aaaaaaaaaaa1': rec('p-aaaaaaaaaaa1', NAVER, { naver: shown('2026-10-24') }),
    'p-aaaaaaaaaaa4': rec('p-aaaaaaaaaaa4', OWN, { google: notYet('2026-10-30') }),
  },
})
const rowOf = (postId: string) => built.rows.find((r) => r.postId === postId)
const unposted = built.rows.filter((r) => r.kind === 'unposted')
ok(
  '줄 — 배정 글은 작성자(키 · 이름), 배정 밖 글은 배정 없음, 제목은 그때 글 제목',
  rowOf('p-aaaaaaaaaaa1')?.writer?.key === 'w1' && rowOf('p-aaaaaaaaaaa1')?.writer?.name === '김가상' && writerLabel(rowOf('p-aaaaaaaaaaa1')!) === 'w1 · 김가상' &&
    rowOf('p-aaaaaaaaaaa3')?.writer === null && writerLabel(rowOf('p-aaaaaaaaaaa3')!) === '배정 없음' && rowOf('p-aaaaaaaaaaa1')?.title === '가상시 숙소, 처음이라면 이렇게 고르세요',
)
ok(
  '줄 — 플랫폼 · 주소 · 발행일, 묶인 줄의 확인 기록은 대표가 아닌 줄 id로도 찾는다',
  rowOf('p-aaaaaaaaaaa1')?.platform?.label === '네이버 블로그' && rowOf('p-aaaaaaaaaaa3')?.platform?.label === '자사 사이트' && rowOf('p-aaaaaaaaaaa3')?.publishedOn === '2026-10-25' &&
    rowOf('p-aaaaaaaaaaa3')?.url === OWN && rowOf('p-aaaaaaaaaaa1')?.naver?.state === 'shown' && rowOf('p-aaaaaaaaaaa1')?.google === null &&
    rowOf('p-aaaaaaaaaaa3')?.google?.state === 'not-yet' && rowOf('p-aaaaaaaaaaa4') === undefined,
)
ok(
  '아직 안 올린 배정 글 — 살아 있는 글이 없는 배정 글마다 한 줄(내린 글만 있으면 아직 안 올림), 작성자 · 주제 이름',
  unposted.length === 3 && unposted.every((r) => r.postId === null && r.url === null && r.writer !== null) && unposted.some((r) => r.articleId === A3 && r.title === '가상시 가족 여행 숙소') &&
    !unposted.some((r) => r.articleId === A1),
)
const w1 = built.writers.find((w) => w.key === 'w1')
const w2 = built.writers.find((w) => w.key === 'w2')
ok('작성자별 진행 — 올림 n/배정 수(같은 글을 두 곳에 올려도 한 편, 내린 글은 세지 않는다)', w1?.posted === 1 && w1.assigned === 2 && w2?.posted === 0 && w2.assigned === 2 && built.writers.length === 2)
const broken = buildTenantStatus({ tenantId: 'vpub-e', brand: '깨진배정', ownedDomains: [], posts: [post('p-e1', NAVER, { articleId: A1 })], plan: null, planUnreadable: true, checks: {} })
ok('배정 파일을 못 읽으면 작성자는 미확인(배정 없음으로 채우지 않는다) · 아직 안 올린 줄 없음', broken.rows.length === 1 && broken.rows[0]!.writerUnknown && writerLabel(broken.rows[0]!) === '미확인' && broken.writers.length === 0)
const noPlan = buildTenantStatus({ tenantId: 'vpub-f', brand: '배정없음', ownedDomains: [], posts: [], plan: null, planUnreadable: false, checks: {} })
ok('원장도 배정도 없으면 줄이 없다', noPlan.rows.length === 0 && noPlan.writers.length === 0)

// ── 4) 확인 기록 찾기 · 적기 · 검사 ──────────────────────────────────────────
const store: Record<string, IndexCheckRecord> = {
  'p-old': rec('p-old', OWN, { naver: shown('2026-10-26'), updatedAt: '2026-10-26T00:00:00.000Z' }),
  'p-older': rec('p-older', OWN, { naver: notYet('2026-10-20'), updatedAt: '2026-10-20T00:00:00.000Z' }),
  'p-rep': rec('p-rep', TISTORY, { google: shown('2026-10-27') }),
}
const ownStore = { tenantId: 'vpub-a', checks: store }
const found = (own: typeof ownStore, others: (typeof ownStore)[], ids: string[], key: string | null) => {
  const f = findIndexRecord(own, others, ids, key)
  return f ? `${f.tenantId}:${f.record.postId}` : null
}
ok(
  '기록 찾기 — 묶인 줄 id · 같은 주소 키 가운데 가장 나중에 고친 기록(줄 id 기록이 더 오래면 같은 주소의 나중 기록), 없으면 null',
  found(ownStore, [], ['p-rep'], 'x') === 'vpub-a:p-rep' && found(ownStore, [], ['p-new', 'p-older'], 'none') === 'vpub-a:p-older' &&
    found(ownStore, [], ['p-new'], trackingKey(OWN)!) === 'vpub-a:p-old' && found(ownStore, [], ['p-older'], trackingKey(OWN)!) === 'vpub-a:p-old' &&
    found(ownStore, [], ['p-new'], 'none') === null,
)
ok(
  '기록 찾기 — 뺀 편(key null)은 제 줄 기록만, 다른 고객 브랜드는 같은 주소 키로만(그 브랜드의 줄 id는 보지 않는다)',
  found(ownStore, [], ['p-older'], null) === 'vpub-a:p-older' && found({ tenantId: 'vpub-g', checks: {} }, [ownStore], ['p-z'], trackingKey(TISTORY)!) === 'vpub-a:p-rep' &&
    found({ tenantId: 'vpub-g', checks: {} }, [ownStore], ['p-rep'], 'none') === null,
)
const marked = applyIndexCheck(null, { id: 'p-x', key: 'fake.tistory.com/12', url: TISTORY }, 'naver', 'shown', NOW)
ok(
  '적기 — 상태 · 확인일(한국 날짜) · 시각 · 출처 manual, 지우면(null) 그 엔진만 빠진다',
  marked.naver?.state === 'shown' && marked.naver.checkedOn === '2026-11-09' && marked.naver.source === 'manual' && marked.naver.checkedAt === new Date(NOW).toISOString() &&
    marked.postId === 'p-x' && marked.google === undefined &&
    applyIndexCheck({ ...marked, google: notYet('2026-11-01') }, { id: 'p-x', key: 'fake.tistory.com/12', url: TISTORY }, 'naver', null, NOW).naver === undefined &&
    applyIndexCheck({ ...marked, google: notYet('2026-11-01') }, { id: 'p-x', key: 'fake.tistory.com/12', url: TISTORY }, 'naver', null, NOW).google?.state === 'not-yet',
)
ok('자동 확인(나중의 네이버 검색 API)도 같은 모양 — 출처 auto', applyIndexCheck(null, { id: 'p-x', key: 'k', url: TISTORY }, 'naver', 'not-yet', NOW, 'auto').naver?.source === 'auto')
const input = (b: unknown) => parseIndexCheckInput(b)
ok(
  '본문 검사 — { engine, state }만, engine은 naver · google, state는 shown · not-yet · null(지우기)',
  input({ engine: 'naver', state: 'shown' }).ok && input({ engine: 'google', state: 'not-yet' }).ok && input({ engine: 'google', state: null }).ok &&
    !input({ engine: 'bing', state: 'shown' }).ok && !input({ engine: 'naver' }).ok && !input({ engine: 'naver', state: 'yes' }).ok &&
    !input({ engine: 'naver', state: 'shown', checkedOn: '2026-01-01' }).ok && !input([]).ok && !input(null).ok && !input('naver').ok,
)
ok(
  '파일 검사 — 형식 · 기록 모양이 틀리면 깨진 파일(읽지도 쓰지도 않는다)',
  parseIndexChecksFile({ format: INDEX_CHECKS_FORMAT, checks: store }).ok && !parseIndexChecksFile({ format: 'x', checks: {} }).ok && !parseIndexChecksFile([]).ok &&
    !parseIndexChecksFile({ format: INDEX_CHECKS_FORMAT, checks: { 'p-a': { ...rec('p-b', OWN) } } }).ok &&
    !parseIndexChecksFile({ format: INDEX_CHECKS_FORMAT, checks: { 'p-a': { ...rec('p-a', OWN), naver: { state: 'maybe', checkedOn: '2026-11-01', checkedAt: '2026-11-01T00:00:00.000Z', source: 'manual' } } } }).ok,
)

// ── 5) 다시 볼 날 ────────────────────────────────────────────────────────────
const PUB = '2026-11-01'
ok('날짜 더하기 — 달을 넘는다', addDays('2026-10-30', 3) === '2026-11-02' && addDays(PUB, 14) === '2026-11-15')
const rc = (today: string, check: IndexCheck | null, pub: string | null = PUB) => recheckOf(pub, check, today)
ok('다시 볼 날 — 노출됨이면 끝 · 발행일 모르면 모름', rc('2026-11-05', shown('2026-11-02')).kind === 'done' && rc('2026-11-05', null, null).kind === 'no-date')
const w0 = rc('2026-11-02', null)
ok('다시 볼 날 — 3일 전이면 3일째가 다음 날(미확인이어도 아직 다시 볼 날이 아니다)', w0.kind === 'wait' && w0.next === '2026-11-04')
const d3 = rc('2026-11-04', null)
ok('다시 볼 날 — 3일째에 확인 기록이 없으면 오늘 다시 볼 글', d3.kind === 'due' && d3.since === '2026-11-04' && !d3.over)
const after3 = rc('2026-11-05', notYet('2026-11-04'))
ok('다시 볼 날 — 3일째에 「아직」으로 봤으면 다음은 7일째', after3.kind === 'wait' && after3.next === '2026-11-08')
ok('다시 볼 날 — 3일째 전에 본 것은 3일째 확인이 아니다', rc('2026-11-04', notYet('2026-11-03')).kind === 'due')
const d7 = rc('2026-11-09', notYet('2026-11-04'))
ok('다시 볼 날 — 7일째가 지나도록 다시 보지 않았으면 오늘 다시 볼 글', d7.kind === 'due' && d7.since === '2026-11-08')
const over = rc('2026-11-20', notYet('2026-11-15'))
ok('다시 볼 날 — 14일째에도 아직이면 14일 지남', over.kind === 'over')
const late = rc('2026-11-20', notYet('2026-11-10'))
ok('다시 볼 날 — 14일째 확인을 빠뜨렸으면 오늘 다시 볼 글(14일 지남 표시와 함께)', late.kind === 'due' && late.since === '2026-11-15' && late.over)
const row = (over: Partial<PublishStatusRow>): PublishStatusRow => ({
  rowKey: 'k',
  tenantId: 'vpub-a',
  brand: '가상스테이',
  kind: 'posted',
  postId: 'p-x',
  key: trackingKey(TISTORY)!,
  articleId: 'content:x',
  title: '가상 글',
  writer: null,
  writerUnknown: null,
  postedUnknown: false,
  platform: { key: 'tistory', label: '티스토리' },
  url: TISTORY,
  publishedOn: PUB,
  removed: null,
  naver: null,
  google: null,
  checkFrom: null,
  ...over,
})
const rr = rowRecheck(row({ naver: shown('2026-11-04'), google: notYet('2026-11-04') }), '2026-11-05')
ok('줄의 다시 볼 날 — 두 엔진 가운데 가장 이른 날(노출된 엔진은 빼고)', !rr.due && rr.nextOn === '2026-11-08' && rr.label === '2026-11-08')
const rd = rowRecheck(row({ naver: shown('2026-11-04') }), '2026-11-05')
ok('줄의 다시 볼 날 — 한 엔진이라도 다시 볼 차례면 오늘 다시 볼 글(그 엔진을 알린다)', rd.due && rd.label === '오늘 다시 볼 글' && rd.engines.join() === 'google')
ok(
  '줄의 다시 볼 날 — 둘 다 나오면 확인 끝, 14일 지남, 발행일 모름, 아직 안 올린 글 · 내린 글은 다시 보지 않는다',
  rowRecheck(row({ naver: shown('2026-11-04'), google: shown('2026-11-04') }), '2026-11-05').label === '확인 끝' &&
    rowRecheck(row({ naver: notYet('2026-11-15'), google: shown('2026-11-04') }), '2026-11-20').label === '14일 지남' &&
    rowRecheck(row({ publishedOn: null }), '2026-11-20').label === '모름' &&
    !rowRecheck(row({ kind: 'unposted', postId: null, url: null, platform: null, publishedOn: null }), '2026-11-20').due &&
    !rowRecheck(row({ removed: { reason: 'taken-down', at: '2026-11-03T00:00:00.000Z' } }), '2026-11-20').due,
)

// ── 6) 요약 · 거르기 ──────────────────────────────────────────────────────────
// 요약은 서로 다른 주소로 세므로 줄마다 주소 키를 다르게 둔다.
const sumRows = [
  row({ rowKey: 'a', key: 'fake.tistory.com/a', naver: shown('2026-11-04'), google: shown('2026-11-04') }),
  row({ rowKey: 'b', key: 'fake.tistory.com/b', naver: notYet('2026-11-04') }),
  row({ rowKey: 'c', key: 'fake.tistory.com/c', publishedOn: '2026-11-08' }),
  row({ rowKey: 'd', key: 'fake.tistory.com/d', removed: { reason: 'taken-down', at: '2026-11-06T00:00:00.000Z' }, naver: shown('2026-11-04') }),
  row({ rowKey: 'e', key: null, kind: 'unposted', postId: null, url: null, platform: null, publishedOn: null, writer: W1 }),
]
const sum = summarizeStatus(sumRows, '2026-11-09')
ok('요약 — 올린 글 · 네이버 노출 · 구글 색인 · 미확인(한 엔진이라도) · 오늘 다시 볼(내린 글 · 안 올린 글은 세지 않는다)', sum.posted === 3 && sum.naverShown === 1 && sum.googleShown === 1 && sum.unknown === 2 && sum.due === 1)
const base: StatusFilter = { tenantId: '', writer: '', naver: '', google: '', dueOnly: false, showUnposted: true, showRemoved: false }
const keys = (f: Partial<StatusFilter>) => filterRows(sumRows, { ...base, ...f }, '2026-11-09').map((r) => r.rowKey).join(',')
ok(
  '거르기 — 기본은 내린 글을 숨기고 안 올린 글을 보인다 · 상태 거르기는 올린 글만 · 오늘 다시 볼 글 · 작성자',
  keys({}) === 'a,b,c,e' && keys({ showRemoved: true }) === 'a,b,c,d,e' && keys({ showUnposted: false }) === 'a,b,c' && keys({ naver: 'unknown' }) === 'c' &&
    keys({ naver: 'not-yet' }) === 'b' && keys({ google: 'shown' }) === 'a' && keys({ dueOnly: true }) === 'b' && keys({ writer: 'w1\n김가상' }) === 'e' && keys({ writer: 'none' }) === 'a,b,c',
)

// ── 7) CSV ───────────────────────────────────────────────────────────────────
ok(
  'CSV 칸 — 쉼표 · 따옴표 · 줄바꿈은 따옴표로 감싸고(따옴표는 두 번), = + - @ 탭 CR로 시작하면 앞에 \' 를 붙인다',
  csvCell('보통 글') === '보통 글' && csvCell('a,b') === '"a,b"' && csvCell('그는 "네"') === '"그는 ""네"""' && csvCell('줄\n바꿈') === '"줄\n바꿈"' &&
    csvCell('=HYPERLINK("http://x")') === `"'=HYPERLINK(""http://x"")"` && csvCell('+1') === "'+1" && csvCell('-10% 할인') === "'-10% 할인" && csvCell('@sum') === "'@sum" &&
    csvCell('\tx') === "'\tx" && csvCell('\rx') === `"'\rx"` && csvCell(null) === '' && csvCell(3) === '3',
)
const csv = publishStatusCsv(
  [
    row({ brand: '가상스테이', writer: W1, title: '=1+1 가상, "글"', naver: shown('2026-11-04') }),
    row({ rowKey: 'u', kind: 'unposted', postId: null, url: null, platform: null, publishedOn: null, writer: W2, title: '가상시 바다 보이는 숙소' }),
  ],
  '2026-11-05',
)
const lines = csv.split('\r\n')
ok('CSV — UTF-8 BOM으로 시작하고 줄은 CRLF', csv.startsWith('﻿') && csv.endsWith('\r\n') && lines.length === 4)
ok(
  'CSV — 열은 표와 같고 엔진마다 확인일을 더한다',
  lines[0] === '﻿브랜드,작성자,글 제목,플랫폼,주소,발행일,네이버 노출,네이버 확인일,구글 색인,구글 확인일,다시 볼 날',
)
ok(
  'CSV — 올린 글 줄(수식 막기 · 미확인 · 다음 날) · 아직 안 올린 줄',
  lines[1] === `가상스테이,w1 · 김가상,"'=1+1 가상, ""글""",티스토리,${TISTORY},${PUB},노출됨,2026-11-04,미확인,,오늘 다시 볼 글 (구글)` &&
    lines[2] === '가상스테이,w2 · 이가상,가상시 바다 보이는 숙소,,,아직 안 올림,,,,,',
)
ok('CSV 파일 이름 — 발행-현황-<한국 날짜>.csv', publishStatusFileName('2026-11-09') === '발행-현황-2026-11-09.csv')

// ── 8) 검색 주소 ─────────────────────────────────────────────────────────────
const nb = naverSearchUrl(row({ platform: { key: 'naver-blog', label: '네이버 블로그' }, url: NAVER, title: '가상 숙소 & 글' }))
const nw = naverSearchUrl(row({ title: '가상 숙소 글' }))
const nu = naverSearchUrl(row({ title: null }))
ok(
  '네이버 확인 주소 — 네이버 블로그 글은 블로그 검색(제목), 그 밖은 웹문서 검색(제목, 없으면 주소)',
  nb === `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent('가상 숙소 & 글')}` &&
    nw === `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent('가상 숙소 글')}` &&
    nu === `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent('fake.tistory.com/12')}` &&
    naverSearchUrl(row({ kind: 'unposted', url: null })) === null,
)
ok(
  '구글 확인 주소 — site:<주소에서 http(s)://를 뗀 것>',
  googleSearchUrl('https://fake.tistory.com/12/') === `https://www.google.com/search?q=${encodeURIComponent('site:fake.tistory.com/12')}` &&
    googleSearchUrl('http://blog.naver.com/fakeid/224000000001#top') === `https://www.google.com/search?q=${encodeURIComponent('site:blog.naver.com/fakeid/224000000001')}`,
)

// ── 9) 검토 반영(2026-11-09) ────────────────────────────────────────────────
const tenantInput = (posts: LedgerPostLike[], checksIn: Record<string, IndexCheckRecord> = {}) => ({
  tenantId: 'vpub-a',
  brand: '가상스테이',
  ownedDomains: owned,
  posts,
  plan: null,
  planUnreadable: false,
  checks: checksIn,
})
// (가) 같은 주소를 올린 날만 다르게 두 줄(자사 10/30 · 채널 11/02 오늘 날짜) — 블로그 글은 하나다.
const SAME = 'https://fake.tistory.com/300'
const twoDays = buildTenantStatus(
  tenantInput(
    [
      post('p-s1', SAME, { publishedOn: '2026-10-30', recordedAt: '2026-10-30T01:00:00.000Z', articleTitle: '가상 같은 글' }),
      post('p-s2', SAME, { publishedOn: '2026-11-02', recordedAt: '2026-11-02T01:00:00.000Z', publishedOnSource: 'default-today', via: 'channel', articleTitle: '가상 같은 글' }),
    ],
    {
      'p-s1': rec('p-s1', SAME, { naver: shown('2026-11-03'), updatedAt: '2026-11-03T00:00:00.000Z' }),
      'p-s2': rec('p-s2', SAME, { naver: shown('2026-11-03'), google: notYet('2026-11-04'), updatedAt: '2026-11-04T00:00:00.000Z' }),
    },
  ),
)
const sameLive = twoDays.rows.filter((r) => r.kind === 'posted' && !r.removed)
ok(
  '같은 주소를 올린 날만 다르게 두 줄 적어도 한 편 — 발행일은 가장 이른 날, 색인 표시는 그 주소의 가장 나중 기록 하나',
  sameLive.length === 1 && sameLive[0]!.publishedOn === '2026-10-30' && sameLive[0]!.naver?.state === 'shown' && sameLive[0]!.google?.state === 'not-yet',
)
ok('같은 주소 두 줄 — 요약도 한 편(다시 볼 날도 한 번)', summarizeStatus(twoDays.rows, '2026-11-09').posted === 1 && summarizeStatus(twoDays.rows, '2026-11-09').due <= 1)
// (나) 대표 줄이 바뀌었다 돌아옴(뺀 줄을 되살림) — 대표 id의 옛 기록보다 나중 기록을 쓴다.
const RESTORE = 'https://fake.tistory.com/88'
const restored = buildTenantStatus(
  tenantInput(
    [post('p-r1', RESTORE), post('p-r2', RESTORE, { recordedAt: '2026-10-20T04:00:00.000Z', via: 'channel' })],
    {
      'p-r1': rec('p-r1', RESTORE, { naver: shown('2026-11-04'), updatedAt: '2026-11-04T01:00:00.000Z' }),
      'p-r2': rec('p-r2', RESTORE, { naver: shown('2026-11-04'), google: shown('2026-11-06'), updatedAt: '2026-11-06T01:00:00.000Z' }),
    },
  ),
)
ok('대표 줄이 바뀌었다 돌아와도 가장 나중에 고친 기록을 쓴다(나중 표시가 사라지지 않는다)', restored.rows[0]?.postId === 'p-r1' && restored.rows[0]?.google?.state === 'shown')
// (다) 내린 뒤 같은 주소로 다시 올림 — 내리기 전 확인(올린 날보다 앞선 확인)은 이 편의 확인이 아니다.
const REPOST = 'https://fake.tistory.com/77'
const reposted = buildTenantStatus(
  tenantInput(
    [
      post('p-d1', REPOST, { publishedOn: '2026-10-01', recordedAt: '2026-10-01T01:00:00.000Z', removedAt: '2026-10-10T01:00:00.000Z', removedReason: 'taken-down' }),
      post('p-d2', REPOST, { publishedOn: '2026-11-01', recordedAt: '2026-11-01T01:00:00.000Z' }),
    ],
    { 'p-d1': rec('p-d1', REPOST, { naver: shown('2026-10-05'), google: shown('2026-10-05'), updatedAt: '2026-10-05T01:00:00.000Z' }) },
  ),
)
const repostRow = reposted.rows.find((r) => r.postId === 'p-d2')
ok(
  '내린 뒤 같은 주소로 다시 올린 글은 내리기 전 확인을 이어받지 않는다(미확인 · 오늘 다시 볼 글)',
  repostRow?.naver === null && repostRow.google === null && rowRecheck(repostRow, '2026-11-09').due && summarizeStatus(reposted.rows, '2026-11-09').unknown === 1,
)
// (라) 작성자 배정은 배정 판(bankVersion)으로 쓴 글만 — 질문 id는 판이 바뀌어도 이어진다.
const PLAN_URL = 'https://fake.tistory.com/500'
const withBank = (topic: unknown) =>
  buildTenantStatus({ ...tenantInput([post('p-v1', PLAN_URL, { articleId: A1, ...(topic === undefined ? {} : { topic }) })]), plan })
const oldBank = withBank(topicOf(A1, 'v0'))
const sameBank = withBank(topicOf(A1, 'v1'))
const noBank = withBank(undefined)
const nullBank = withBank(topicOf(A1, null))
const progress = (s: typeof oldBank) => s.writers.find((w) => w.key === 'w1')?.posted
const hasUnposted = (s: typeof oldBank) => s.rows.some((r) => r.kind === 'unposted' && r.articleId === A1)
ok(
  '작성자 배정 — 옛 판 글은 배정 없음 · 그 배정 글은 아직 안 올림 · 진행에 세지 않는다, 같은 판이면 배정 글',
  writerLabel(oldBank.rows[0]!) === '배정 없음' && progress(oldBank) === 0 && hasUnposted(oldBank) &&
    sameBank.rows[0]?.writer?.key === 'w1' && progress(sameBank) === 1 && !hasUnposted(sameBank),
)
ok(
  '작성자 배정 — 판을 모르면(스냅샷 없음 · 판 null) 작성자 미확인, 진행에 세지 않는다',
  writerLabel(noBank.rows[0]!) === '미확인' && writerLabel(nullBank.rows[0]!) === '미확인' && progress(noBank) === 0 && progress(nullBank) === 0,
)
// (마) 범위 변형 두 브랜드에 같은 글 주소 — 색인 상태는 주소의 것이라 함께 보이고, 모든 브랜드 요약은 한 번 센다.
const sharedRows = buildTenantStatus({
  tenantId: 'vpub-g',
  brand: '가상스테이 · 전국형',
  ownedDomains: [],
  posts: [post('p-x1', TISTORY)],
  plan: null,
  planUnreadable: false,
  checks: {},
  others: [{ tenantId: 'vpub-a', brand: '가상스테이', checks: { 'p-aaaaaaaaaaa2': rec('p-aaaaaaaaaaa2', TISTORY, { naver: shown('2026-11-03') }) } }],
})
ok('다른 고객 브랜드에 적은 같은 주소의 확인도 보인다(어느 브랜드 줄에서 표시했는지와 함께)', sharedRows.rows[0]?.naver?.state === 'shown' && sharedRows.rows[0]?.checkFrom === '가상스테이')
const bothBrands = [...built.rows, ...sharedRows.rows]
const distinctLive = new Set(bothBrands.filter((r) => r.kind === 'posted' && !r.removed).map((r) => trackingKey(r.url!))).size
ok('모든 브랜드 요약은 서로 다른 주소로 센다', summarizeStatus(bothBrands, '2026-11-09').posted === distinctLive)
// (바) CSV 다시 볼 날 — 표처럼 어느 엔진인지 · 14일 지남까지.
const dueLine = publishStatusCsv([row({ publishedOn: '2026-09-01' })], '2026-11-09').split('\r\n')[1] ?? ''
ok('CSV 다시 볼 날 — 표와 같이 엔진 · 14일 지남을 함께 적는다', dueLine.endsWith(',오늘 다시 볼 글 (네이버 · 구글 · 14일 지남)'))
// (사) 기본 창(1360×900)에서 표가 잘리지 않는다 — 표 최소 너비가 표 상자 안에 들어오고, 표 상자가 세로로도 스크롤해 가로 막대 · 머리글이 보인다.
const css = readFileSync(path.join(process.cwd(), 'src', 'App.css'), 'utf-8')
const cssBlock = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
const tableMin = Number(/min-width:\s*(\d+)px/.exec(cssBlock('.ps-table'))?.[1] ?? NaN)
ok('표 최소 너비가 기본 창 본문(표 상자 안쪽 약 1040px)에 들어온다', tableMin <= 1000)
ok(
  '표 상자는 화면 높이 안에서 스크롤하고 머리글이 붙는다(가로 스크롤 막대 · 열 이름이 늘 보인다)',
  /max-height/.test(cssBlock('.ps-table-wrap')) && /overflow:\s*auto/.test(cssBlock('.ps-table-wrap')) && /position:\s*sticky/.test(cssBlock('.ps-table thead th')),
)
// (아) 판을 모르는 배정 글 — 아직 안 올렸다고 하지 않는다(올렸는지 미확인), 작성자 진행에도 따로 센다.
const noBankUnposted = noBank.rows.find((r) => r.kind === 'unposted' && r.articleId === A1)
ok(
  '판을 모르는 배정 글 — 그 배정 글 줄은 「올렸는지 미확인」, 작성자 진행은 미확인 1(올림에는 세지 않는다)',
  noBankUnposted?.postedUnknown === true && unpostedLabel(noBankUnposted) === '올렸는지 미확인' && noBank.writers.find((w) => w.key === 'w1')?.unsure === 1 &&
    publishStatusCsv([noBankUnposted], '2026-11-09').split('\r\n')[1]!.includes(',올렸는지 미확인,') &&
    oldBank.rows.find((r) => r.kind === 'unposted' && r.articleId === A1)?.postedUnknown === false && oldBank.writers.find((w) => w.key === 'w1')?.unsure === 0,
)
// (자) 표시 뒤 화면 갱신 — 같은 주소의 줄 모두(다른 브랜드 포함), 줄마다 올린 날보다 앞선 확인은 뺀다.
const synced = withIndexRecord(
  [
    row({ rowKey: 'x1', tenantId: 'vpub-a', brand: '가상스테이' }),
    row({ rowKey: 'x2', tenantId: 'vpub-g', brand: '가상스테이전국' }),
    row({ rowKey: 'x3', tenantId: 'vpub-g', brand: '가상스테이전국', publishedOn: '2026-11-08' }),
    row({ rowKey: 'x4', key: 'fake.tistory.com/other' }),
    row({ rowKey: 'x5', removed: { reason: 'taken-down', at: '2026-11-06T00:00:00.000Z' } }),
  ],
  row({ tenantId: 'vpub-a', brand: '가상스테이' }),
  rec('p-x', TISTORY, { naver: shown('2026-11-05'), google: notYet('2026-11-05') }),
)
ok(
  '표시 뒤 화면 — 같은 주소 줄 모두 고치고(다른 브랜드 줄엔 표시한 브랜드), 올린 날보다 앞선 확인은 빼고, 다른 주소 · 뺀 줄은 그대로',
  synced[0]!.naver?.state === 'shown' && synced[0]!.checkFrom === null && synced[1]!.google?.state === 'not-yet' && synced[1]!.checkFrom === '가상스테이' &&
    synced[2]!.naver === null && synced[2]!.checkFrom === null && synced[3]!.naver === null && synced[4]!.naver === null,
)
const urlBrands = sameUrlBrands([row({ brand: '가상스테이' }), row({ rowKey: 'y', brand: '가상스테이전국' }), row({ rowKey: 'z', key: 'fake.tistory.com/z' })])
ok('같은 주소를 적은 브랜드 — 둘 이상인 주소만', urlBrands.size === 1 && urlBrands.get(trackingKey(TISTORY)!)?.join() === '가상스테이,가상스테이전국')
// (차) 다시 읽은 뒤 고른 브랜드 · 작성자가 사라지면 모두로 되돌린다.
const readRows = [row({ tenantId: 'vpub-a', writer: W1 }), row({ rowKey: 'k2', tenantId: 'vpub-g' })]
const gone = validFilter({ ...base, tenantId: 'vpub-gone', writer: 'w1\n김가상' }, readRows)
const goneWriter = validFilter({ ...base, tenantId: 'vpub-a', writer: 'w2\n이가상' }, readRows)
const kept = { ...base, tenantId: 'vpub-a', writer: 'w1\n김가상' }
const allWriter = { ...base, writer: 'w1\n김가상' }
ok(
  '거르기 되돌리기 — 없는 브랜드는 모두로(그 브랜드에서 고른 작성자도 비움), 그 브랜드에 없는 작성자도 모두로, 있으면 그대로(같은 값)',
  gone.tenantId === '' && gone.writer === '' && goneWriter.tenantId === 'vpub-a' && goneWriter.writer === '' && validFilter(kept, readRows) === kept &&
    validFilter(allWriter, readRows) === allWriter && filterRows(readRows, gone, '2026-11-09').length === 2,
)
// (카) 작성자 칩 — 끄면 켜기 전 브랜드 거르기로 돌아간다.
const chipOn = toggleWriterChip(base, { tenantId: 'vpub-a', writer: 'w1\n김가상' }, null)
const chipOff = toggleWriterChip(chipOn.filter, { tenantId: 'vpub-a', writer: 'w1\n김가상' }, chipOn.before)
const chipSwap = toggleWriterChip(chipOn.filter, { tenantId: 'vpub-g', writer: 'w1\n박가상' }, chipOn.before)
const chipOffSwap = toggleWriterChip(chipSwap.filter, { tenantId: 'vpub-g', writer: 'w1\n박가상' }, chipSwap.before)
ok(
  '작성자 칩 — 켜면 그 브랜드 · 작성자, 끄면 켜기 전(모든 브랜드)으로, 칩을 바꿔 눌러도 처음 브랜드 거르기를 기억한다',
  chipOn.filter.tenantId === 'vpub-a' && chipOn.filter.writer === 'w1\n김가상' && chipOn.before === '' && chipOff.filter.tenantId === '' && chipOff.filter.writer === '' &&
    chipOff.before === null && chipOffSwap.filter.tenantId === '' && toggleWriterChip(kept, { tenantId: 'vpub-a', writer: 'w1\n김가상' }, null).filter.tenantId === 'vpub-a',
)
// (타) 줄이 없을 때 — 파일 오류가 있으면 「기록이 없다」고 하지 않는다.
ok(
  '빈 상태 — 오류가 있으면 issues, 정말 없으면 empty, 줄이 있으면 null',
  emptyStateOf({ rows: [], issues: [{ tenantId: 'vpub-c', brand: '깨진원장', error: 'x' }] }) === 'issues' && emptyStateOf({ rows: [], issues: [] }) === 'empty' &&
    emptyStateOf({ rows: [row({})], issues: [{ tenantId: 'vpub-c', brand: '깨진원장', error: 'x' }] }) === null,
)
// (파) 줄 순서 — 모든 브랜드의 올린 글(늦은 날 먼저) 뒤에 아직 안 올린 배정 글.
const ordered = orderRows([
  row({ rowKey: 'a-post', publishedOn: '2026-11-01' }),
  row({ rowKey: 'a-plan', kind: 'unposted', key: null, url: null, publishedOn: null }),
  row({ rowKey: 'g-post', tenantId: 'vpub-g', publishedOn: '2026-11-05' }),
  row({ rowKey: 'g-nodate', tenantId: 'vpub-g', publishedOn: null }),
  row({ rowKey: 'g-plan', tenantId: 'vpub-g', kind: 'unposted', key: null, url: null, publishedOn: null }),
])
ok('줄 순서 — 올린 글(브랜드를 건너 늦은 날 먼저, 모르면 뒤) → 아직 안 올린 배정 글(브랜드 순)', ordered.map((r) => r.rowKey).join() === 'g-post,a-post,g-nodate,a-plan,g-plan')
// (하) 화면 읽기 이름 — 줄마다 다르고, 이미 눌린 단추는 다시 누르면 확인일만 오늘로 바뀐다고 알린다.
const twoRows = [
  row({ title: '가상 글 하나' }),
  row({ rowKey: 'k2', title: '가상 글 둘' }),
  row({ rowKey: 'k3', title: null, url: 'https://fake.tistory.com/9' }),
  row({ rowKey: 'k4', title: '가상 글 하나', url: NAVER, platform: { key: 'naver-blog', label: '네이버 블로그' } }),
]
const labels = twoRows.flatMap((r) => [markLabel(r, 'naver', 'shown', null), markLabel(r, 'google', 'not-yet', null), searchLabel(r, 'naver'), searchLabel(r, 'google')])
ok(
  '화면 읽기 이름 — 단추 · 링크 이름에 브랜드 · 제목(없으면 주소) · 플랫폼(같은 글을 두 곳에 올려도 다르다), 링크는 새 창, 지우기, 눌린 단추는 확인일을 오늘로',
  new Set(labels).size === labels.length && labels[0] === '가상스테이 「가상 글 하나」 티스토리 네이버 노출됨으로 표시' &&
    labels[2] === '가상스테이 「가상 글 하나」 티스토리 네이버에서 확인(새 창)' &&
    markLabel(twoRows[2]!, 'google', 'shown', null) === '가상스테이 「fake.tistory.com/9」 티스토리 구글 색인됨으로 표시' &&
    markLabel(twoRows[0]!, 'naver', null, shown('2026-11-04')) === '가상스테이 「가상 글 하나」 티스토리 네이버 표시 지우기(미확인으로)' &&
    markLabel(twoRows[0]!, 'naver', 'shown', shown('2026-11-04')) === '가상스테이 「가상 글 하나」 티스토리 네이버 노출됨 — 지금 표시됨, 다시 누르면 확인일을 오늘로',
)

// ── 10) 서버 길 ─────────────────────────────────────────────────────────────
const PORT = 4171
const BASE = `http://127.0.0.1:${PORT}`
const portFree = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
const dir = mkdtempSync(path.join(tmpdir(), 'verify-publish-status-'))
const tenant = (tenantId: string, brandName: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  brandName,
  aliases: [brandName],
  ownedDomains: [`${tenantId}.example`],
  industry: '숙박',
  region: '가상시',
  engines: ['gemini'],
  questionBankSize: 4,
  questionBankVersion: 'v1',
  repeatsPerQuestion: 1,
  factGraph: [],
  competitors: [],
  ...over,
})
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    tenant('vpub-a', '가상스테이', { ownedDomains: ['stay.example'] }),
    tenant('vpub-b', '빈브랜드'),
    tenant('vpub-c', '깨진원장'),
    tenant('vpub-d', '깨진확인'),
    tenant('vpub-e', '깨진배정'),
    tenant('vpub-g', '가상스테이전국'),
    tenant('vpub-comp', '가상경쟁사', { cohortOnly: true }),
  ]),
)
const tenantDir = (id: string) => {
  const d = path.join(dir, 'data', id)
  mkdirSync(d, { recursive: true })
  return d
}
const ledgerFile = (posts: unknown[]) => JSON.stringify({ version: 1, keyRule: 3, posts }, null, 2)
const LEDGER_A = ledgerFile(ledgerA)
writeFileSync(path.join(tenantDir('vpub-a'), 'published-posts.json'), LEDGER_A)
writeFileSync(path.join(tenantDir('vpub-a'), 'probe-plan.json'), JSON.stringify(planOf('vpub-a')))
writeFileSync(path.join(tenantDir('vpub-c'), 'published-posts.json'), '{"version":1,"posts":[')
writeFileSync(path.join(tenantDir('vpub-d'), 'published-posts.json'), ledgerFile([post('p-dddddddddd01', 'https://fake.tistory.com/700')]))
const BROKEN_CHECKS = '{"format":"index-checks/1","checks":'
writeFileSync(path.join(tenantDir('vpub-d'), 'index-checks.json'), BROKEN_CHECKS)
writeFileSync(path.join(tenantDir('vpub-e'), 'published-posts.json'), ledgerFile([post('p-eeeeeeeeee01', 'https://fake.tistory.com/800', { articleId: A1 })]))
writeFileSync(path.join(tenantDir('vpub-e'), 'probe-plan.json'), '{"format":"probe-plan/2"')
writeFileSync(path.join(tenantDir('vpub-comp'), 'published-posts.json'), ledgerFile([post('p-cccccccccc01', 'https://fake.tistory.com/900')]))
// vpub-g — vpub-a와 같은 글 주소(TISTORY), 같은 주소를 올린 날만 다르게 두 줄(SAME), 내린 뒤 다시 올린 주소(REPOST — 내리기 전 확인이 있다).
const LEDGER_G = ledgerFile([
  post('p-gggggggggg01', TISTORY, { via: 'channel', articleTitle: '가상시 숙소, 처음이라면 이렇게 고르세요' }),
  post('p-gggggggggg02', SAME, { publishedOn: '2026-10-30', recordedAt: '2026-10-30T01:00:00.000Z', articleTitle: '가상 같은 글' }),
  post('p-gggggggggg03', SAME, { publishedOn: '2026-11-02', recordedAt: '2026-11-02T01:00:00.000Z', publishedOnSource: 'default-today', via: 'channel', articleTitle: '가상 같은 글' }),
  post('p-gggggggggg04', REPOST, { publishedOn: '2026-10-01', recordedAt: '2026-10-01T01:00:00.000Z', removedAt: '2026-10-10T01:00:00.000Z', removedReason: 'taken-down' }),
  post('p-gggggggggg05', REPOST, { publishedOn: '2026-11-01', recordedAt: '2026-11-01T01:00:00.000Z' }),
])
writeFileSync(path.join(tenantDir('vpub-g'), 'published-posts.json'), LEDGER_G)
writeFileSync(
  path.join(tenantDir('vpub-g'), 'index-checks.json'),
  JSON.stringify({
    format: INDEX_CHECKS_FORMAT,
    checks: { 'p-gggggggggg04': rec('p-gggggggggg04', REPOST, { naver: shown('2026-10-05'), google: shown('2026-10-05'), updatedAt: '2026-10-05T01:00:00.000Z' }) },
  }),
)

const env: Record<string, string | undefined> = {
  ...process.env,
  APP_DATA_DIR: dir,
  PORT: String(PORT),
  USE_MOCK_ENGINES: 'true',
  DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
  BLOB_READ_WRITE_TOKEN: '',
  BLOB_STORE_ID: '',
  PIPELINE_CRON: '',
  GH_MEASURE_TOKEN: '',
  ANTHROPIC_API_KEY: '',
}
delete env.AEO_SERVER_HOST

if (!(await portFree())) {
  console.error(`포트 ${PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
const getStatus = async () => {
  const r = await fetch(`${BASE}/api/publish-status`)
  return { status: r.status, body: (await r.json().catch(() => ({}))) as PublishStatus }
}
const put = (tenantId: string, postId: string, body: unknown, raw?: string) =>
  fetch(`${BASE}/api/index-checks/${encodeURIComponent(tenantId)}/${encodeURIComponent(postId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { record?: IndexCheckRecord; error?: string } }))
const checksFile = (id: string) => readFileSync(path.join(dir, 'data', id, 'index-checks.json'), 'utf-8')
try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  const first = await getStatus()
  const mine = (id: string) => first.body.rows?.filter((r) => r.tenantId === id) ?? []
  const issueOf = (id: string) => first.body.issues?.find((i) => i.tenantId === id)
  ok('발행 현황 — 200 · 오늘(한국 날짜)', first.status === 200 && first.body.today === todayKst())
  ok(
    '발행 현황 — 고객 브랜드의 올린 글(한 편 한 줄) · 내린 글 · 아직 안 올린 배정 글',
    mine('vpub-a').filter((r) => r.kind === 'posted' && !r.removed).length === 11 && mine('vpub-a').filter((r) => r.removed).length === 1 &&
      mine('vpub-a').filter((r) => r.kind === 'unposted').length === 3 && mine('vpub-a').every((r) => r.brand === '가상스테이'),
  )
  ok(
    '발행 현황 — 작성자별 진행(올림 n/배정 수)',
    first.body.writers?.filter((w) => w.tenantId === 'vpub-a').map((w) => `${w.key}:${w.posted}/${w.assigned}`).join(',') === 'w1:1/2,w2:0/2',
  )
  ok('발행 현황 — 원장 · 배정이 없는 브랜드는 줄도 오류도 없다', mine('vpub-b').length === 0 && issueOf('vpub-b') === undefined)
  ok('발행 현황 — 원장이 깨진 브랜드는 그 브랜드만 오류(다른 브랜드는 그대로)', mine('vpub-c').length === 0 && /published-posts\.json/.test(issueOf('vpub-c')?.error ?? ''))
  ok('발행 현황 — 확인 파일이 깨진 브랜드도 그 브랜드만 오류', mine('vpub-d').length === 0 && /index-checks\.json/.test(issueOf('vpub-d')?.error ?? ''))
  ok(
    '발행 현황 — 배정 파일이 깨진 브랜드는 줄을 보이되 작성자는 미확인, 오류에 알린다',
    mine('vpub-e').length === 1 && mine('vpub-e')[0]!.writerUnknown && mine('vpub-e')[0]!.writer === null && /probe-plan\.json/.test(issueOf('vpub-e')?.error ?? ''),
  )
  ok('발행 현황 — 경쟁사(비교용) 브랜드는 넣지 않는다', mine('vpub-comp').length === 0 && issueOf('vpub-comp') === undefined)
  ok('발행 현황 — 확인하지 않은 글은 두 엔진 모두 미확인(null)', mine('vpub-a').filter((r) => r.kind === 'posted').every((r) => r.naver === null && r.google === null))

  // PUT 검사
  const valid = { engine: 'naver', state: 'shown' }
  ok('없는 브랜드는 404', (await put('vpub-nope', 'p-aaaaaaaaaaa1', valid)).status === 404)
  ok('경쟁사 브랜드는 404', (await put('vpub-comp', 'p-cccccccccc01', valid)).status === 404)
  ok('엔진이 틀리면 400', (await put('vpub-a', 'p-aaaaaaaaaaa1', { engine: 'bing', state: 'shown' })).status === 400)
  ok('state가 없으면 400', (await put('vpub-a', 'p-aaaaaaaaaaa1', { engine: 'naver' })).status === 400)
  ok('state가 틀리면 400', (await put('vpub-a', 'p-aaaaaaaaaaa1', { engine: 'naver', state: 'yes' })).status === 400)
  ok('모르는 칸이 있으면 400(확인일을 화면이 정하지 않는다)', (await put('vpub-a', 'p-aaaaaaaaaaa1', { ...valid, checkedOn: '2026-01-01' })).status === 400)
  ok('배열 본문은 400', (await put('vpub-a', 'p-aaaaaaaaaaa1', [valid])).status === 400)
  ok('JSON이 아니면 400', (await put('vpub-a', 'p-aaaaaaaaaaa1', null, '{"engine":')).status === 400)
  ok('기록 id 모양이 틀리면 400', (await put('vpub-a', 'p a', valid)).status === 400)
  ok('원장에 없는 기록은 404', (await put('vpub-a', 'p-ffffffffffff', valid)).status === 404)
  let fileMissing = false
  try {
    checksFile('vpub-a')
  } catch {
    fileMissing = true
  }
  ok('거절한 요청은 확인 파일을 만들지 않는다', fileMissing)
  const brokenPut = await put('vpub-d', 'p-dddddddddd01', valid)
  ok('깨진 확인 파일 위로는 쓰지 않는다(500 · 파일 그대로)', brokenPut.status === 500 && checksFile('vpub-d') === BROKEN_CHECKS)

  // 표시 · 지우기
  const mark = await put('vpub-a', 'p-aaaaaaaaaaa1', valid)
  ok(
    '표시 — 200 · 상태 · 오늘(한국 날짜) · manual',
    mark.status === 200 && mark.body.record?.naver?.state === 'shown' && mark.body.record.naver.checkedOn === todayKst() && mark.body.record.naver.source === 'manual',
  )
  const sibling = await put('vpub-a', 'p-aaaaaaaaaaa4', { engine: 'google', state: 'not-yet' })
  const afterMark = await getStatus()
  const rowA = (id: string) => afterMark.body.rows.find((r) => r.tenantId === 'vpub-a' && r.postId === id)
  ok(
    '다시 읽기 — 표시가 남고, 묶인 줄(대표 아님)에 적은 표시도 그 편에 보인다',
    sibling.status === 200 && rowA('p-aaaaaaaaaaa1')?.naver?.state === 'shown' && rowA('p-aaaaaaaaaaa1')?.google === null && rowA('p-aaaaaaaaaaa3')?.google?.state === 'not-yet',
  )
  const cleared = await put('vpub-a', 'p-aaaaaaaaaaa1', { engine: 'naver', state: null })
  const afterClear = await getStatus()
  const stored = JSON.parse(checksFile('vpub-a')) as { format: string; checks: Record<string, IndexCheckRecord> }
  ok(
    '지우기 — 미확인으로 돌아간다(파일에서도 그 엔진이 빠진다)',
    cleared.status === 200 && afterClear.body.rows.find((r) => r.postId === 'p-aaaaaaaaaaa1')?.naver === null && stored.format === INDEX_CHECKS_FORMAT &&
      stored.checks['p-aaaaaaaaaaa1']?.naver === undefined && stored.checks['p-aaaaaaaaaaa1']?.key === trackingKey(NAVER),
  )

  // 동시 저장 — 8편 × 두 엔진을 한꺼번에
  const generic = ledgerA.filter((p) => p.id.startsWith('p-bbbbbbbbbb'))
  const want = (i: number, engine: string) => ((i + (engine === 'naver' ? 0 : 1)) % 2 === 0 ? 'shown' : 'not-yet')
  const many = await Promise.all(generic.flatMap((p, i) => ['naver', 'google'].map((engine) => put('vpub-a', p.id, { engine, state: want(i, engine) }))))
  const afterMany = await getStatus()
  const allKept = generic.every((p, i) => {
    const r = afterMany.body.rows.find((x) => x.postId === p.id)
    return r?.naver?.state === want(i, 'naver') && r.google?.state === want(i, 'google')
  })
  const fileAfter = JSON.parse(checksFile('vpub-a')) as { checks: Record<string, IndexCheckRecord> }
  ok(
    '동시 저장 — 16건 모두 200이고 하나도 사라지지 않는다(화면 · 파일)',
    many.every((r) => r.status === 200) && allKept && generic.every((p, i) => fileAfter.checks[p.id]?.naver?.state === want(i, 'naver') && fileAfter.checks[p.id]?.google?.state === want(i, 'google')),
  )

  // 검토 반영 — 같은 주소 한 편 · 다시 올린 글 · 브랜드 사이 같은 주소 · 줄 순서
  const rowsG = (s: PublishStatus) => s.rows.filter((r) => r.tenantId === 'vpub-g')
  const liveG = rowsG(first.body).filter((r) => r.kind === 'posted' && !r.removed)
  ok('발행 현황 — 같은 주소를 올린 날만 다르게 적은 두 줄은 한 줄(가장 이른 날)', liveG.length === 3 && liveG.filter((r) => r.url === SAME).map((r) => r.publishedOn).join() === '2026-10-30')
  const firstUnposted = first.body.rows.findIndex((r) => r.kind === 'unposted')
  const lastPosted = first.body.rows.map((r) => r.kind === 'posted' && !r.removed).lastIndexOf(true)
  ok('발행 현황 — 모든 브랜드의 올린 글이 아직 안 올린 배정 글보다 앞에 온다', firstUnposted > lastPosted)
  const sameA = await put('vpub-g', 'p-gggggggggg02', { engine: 'naver', state: 'shown' })
  const sameB = await put('vpub-g', 'p-gggggggggg03', { engine: 'google', state: 'not-yet' })
  const afterSame = await getStatus()
  const sameRows = rowsG(afterSame.body).filter((r) => r.url === SAME && !r.removed)
  ok(
    '같은 주소의 두 줄에 따로 눌러도 한 편의 표시 하나로 모인다',
    sameA.status === 200 && sameB.status === 200 && sameRows.length === 1 && sameRows[0]!.naver?.state === 'shown' && sameRows[0]!.google?.state === 'not-yet',
  )
  const repostPut = await put('vpub-g', 'p-gggggggggg05', { engine: 'google', state: 'not-yet' })
  ok('다시 올린 글에 표시하면 내리기 전 확인(올린 날보다 앞)을 이어받지 않는다', repostPut.status === 200 && repostPut.body.record?.naver === undefined && repostPut.body.record?.google?.state === 'not-yet')
  ok('내린 글에는 표시하지 않는다(409)', (await put('vpub-g', 'p-gggggggggg04', { engine: 'naver', state: 'shown' })).status === 409)
  const crossA = await put('vpub-a', 'p-aaaaaaaaaaa2', { engine: 'naver', state: 'shown' })
  const afterCross = await getStatus()
  ok('다른 고객 브랜드에 같은 주소가 있으면 한쪽 표시가 다른 쪽 줄에도 보인다', crossA.status === 200 && rowsG(afterCross.body).find((r) => r.url === TISTORY)?.naver?.state === 'shown')
  const crossG = await put('vpub-g', 'p-gggggggggg01', { engine: 'google', state: 'shown' })
  const afterCross2 = await getStatus()
  const tistoryA = afterCross2.body.rows.find((r) => r.tenantId === 'vpub-a' && r.url === TISTORY)
  ok(
    '다른 브랜드 줄에서 다른 엔진을 눌러도 앞 표시를 이어받는다(두 브랜드 줄이 같은 상태)',
    crossG.status === 200 && crossG.body.record?.naver?.state === 'shown' && tistoryA?.naver?.state === 'shown' && tistoryA.google?.state === 'shown',
  )
  const liveAll = afterCross2.body.rows.filter((r) => r.kind === 'posted' && !r.removed)
  ok('발행 현황 요약 — 모든 브랜드에서 서로 다른 주소로 센다', summarizeStatus(afterCross2.body.rows, afterCross2.body.today).posted === new Set(liveAll.map((r) => trackingKey(r.url!))).size)
  ok('vpub-g 원장도 바뀌지 않는다', readFileSync(path.join(dir, 'data', 'vpub-g', 'published-posts.json'), 'utf-8') === LEDGER_G)
  ok('원장(published-posts.json)은 한 글자도 바뀌지 않는다', readFileSync(path.join(dir, 'data', 'vpub-a', 'published-posts.json'), 'utf-8') === LEDGER_A)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 800))
  rmSync(dir, { recursive: true, force: true })
}

let failed = 0
for (const [text, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${text}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
