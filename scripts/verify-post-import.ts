/**
 * 주소 한꺼번에 등록(발행 현황 「주소 한꺼번에 등록」 — src/lib/postImport.ts · src/lib/postRegistration.ts · server/postImport.ts,
 * 2026-11-09)을 확인한다. 바깥 사이트는 부르지 않는다 — 가짜 블로그 서버(127.0.0.1:4191)와 임시 데이터 폴더의 서버(server/index.ts,
 * 포트 4192)를 띄워 HTTP로 부른다. 글 · 브랜드 · 작성자 · 주소는 모두 가짜다(실제 블로그 글을 옮기지 않았다).
 *
 * 왜:
 * - 작성자 8명이 메일로 보낸 주소를 운영자가 글마다 열어 앱 글과 맞춰 보고 CLI로 적었다(11-09 48건). 앱이 같은 일을 하되, 잘못 짝지은
 *   주소가 원장에 들어가면 성과 표가 엉뚱한 글의 인용을 센다 — 확실한 것만 「맞음」으로 미리 고르고 나머지는 사람이 고른다.
 * - 기록 모양은 CLI(scripts/register-posts.ts)와 「올렸어요」와 같아야 한다 — 같은 규칙 모듈을 쓰는지 본다.
 * - 바깥 주소를 서버가 읽는다 — 내부 주소(루프백 · 사설 · 링크 로컬 · 메타데이터)로 가는 요청을 DNS 뒤에서 막아야 한다. 이 확인만
 *   시험 깃발(POST_IMPORT_TEST_LOOPBACK=1)로 루프백을 연다.
 * - 페이지 날짜를 모르면 오늘로 채우지 않는다(확인 불가 원칙) — 사람이 고른 날만 적는다.
 *
 *   npx tsx scripts/verify-post-import.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StoredDraft } from '../src/lib/api'

const tmp = mkdtempSync(path.join(tmpdir(), 'verify-post-import-'))
const appRoot = path.join(tmp, 'app')
// 서버 모듈은 불러올 때 데이터 폴더를 정한다 — 불러오기 전에 둔다. 루프백 시험 깃발은 이 프로세스에서는 꺼 둔다.
process.env.APP_DATA_DIR = appRoot
delete process.env.POST_IMPORT_TEST_LOOPBACK

const checks: [string, boolean, string | undefined][] = []
/** detail은 실패했을 때만 찍는다. */
const ok = (label: string, cond: boolean, detail?: unknown) =>
  checks.push([label, cond, detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail)])

// ── 가짜 글 ─────────────────────────────────────────────────────────────────
const TEXT_A1 = [
  '가상시 원도심은 걸어서 둘러보기 좋은 골목이 이어져 있어 숙소 위치가 하루 동선을 정합니다.',
  '기차역에서 원도심까지는 버스로 십오 분 정도라 짐이 많다면 역 근처 숙소에 먼저 맡기는 편이 편합니다.',
  '오래된 시장과 근대 건물 거리가 가까워 아침 산책 뒤 바로 시장 국밥을 먹으러 가기 좋습니다.',
  '골목 안쪽 한옥 숙소는 밤에 조용하지만 차가 들어오기 어려워 짐을 끌고 걸어야 합니다.',
  '저녁에는 항구 쪽 야경 산책로가 이어져 원도심 숙소에서 걸어 나가 노을을 보기 쉽습니다.',
  '처음 방문한다면 원도심 중앙 광장에서 도보 십 분 안쪽 숙소를 고르면 대부분의 명소에 걸어서 닿습니다.',
]
const TEXT_A2 = [
  '가족 여행으로 차를 가져온다면 숙소 주차 칸 수와 진입로 폭부터 확인하는 편이 안전합니다.',
  '독채 숙소는 마당이 딸린 곳이 많아 바비큐 도구 대여 여부와 이용 시간을 미리 물어보세요.',
  '주말에는 주차장이 일찍 차므로 체크인 시간을 오후 이른 시각으로 잡으면 자리를 구하기 쉽습니다.',
  '대형 승합차라면 지하 주차장 높이 제한이 있는지 예약 전에 꼭 문의하셔야 합니다.',
  '독채는 이웃 객실 소음이 적어 아이와 함께 묵기에 편하지만 청소 도구 위치는 직접 챙겨야 합니다.',
  '근처 공영 주차장의 하루 요금과 숙소 무료 주차 조건을 비교하면 이틀 일정의 비용을 줄일 수 있습니다.',
]
const TEXT_C2 = [
  '반려견과 함께 묵을 숙소는 객실 바닥 재질과 미끄럼 방지 매트가 있는지부터 살펴보세요.',
  '대형견을 받는 곳은 드물어서 몸무게 기준과 추가 요금을 예약 단계에서 확인해야 합니다.',
  '산책로가 숙소 바로 앞에 있으면 아침저녁 배변 산책이 편하고 이웃 민원도 줄어듭니다.',
  '펫 전용 수건과 식기를 주는지, 목줄을 걸어 둘 고리가 있는지도 후기에서 자주 언급됩니다.',
  '반려견 동반 카페와 해변 출입 규칙은 계절마다 바뀌므로 출발 전에 공지를 다시 보세요.',
]
const TEXT_B1 = [
  '바다 전망 객실은 동향이면 일출을, 서향이면 노을을 객실 창으로 바로 볼 수 있습니다.',
  '방파제 산책로와 수산시장이 가까운 여관은 저녁에 회를 포장해 와서 먹기 좋습니다.',
  '파도 소리가 크게 들리는 저층 객실은 잠귀가 밝다면 피하는 편이 낫습니다.',
  '겨울 바다 바람이 세서 난방 방식과 창문 단열 상태를 미리 물어보는 손님이 많습니다.',
  '해안 도로 드라이브 코스 중간에 있어 차로 이동하는 여행자에게 위치가 편합니다.',
]
const TEXT_COMP = [
  '경쟁 여관의 조식 뷔페는 지역 농산물로 차려 제철 나물 반찬이 매일 바뀝니다.',
  '로비 서가에는 지역 작가의 사진집과 지도가 있어 비 오는 날 머물기 좋습니다.',
  '자전거 대여소가 입구 옆에 있어 강변 자전거길로 바로 나갈 수 있습니다.',
  '온돌방과 침대방 중에서 고를 수 있고 이불은 매번 새로 빨아 둡니다.',
]
const TEXT_OTHER = [
  '겨울 산행에는 아이젠과 스패츠를 챙기고 보온병에 따뜻한 차를 담아 가는 것이 좋습니다.',
  '능선에서는 바람막이 겉옷을 꺼내 입고 땀이 식기 전에 체온을 지켜야 합니다.',
  '하산 시간은 해 지기 두 시간 전으로 잡고 헤드랜턴 배터리를 미리 확인하세요.',
  '등산화 끈은 내리막에서 한 번 더 조여 발가락이 앞으로 밀리지 않게 합니다.',
]
const TEXT_A3 = [
  '단풍이 절정인 시월 말에는 고개 넘는 국도가 붐벼 이른 아침에 출발하는 편이 낫습니다.',
  '전망대 주차장은 오전 아홉 시 전에 차면 다음 휴게소까지 내려가 기다려야 합니다.',
  '고갯마루 휴게소의 군고구마와 호떡은 줄이 길어 현금을 조금 챙겨 두면 빠릅니다.',
  '안개가 짙은 날은 전조등을 켜고 급커브 구간에서 속도를 줄이는 것이 안전합니다.',
  '내려오는 길 계곡 옆 국숫집은 오후 세 시에 문을 닫으니 점심을 일찍 드세요.',
]
const TEXT_Q5 = [
  '비 오는 날 가상시 실내 전시관은 오전 열 시에 문을 열고 입장권은 현장에서만 팝니다.',
  '전시관 이층 카페는 창가 자리가 넓어 우산을 말리며 쉬어 가기 좋습니다.',
  '어린이 체험실은 회차마다 정원이 있어 도착하자마자 다음 회차 표를 받아 두세요.',
  '전시관 앞 버스 정류장은 원도심 순환 버스가 이십 분마다 섭니다.',
]

const draftOf = (actionId: string, title: string, text: string[]): StoredDraft => ({
  actionId,
  generatedAt: '2026-10-28T09:00:00.000Z',
  draft: {
    format: 'article',
    title,
    lead: text[0]!,
    sections: [
      { heading: '무엇부터 보나요?', answers: 'c1-001', blocks: text.slice(1, 3).map((body) => ({ kind: 'text' as const, role: 'key' as const, body })) },
      { heading: '고를 때 확인할 것', answers: 'c1-002', blocks: text.slice(3).map((body) => ({ kind: 'text' as const, body })) },
    ],
    gapCount: 0,
    usedFacts: [],
  },
})

// 가짜 브랜드 vpi-a(작성자 배정 · 질문지 v9) · vpi-b(배정 없음) · vpi-comp(비교용 경쟁사 — 후보가 되면 안 된다).
const QTEXT: Record<string, string> = {
  'c1-001': '가상시 원도심 걸어 다니기 좋은 숙소 어디야?',
  'c1-002': '가상시 기차역에서 가까운 조용한 숙소 추천해줘',
  'c1-003': '가상시 숙소 주차 편한 곳 후기 어디서 봐?',
  'c1-004': '가상시 독채 숙소 특징이 어때?',
  'c1-006': '가상시 근처 단풍 드라이브 코스 추천해줘',
  'c1-007': '가상시 고개 휴게소 먹거리 뭐가 유명해?',
}
const W1 = { key: 'w1', name: '가상 작성자 하나' }
const W2 = { key: 'w2', name: '가상 작성자 둘' }
const planArt = (ids: string[], name: string, writer: { key: string; name: string }) => ({
  id: `topic:${[...ids].sort().join('+')}`,
  name,
  angle: `${name} — 천천히 둘러보는 하루`,
  writer,
  blog: '',
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => QTEXT[id]!),
})
const A1 = planArt(['c1-001', 'c1-002'], '원도심 걸어서 다니는 숙소', W1)
const A2 = planArt(['c1-003', 'c1-004'], '주차 편한 독채 숙소', W2)
// A3는 추가 글 정의가 없는 배정 글(질문 은행 화면에서 만든 글 — 콘텐츠 보관함의 「판 미확인」) — 그 작성자(w2) 글이다.
const A3 = planArt(['c1-006', 'c1-007'], '단풍 드라이브 고개 휴게소', W2)
const PLAN = { format: 'probe-plan/2', tenantId: 'vpi-a', bankVersion: 'v9', activeUntil: '2027-03-31', source: { writers: 'docs/writers.json', seed: 7 }, articles: [A1, A2, A3] }
const C2_ID = 'content:c1-050'
const B1_ID = 'content:c2-001'
const COMP_ID = 'content:c3-001'
const DRAFT_A1 = draftOf(A1.id, '가상시 원도심 숙소 고르는 기준 {N}가지', TEXT_A1)
const DRAFT_A2 = draftOf(A2.id, '주차 편한 가상시 독채 숙소', TEXT_A2)
const DRAFT_C2 = draftOf(C2_ID, '반려견과 묵기 좋은 가상시 숙소', TEXT_C2)
const DRAFT_B1 = draftOf(B1_ID, '바다 전망 가상 여관 고르기', TEXT_B1)
const DRAFT_COMP = draftOf(COMP_ID, '경쟁 여관 이야기', TEXT_COMP)
// 추가 글 정의가 없는 질문 은행 글 — 등록할 때 질문 은행으로 판을 본다.
const Q5_ID = 'topic:c1-005'
const DRAFT_Q5 = draftOf(Q5_ID, '비 오는 날 가상시 실내 전시관', TEXT_Q5)
const DRAFT_A3 = draftOf(A3.id, '단풍 드라이브 길의 고개 휴게소', TEXT_A3)
const DRAFTS_A = { [A1.id]: DRAFT_A1, [A2.id]: DRAFT_A2, [C2_ID]: DRAFT_C2, [Q5_ID]: DRAFT_Q5, [A3.id]: DRAFT_A3 }
// A1은 배정 판(v9)으로 만든 추가 글 — 작성자 글이다. A2는 다른 판(v8)으로 만들어 배정 글로 세지 않는다(보관함 · 발행 현황과 같은 규칙).
const EXTRAS_A = {
  version: 1,
  articles: [
    { id: A1.id, name: A1.name, angle: A1.angle, bankVersion: 'v9', questionIds: A1.questionIds, questionTexts: A1.questionTexts, createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' },
    { id: A2.id, name: A2.name, angle: A2.angle, bankVersion: 'v8', questionIds: A2.questionIds, questionTexts: A2.questionTexts, createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' },
  ],
}

const FIX_PORT = 4191
// 4190은 fetch 규격의 막힌 포트(bad port)라 쓰지 않는다.
const API_PORT = 4192
const FIX = `http://127.0.0.1:${FIX_PORT}`
const API = `http://127.0.0.1:${API_PORT}`
const TAKEN_URL = `${FIX}/post/taken`
const LEDGER_A = {
  version: 1,
  keyRule: 3,
  posts: [
    { id: 'p-taken000001', url: TAKEN_URL, key: '127.0.0.1/post/taken', publishedOn: '2026-10-20', publishedOnSource: 'user', recordedAt: '2026-10-20T01:00:00.000Z', articleId: 'content:c1-099', targetActionId: 'content:c1-099', via: 'own', articleTitle: '다른 가상 글' },
  ],
}

// ── 가짜 블로그 페이지 ───────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const paragraphs = (text: string[]) => text.map((t) => `<p>${esc(t)}</p>`).join('\n')
function page(opts: { title: string; text: string[]; head?: string; bodyTop?: string; charset?: string }): string {
  return `<!doctype html><html><head><meta charset="${opts.charset ?? 'utf-8'}"><title>${esc(opts.title)} - 가상 블로그</title>
<meta property="og:title" content="${esc(opts.title)}">${opts.head ?? ''}
<style>p { color: red }</style></head><body><nav>메뉴 홈 소개 방명록</nav>${opts.bodyTop ?? ''}
<article><h1>${esc(opts.title)}</h1>${paragraphs(opts.text)}</article>
<footer>가상 블로그 꼬리말</footer><script>window.alert('읽지 않는다')</script></body></html>`
}
const jsonLd = (date: string) => `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"가상"},{"@type":"BlogPosting","datePublished":"${date}"}]}</script>`

/** EUC-KR 바이트 — TextDecoder('euc-kr')로 완성형 표를 거꾸로 만든다(노드에는 EUC-KR 인코더가 없다). */
const EUCKR = new Map<string, number[]>()
{
  const dec = new TextDecoder('euc-kr')
  for (let lead = 0xa1; lead <= 0xfe; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const ch = dec.decode(new Uint8Array([lead, trail]))
      if (ch.length === 1 && ch !== '�' && !EUCKR.has(ch)) EUCKR.set(ch, [lead, trail])
    }
  }
}
function eucKr(text: string): Buffer {
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) out.push(code)
    else {
      const bytes = EUCKR.get(ch)
      if (!bytes) throw new Error(`EUC-KR로 쓸 수 없는 글자: ${ch}`)
      out.push(...bytes)
    }
  }
  return Buffer.from(out)
}

