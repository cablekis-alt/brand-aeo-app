/**
 * 초안 유사도 검사(scripts/draft-similarity.ts)를 확인한다. 가짜 브랜드 · 가짜 초안만 쓰고, 스크립트는 임시 폴더를 읽는 하위 프로세스로도
 * 돌린다(읽기만 하는지 파일 지문으로 본다). 서버 · AI는 부르지 않는다.
 *
 * 왜: 한 질문을 서너 편이 맡으니 엔진이 같은 문장을 되풀이하면 작성자 블로그 여러 곳에 거의 같은 글이 올라간다. 문장을 옮긴 쌍(단어
 * 조각)과 어미만 바꾼 쌍(글자 조각)을 모두 잡고, 같은 질문을 맡은 쌍을 먼저 보이고, 서로 다른 글은 잡지 않아야 한다. 빈칸 줄 · 사진
 * 자리 · 주소처럼 글마다 같은 꼴은 비교에서 빠져야 한다.
 *
 *   npx tsx scripts/verify-draft-similarity.ts
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StoredDraft } from '../src/lib/api'
import { normalizeExtraArticles } from '../src/lib/extraArticles'
import { parseWriterPlan } from '../src/lib/probePlan'
import {
  jaccard,
  pairLine,
  pairsToShow,
  plainText,
  questionIdsOf,
  shingles,
  SIMILARITY_DEFAULTS,
  similarityItems,
  similarityReport,
} from './draft-similarity'

const checks: [string, boolean, string | undefined][] = []
/** detail은 실패했을 때만 찍는다. */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail])

// ── 글자 다듬기 · 조각 · 자카드 ─────────────────────────────────────────────
ok(
  '글자 — 사진 자리 · 주소 · 마크다운 기호를 빼고 링크는 글자만, 소문자 낱말을 공백 하나로',
  plainText('## 1. 가상시 *골목*\n\n![골목 사진](#image-slot)\n> [가상 스테이](https://vstay.example/a) 안내 https://x.example/p?q=1 ABC') === '1 가상시 골목 가상 스테이 안내 abc',
  plainText('## 1. 가상시 *골목*\n\n![골목 사진](#image-slot)\n> [가상 스테이](https://vstay.example/a) 안내 https://x.example/p?q=1 ABC'),
)
ok('단어 조각 — 연속한 세 낱말', [...shingles('가 나 다 라', 'word', 3)].join('|') === '가 나 다|나 다 라')
ok('글자 조각 — 띄어쓰기를 빼고 연속 다섯 글자', [...shingles('가나 다라 마바', 'char', 5)].join('|') === '가나다라마|나다라마바')
ok('조각 — n보다 짧으면 글 전체 하나 · 빈 글은 빈 집합', [...shingles('가 나', 'word', 3)].join('|') === '가 나' && shingles('', 'char', 5).size === 0)
const s1 = new Set(['a', 'b', 'c'])
ok('자카드 — 같으면 1 · 겹침 없으면 0 · 반쯤 겹치면 겹침/합집합 · 빈 집합은 0', jaccard(s1, new Set(s1)) === 1 && jaccard(s1, new Set(['x'])) === 0 && jaccard(s1, new Set(['b', 'c', 'd'])) === 0.5 && jaccard(new Set(), new Set()) === 0)
ok('글 id → 질문 id', questionIdsOf('topic:c1-001+c1-002').join() === 'c1-001,c1-002' && questionIdsOf('content:c1-001').length === 0)

// ── 가짜 브랜드 「가상머뭄」 · 작성자 3명 ─────────────────────────────────────
const TENANT = 'fake-similarity'
const QTEXT = (id: string) => `가상시 숙소 질문 ${id}?`
const W = { w1: '가상 작성자 하나', w2: '가상 작성자 둘', w3: '가상 작성자 셋' } as const
const art = (ids: string[], name: string, key: keyof typeof W) => ({
  id: `topic:${[...ids].sort().join('+')}`,
  name,
  angle: `${name} — 천천히 둘러보는 하루`,
  writer: { key, name: W[key] },
  blog: '',
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map(QTEXT),
})
const X1 = art(['c1-001', 'c1-002'], '원도심 걸어서 다니는 숙소', 'w1')
const X2 = art(['c1-002', 'c1-003'], '역 가까운 원도심 숙소', 'w2')
const X3 = art(['c1-003', 'c1-004'], '주차 편한 독채 숙소', 'w3')
const X4 = art(['c1-005', 'c1-006'], '가족과 묵는 독채', 'w1')
const Y = art(['c1-007', 'c1-008'], '바다 전망 숙소', 'w2')
const planFile = { format: 'probe-plan/2', tenantId: TENANT, bankVersion: 'v9', activeUntil: '2027-03-31', source: { writers: 'docs/writers.json', seed: 3 }, articles: [X1, X2, X3, X4, Y] }

