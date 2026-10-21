/**
 * 「이 브랜드만 측정」(server/measureAndBake.ts selfOnly)과 측정 전 계획(measurePreview)을 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. 측정은 가짜 엔진.
 *
 * 왜: 고객 브랜드를 재면 늘 경쟁사까지 함께 쟀다. 「건너뛰기」는 같은 엔진으로 잰 이번 주 경쟁사만 빼서, 엔진 설정을 바꾸면
 * (2026-10-21 Gemini를 끈 뒤 군산각만 다시 재려던 일) 경쟁사를 전부 다시 쟀다. 이 브랜드만 재되, 경쟁사 카드와 도구가 다르면
 * 화면이 측정 전에 알 수 있어야 한다.
 *
 *   npx tsx scripts/verify-measure-self-only.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-measure-self-only-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

try {
  const { measureAndBake, measurePreview } = await import('../server/measureAndBake')
  const { resolveCollectionEngines } = await import('../server/pipeline')
  const { resolveJudgeEngineId } = await import('../server/engines/index')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const reg = await import('../server/tenantRegistry')
  const store = new FileResultStore()
  const week = getIsoWeekString(new Date())

  // 가짜 코호트(펜션 · 가상시): 고객 scust가 경쟁사 sone(이번 주에 같은 도구로 잼) · stwo(이번 주에 다른 엔진으로 잼)를 둔다.
  const base = { engines: ['gemini'], questionBankSize: 1, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1' }
  const line = (name: string, domain: string) => ({ name, aliases: [name], domains: [domain] })
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'scust', brandName: '셀프 펜션', aliases: ['셀프 펜션'], ownedDomains: ['scust.example'], industry: '펜션', region: '가상시',
      competitors: [line('하나 펜션', 'sone.example'), line('둘 펜션', 'stwo.example')] },
    { ...base, tenantId: 'sone', brandName: '하나 펜션', aliases: ['하나 펜션'], ownedDomains: ['sone.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
    { ...base, tenantId: 'stwo', brandName: '둘 펜션', aliases: ['둘 펜션'], ownedDomains: ['stwo.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
  ])
  const scust = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'scust')!
  const enginesNow = [...resolveCollectionEngines(scust)].sort()
  const judgeNow = resolveJudgeEngineId()
  const card = (tenantId: string, score: number, enginesUsed: string[]) => ({
    tenantId, brandName: tenantId, industry: '펜션', region: '가상시', weekOf: week, questionBankVersion: 'v3',
    aeoScore: { current: score }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position: 1, totalTenants: 1 },
    judgeEngine: judgeNow, enginesUsed,
  })
  writeJson('data/sone/scorecard-history.json', [card('sone', 77, enginesNow)])
  writeJson('data/stwo/scorecard-history.json', [card('stwo', 66, [...enginesNow, 'perplexity'])])
  // 경쟁사 편집 파일 — 「이 브랜드만」 측정은 경쟁사 목록을 「측정함」으로 적지 않아야 한다.
  writeJson('data/scust/competitors.json', { current: null, lastSave: null, measured: null, updatedAt: '2026-10-21T00:00:00.000Z' })

  // 1) 측정 전 계획
  const plan = await measurePreview(scust, store)
  const peer = (id: string) => plan.peers.find((p) => p.tenantId === id)
  ok('계획: 지금 엔진 · 판단 엔진', plan.engines.join(',') === enginesNow.join(',') && plan.judgeEngine === judgeNow && plan.enginesError === null)
  ok('계획: 같은 도구로 잰 경쟁사 카드는 sameTools', peer('sone')?.sameTools === true)
  ok('계획: 다른 엔진으로 잰 경쟁사 카드는 sameTools 아님', peer('stwo')?.sameTools === false)
  ok('계획(건너뛰기): 같은 도구 카드는 다시 쓰고, 다른 엔진 카드는 까닭과 함께 다시 잼',
    plan.targets.some((t) => t.tenantId === 'sone' && t.reusable) && plan.targets.some((t) => t.tenantId === 'stwo' && !t.reusable && Boolean(t.reason?.includes('수집 엔진'))))

  // 2) 이 브랜드만 측정 — 경쟁사는 재지 않고, 순위는 경쟁사들의 이번 주 카드와 함께 다시 매긴다
  await measureAndBake({ ...scust }, store, { selfOnly: true })
  const mine = (await store.getScorecardHistory('scust', 99)).find((c) => c.weekOf === week)
  const one = (await store.getScorecardHistory('sone', 99)).find((c) => c.weekOf === week)
  const two = (await store.getScorecardHistory('stwo', 99)).find((c) => c.weekOf === week)
  ok('이 브랜드만: 본 브랜드 카드가 생긴다', Boolean(mine))
  ok('이 브랜드만: 경쟁사는 다시 재지 않는다(점수 그대로)', one?.aeoScore.current === 77 && two?.aeoScore.current === 66)
  ok('이 브랜드만: 순위는 경쟁사 카드와 함께 매긴다(3곳)', mine?.cohortRank?.totalTenants === 3 && one?.cohortRank?.totalTenants === 3)
  const file = JSON.parse(readFileSync(path.join(dir, 'data/scust/competitors.json'), 'utf-8')) as { measured: unknown }
  ok('이 브랜드만: 경쟁사 목록을 「측정함」으로 적지 않는다', file.measured === null)

  // 3) 경쟁사도 함께 측정(기본) — 경쟁사를 다시 잰다
  await measureAndBake({ ...scust }, store, {})
  const oneAgain = (await store.getScorecardHistory('sone', 99)).find((c) => c.weekOf === week)
  ok('함께 측정: 경쟁사도 다시 잰다(카드가 바뀐다)', oneAgain?.aeoScore.current !== 77)
  const fileAgain = JSON.parse(readFileSync(path.join(dir, 'data/scust/competitors.json'), 'utf-8')) as { measured: { listHash?: string } | null }
  ok('함께 측정: 경쟁사 목록을 「측정함」으로 적는다', Boolean(fileAgain.measured?.listHash))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

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