const PAGES: Record<string, () => { status?: number; type?: string; body: string | Buffer; headers?: Record<string, string> }> = {
  '/post/a1': () => ({ body: page({ title: '원도심 걸어서 다니는 가상시 숙소', text: TEXT_A1, head: jsonLd('2026-11-01T10:00:00+09:00') }) }),
  '/post/a2': () => ({ body: page({ title: '차 가져가는 가족의 독채 숙소', text: TEXT_A2, bodyTop: '<time datetime="2026-11-02T09:00:00+09:00">11월 2일</time>' }) }),
  '/post/c2': () => ({ body: page({ title: '반려견 숙소 고르기', text: TEXT_C2, head: '<meta property="article:published_time" content="2026-11-03T08:00:00+09:00">' }) }),
  '/post/a3': () => ({ body: page({ title: '단풍 드라이브 고개 휴게소', text: TEXT_A3, head: jsonLd('2026-11-03T10:00:00+09:00') }) }),
  '/post/b1-euckr': () => ({
    type: 'text/html',
    body: eucKr(page({ title: '바다 전망 여관', text: TEXT_B1, charset: 'euc-kr' })),
  }),
  '/post/b1-copy': () => ({ body: page({ title: '바다 전망 여관(다시 올림)', text: TEXT_B1 }) }),
  '/post/mix': () => ({ body: page({ title: '가상시 숙소 이야기', text: [...TEXT_A1.slice(0, 3), ...TEXT_A2.slice(0, 3)], head: jsonLd('2026-11-04T10:00:00+09:00') }) }),
  '/post/other': () => ({ body: page({ title: '겨울 산행 준비물', text: TEXT_OTHER, head: jsonLd('2026-11-05T10:00:00+09:00') }) }),
  '/post/comp': () => ({ body: page({ title: '경쟁 여관 이야기', text: TEXT_COMP, head: jsonLd('2026-11-05T10:00:00+09:00') }) }),
  '/post/taken': () => ({ body: page({ title: '반려견 숙소', text: TEXT_C2, head: jsonLd('2026-10-20T10:00:00+09:00') }) }),
  '/post/empty': () => ({ body: page({ title: '사진만 있는 글', text: ['사진'], head: jsonLd('2026-11-05T10:00:00+09:00') }) }),
  // 같은 글의 다른 주소 — 정식 주소(canonical)를 밝힌 페이지, 다른 사이트를 정식 주소로 적은 페이지(따르지 않는다), 블로그 홈으로 넘기는 지운 글.
  '/amp/a1': () => ({ body: page({ title: '원도심 걸어서 다니는 가상시 숙소', text: TEXT_A1, head: `<link rel="canonical" href="${FIX}/post/a1">${jsonLd('2026-11-01T10:00:00+09:00')}` }) }),
  '/post/canon-other': () => ({ body: page({ title: '반려견 숙소 고르기', text: TEXT_C2, head: `<link rel="canonical" href="http://elsewhere.example/post/c2">${jsonLd('2026-11-03T08:00:00+09:00')}` }) }),
  '/gone': () => ({ status: 301, body: '', headers: { Location: '/' } }),
  '/': () => ({ body: page({ title: '가상 블로그 홈', text: TEXT_OTHER }) }),
  '/big': () => ({ body: `<html><body><article>${'가'.repeat(1_200_000)}</article></body></html>` }),
  '/to-private': () => ({ status: 302, body: '', headers: { Location: 'http://10.255.255.1/secret' } }),
  '/rss': () => ({
    type: 'application/rss+xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>가상</title><link>${FIX}/</link>
<item><title><![CDATA[원도심]]></title><link><![CDATA[${FIX}/post/a1]]></link></item>
<item><title>반려견</title><link>${FIX}/post/c2</link></item></channel></rss>`,
  }),
  '/sitemap.xml': () => ({
    type: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${FIX}/</loc></url><url><loc>${FIX}/category/stay</loc></url><url><loc>${FIX}/tag/sea</loc></url>
<url><loc>${FIX}/post/a1</loc></url><url><loc>${FIX}/post/a2</loc></url><url><loc>${FIX}/post/other</loc></url>
<url><loc>${FIX}/post/taken</loc></url><url><loc>http://elsewhere.example/post/9</loc></url></urlset>`,
  }),
}
let inFlight = 0
let maxInFlight = 0
function fixtureHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', FIX)
  // 워드프레스 ?p=번호 주소 — 고유 주소로 넘긴다.
  if (url.pathname === '/' && url.searchParams.get('p') === '1') {
    res.writeHead(301, { Location: '/post/a1' })
    res.end()
    return
  }
  const hop = /^\/hop\/(\d+)$/.exec(url.pathname)
  if (hop) {
    const n = Number(hop[1])
    if (n === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGES['/post/a1']!().body)
    } else {
      res.writeHead(301, { Location: `/hop/${n - 1}` })
      res.end()
    }
    return
  }
  const slow = /^\/slow\/(\d+)$/.exec(url.pathname)
  if (slow) {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    setTimeout(() => {
      inFlight -= 1
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page({ title: `느린 글 ${slow[1]}`, text: TEXT_OTHER, head: jsonLd('2026-11-05T10:00:00+09:00') }))
    }, 400)
    return
  }
  const make = PAGES[url.pathname]
  if (!make) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body>없는 글</body></html>')
    return
  }
  const r = make()
  res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'text/html; charset=utf-8', ...(r.headers ?? {}) })
  res.end(r.body)
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })

const put = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