const OLD_TOWN = [
  '가상시 원도심은 걸어서 둘러보기 좋은 동네입니다.',
  '기차역에서 버스로 십오 분이면 닿고 골목마다 오래된 상점이 남아 있습니다.',
  '숙소를 고를 때는 골목 안쪽의 조용한 곳을 먼저 보세요.',
  '저녁에는 시장 근처 식당이 늦게까지 문을 엽니다.',
  '아침에는 강변 산책로를 따라 걷다가 빵집에 들르기 좋습니다.',
]
// 문장 하나만 바꾼 거의 같은 글.
const OLD_TOWN_COPY = [...OLD_TOWN.slice(0, 3), '밤에는 역 앞 광장에 작은 공연이 자주 열립니다.', OLD_TOWN[4]!]
const COTTAGE = [
  '독채 숙소는 가족 여행에 알맞습니다.',
  '주차 칸이 따로 있어 짐을 옮기기 쉽고 아이가 뛰어도 이웃 걱정이 적습니다.',
  '예약 전에 난방 방식과 침구 수를 확인해 두면 좋습니다.',
  '바다까지는 차로 이십 분 거리이고 가는 길에 큰 마트가 있습니다.',
  '마당이 있는 곳은 저녁에 고기를 구워 먹을 수 있는지 물어보세요.',
]
// 어미 · 조사만 바꾼 글 — 낱말이 달라져 단어 조각은 적게 겹치고 글자 조각은 많이 겹친다.
const COTTAGE_REWORDED = [
  '독채 숙소가 가족 여행에 알맞아요.',
  '주차 칸이 따로 있으니 짐을 옮기기 쉽고 아이가 뛰더라도 이웃 걱정이 적어요.',
  '예약하기 전에 난방 방식이랑 침구 수를 확인해 두면 좋아요.',
  '바다까지는 차로 이십 분 거리이며 가는 길에 큰 마트도 있어요.',
  '마당이 있는 곳이면 저녁에 고기를 구워 먹을 수 있는지 물어보세요.',
]
const SEA = [
  '바다 전망 객실은 해 질 녘이 가장 아름답습니다.',
  '창이 서쪽으로 난 방을 고르면 노을을 오래 볼 수 있습니다.',
  '겨울에는 바닷바람이 세니 창틀 단열을 확인하세요.',
]

const draftOf = (actionId: string, title: string, lines: string[]): StoredDraft => ({
  actionId,
  generatedAt: '2026-11-02T09:00:00.000Z',
  draft: {
    format: 'article',
    title,
    lead: lines[0]!,
    sections: [
      { heading: '무엇부터 보나요?', answers: 'c1-001', blocks: [{ kind: 'text', body: lines.slice(1, 3).join(' ') }], image: { alt: '가상 골목 풍경', caption: '골목 입구' } },
      { heading: '더 알아 두면 좋은 점', answers: 'c1-002', blocks: [{ kind: 'text', body: lines.slice(3).join(' ') }, { kind: 'gap', need: '가격 — 항목 없음' }] },
    ],
    gapCount: 1,
    usedFacts: [],
  },
})
const REMOVED_ID = 'topic:c1-009+c1-010'
const drafts: Record<string, StoredDraft> = {
  [X1.id]: draftOf(X1.id, '원도심 숙소 고르는 기준', OLD_TOWN),
  [X2.id]: draftOf(X2.id, '역에서 가까운 원도심 숙소', OLD_TOWN_COPY),
  [X3.id]: draftOf(X3.id, '주차 편한 독채 고르기', COTTAGE),
  [X4.id]: draftOf(X4.id, '가족과 묵기 좋은 독채', COTTAGE_REWORDED),
  // Y는 초안이 없다. 뺀 추가 글 · 추가 글이 아닌 초안은 기본으로 보지 않는다.
  [REMOVED_ID]: draftOf(REMOVED_ID, '예전에 뺀 글', OLD_TOWN),
  'content:c1-001': draftOf('content:c1-001', '실행 항목 글', OLD_TOWN),
}
// 배정 밖의 살아 있는 추가 글 하나(바다) — 작성자 없이 본다.
const LOOSE_ID = 'topic:c1-011+c1-012'
drafts[LOOSE_ID] = draftOf(LOOSE_ID, '노을 보는 객실', SEA)
const extraOf = (id: string, name: string, removedAt?: string) => ({
  id,
  name,
  bankVersion: 'v9',
  questionIds: questionIdsOf(id),
  questionTexts: questionIdsOf(id).map(QTEXT),
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...(removedAt ? { removedAt } : {}),
})
const extrasFile = { version: 1, articles: [extraOf(X1.id, X1.name), extraOf(LOOSE_ID, '노을 보는 바다 객실'), extraOf(REMOVED_ID, '예전에 뺀 글', '2026-10-30T00:00:00.000Z')] }