let fixture: ReturnType<typeof createServer> | null = null
let server: ReturnType<typeof spawn> | null = null
try {
  const pi = await import('../src/lib/postImport')
  const pr = await import('../src/lib/postRegistration')
  const reg = await import('./register-posts')
  const { parseWriterPlan } = await import('../src/lib/probePlan')
  const { normalizeExtraArticles } = await import('../src/lib/extraArticles')
  const { draftTitle } = await import('../src/lib/markdownFile')
  const { effectiveDraft } = await import('../src/lib/draftGaps')
  const { todayKst } = await import('../src/lib/publishedUrl')
  const plan = parseWriterPlan(PLAN).plan!
  ok('가짜 배정 파일이 앱 검사를 통과함', Boolean(plan))
  const extras = normalizeExtraArticles(EXTRAS_A)
  const today = todayKst()

  // ── 1. 붙여 넣은 메일에서 주소 찾기 ─────────────────────────────────────────
  const WP1 =
    'https://fakewriter.wordpress.com/2026/11/07/%ea%b8%b0%eb%85%90%ec%9d%bc-%ea%b0%80%ec%83%81-1%eb%b0%95-%ec%b2%b4%ed%81%ac%ec%9d%b8%ea%b3%bc-%ec%88%99%ec%86%8c%ec%97%90%ec%84%9c-%ec%a6%90%ea%b8%b0%eb%8a%94-%eb%b0%b0%eb%8b%ac/'
  const WP2_HEAD = 'https://fakewriter.wordpress.com/2026/11/07/%ea%b0%80%ec%83%81-%ec%bb%a4%ed%94%8c-%ec%97%ac%ed%96%89-'
  const WP2_TAIL = '%ed%8e%9c%ec%85%98-%ec%98%88%ec%95%bd/'
  const email = [
    '-----Original Message-----',
    'From: 가상 작성자 하나',
    'Sent: Monday, November 9, 2026 3:12 PM',
    'To: 가상 운영자',
    'Subject: 오늘 올린 글 주소입니다',
    '',
    '안녕하세요. 오늘 올린 글 보내드립니다.',
    `1) ${WP1}<${WP1}>`,
    `2) <${WP2_HEAD}`,
    `${WP2_TAIL}>`,
    '3) 네이버: https://blog.naver.com/fakewriter/224470026946.',
    '4) https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ffakewriter.tistory.com%2F13&data=05%7C02%7Cfake%7C0&sdata=abc&reserved=0',
    '5) 블로그 홈: https://blog.naver.com/fakewriter',
    '6) 짧은 주소: https://naver.me/xAbCdEf',
    '7) 다시 한 번(모바일): https://m.blog.naver.com/fakewriter/224470026946',
    '8) (https://fakewriter.tistory.com/14), 그리고 https://blog.naver.com/fakewriter/224470028121입니다',
    '감사합니다.',
  ].join('\r\n')
  const ex = pi.extractPostUrls(email)
  ok(
    '메일 붙여 넣기 — 글 주소만(줄 끝 마침표 · 괄호 · 쉼표 · 붙은 한글을 떼고, <…> 안에서 줄이 바뀐 긴 주소는 잇고, Outlook 안전 링크는 원래 주소로)',
    JSON.stringify(ex.urls) ===
      JSON.stringify([
        WP1,
        `${WP2_HEAD}${WP2_TAIL}`,
        'https://blog.naver.com/fakewriter/224470026946',
        'https://fakewriter.tistory.com/13',
        'https://fakewriter.tistory.com/14',
        'https://blog.naver.com/fakewriter/224470028121',
      ]),
    ex.urls,
  )
  ok('메일 붙여 넣기 — 같은 글(추적 키)이 두 번이면 한 번만 · 몇 개를 겹쳐 뺐는지 센다', ex.duplicates === 2, ex)
  ok(
    '메일 붙여 넣기 — 글 주소가 아닌 것은 이유와 함께 건너뜀(블로그 홈 · 단축 주소)',
    ex.ignored.length === 2 &&
      ex.ignored.some((i) => i.url === 'https://blog.naver.com/fakewriter' && i.reason.includes('블로그 홈')) &&
      ex.ignored.some((i) => i.url === 'https://naver.me/xAbCdEf' && i.reason.includes('단축 주소')),
    ex.ignored,
  )
  ok('메일 붙여 넣기 — 주소가 없으면 빈 결과', pi.extractPostUrls('주소 없는 메일입니다.').urls.length === 0)
  const tagged = pi.extractPostUrls(
    [
      '1) https://fakewriter.tistory.com/1044(가상군산)',
      '2) https://blog.naver.com/fakewriter/224012345678(가상스테이,가상머뭄),',
      '3) https://fakewriter.wordpress.com/2026/11/07/fake-trip/(가상군산)',
      '4) https://ko.wikipedia.org/wiki/가상_(도시)',
    ].join('\n'),
  )
  ok(
    '메일 붙여 넣기 — 주소 바로 뒤에 붙은 「(브랜드)」 꼬리표는 뗌(글 번호 뒤 · ASCII 주소 뒤) · 주소 안의 한글 괄호는 그대로',
    JSON.stringify(tagged.urls) ===
      JSON.stringify([
        'https://fakewriter.tistory.com/1044',
        'https://blog.naver.com/fakewriter/224012345678',
        'https://fakewriter.wordpress.com/2026/11/07/fake-trip/',
        'https://ko.wikipedia.org/wiki/가상_(도시)',
      ]),
    tagged.urls,
  )
  ok(
    '주소 끝 글자 떼기 — ASCII 주소 끝에 붙은 한글만 떼어 본 주소(404일 때 한 번 더 읽는다), 뗄 것이 없으면 null',
    pi.withoutTrailingText('https://fakewriter.wordpress.com/2026/11/07/fake-trip/입니다') === 'https://fakewriter.wordpress.com/2026/11/07/fake-trip/' &&
      pi.withoutTrailingText('http://127.0.0.1:4191/p/a2입니다') === 'http://127.0.0.1:4191/p/a2' &&
      pi.withoutTrailingText('https://fakewriter.tistory.com/13') === null &&
      pi.withoutTrailingText('https://fakewriter.tistory.com/입니다') === null,
  )

  // ── 2. 플랫폼 · 읽을 주소 ──────────────────────────────────────────────────
  ok(
    '플랫폼 — 네이버 블로그 · 티스토리 · 워드프레스(.com) · 그 밖',
    pi.postPlatformOf('https://blog.naver.com/fakewriter/224470026946') === 'naver' &&
      pi.postPlatformOf('https://m.blog.naver.com/fakewriter/224470026946') === 'naver' &&
      pi.postPlatformOf('https://fakewriter.tistory.com/13') === 'tistory' &&
      pi.postPlatformOf(WP1) === 'wordpress' &&
      pi.postPlatformOf('https://example.com/blog/1') === 'generic',
  )
  ok(
    '읽을 주소 — 네이버 글은 PostView(본문이 든 페이지)로, 나머지는 그대로',
    pi.readTargetOf('https://blog.naver.com/fakewriter/224470026946') === 'https://blog.naver.com/PostView.naver?blogId=fakewriter&logNo=224470026946' &&
      pi.readTargetOf('https://m.blog.naver.com/fakewriter/224470026946?referrerCode=0') === 'https://blog.naver.com/PostView.naver?blogId=fakewriter&logNo=224470026946' &&
      pi.readTargetOf('https://blog.naver.com/fakewriter?Redirect=Log&logNo=224470026946') === 'https://blog.naver.com/PostView.naver?blogId=fakewriter&logNo=224470026946' &&
      pi.readTargetOf('https://fakewriter.tistory.com/13') === 'https://fakewriter.tistory.com/13',
  )

  // ── 3. 페이지 읽기(플랫폼별) ───────────────────────────────────────────────
  // now = 2026-11-09 14:00 KST
  const NOW = Date.UTC(2026, 10, 9, 5, 0, 0)
  const naverHtml = (date: string, title = '가상 네이버 글 &middot; 하나') =>
    `<html><head><meta property="og:title" content="${title}"/></head><body><div class="se-viewer"><div class="blog2_container"><span class="se_publishDate pcol2">${date}</span></div>
<div class="se-main-container"><div class="se-component se-text"><div class="se-module"><p class="se-text-paragraph"><span>${TEXT_A1[0]}</span></p></div></div>
<div class="se-component se-text"><div class="se-module"><p><span>${TEXT_A1[1]}</span></p></div></div></div>
<div class="comment_area">댓글 쓰기 공감 이 글은 본문이 아니다</div></div><script>var x = '${TEXT_OTHER[0]}'</script></body></html>`
  const nAbs = pi.parsePostHtml('naver', naverHtml('2026. 11. 7. 14:03'), NOW)
  ok(
    '네이버 — og:title(엔티티 풀기) · 「2026. 11. 7. 14:03」 날짜 · 본문은 se-main-container만(댓글 · 스크립트 빼고)',
    nAbs.title === '가상 네이버 글 · 하나' &&
      nAbs.publishedOn === '2026-11-07' &&
      nAbs.body.includes(TEXT_A1[0]!) &&
      nAbs.body.includes(TEXT_A1[1]!) &&
      !nAbs.body.includes('댓글') &&
      !nAbs.body.includes(TEXT_OTHER[0]!),
    nAbs,
  )
  const nRel = (raw: string, now = NOW) => pi.parsePostHtml('naver', naverHtml(raw), now).publishedOn
  ok('네이버 — 「2시간 전」은 지금(한국 시각)에서 센 날', nRel('2시간 전') === '2026-11-09')
  ok('네이버 — 「15시간 전」은 어제(한국 날짜가 넘어감)', nRel('15시간 전') === '2026-11-08')
  ok('네이버 — 「35분 전」 · 「방금 전」 · 「어제」', nRel('35분 전') === '2026-11-09' && nRel('방금 전') === '2026-11-09' && nRel('어제 21:10') === '2026-11-08')
  // now = 2026-11-10 00:30 KST(UTC로는 11-09 15:30) — UTC 날짜로 세면 하루 틀린다.
  ok('네이버 — 한국 자정 직후 「2시간 전」은 한국 날짜로 전날', nRel('2시간 전', Date.UTC(2026, 10, 9, 15, 30)) === '2026-11-09' && nRel('10분 전', Date.UTC(2026, 10, 9, 15, 30)) === '2026-11-10')
  // 네이버는 지난 시간을 내림해 보인다(실측 4시간 48분 → 「4시간 전」). 11-08 23:50 KST에 올린 글은 11-09 01:40에 「1시간 전」, 09:30에
  // 「9시간 전」이다 — 그 구간([지금 − (N+1)단위, 지금 − N단위])이 자정을 걸치면 어느 날인지 모른다.
  const nAmb = (raw: string, now: number) => pi.parsePostHtml('naver', naverHtml(raw), now)
  const at0140 = nAmb('1시간 전', Date.UTC(2026, 10, 8, 16, 40))
  ok('네이버 — 「1시간 전」 @11-09 01:40 KST는 자정을 걸쳐 날을 정하지 않음(null · 까닭 ambiguous)', at0140.publishedOn === null && at0140.dateProblem === 'ambiguous', at0140)
  ok('네이버 — 「9시간 전」 @09:30 KST · 「3일 전」 · 자정 30초 뒤 「방금 전」도 null', nRel('9시간 전', Date.UTC(2026, 10, 9, 0, 30)) === null && nRel('3일 전') === null && nRel('방금 전', Date.UTC(2026, 10, 9, 15, 0, 30)) === null)
  ok('네이버 — 구간이 한 날 안이면 그 날(「15시간 전」 @14:00 → 11-08 22:00~23:00)', nRel('15시간 전') === '2026-11-08' && nAmb('15시간 전', NOW).dateProblem === null)
  const nUnknown = pi.parsePostHtml('naver', naverHtml('얼마 전'), NOW)
  ok('네이버 — 읽지 못한 날짜는 null(오늘로 채우지 않음) · 읽은 글자 · 까닭(unknown)은 남김', nUnknown.publishedOn === null && nUnknown.dateText === '얼마 전' && nUnknown.dateProblem === 'unknown', nUnknown)
  ok('날짜 — 미래 날짜는 쓰지 않음(null · 까닭 future) · 2020년 전은 early', nRel('2027. 1. 5. 10:00') === null && nAmb('2027. 1. 5. 10:00', NOW).dateProblem === 'future' && nAmb('2019. 12. 31. 10:00', NOW).dateProblem === 'early')
  ok('날짜 — 날짜 글자가 없으면 까닭도 없음', pi.parsePostHtml('generic', '<html><body><main><p>날짜 없는 글</p></main></body></html>', NOW).dateProblem === null)
  ok('날짜 까닭 — 화면 문구가 모두 있음', (['future', 'early', 'ambiguous', 'unknown'] as const).every((k) => typeof pi.DATE_PROBLEM_TEXT[k] === 'string' && pi.DATE_PROBLEM_TEXT[k].length > 0))

  const tistoryHtml = `<html><head><meta property="og:title" content="가상 티스토리 글"><meta property="article:published_time" content="2026-11-08T23:40:00+09:00"></head>
<body><div class="tt_category">카테고리</div><div class="entry-content"><div class="contents_style"><p>${TEXT_A2[0]}</p><div><p>${TEXT_A2[1]}</p></div></div>
<div class="article-tag">태그 목록</div></div><div class="another_category">이 글과 관련된 다른 글</div></body></html>`
  const tPost = pi.parsePostHtml('tistory', tistoryHtml, NOW)
  ok(
    '티스토리 — og:title · article:published_time(한국 날짜) · 본문은 contents_style(태그 · 관련 글 빼고)',
    tPost.title === '가상 티스토리 글' && tPost.publishedOn === '2026-11-08' && tPost.body.includes(TEXT_A2[1]!) && !tPost.body.includes('관련된') && !tPost.body.includes('태그 목록'),
    tPost,
  )
  // 워드프레스 article:published_time이 UTC로 적혀 있어도 한국 날짜로 바꾼다.
  const wpHtml = `<html><head><meta property='og:title' content='가상 워드프레스 &#8216;글&#8217;' /><meta property='article:published_time' content='2026-11-06T16:30:00+00:00' /></head>
<body><header>사이트 이름</header><article class="post"><h1 class="entry-title">가상 워드프레스 글</h1><div class="entry-content"><p>${TEXT_C2[0]}</p><p>${TEXT_C2[1]}</p></div><footer class="entry-footer">분류 없음</footer></article><aside>최근 글 목록</aside></body></html>`
  const wPost = pi.parsePostHtml('wordpress', wpHtml, NOW)
  ok('워드프레스 — 작은따옴표 meta · 숫자 엔티티 · UTC 시각은 한국 날짜로 · 본문은 entry-content', wPost.title === '가상 워드프레스 ‘글’' && wPost.publishedOn === '2026-11-07' && wPost.body.includes(TEXT_C2[1]!) && !wPost.body.includes('최근 글'), wPost)
  const gPost = pi.parsePostHtml('generic', page({ title: '가상 일반 글', text: TEXT_B1, head: jsonLd('2026-11-01T10:00:00+09:00') }), NOW)
  ok('그 밖 — JSON-LD datePublished(@graph 안) · <article> 본문(메뉴 · 꼬리말 · 스크립트 · 스타일 빼고)', gPost.publishedOn === '2026-11-01' && gPost.body.includes(TEXT_B1[4]!) && !gPost.body.includes('메뉴') && !gPost.body.includes('읽지 않는다') && !gPost.body.includes('color'), gPost)
  const gTime = pi.parsePostHtml('generic', page({ title: '시간 태그 글', text: TEXT_B1, bodyTop: '<time datetime="2026-10-31">10월 31일</time>' }), NOW)
  ok('그 밖 — <time datetime>', gTime.publishedOn === '2026-10-31', gTime)
  const gNone = pi.parsePostHtml('generic', '<html><head><title>제목만 &amp; 있음</title></head><body><main><p>본문 한 줄</p></main></body></html>', NOW)
  ok('그 밖 — og:title이 없으면 <title> · 날짜가 없으면 null · <main> 본문', gNone.title === '제목만 & 있음' && gNone.publishedOn === null && gNone.body.includes('본문 한 줄'), gNone)
  const gCanon = pi.parsePostHtml('generic', page({ title: '정식 주소 글', text: TEXT_B1, head: '<link rel="canonical" href="/post/b1"><meta property="og:url" content="https://fake.example/og">' }), NOW)
  ok('그 밖 — 페이지가 밝힌 정식 주소(canonical · og:url)를 읽음', gCanon.canonical === '/post/b1' && gCanon.ogUrl === 'https://fake.example/og', gCanon)
  ok('그 밖 — 닫히지 않은 태그 뒤 글자 · 엔티티 · 줄바꿈', pi.htmlToText('<p>가&amp;나</p>\r\n\r\n<div>다 <b>라</b></div><p>마 < 바') === '가&나\n다 라\n마 < 바', pi.htmlToText('<p>가&amp;나</p>\r\n\r\n<div>다 <b>라</b></div><p>마 < 바'))

  // 망가진 페이지 — 닫는 짝이 없는 태그 · 주석이 많아도 페이지 크기에 비례해 끝나야 한다(정규식이 시작 위치마다 문서 끝까지 다시 훑으면
  // 200KB에 44초 — 그동안 서버 전체가 멈춘다). 1MB씩, 하나에 1초 안.
  const MB = 1_000_000
  const timed = (fn: () => unknown) => {
    const t0 = performance.now()
    fn()
    return Math.round(performance.now() - t0)
  }
  const brokenPages: [string, string][] = [
    ['「>」 없는 「<a 」 반복', `<html><head><title>x</title></head><body>${'<a '.repeat(MB / 3)}`],
    ['닫히지 않은 주석 반복', `<html><body><p>본문</p>${'<!-- x '.repeat(MB / 7)}`],
    ['닫히지 않은 <script> 반복', '<script>'.repeat(MB / 8)],
    ['닫히지 않은 <nav> 반복', `<body>${'<nav>가'.repeat(MB / 6)}</body>`],
    ['닫히지 않은 <title> 반복', '<title>'.repeat(MB / 7)],
    ['닫히지 않은 <div class=se-main-container> 반복', '<div class="se-main-container">'.repeat(MB / 32)],
    ['「>」 없는 <meta 반복', `<head>${'<meta property="og:title" '.repeat(MB / 26)}`],
    ['아주 긴 속성 이름', `<div ${'a'.repeat(MB)}>본문</div>`],
    ['닫히지 않은 따옴표 속성 반복', `<p>${'<i a="'.repeat(MB / 6)}`],
    ['줄바꿈 없는 \\r 반복', `<p>${'\r'.repeat(MB)}x</p>`],
    ['닫히지 않은 <time 반복', `<p>${'<time datetime="2026-11-01" '.repeat(MB / 28)}`],
    ['닫히지 않은 ld+json 반복', '<script type="application/ld+json">{'.repeat(MB / 38)],
  ]
  for (const [label, html] of brokenPages) {
    const ms = Math.max(...(['naver', 'generic'] as const).map((p) => timed(() => pi.parsePostHtml(p, html, NOW))))
    ok(`망가진 페이지 1MB — ${label}: 1초 안(${ms}ms)`, ms < 1000, `${ms}ms`)
  }
  const brokenLists: [string, () => unknown][] = [
    ['사이트맵 — 닫히지 않은 <url> 반복', () => pi.parseSitemap('<url>'.repeat(MB / 5))],
    ['사이트맵 — <url> 하나 안에 닫히지 않은 <loc> 반복', () => pi.parseSitemap(`<urlset><url>${'<loc>'.repeat(MB / 5)}</url></urlset>`)],
    ['사이트맵 — 「>」 없는 <url 반복', () => pi.parseSitemap('<url '.repeat(MB / 5))],
    ['RSS — 닫히지 않은 <link> 반복', () => pi.parseFeedLinks('<link>'.repeat(MB / 6))],
    ['RSS — 「>」 없는 <link 반복', () => pi.parseFeedLinks('<link '.repeat(MB / 6))],
    ['RSS — 닫히지 않은 <guid> 반복', () => pi.parseFeedLinks(`<rss>${'<guid>https://x.example/1'.repeat(MB / 26)}`)],
  ]
  for (const [label, fn] of brokenLists) {
    const ms = timed(fn)
    ok(`망가진 목록 1MB — ${label}: 1초 안(${ms}ms)`, ms < 1000, `${ms}ms`)
  }
  const bigNormal = page({ title: '큰 가상 글', text: Array.from({ length: 12_000 }, (_, i) => `${TEXT_A1[i % TEXT_A1.length]!} <a href="/t/${i}">태그 ${i}</a>`) })
  const msNormal = timed(() => pi.parsePostHtml('generic', bigNormal, NOW))
  ok(`보통 모양의 큰 페이지(${Math.round(bigNormal.length / 1000)}KB) — 1초 안(${msNormal}ms) · 본문을 다 읽음`, msNormal < 1000 && pi.parsePostHtml('generic', bigNormal, NOW).body.includes('태그 11999'), `${msNormal}ms`)

  // ── 4. 맞음 정도 · 상태 ─────────────────────────────────────────────────────
  const m = pi.MATCH_RULE
  ok('기준 — 맞음 본문 0.35 이상 · 다음 후보와 0.15 이상 차이, 확인 필요 0.2 이상', m.matchBody === 0.35 && m.matchGap === 0.15 && m.reviewBody === 0.2)
  const decisions: [number[], string][] = [
    [[0.43, 0.27], 'match'], // 실측: 맞는 글의 가장 낮은 본문 겹침 · 다른 글의 가장 높은 겹침
    [[0.85, 0.2], 'match'],
    [[0.35, 0.2], 'match'], // 경계(같으면 맞음)
    [[0.5], 'match'], // 후보가 하나뿐
    [[0.4, 0.3], 'review'], // 두 글이 비슷하게 겹침
    [[0.3, 0.1], 'review'],
    [[0.2, 0], 'review'],
    [[0.16, 0.14], 'none'], // 실측: 앱 글이 아닌 글의 가장 높은 겹침
    [[], 'none'],
  ]
  for (const [scores, want] of decisions) ok(`판정 — 본문 겹침 [${scores.join(', ')}] → ${want}`, pi.decideMatch(scores) === want, pi.decideMatch(scores))
  const g = pi.bigrams('가나다 가나! {N}AB')
  ok('2글자 묶음 — 기호 · 공백 · {N}을 빼고 이어 센다', [...g].sort().join(',') === ['가나', '나다', '다가', '나A', 'AB'].sort().join(','), [...g])
  ok('겹침(Jaccard) — 같으면 1, 하나가 비면 0', pi.jaccard(g, g) === 1 && pi.jaccard(g, new Set()) === 0)
  const mt = pi.draftMatchText(DRAFT_A1)
  ok('초안 비교 글 — 제목 · 첫머리와 절 본문', mt.title === DRAFT_A1.draft.title && mt.body.includes(TEXT_A1[0]!) && mt.body.includes(TEXT_A1[5]!), mt)
  const edited = pi.draftMatchText({ ...DRAFT_A1, editedMarkdown: '# 고친 제목\n\n고친 본문입니다.' })
  ok('초안 비교 글 — 고친 글이 있으면 그 # 제목 · 그 글', edited.title === '고친 제목' && edited.body.includes('고친 본문입니다'), edited)

  // ── 5. 줄 상태 ──────────────────────────────────────────────────────────────
  const cand = (tenantId: string, articleId: string, body: number) => ({
    tenantId,
    brand: tenantId,
    articleId,
    title: articleId,
    body,
    titleScore: 0.5,
    writer: null,
    writerUnknown: false,
    otherUrls: 0,
  })
  const readOf = (candidates: ReturnType<typeof cand>[], known: import('../src/lib/postImport').KnownRecord[] = [], publishedOn: string | null = '2026-11-01') =>
    ({
      ok: true,
      url: 'https://fake.tistory.com/1',
      key: 'fake.tistory.com/1',
      recordUrl: 'https://fake.tistory.com/1',
      recordKey: 'fake.tistory.com/1',
      urlNote: null,
      platform: { key: 'tistory', label: '티스토리' },
      post: { title: '가짜', publishedOn, dateText: null, dateProblem: null, bodyChars: 500 },
      candidates,
      known,
    }) as import('../src/lib/postImport').PostImportRead
  const known = (tenantId: string, articleId: string, over: Partial<import('../src/lib/postImport').KnownRecord> = {}) => ({
    tenantId,
    brand: tenantId,
    articleId,
    targetActionId: articleId,
    via: 'own',
    articleTitle: '적힌 글',
    publishedOn: '2026-11-01',
    legacy: false,
    ...over,
  })
  const rMatch = readOf([cand('t1', 'a', 0.6), cand('t1', 'b', 0.2)])
  ok('줄 — 맞음이면 첫 후보를 고르고 체크해 둠', pi.rowStateOf(rMatch, pi.autoPick(rMatch)).state === 'match' && pi.checkedByDefault(rMatch) && pi.autoPick(rMatch)?.articleId === 'a')
  const rReview = readOf([cand('t1', 'a', 0.42), cand('t2', 'b', 0.33)])
  ok('줄 — 확인 필요는 첫 후보를 보이되 체크하지 않음', pi.rowStateOf(rReview, pi.autoPick(rReview)).state === 'review' && !pi.checkedByDefault(rReview) && pi.autoPick(rReview)?.articleId === 'a')
  const rNone = readOf([cand('t1', 'a', 0.12)])
  ok('줄 — 앱 글 아님은 고른 글 없음 · 체크 안 함', pi.rowStateOf(rNone, pi.autoPick(rNone)).state === 'none' && pi.autoPick(rNone) === null && !pi.checkedByDefault(rNone))
  const rAlready = readOf([cand('t1', 'a', 0.6)], [known('t1', 'a')])
  ok('줄 — 그 글 자사 · 직접 줄에 이미 있는 주소는 「이미 등록됨」 · 체크 안 함', pi.rowStateOf(rAlready, pi.autoPick(rAlready)).state === 'already' && !pi.checkedByDefault(rAlready))
  const rOther = readOf([cand('t1', 'a', 0.6)], [known('t1', 'z')])
  ok('줄 — 다른 글의 주소면 「다른 글로 등록됨」(막음)', pi.rowStateOf(rOther, pi.autoPick(rOther)).state === 'other' && !pi.checkedByDefault(rOther))
  const rOtherBrand = readOf([cand('t1', 'a', 0.6)], [known('t2', 'a')])
  ok('줄 — 다른 브랜드에 적힌 주소도 「다른 글로 등록됨」', pi.rowStateOf(rOtherBrand, pi.autoPick(rOtherBrand)).state === 'other')
  const rChannel = readOf([cand('t1', 'a', 0.6)], [known('t1', 'a', { targetActionId: 'channel:tistory', via: 'channel' })])
  ok('줄 — 같은 글의 채널 줄에만 있는 주소는 새로 적을 수 있음(CLI · 「올렸어요」와 같다)', pi.rowStateOf(rChannel, pi.autoPick(rChannel)).state === 'match' && pi.checkedByDefault(rChannel))
  const rLegacy = readOf([cand('t1', 'a', 0.6)], [known('t1', 'a', { legacy: true, via: 'direct', publishedOn: null })])
  ok('줄 — 예전 방식으로 적힌 같은 글 주소는 「이미 등록됨」(새로 적지 않음)', pi.rowStateOf(rLegacy, pi.autoPick(rLegacy)).state === 'already')
  const rSecond = readOf([cand('t1', 'a', 0.5), cand('t1', 'b', 0.45)], [known('t1', 'b')])
  ok('줄 — 이 주소가 둘째 후보 글에 이미 적혀 있으면 그 글을 골라 「이미 등록됨」(사람이 고른 것을 다시 읽어도)', pi.autoPick(rSecond)?.articleId === 'b' && pi.rowStateOf(rSecond, pi.autoPick(rSecond)).state === 'already')
  ok('줄 — 사람이 다른 글을 고르면 그 글로 다시 봄', pi.rowStateOf(rOther, { tenantId: 't1', articleId: 'z' }).state === 'already')
  const rNoDate = readOf([cand('t1', 'a', 0.6), cand('t1', 'b', 0.1)], [], null)
  ok('줄 — 날짜를 모르는 맞음 줄도 체크는 하되(사람이 날을 고르면 등록) 상태는 맞음', pi.rowStateOf(rNoDate, pi.autoPick(rNoDate)).state === 'match' && pi.checkedByDefault(rNoDate))
  const rFail = { ok: false, url: 'https://fake.tistory.com/2', key: 'fake.tistory.com/2', error: '페이지를 찾지 못했습니다(HTTP 404).' } as import('../src/lib/postImport').PostImportRead
  ok('줄 — 읽지 못한 주소는 「읽지 못함」', pi.rowStateOf(rFail, null).state === 'unreadable' && !pi.checkedByDefault(rFail) && pi.ROW_STATE_LABEL.unreadable === '읽지 못함')
  // 상태는 사람이 고른 글을 기준으로 — 맞음 줄에서 더 약한 후보를 고르면(키보드 화살표 한 번으로도) 「맞음」이 아니다.
  const rStrong = readOf([cand('t1', 'a', 0.99), cand('t1', 'b', 0.26)])
  ok('줄 — 맞음 줄에서 더 약한 후보를 고르면 「직접 고름」', pi.rowStateOf(rStrong, { tenantId: 't1', articleId: 'b' }).state === 'manual' && pi.ROW_STATE_LABEL.manual === '직접 고름')
  ok('줄 — 처음 고른 글로 되돌리면 다시 「맞음」', pi.rowStateOf(rStrong, { tenantId: 't1', articleId: 'a' }).state === 'match')
  ok('줄 — 앱 글 아님 줄에서 후보를 고르면 「직접 고름」(앱 글 아님이 아님)', pi.rowStateOf(rNone, { tenantId: 't1', articleId: 'a' }).state === 'manual')
  ok('줄 — 확인 필요 줄에서 둘째 후보를 고르면 「직접 고름」', pi.rowStateOf(rReview, { tenantId: 't2', articleId: 'b' }).state === 'manual')
  ok(
    '줄 — 사람이 「앱 글 아님」을 고르면 「앱 글 아님(직접)」, 처음부터 앱 글 아님이면 그대로',
    pi.rowStateOf(rReview, null).state === 'dismissed' && pi.rowStateOf(rStrong, null).state === 'dismissed' && pi.ROW_STATE_LABEL.dismissed === '앱 글 아님(직접)' && pi.rowStateOf(rNone, null).state === 'none',
  )
  // 미리 체크 — 같은 글을 또 올린 것일 수 있는 줄은 사람이 보게 비워 둔다.
  const rOtherUrl = readOf([{ ...cand('t1', 'a', 0.6), otherUrls: 1 }, cand('t1', 'b', 0.1)])
  ok('줄 — 그 앱 글에 이미 다른 주소가 적혀 있으면 맞음이라도 미리 체크하지 않음', pi.rowStateOf(rOtherUrl, pi.autoPick(rOtherUrl)).state === 'match' && !pi.checkedByDefault(rOtherUrl))
  ok(
    '줄 — 표의 다른 줄이 이미 그 앱 글을 골랐으면(체크 · 등록) 미리 체크하지 않음(같은 글 무리에 한 줄만)',
    !pi.checkedByDefault(rMatch, new Set([pi.pickKey({ tenantId: 't1', articleId: 'a' })])) && pi.checkedByDefault(rMatch, new Set([pi.pickKey({ tenantId: 't1', articleId: 'b' })])),
  )
  // 등록한 뒤 — 이 표에서 같은 글로 등록한 다른 주소도 「이미 다른 주소」로 센다(읽은 뒤에 등록한 것만 — 읽기 전 등록은 원장 셈에 들었다).
  const cA = cand('t1', 'a', 0.6)
  const reg1 = { pick: { tenantId: 't1', articleId: 'a' }, recordKey: 'fake.tistory.com/9', seq: 5 }
  ok(
    '줄 — 지금 그 앱 글에 적힌 다른 주소 수 = 읽을 때 센 수 + 읽은 뒤 이 표에서 그 글로 등록한 다른 주소',
    pi.otherUrlsNow(cA, 'fake.tistory.com/1', 3, [reg1]) === 1 &&
      pi.otherUrlsNow(cA, 'fake.tistory.com/1', 7, [reg1]) === 0 &&
      pi.otherUrlsNow(cA, 'fake.tistory.com/9', 3, [reg1]) === 0 &&
      pi.otherUrlsNow(cA, 'fake.tistory.com/1', 3, [{ ...reg1, pick: { tenantId: 't1', articleId: 'b' } }]) === 0 &&
      pi.otherUrlsNow({ ...cA, otherUrls: 2 }, 'fake.tistory.com/1', 3, [reg1, { ...reg1, seq: 6 }]) === 3,
  )

  // ── 6. 저장한 블로그 · 목록 읽기 ───────────────────────────────────────────
  const ns = (raw: string) => pi.normalizeBlogSource(raw)
  ok(
    '블로그 주소 — 홈으로 맞춤(네이버 아이디 · 티스토리 · 워드프레스 · 그 밖은 사이트 주소), 글 주소를 넣어도 그 블로그',
    JSON.stringify([ns('https://blog.naver.com/fakewriter/224470026946'), ns('m.blog.naver.com/fakewriter'), ns('rss.blog.naver.com/fakewriter.xml'), ns('fakewriter.tistory.com/13'), ns(WP1), ns('http://127.0.0.1:4191/post/a1')]) ===
      JSON.stringify([
        { ok: true, url: 'https://blog.naver.com/fakewriter', platform: 'naver' },
        { ok: true, url: 'https://blog.naver.com/fakewriter', platform: 'naver' },
        { ok: true, url: 'https://blog.naver.com/fakewriter', platform: 'naver' },
        { ok: true, url: 'https://fakewriter.tistory.com', platform: 'tistory' },
        { ok: true, url: 'https://fakewriter.wordpress.com', platform: 'wordpress' },
        { ok: true, url: 'http://127.0.0.1:4191', platform: 'generic' },
      ]),
    [ns('https://blog.naver.com/fakewriter/224470026946'), ns('fakewriter.tistory.com/13'), ns(WP1), ns('http://127.0.0.1:4191/post/a1')],
  )
  ok('블로그 주소 — 네이버 아이디가 없거나 http(s)가 아니면 거절', !ns('https://blog.naver.com/').ok && !ns('ftp://fake.example').ok && !ns('').ok)
  const targets = (u: string) => pi.blogListTargets(u).map((t) => t.url)
  ok(
    '목록 읽을 곳 — 네이버 RSS · 티스토리 사이트맵과 RSS · 워드프레스 공개 API · 그 밖은 RSS · feed · 사이트맵',
    JSON.stringify(targets('https://blog.naver.com/fakewriter')) === JSON.stringify(['https://rss.blog.naver.com/fakewriter.xml']) &&
      JSON.stringify(targets('https://fakewriter.tistory.com')) === JSON.stringify(['https://fakewriter.tistory.com/sitemap.xml', 'https://fakewriter.tistory.com/rss']) &&
      targets('https://fakewriter.wordpress.com')[0] === 'https://public-api.wordpress.com/rest/v1.1/sites/fakewriter.wordpress.com/posts/?number=100&fields=URL,date&page=1' &&
      JSON.stringify(targets('http://127.0.0.1:4191')) === JSON.stringify(['http://127.0.0.1:4191/rss', 'http://127.0.0.1:4191/feed', 'http://127.0.0.1:4191/sitemap.xml']),
    [targets('https://fakewriter.wordpress.com'), targets('http://127.0.0.1:4191')],
  )
  const naverRss = `<rss><channel><link><![CDATA[https://blog.naver.com/fakewriter?fromRss=true]]></link><item><link><![CDATA[https://blog.naver.com/fakewriter/224470026946?fromRss=true&trackingCode=rss]]></link><guid>https://blog.naver.com/fakewriter/224470026946</guid></item>
<item><link>https://blog.naver.com/fakewriter/224470028121?fromRss=true</link></item></channel></rss>`
  ok(
    '목록 — 네이버 RSS는 글 주소를 꼬리표 없이(guid · 링크) · 블로그 홈 링크는 뺌',
    JSON.stringify(pi.listedPostUrls('https://blog.naver.com/fakewriter', pi.parseFeedLinks(naverRss))) ===
      JSON.stringify(['https://blog.naver.com/fakewriter/224470026946', 'https://blog.naver.com/fakewriter/224470028121']),
    pi.listedPostUrls('https://blog.naver.com/fakewriter', pi.parseFeedLinks(naverRss)),
  )
  const tSitemap = pi.parseSitemap(`<urlset><url><loc>https://fakewriter.tistory.com</loc></url><url><loc>https://fakewriter.tistory.com/category</loc></url>
<url><loc>https://fakewriter.tistory.com/m/13</loc></url><url><loc>https://fakewriter.tistory.com/13</loc></url><url><loc>https://fakewriter.tistory.com/entry/%EA%B0%80%EC%83%81-%EA%B8%80</loc></url>
<url><loc>https://fakewriter.tistory.com/tag/%EA%B0%80%EC%83%81</loc></url><url><loc>https://fakewriter.tistory.com/guestbook</loc></url><url><loc>https://fakewriter.tistory.com/notice/3</loc></url>
<url><loc>https://fakewriter.tistory.com/14</loc></url></urlset>`)
  ok(
    '목록 — 티스토리 사이트맵은 숫자 글 · /entry/ 글만(/m/ · 분류 · 태그 · 방명록 · 공지 빼고)',
    JSON.stringify(pi.listedPostUrls('https://fakewriter.tistory.com', tSitemap.urls)) ===
      JSON.stringify(['https://fakewriter.tistory.com/13', 'https://fakewriter.tistory.com/entry/%EA%B0%80%EC%83%81-%EA%B8%80', 'https://fakewriter.tistory.com/14']),
    pi.listedPostUrls('https://fakewriter.tistory.com', tSitemap.urls),
  )
  ok('목록 — 사이트맵 묶음(sitemapindex)은 하위 사이트맵을 알려 줌', JSON.stringify(pi.parseSitemap('<sitemapindex><sitemap><loc>https://x.example/s1.xml</loc></sitemap></sitemapindex>').sitemaps) === JSON.stringify(['https://x.example/s1.xml']))
  const wpList = pi.parseWpPostList({ found: 3, posts: [{ URL: WP1, date: '2026-11-07T16:03:53+09:00' }, { URL: 'https://fakewriter.wordpress.com/2026/11/07/hello-world/' }, { URL: 'https://fakewriter.wordpress.com/2026/11/08/second/' }] })
  ok('목록 — 워드프레스 공개 API(기본 글 hello-world는 뺌)', wpList.found === 3 && JSON.stringify(pi.listedPostUrls('https://fakewriter.wordpress.com', wpList.urls)) === JSON.stringify([WP1, 'https://fakewriter.wordpress.com/2026/11/08/second/']), wpList)
  ok(
    '목록 — 최근 글부터(티스토리 숫자 글 · 네이버 글번호는 큰 번호부터, 번호 없는 주소는 그 뒤에 원래 순서)',
    JSON.stringify(pi.newestFirst(['https://fakewriter.tistory.com/9', 'https://fakewriter.tistory.com/entry/a', 'https://fakewriter.tistory.com/1044', 'https://fakewriter.tistory.com/entry/b', 'https://fakewriter.tistory.com/13'])) ===
      JSON.stringify(['https://fakewriter.tistory.com/1044', 'https://fakewriter.tistory.com/13', 'https://fakewriter.tistory.com/9', 'https://fakewriter.tistory.com/entry/a', 'https://fakewriter.tistory.com/entry/b']) &&
      pi.newestFirst(['https://blog.naver.com/fakewriter/224138927614', 'https://blog.naver.com/fakewriter/224470026946'])[0] === 'https://blog.naver.com/fakewriter/224470026946' &&
      pi.NEW_URLS_MAX === 50,
  )
  ok('목록 — 다른 사이트 주소는 뺌', pi.listedPostUrls('https://fakewriter.tistory.com', ['https://other.tistory.com/3', 'https://fakewriter.tistory.com/3']).length === 1)
  const wwwPosts = ['https://www.myblog.example/2026/11/07/first-post/', 'https://www.myblog.example/2026/11/08/second-post/']
  ok('목록 — 그 밖 블로그는 www. · m.를 떼고 같은 사이트로 봄(추적 키와 같은 규칙)', pi.listedPostUrls('https://myblog.example', wwwPosts).length === 2 && pi.listedPostUrls('https://www.myblog.example', ['https://myblog.example/2026/11/07/first-post/']).length === 1)
  ok('목록 — 목록을 실제로 받은 곳(리디렉션 뒤)의 호스트도 같은 블로그', pi.listedPostUrls('https://myblog.example', ['https://new-home.example/2026/11/07/a/'], ['new-home.example']).length === 1 && pi.listedPostUrls('https://myblog.example', ['https://new-home.example/2026/11/07/a/']).length === 0)
  ok(
    '목록 — 이 블로그 글이 하나도 없을 때 목록에 있던 다른 사이트 글의 호스트를 알려 줌(그 주소로 저장하게)',
    JSON.stringify(pi.otherListHosts('https://fakewriter.wordpress.com', ['https://fake-domain.example/2026/11/07/a/', 'https://fake-domain.example/2026/11/08/b/', 'https://fake-domain.example/'])) === '["fake-domain.example"]' &&
      pi.otherListHosts('https://fakewriter.tistory.com', ['https://fakewriter.tistory.com/category']).length === 0,
    pi.otherListHosts('https://fakewriter.wordpress.com', ['https://fake-domain.example/2026/11/07/a/']),
  )
  ok(
    '정식 주소 — 같은 블로그의 글 주소일 때만 받음(분류 · 다른 사이트 · 블로그 홈은 아님)',
    pi.sameBlogPostUrl('https://fakewriter.wordpress.com/?p=7', 'https://fakewriter.wordpress.com/2026/11/08/fake-slug/') === 'https://fakewriter.wordpress.com/2026/11/08/fake-slug/' &&
      pi.sameBlogPostUrl('https://fakewriter.tistory.com/entry/fake', 'https://fakewriter.tistory.com/13') === 'https://fakewriter.tistory.com/13' &&
      pi.sameBlogPostUrl('https://fakewriter.tistory.com/13', 'https://fakewriter.tistory.com/category/x') === null &&
      pi.sameBlogPostUrl('https://fakewriter.wordpress.com/a/', 'https://elsewhere.example/a/') === null &&
      pi.sameBlogPostUrl('https://blog.naver.com/PostView.naver?blogId=fakewriter&logNo=224470026946', 'https://m.blog.naver.com/fakewriter/224470026946') === 'https://blog.naver.com/fakewriter/224470026946' &&
      pi.sameBlogPostUrl('https://blog.naver.com/PostView.naver?blogId=fakewriter&logNo=224470026946', 'https://blog.naver.com/fakewriter') === null,
  )

  // ── 7. 등록 규칙 — CLI와 같은 모듈 ───────────────────────────────────────────
  ok('CLI(scripts/register-posts.ts)는 공용 규칙 모듈의 함수를 그대로 쓴다', reg.planRegistration === pr.planRegistration && reg.normalizeDay === pr.normalizeDay)
  const A1_URL = `${FIX}/post/a1`
  const cli = reg.planRegistration({ plan, drafts: DRAFTS_A, extras, posts: [], rows: [{ line: 2, writer: 'w1', article: A1.id, url: A1_URL, postedOn: '2026-11-01' }], today })
  const appInput = pr.writerRecordInput({ article: plan.articles[0]!, plan, draft: DRAFT_A1, extras, url: A1_URL, day: '2026-11-01' })
  ok('배정 글 기록 — 앱(writerRecordInput)과 CLI(planRegistration)의 기록이 한 글자도 같다', cli.errors.length === 0 && JSON.stringify(cli.items[0]?.input) === JSON.stringify(appInput), { cli, appInput })
  const pick = pr.importRecordInput({ plan, planUnreadable: false, extras, bank: null, draft: DRAFT_A1, articleId: A1.id, url: A1_URL, day: '2026-11-01' })
  ok('주소 등록 — 배정 판으로 만든 배정 글은 작성자 기록(자사 줄 · 배정 판 스냅샷)', 'input' in pick && JSON.stringify(pick.input) === JSON.stringify(appInput), pick)
  const libA2 = pr.importRecordInput({ plan, planUnreadable: false, extras, bank: null, draft: DRAFT_A2, articleId: A2.id, url: `${FIX}/post/a2`, day: '2026-11-02' })
  ok(
    '주소 등록 — 다른 판으로 만든 글은 보관함 「올렸어요」 모양(직접 · 추가 글 정의의 판 · 초안 제목 · 집행함)',
    'input' in libA2 &&
      libA2.input.via === 'direct' &&
      libA2.input.targetActionId === A2.id &&
      JSON.stringify(libA2.input.topic) === JSON.stringify({ bankVersion: 'v8', questionIds: A2.questionIds, questionTexts: A2.questionTexts }) &&
      libA2.input.articleTitle === draftTitle(effectiveDraft(DRAFT_A2)) &&
      libA2.input.publishedOnChosen === true &&
      libA2.input.markDone === true,
    libA2,
  )
  const libC2 = pr.importRecordInput({ plan, planUnreadable: false, extras, bank: null, draft: DRAFT_C2, articleId: C2_ID, url: `${FIX}/post/c2`, day: '2026-11-03' })
  ok('주소 등록 — 본 글(content:)은 질문 스냅샷 없이 직접 줄', 'input' in libC2 && libC2.input.via === 'direct' && libC2.input.topic === undefined, libC2)
  const unsure = pr.importRecordInput({ plan: null, planUnreadable: true, extras, bank: null, draft: DRAFT_A1, articleId: A1.id, url: A1_URL, day: '2026-11-01' })
  ok('주소 등록 — 배정 파일을 읽지 못하면 질문 글(topic:)은 적지 않음(누구 글인지 모른다)', 'error' in unsure && unsure.error.includes('배정'), unsure)
  const BANK = {
    version: 'v3',
    generatedAt: '2026-10-01T00:00:00.000Z',
    questions: ['c1-001', 'c1-002', 'c1-005'].map((questionId) => ({ questionId, text: `${questionId} 가상 질문`, category: 'local', industry: '숙박', region: '가상시', containsBrandName: false, version: 'v3' })),
  } as unknown as import('../src/lib/types').QuestionBank
  const noPlan = pr.importRecordInput({ plan: null, planUnreadable: false, extras: null, bank: BANK, draft: DRAFT_A1, articleId: A1.id, url: A1_URL, day: '2026-11-01' })
  ok(
    '주소 등록 — 배정 파일이 없는 브랜드는 추가 글 목록을 읽지 못해도 보관함 「올렸어요」 모양(직접 · 질문 은행 판)',
    'input' in noPlan && noPlan.input.via === 'direct' && noPlan.input.topic?.bankVersion === 'v3',
    noPlan,
  )
  ok(
    '작성자 모름 — 화면과 등록이 같은 식(배정 파일을 읽지 못함, 또는 배정이 있는데 추가 글 목록을 읽지 못함 · 질문 글만)',
    pr.writerUnknownOf(A1.id, null, false, null) === false &&
      pr.writerUnknownOf(A1.id, plan, false, null) === true &&
      pr.writerUnknownOf(A1.id, null, true, extras) === true &&
      pr.writerUnknownOf(C2_ID, plan, true, null) === false &&
      pr.writerUnknownOf(A1.id, plan, false, extras) === false,
  )
  const noExtras = pr.importRecordInput({ plan, planUnreadable: false, extras: null, bank: BANK, draft: DRAFT_A1, articleId: A1.id, url: A1_URL, day: '2026-11-01' })
  ok('주소 등록 — 배정이 있는데 추가 글 목록을 읽지 못하면 질문 글은 적지 않음(화면의 「미확인」과 같다)', 'error' in noExtras && noExtras.error.includes('추가 글'), noExtras)
  // 추가 글 정의가 없는 배정 글(질문 은행 화면에서 만든 글 — 보관함의 「판 미확인」)은 그 작성자 글이다(사용자 결정, 2026-11-09). 앱 등록은
  // CLI(planRegistration)와 같은 기록 — 자사 줄 · 배정 파일의 스냅샷(판 v9). 질문 은행(v3)으로 판을 보지 않는다.
  const extrasNoA1 = extras.filter((e) => e.id !== A1.id)
  const cliNoDef = reg.planRegistration({ plan, drafts: DRAFTS_A, extras: extrasNoA1, posts: [], rows: [{ line: 2, writer: 'w1', article: A1.id, url: A1_URL, postedOn: '2026-11-01' }], today })
  const appNoDef = pr.importRecordInput({ plan, planUnreadable: false, extras: extrasNoA1, bank: BANK, draft: DRAFT_A1, articleId: A1.id, url: A1_URL, day: '2026-11-01' })
  ok(
    '주소 등록 — 추가 글 정의가 없는 배정 글(판 미확인)은 CLI와 한 글자도 같은 작성자 기록(자사 줄 · 배정 파일 스냅샷 v9 — 질문 은행 판이 아님)',
    cliNoDef.errors.length === 0 &&
      'input' in appNoDef &&
      JSON.stringify(appNoDef.input) === JSON.stringify(cliNoDef.items[0]?.input) &&
      appNoDef.input.via === 'own' &&
      JSON.stringify(appNoDef.input.topic) === JSON.stringify({ bankVersion: 'v9', questionIds: A1.questionIds, questionTexts: A1.questionTexts }),
    { cli: cliNoDef.items[0]?.input, app: appNoDef },
  )
  ok('올린 날 검사 — 오늘 뒤 · 너무 이른 날은 CLI와 같은 문구', pr.postedDayProblem('2999-01-01', today)?.includes('오늘') === true && pr.postedDayProblem('2019-12-31', today)?.includes('너무 이릅니다') === true && pr.postedDayProblem('2026-11-01', today) === null)

  // ── 8. 내부 주소 막기(이 프로세스 — 시험 깃발 없음) ─────────────────────────
  const sp = await import('../server/postImport')
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.0.10', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', 'ff02::1']
  const allowed = ['8.8.8.8', '125.209.222.142', '2404:6800:4004:80c::200e']
  ok('내부 주소 — 루프백 · 사설 · 링크 로컬(메타데이터) · CGNAT · IPv6 사설/문서/6to4는 막음', blocked.every((ip) => sp.addressBlocked(ip)), blocked.filter((ip) => !sp.addressBlocked(ip)))
  ok('내부 주소 — 공개 주소는 통과', allowed.every((ip) => !sp.addressBlocked(ip)), allowed.filter((ip) => sp.addressBlocked(ip)))
  const errOf = (p: Promise<unknown>) => p.then(() => '(통과함)', (err: unknown) => `${(err as { code?: string }).code ?? ''} ${err instanceof Error ? err.message : String(err)}`)
  ok('읽기 — http(s)가 아니면 거절', (await errOf(sp.fetchText('file:///etc/passwd'))).includes('http'))
  ok('읽기 — 루프백 주소(127.0.0.1 · [::1])는 깃발 없이는 연결 전에 막음', (await errOf(sp.fetchText('http://127.0.0.1/x'))).startsWith('PRIVATE_ADDRESS') && (await errOf(sp.fetchText('http://[::1]/x'))).startsWith('PRIVATE_ADDRESS'))
  ok('읽기 — 이름이 루프백으로 풀리면(localhost) DNS 뒤에서 막음', (await errOf(sp.fetchText('http://localhost/x'))).startsWith('PRIVATE_ADDRESS'))
  ok('읽기 — 80 · 443이 아닌 포트는 깃발 없이는 막음', (await errOf(sp.fetchText(`${FIX}/post/a1`))).startsWith('BLOCKED_PORT'))
  // 시험 깃발은 설치본에서 켤 수 없어야 한다 — 설치본 서버 묶음(scripts/build-electron-server.mjs)이 그 이름을 지운다(userData/.env · 환경변수로
  // 켜면 그 PC의 로컬 서비스를 읽게 된다).
  const FLAG_DEFINE = { 'process.env.POST_IMPORT_TEST_LOOPBACK': 'undefined' }
  const buildScript = readFileSync(path.join(process.cwd(), 'scripts', 'build-electron-server.mjs'), 'utf8')
  ok('설치본 — 서버 묶음 빌드가 시험 깃발을 지운다(define)', buildScript.includes(`define: { 'process.env.POST_IMPORT_TEST_LOOPBACK': 'undefined' }`))
  const { build } = await import('esbuild')
  const bundled = await build({ entryPoints: ['server/postImport.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', packages: 'external', write: false, logLevel: 'silent', define: FLAG_DEFINE })
  ok('설치본 — 그 define으로 묶으면 묶음에 깃발 이름이 남지 않는다', bundled.outputFiles.length === 1 && !bundled.outputFiles[0]!.text.includes('POST_IMPORT_TEST_LOOPBACK') && bundled.outputFiles[0]!.text.includes('addressBlocked'))

  // ── 9. 서버 길(가짜 블로그 + 임시 데이터 폴더) ──────────────────────────────
  for (const port of [FIX_PORT, API_PORT]) {
    if (!(await portFree(port))) throw new Error(`포트 ${port}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  }
  fixture = createServer(fixtureHandler)
  await new Promise<void>((resolve) => fixture!.listen(FIX_PORT, '127.0.0.1', () => resolve()))

  // 이 프로세스에서 깃발을 켜면 같은 주소가 읽힌다 — 깃발이 루프백만 연다(사설 주소는 그대로 막힘).
  process.env.POST_IMPORT_TEST_LOOPBACK = '1'
  const viaFlag = await sp.fetchText(`${FIX}/post/a1`).then((r) => r.status, (err: unknown) => String(err))
  const privateStill = await errOf(sp.fetchText('http://10.255.255.1/x'))
  delete process.env.POST_IMPORT_TEST_LOOPBACK
  ok('시험 깃발 — 루프백만 열고 사설 주소는 여전히 막음', viaFlag === 200 && privateStill.startsWith('PRIVATE_ADDRESS'), { viaFlag, privateStill })

  const tenant = (tenantId: string, brandName: string, over: Record<string, unknown> = {}) => ({
    tenantId,
    brandName,
    aliases: [brandName],
    ownedDomains: [`${tenantId}.example`],
    industry: '숙박',
    region: '가상시',
    engines: ['gemini'],
    questionBankSize: 4,
    questionBankVersion: 'v9',
    repeatsPerQuestion: 1,
    factGraph: [],
    competitors: [],
    ...over,
  })
  put(path.join(appRoot, 'tenants.overlay.json'), [tenant('vpi-a', '가상스테이'), tenant('vpi-b', '가상여관'), tenant('vpi-comp', '가상경쟁', { cohortOnly: true })])
  const dirA = path.join(appRoot, 'data', 'vpi-a')
  put(path.join(dirA, 'probe-plan.json'), PLAN)
  put(path.join(dirA, 'drafts.json'), DRAFTS_A)
  put(path.join(dirA, 'extra-articles.json'), EXTRAS_A)
  put(path.join(dirA, 'published-posts.json'), LEDGER_A)
  put(path.join(dirA, 'action-states.json'), { 'content:c1-099': { status: 'done', updatedAt: '2026-10-20T01:00:00.000Z' } })
  put(path.join(appRoot, 'data', 'vpi-b', 'drafts.json'), { [B1_ID]: DRAFT_B1 })
  put(path.join(appRoot, 'data', 'vpi-comp', 'drafts.json'), { [COMP_ID]: DRAFT_COMP })

  const env: Record<string, string | undefined> = {
    ...process.env,
    APP_DATA_DIR: appRoot,
    PORT: String(API_PORT),
    USE_MOCK_ENGINES: 'true',
    DOTENV_CONFIG_PATH: path.join(tmp, 'no-such.env'),
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    GH_MEASURE_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    POST_IMPORT_TEST_LOOPBACK: '1',
  }
  delete env.AEO_SERVER_HOST
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${API}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  const post = async <T>(route: string, body: unknown, method = 'POST') => {
    const r = await fetch(`${API}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T & { error?: string } }
  }
  type Read = import('../src/lib/postImport').PostImportRead
  const read = (url: string) => post<Read>('/api/post-import/read', { url })
  const stateOf = (r: Read) => pi.rowStateOf(r, pi.autoPick(r)).state

  const ra1 = (await read(A1_URL)).body
  ok(
    '읽기 — 배정 글: 「맞음」 · 브랜드 · 작성자(w1) · 앱 글 제목({N} 채움) · 올린 날(JSON-LD) · 그 밖 플랫폼',
    ra1.ok &&
      stateOf(ra1) === 'match' &&
      ra1.candidates[0]!.tenantId === 'vpi-a' &&
      ra1.candidates[0]!.articleId === A1.id &&
      ra1.candidates[0]!.brand === '가상스테이' &&
      ra1.candidates[0]!.writer?.key === 'w1' &&
      ra1.candidates[0]!.title === draftTitle(effectiveDraft(DRAFT_A1)) &&
      !ra1.candidates[0]!.title.includes('{N}') &&
      ra1.post.publishedOn === '2026-11-01' &&
      ra1.platform.key === 'generic',
    ra1,
  )
  ok('읽기 — 후보는 많아야 3개 · 본문 겹침 순', ra1.ok && ra1.candidates.length <= 3 && ra1.candidates.every((c, i, a) => i === 0 || a[i - 1]!.body >= c.body), ra1.ok ? ra1.candidates : ra1)
  ok('읽기 — 응답에 페이지 HTML · 본문을 싣지 않음', !JSON.stringify(ra1).includes('<p>') && !JSON.stringify(ra1).includes(TEXT_A1[3]!))
  const ra2 = (await read(`${FIX}/post/a2`)).body
  ok('읽기 — 다른 판으로 만든 배정 id 글: 「맞음」 · 작성자 없음(보관함 규칙) · <time> 날짜', ra2.ok && stateOf(ra2) === 'match' && ra2.candidates[0]!.articleId === A2.id && ra2.candidates[0]!.writer === null && ra2.post.publishedOn === '2026-11-02', ra2)
  const ra3 = (await read(`${FIX}/post/a3`)).body
  ok(
    '읽기 — 추가 글 정의가 없는 배정 글(판 미확인): 「맞음」 · 그 작성자(w2 — 보관함 작성자 칸 · 등록 기록과 같다)',
    ra3.ok && stateOf(ra3) === 'match' && ra3.candidates[0]!.articleId === A3.id && ra3.candidates[0]!.writer?.key === 'w2' && ra3.candidates[0]!.writerUnknown === false,
    ra3,
  )
  const rb1 = (await read(`${FIX}/post/b1-euckr`)).body
  ok('읽기 — EUC-KR 페이지(머리글에 charset 없음, meta로) · 다른 브랜드 글 · 날짜 모름(null)', rb1.ok && stateOf(rb1) === 'match' && rb1.candidates[0]!.tenantId === 'vpi-b' && rb1.post.title === '바다 전망 여관' && rb1.post.publishedOn === null, rb1)
  const rmix = (await read(`${FIX}/post/mix`)).body
  ok('읽기 — 두 글이 반씩 섞이면 「확인 필요」(두 후보 모두 보임)', rmix.ok && stateOf(rmix) === 'review' && rmix.candidates.slice(0, 2).map((c) => c.articleId).sort().join() === [A1.id, A2.id].sort().join(), rmix)
  const rother = (await read(`${FIX}/post/other`)).body
  ok('읽기 — 앱 글이 아니면 「앱 글 아님」', rother.ok && stateOf(rother) === 'none', rother)
  const rcomp = (await read(`${FIX}/post/comp`)).body
  ok('읽기 — 경쟁사(비교용) 브랜드의 초안은 후보가 아님', rcomp.ok && stateOf(rcomp) === 'none' && rcomp.candidates.every((c) => c.tenantId !== 'vpi-comp'), rcomp)
  const rtaken = (await read(TAKEN_URL)).body
  ok(
    '읽기 — 다른 글에 적힌 주소: 「다른 글로 등록됨」 · 적힌 기록(브랜드 · 글 제목)을 함께',
    rtaken.ok && stateOf(rtaken) === 'other' && rtaken.known.length === 1 && rtaken.known[0]!.articleTitle === '다른 가상 글' && rtaken.known[0]!.brand === '가상스테이',
    rtaken,
  )
  const unreadable = async (url: string, want: string) => {
    const r = (await read(url)).body
    return !r.ok && r.error.includes(want) ? '' : JSON.stringify(r)
  }
  ok('읽기 — 없는 글(404)은 「읽지 못함」 · 이유', (await unreadable(`${FIX}/missing`, '404')) === '', await unreadable(`${FIX}/missing`, '404'))
  ok('읽기 — 3MB를 넘는 페이지는 끊고 「읽지 못함」', (await unreadable(`${FIX}/big`, '크기')) === '', await unreadable(`${FIX}/big`, '크기'))
  ok('읽기 — 본문 글자가 거의 없으면 「읽지 못함」(앱 글 아님으로 단정하지 않음)', (await unreadable(`${FIX}/post/empty`, '본문')) === '', await unreadable(`${FIX}/post/empty`, '본문'))
  ok('읽기 — 사설 주소로 넘기는 리디렉션은 막음(깃발이 있어도)', (await unreadable(`${FIX}/to-private`, '내부')) === '', await unreadable(`${FIX}/to-private`, '내부'))
  const hop3 = (await read(`${FIX}/hop/3`)).body
  ok('읽기 — 리디렉션 3번까지 따라감(매번 주소 검사)', hop3.ok && stateOf(hop3) === 'match', hop3)
  ok('읽기 — 리디렉션 4번이면 멈춤', (await unreadable(`${FIX}/hop/4`, '리디렉션')) === '', await unreadable(`${FIX}/hop/4`, '리디렉션'))
  ok('읽기 — 글 주소가 아니면 400', (await read('https://blog.naver.com/fakewriter')).status === 400 && (await post('/api/post-import/read', {})).status === 400)
  maxInFlight = 0
  await Promise.all(Array.from({ length: 7 }, (_, i) => read(`${FIX}/slow/${i}`)))
  ok('읽기 — 바깥 요청은 한 번에 3개까지', maxInFlight > 0 && maxInFlight <= 3, maxInFlight)

  // 등록
  type Commit = { results: import('../src/lib/postImport').CommitResult[] }
  const commit = (items: unknown) => post<Commit>('/api/post-import/commit', { items })
  const ledgerOf = (id: string) => JSON.parse(readFileSync(path.join(appRoot, 'data', id, 'published-posts.json'), 'utf8')) as { posts: Record<string, unknown>[] }
  const statesOf = (id: string) => JSON.parse(readFileSync(path.join(appRoot, 'data', id, 'action-states.json'), 'utf8')) as Record<string, { status?: string }>
  const { readPublishedPosts } = await import('../server/publishedPosts')
  const before = await readPublishedPosts('vpi-a')
  const c1 = await commit([
    { tenantId: 'vpi-a', articleId: A1.id, url: A1_URL, publishedOn: '2026-11-01' },
    { tenantId: 'vpi-a', articleId: A1.id, url: TAKEN_URL, publishedOn: '2026-11-01' },
    { tenantId: 'vpi-a', articleId: A2.id, url: `${FIX}/post/a2`, publishedOn: '2026-11-02' },
    { tenantId: 'vpi-a', articleId: C2_ID, url: `${FIX}/post/c2`, publishedOn: '2999-01-01' },
    { tenantId: 'vpi-b', articleId: B1_ID, url: `${FIX}/post/b1-euckr`, publishedOn: '2026-11-04' },
  ])
  const st = c1.body.results?.map((r) => r.status).join(',')
  ok('등록 — 줄마다 결과 · 걸린 줄이 있어도 나머지는 적음(added,error,added,error,added)', c1.status === 200 && st === 'added,error,added,error,added', c1.body)
  ok('등록 — 다른 글의 주소는 거절 · 이유에 그 글', (c1.body.results?.[1]?.error ?? '').includes('다른 가상 글'), c1.body.results?.[1])
  ok('등록 — 오늘 뒤의 날은 거절', (c1.body.results?.[3]?.error ?? '').includes('오늘'), c1.body.results?.[3])
  const afterA = await readPublishedPosts('vpi-a')
  ok(
    '등록 — 배정 글 기록은 CLI 확인(checkRegistration)을 그대로 통과(원래 기록 그대로 · 자사 줄 · 사람이 고른 날 · 스냅샷 · 제목 · 초안 판 · 집행함)',
    reg.checkRegistration({ before, after: afterA.filter((p) => p.articleId !== A2.id), items: cli.items, states: statesOf('vpi-a') }).length === 0,
    reg.checkRegistration({ before, after: afterA.filter((p) => p.articleId !== A2.id), items: cli.items, states: statesOf('vpi-a') }),
  )
  const a2rec = ledgerOf('vpi-a').posts.find((p) => p.articleId === A2.id)
  ok(
    '등록 — 배정 밖 글은 「올렸어요」 모양(직접 · 사람이 고른 날 · 추가 글 판 스냅샷 · 집행함)',
    a2rec?.via === 'direct' && a2rec.publishedOnSource === 'user' && (a2rec.topic as { bankVersion?: string })?.bankVersion === 'v8' && statesOf('vpi-a')[A2.id]?.status === 'done',
    a2rec,
  )
  ok('등록 — 다른 브랜드(vpi-b)는 그 브랜드 원장에', ledgerOf('vpi-b').posts.length === 1 && ledgerOf('vpi-b').posts[0]!.articleId === B1_ID && ledgerOf('vpi-b').posts[0]!.publishedOn === '2026-11-04')
  // 판 미확인 배정 글(A3)의 등록 — CLI가 같은 줄로 적을 기록과 같은지 CLI 확인(checkRegistration)으로 본다(자사 줄 · 배정 파일 스냅샷).
  const A3_URL = `${FIX}/post/a3`
  const cliA3 = reg.planRegistration({ plan, drafts: DRAFTS_A, extras, posts: afterA, rows: [{ line: 2, writer: 'w2', article: A3.id, url: A3_URL, postedOn: '2026-11-03' }], today })
  const cA3 = await commit([{ tenantId: 'vpi-a', articleId: A3.id, url: A3_URL, publishedOn: '2026-11-03' }])
  const afterA3 = await readPublishedPosts('vpi-a')
  const a3Problems = reg.checkRegistration({ before: afterA, after: afterA3, items: cliA3.items, states: statesOf('vpi-a') })
  ok(
    '등록 — 추가 글 정의가 없는 배정 글(판 미확인)은 CLI 확인을 그대로 통과(자사 줄 · 배정 파일 스냅샷 v9 · 집행함)',
    cA3.body.results?.[0]?.status === 'added' && cliA3.errors.length === 0 && a3Problems.length === 0,
    { result: cA3.body.results, cliErrors: cliA3.errors, a3Problems, record: afterA3.find((p) => p.articleId === A3.id) },
  )
  const ledgerAfter = readFileSync(path.join(dirA, 'published-posts.json'), 'utf8')
  const c2 = await commit([{ tenantId: 'vpi-a', articleId: A1.id, url: A1_URL, publishedOn: '2026-11-05' }])
  ok('다시 등록 — 같은 주소 · 같은 글은 「이미 등록됨」 · 원장 그대로(날짜도 바꾸지 않음)', c2.body.results?.[0]?.status === 'existing' && readFileSync(path.join(dirA, 'published-posts.json'), 'utf8') === ledgerAfter, c2.body)
  const ra1again = (await read(A1_URL)).body
  ok('다시 읽기 — 등록한 주소는 「이미 등록됨」', ra1again.ok && stateOf(ra1again) === 'already', ra1again)
  const sameArticle = (await read(`${FIX}/hop/1`)).body
  ok(
    '읽기 — 같은 앱 글을 다른 주소로 읽으면 「맞음」이되 그 글에 이미 적힌 다른 주소 수를 함께(CLI 경고와 같은 셈) · 미리 체크하지 않음',
    sameArticle.ok &&
      stateOf(sameArticle) === 'match' &&
      sameArticle.candidates[0]!.articleId === A1.id &&
      sameArticle.candidates[0]!.otherUrls === 1 &&
      sameArticle.candidates.find((c) => c.articleId === Q5_ID)?.otherUrls === 0 &&
      !pi.checkedByDefault(sameArticle),
    sameArticle,
  )
  ok('읽기 — 리디렉션되면 넘어간 뒤 주소로 적는다(적을 주소 · 키 · 까닭)', sameArticle.ok && sameArticle.recordUrl === `${FIX}/hop/0` && sameArticle.recordKey === '127.0.0.1/hop/0' && sameArticle.urlNote !== null, sameArticle)
  const viaP = (await read(`${FIX}/?p=1`)).body
  ok(
    '읽기 — ?p=번호 주소가 이미 등록한 글 주소로 넘어가면 「이미 등록됨」(맞음 · 미리 체크가 아님) · 적을 주소는 넘어간 주소',
    viaP.ok && stateOf(viaP) === 'already' && !pi.checkedByDefault(viaP) && viaP.recordUrl === A1_URL && viaP.recordKey === '127.0.0.1/post/a1',
    viaP,
  )
  const viaCanon = (await read(`${FIX}/amp/a1`)).body
  ok('읽기 — 페이지가 밝힌 정식 주소(같은 블로그)가 이미 등록한 주소면 「이미 등록됨」', viaCanon.ok && stateOf(viaCanon) === 'already' && viaCanon.recordUrl === A1_URL, viaCanon)
  const canonOther = (await read(`${FIX}/post/canon-other`)).body
  ok('읽기 — 다른 사이트를 정식 주소로 적은 페이지는 따르지 않고 붙여 넣은 주소로', canonOther.ok && canonOther.recordUrl === `${FIX}/post/canon-other` && canonOther.urlNote === null, canonOther)
  const trailing = (await read(`${FIX}/post/c2입니다`)).body
  ok(
    '읽기 — 주소 끝에 한글이 붙어 404면 그 글자를 떼고 한 번 더 읽는다(적을 주소 · 까닭에 뗀 글자)',
    trailing.ok && trailing.recordUrl === `${FIX}/post/c2` && trailing.recordKey === '127.0.0.1/post/c2' && (trailing.urlNote ?? '').includes('입니다') && stateOf(trailing) === 'match',
    trailing,
  )
  ok('읽기 — 블로그 홈으로 넘어가는 주소(지운 글)는 「읽지 못함」', (await unreadable(`${FIX}/gone`, '홈')) === '', await unreadable(`${FIX}/gone`, '홈'))
  // 한 브랜드의 초안 파일을 읽지 못하면(잠김 · 깨짐) 그 브랜드 글을 빼고 짝짓지 않는다 — 「앱 글 아님」으로 숨으면 틀린 판정이 된다.
  const draftsB = path.join(appRoot, 'data', 'vpi-b', 'drafts.json')
  renameSync(draftsB, `${draftsB}.bak`)
  mkdirSync(draftsB)
  const rLocked = (await read(`${FIX}/post/b1-copy`)).body
  rmSync(draftsB, { recursive: true, force: true })
  renameSync(`${draftsB}.bak`, draftsB)
  const rUnlocked = (await read(`${FIX}/post/b1-copy`)).body
  ok('읽기 — 한 브랜드의 초안(drafts.json)을 읽지 못하면 「읽지 못함」 · 브랜드 이름(앱 글 아님으로 숨기지 않음)', !rLocked.ok && rLocked.error.includes('가상여관') && rLocked.error.includes('초안'), rLocked)
  ok('읽기 — 다시 읽을 수 있게 되면 그 브랜드 글과 다시 맞춤', rUnlocked.ok && stateOf(rUnlocked) === 'match' && rUnlocked.candidates[0]!.tenantId === 'vpi-b', rUnlocked)
  const c3 = await commit([
    { tenantId: 'vpi-nope', articleId: A1.id, url: `${FIX}/post/x1`, publishedOn: '2026-11-01' },
    { tenantId: 'vpi-comp', articleId: COMP_ID, url: `${FIX}/post/comp`, publishedOn: '2026-11-01' },
    { tenantId: 'vpi-a', articleId: 'content:nope', url: `${FIX}/post/x2`, publishedOn: '2026-11-01' },
    { tenantId: 'vpi-a', articleId: C2_ID, url: 'https://blog.naver.com/fakewriter', publishedOn: '2026-11-01' },
    { tenantId: 'vpi-a', articleId: C2_ID, url: `${FIX}/post/c2`, publishedOn: '2026-02-30' },
    { tenantId: 'vpi-b', articleId: B1_ID, url: A1_URL, publishedOn: '2026-11-01' },
  ])
  ok(
    '등록 — 없는 브랜드 · 경쟁사 · 없는 글 · 글 주소 아님 · 없는 날 · 다른 브랜드에 적힌 주소는 모두 거절',
    c3.status === 200 && c3.body.results?.every((r) => r.status === 'error') === true && (c3.body.results?.[5]?.error ?? '').includes('가상스테이'),
    c3.body,
  )
  ok('등록 — 본문 모양이 틀리면 400', (await post('/api/post-import/commit', { items: 'x' })).status === 400 && (await post('/api/post-import/commit', { items: [{ tenantId: 1 }] })).status === 400)

  // 저장한 블로그 · 새 글 찾기
  const sourcesFile = path.join(appRoot, 'blog-sources.json')
  const g0 = await fetch(`${API}/api/blog-sources`).then(async (r) => ({ status: r.status, body: (await r.json()) as { sources: { url: string }[] } }))
  ok('저장한 블로그 — 처음엔 빈 목록', g0.status === 200 && g0.body.sources.length === 0)
  const p1 = await post<{ sources: { url: string; platform: string }[] }>('/api/blog-sources', { sources: [`${FIX}/post/a1`, 'fakewriter.tistory.com/13', 'https://blog.naver.com/fakewriter/224470026946', 'https://fakewriter.tistory.com'] }, 'PUT')
  ok(
    '저장한 블로그 — 홈으로 맞춰 한 번씩 저장(앱 전체에 한 목록 — 데이터 폴더 밖 상태 파일)',
    p1.status === 200 &&
      p1.body.sources.map((s) => s.url).join(' ') === `${FIX} https://fakewriter.tistory.com https://blog.naver.com/fakewriter` &&
      existsSync(sourcesFile) &&
      !existsSync(path.join(appRoot, 'data', 'blog-sources.json')),
    p1.body,
  )
  const badPut = await post('/api/blog-sources', { sources: [`${FIX}`, 'ftp://fake.example'] }, 'PUT')
  ok('저장한 블로그 — 틀린 주소가 하나라도 있으면 400 · 저장 그대로', badPut.status === 400 && (badPut.body.error ?? '').includes('ftp://fake.example') && JSON.parse(readFileSync(sourcesFile, 'utf8')).sources.length === 3, badPut.body)
  const tooMany = await post('/api/blog-sources', { sources: Array.from({ length: 31 }, (_, i) => `https://fake${i}.tistory.com`) }, 'PUT')
  ok('저장한 블로그 — 30곳을 넘으면 400', tooMany.status === 400)
  const p2 = await post<{ sources: { url: string }[] }>('/api/blog-sources', { sources: [FIX, 'https://fakewriter.tistory.com'] }, 'PUT')
  ok('저장한 블로그 — 빼기(목록을 다시 저장)', p2.status === 200 && p2.body.sources.length === 2)
  const list = await post<import('../src/lib/postImport').BlogListResult>('/api/post-import/list', { source: FIX })
  ok(
    '새 글 찾기 — RSS · 사이트맵을 합쳐 이 블로그 글만, 고객 브랜드 원장에 살아 있는 주소는 빼고(feed 404는 넘어감)',
    list.status === 200 &&
      JSON.stringify([...list.body.newUrls].sort()) === JSON.stringify([`${FIX}/post/c2`, `${FIX}/post/other`].sort()) &&
      list.body.found === 5 &&
      list.body.older === 0,
    list.body,
  )
  ok('새 글 찾기 — 저장하지 않은 블로그 · 틀린 주소는 400', (await post('/api/post-import/list', { source: 'https://unsaved.tistory.com' })).status === 400 && (await post('/api/post-import/list', {})).status === 400)

  // 한 줄에서 예외가 나도(질문 은행 파일을 다른 프로그램이 잡고 있음 — EPERM) 그 줄만 걸리고, 앞 줄은 적힌 그대로 결과에 나와야 한다.
  // 서버 모듈을 이 프로세스에서 같은 임시 데이터 폴더로 부른다(질문 은행을 던지게 할 수 있게).
  const inProcTenants = [tenant('vpi-a', '가상스테이'), tenant('vpi-b', '가상여관'), tenant('vpi-comp', '가상경쟁', { cohortOnly: true })] as unknown as import('../server/types').TenantConfig[]
  const throwingBank = async (): Promise<null> => {
    throw Object.assign(new Error('EPERM: 가짜 — 질문 은행 파일을 다른 프로그램이 잡고 있음'), { code: 'EPERM' })
  }
  const partial = await sp
    .commitPostImport(
      {
        items: [
          { tenantId: 'vpi-b', articleId: B1_ID, url: `${FIX}/post/b1-copy`, publishedOn: '2026-11-05' },
          { tenantId: 'vpi-a', articleId: Q5_ID, url: `${FIX}/post/q5`, publishedOn: '2026-11-05' },
        ],
      },
      inProcTenants,
      throwingBank,
    )
    .then(
      (r) => r,
      (err: unknown) => `요청 전체가 실패함: ${err instanceof Error ? err.message : String(err)}`,
    )
  ok(
    '등록 — 한 줄에서 예외가 나도 그 줄만 「걸림」(이유) · 앞 줄은 적힌 그대로 결과에(요청 전체가 실패하지 않음)',
    typeof partial !== 'string' &&
      partial.results.map((r) => r.status).join() === 'added,error' &&
      (partial.results[1]!.error ?? '').includes('EPERM') &&
      ledgerOf('vpi-b').posts.some((p) => p.url === `${FIX}/post/b1-copy`),
    partial,
  )
} catch (err) {
  ok('예외 없이 끝남', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
} finally {
  server?.kill()
  fixture?.close()
  await new Promise((r) => setTimeout(r, 800))
  rmSync(tmp, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass && detail) console.log(`    ${detail.slice(0, 2000).replace(/\n/g, '\n    ')}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