const plan = parseWriterPlan(planFile).plan ?? null
ok('가짜 배정 파일이 앱 검사를 통과함(probe-plan/2)', plan !== null, parseWriterPlan(planFile).error)
const extras = normalizeExtraArticles(extrasFile)
const picked = similarityItems({ drafts, extras, plan, includeRemoved: false })
ok(
  '고르기 — 배정 글 · 살아 있는 추가 글의 초안만(뺀 글 · 실행 항목 글 빼고), 초안 없는 배정 글 1편',
  picked.items.map((i) => i.id).join() === [X1.id, X2.id, X3.id, X4.id, LOOSE_ID].sort().join() && picked.undrafted === 1,
  JSON.stringify(picked.items.map((i) => i.id)),
)
const byId = new Map(picked.items.map((i) => [i.id, i]))
ok('고르기 — 이름은 추가 글 → 배정 순, 작성자는 배정에서', byId.get(LOOSE_ID)?.name === '노을 보는 바다 객실' && byId.get(LOOSE_ID)?.writer === null && byId.get(X2.id)?.name === X2.name && byId.get(X2.id)?.writer === 'w2')
ok('고르기 — 발행용 원고(빈칸 줄 · 사진 자리 없이)', !picked.items.some((i) => i.text.includes('채워야') || i.text.includes('image') || i.text.includes('사진 넣을')), byId.get(X1.id)?.text)
ok('고르기 — --include-removed면 뺀 글도(실행 항목 글은 여전히 아님)', similarityItems({ drafts, extras, plan, includeRemoved: true }).items.length === 6)
ok('고르기 — 배정이 없으면 살아 있는 추가 글만 · 작성자 없음', similarityItems({ drafts, extras, plan: null, includeRemoved: false }).items.map((i) => i.id).join() === [X1.id, LOOSE_ID].sort().join())

const report = similarityReport(picked.items, SIMILARITY_DEFAULTS)
const pairOf = (a: string, b: string) => [...report.sharedPairs, ...report.otherPairs].find((p) => (p.a.id === a && p.b.id === b) || (p.a.id === b && p.b.id === a))
const copy = pairOf(X1.id, X2.id)
const reworded = pairOf(X3.id, X4.id)
const fmt = (p: ReturnType<typeof pairOf>) => (p ? `단어 ${p.word.toFixed(3)} 글자 ${p.char.toFixed(3)}` : '없음')
ok('보고 — 5편이면 10쌍(같은 질문 쌍 + 그 밖)', report.sharedPairs.length + report.otherPairs.length === 10)
ok('보고 — 문장을 옮긴 쌍(같은 질문 c1-002)은 단어 · 글자 모두 기준 이상 ⚠', Boolean(copy?.flagged) && copy!.word >= 0.3 && copy!.char >= 0.3 && copy!.shared.join() === 'c1-002', fmt(copy))
ok('보고 — 어미만 바꾼 쌍은 단어는 기준 아래 · 글자로 ⚠', Boolean(reworded?.flagged) && reworded!.word < 0.3 && reworded!.char >= 0.3 && reworded!.shared.length === 0, fmt(reworded))
const different = [...report.sharedPairs, ...report.otherPairs].filter((p) => p !== copy && p !== reworded)
ok('보고 — 서로 다른 글은 잡지 않음(같은 질문을 맡아도)', different.every((p) => !p.flagged) && Boolean(pairOf(X2.id, X3.id)?.shared.length), different.map(fmt).join(' / '))
ok('보고 — 기준을 넘은 쌍 2개', report.flagged === 2)
ok('보고 — 같은 질문 쌍이 따로 · 비슷한 순(첫 줄이 옮긴 쌍)', report.sharedPairs[0] === copy && report.sharedPairs.every((p) => p.shared.length > 0) && report.otherPairs.every((p) => p.shared.length === 0))
ok('보고 — 그 밖의 쌍은 기준에 가까운 순(첫 줄이 어미만 바꾼 쌍)', report.otherPairs[0] === reworded && report.otherPairs.every((p, i, all) => i === 0 || all[i - 1]!.ratio >= p.ratio))
ok('보이기 — 상위 0개여도 기준을 넘은 쌍은 모두', pairsToShow(report.otherPairs, 0).length === 1 && pairsToShow(report.otherPairs, 3).length === 3)
ok('한 줄 — 표시 · 두 값 · 작성자 · 이름 · 같은 질문', pairLine(copy!).startsWith('⚠ 단어 ') && pairLine(copy!).includes(`w1 「${X1.name}」 ↔ w2 「${X2.name}」 · 같은 질문 c1-002`), pairLine(copy!))
const stricter = similarityReport(picked.items, { ...SIMILARITY_DEFAULTS, wordThreshold: 0.99, charThreshold: 0.99 })
ok('기준을 올리면 ⚠ 없음', stricter.flagged === 0)

// ── 스크립트(하위 프로세스) — 읽기만 한다 ──────────────────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'verify-draft-similarity-'))
try {
  const put = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2))
  }
  const root = path.join(tmp, 'app')
  const dir = path.join(root, 'data', TENANT)
  put(path.join(dir, 'drafts.json'), drafts)
  put(path.join(dir, 'extra-articles.json'), extrasFile)
  put(path.join(dir, 'probe-plan.json'), planFile)
  const snapshot = () => {
    const out: Record<string, string> = {}
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name)
        if (statSync(full).isDirectory()) walk(full)
        else out[path.relative(root, full)] = createHash('sha1').update(readFileSync(full)).digest('hex')
      }
    }
    walk(root)
    return JSON.stringify(out)
  }
  const before = snapshot()
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs')
  const run = (...extra: string[]) => spawnSync(process.execPath, [tsxCli, 'scripts/draft-similarity.ts', ...extra], { encoding: 'utf8', env: { ...process.env, APP_DATA_DIR: '' } })
  const out = run(TENANT, '--app-data', root)
  ok(
    '스크립트 — 같은 질문 쌍 먼저 · 그 밖 · ⚠ 수를 보이고 아무것도 쓰지 않음',
    out.status === 0 &&
      out.stdout.includes(`■ ${TENANT} — 추가 글 초안 5편 (배정 글 5편 중 초안 없음 1편) · 10쌍`) &&
      out.stdout.indexOf('① 같은 질문을 맡은 쌍') < out.stdout.indexOf('② 그 밖의 쌍') &&
      out.stdout.includes(pairLine(copy!)) &&
      out.stdout.includes('⚠ 기준을 넘은 쌍 2개') &&
      snapshot() === before,
    `${out.status} ${out.stdout}${out.stderr}`,
  )
  const top1 = run(TENANT, '--app-data', root, '--top', '1', '--threshold', '0.99', '--char-threshold', '0.99')
  ok('스크립트 — --top · 기준 옵션', top1.status === 0 && top1.stdout.includes('비슷한 순 1개') && top1.stdout.includes('기준을 넘은 쌍이 없습니다'), `${top1.status} ${top1.stdout}${top1.stderr}`)
  const removed = run(TENANT, '--app-data', root, '--include-removed')
  ok('스크립트 — --include-removed면 6편', removed.status === 0 && removed.stdout.includes('추가 글 초안 6편'), `${removed.status} ${removed.stdout}`)
  const badValue = run(TENANT, '--app-data', root, '--threshold', '2')
  ok('스크립트 — 틀린 기준 값은 거절', badValue.status === 1 && badValue.stderr.includes('--threshold 값이 틀렸습니다: 2'), `${badValue.status} ${badValue.stderr}`)
  const badFlag = run(TENANT, '--app-data', root, '--write')
  ok('스크립트 — 모르는 옵션(--write 포함)은 거절', badFlag.status === 1 && badFlag.stderr.includes('모르는 옵션입니다: --write'), `${badFlag.status} ${badFlag.stderr}`)
  const missing = run('nobody', '--app-data', root)
  ok('스크립트 — 없는 브랜드는 멈춤', missing.status === 1 && missing.stderr.includes('브랜드 폴더가 없습니다'), `${missing.status} ${missing.stderr}`)
  ok('스크립트 — 돌린 뒤에도 파일 그대로', snapshot() === before)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass && detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
