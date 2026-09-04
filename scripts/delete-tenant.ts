/**
 * 등록된 브랜드를 완전히 삭제한다 — config·데이터 파일·레지스트리·스코어카드에서 제거하고
 * 코호트 순위를 재계산한다. Blob이 있으면 오버레이·대기열도 정리한다.
 *   npx tsx scripts/delete-tenant.ts <tenantId>     # 단건
 *   npx tsx scripts/delete-tenant.ts __queue__      # 삭제 대기열 전체(여러 개 안전하게)
 * 이후: git add -A && git commit && (배포)
 */
import 'dotenv/config'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { computeCohortRank } from '../server/scoring'
import { blobStoreEnabled, removeOverlayTenant } from '../server/tenantOverlay'
import { removeMeasureRequest } from '../server/measureRequests'
import { DELETE_QUEUE_SENTINEL, readDeleteRequests, removeDeleteRequest } from '../server/deleteRequests'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { TenantConfig } from '../server/types'

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

// 시드 브랜드는 파일명이 다르다(publish-tenant.ts와 동일 규칙).
const SEED_FILES: Record<string, string[]> = {
  'example-brand': ['src/data/live-question-bank.json', 'src/data/live-question-analyses.json'],
  'stay-meomum': ['src/data/live-stay-question-bank.json', 'src/data/live-stay-question-analyses.json'],
}

/** config에서 제거 + 데이터 파일 삭제(코호트/publish는 나중에 일괄). */
function removeConfigAndFiles(tenantId: string): void {
  const cfgPath = 'server/tenants.config.json'
  const tenants = read<TenantConfig[]>(cfgPath)
  const nextTenants = tenants.filter((t) => t.tenantId !== tenantId)
  const inConfig = nextTenants.length !== tenants.length
  if (inConfig) writeFileSync(cfgPath, JSON.stringify(nextTenants, null, 2) + '\n')
  console.log(`[${tenantId}] config: ${inConfig ? '제거됨' : '없음'}`)

  const files = SEED_FILES[tenantId] ?? [
    `src/data/live-${tenantId}-question-bank.json`,
    `src/data/live-${tenantId}-question-analyses.json`,
  ]
  for (const f of files) {
    if (existsSync(f)) {
      rmSync(f)
      console.log(`[${tenantId}] 데이터 파일 삭제: ${f}`)
    }
  }
}

/** 런타임 상태(오버레이·측정 대기열) 정리 — Blob 또는 로컬 파일이 있을 때만. */
async function removeRuntimeState(tenantId: string): Promise<void> {
  if (blobStoreEnabled() || !process.env.VERCEL) {
    try {
      const { removed } = await removeOverlayTenant(tenantId)
      await removeMeasureRequest(tenantId)
      console.log(`[${tenantId}] 오버레이: ${removed ? '제거됨' : '없음'} · 측정 대기열 정리`)
    } catch (err) {
      console.warn(`[${tenantId}] 오버레이/대기열 정리 건너뜀: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/** demo-scorecards에서 삭제 대상들을 빼고 남은 코호트 순위를 한 번에 재계산. */
function removeFromScorecards(tenantIds: Set<string>): void {
  const cardsPath = 'src/data/demo-scorecards.json'
  const cards = read<WeeklyScorecard[]>(cardsPath)
  const nextCards = cards.filter((c) => !tenantIds.has(c.tenantId))
  for (const card of nextCards) {
    const group = nextCards.filter(
      (c) => c.industry === card.industry && c.region === card.region && c.weekOf === card.weekOf,
    )
    card.cohortRank = computeCohortRank(card.aeoScore.current, group)
  }
  if (nextCards.length !== cards.length) writeFileSync(cardsPath, JSON.stringify(nextCards, null, 2) + '\n')
  console.log(`demo-scorecards: ${cards.length} → ${nextCards.length}`)
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (!arg) throw new Error('사용법: npx tsx scripts/delete-tenant.ts <tenantId | __queue__>')

  const queueMode = arg === DELETE_QUEUE_SENTINEL
  const ids = queueMode ? await readDeleteRequests() : [arg]
  if (ids.length === 0) {
    console.log('삭제 대기열이 비어 있습니다. 삭제할 항목 없음.')
    return
  }
  console.log(`삭제 대상 ${ids.length}건: ${ids.join(', ')}`)

  for (const id of ids) {
    removeConfigAndFiles(id)
    await removeRuntimeState(id)
    if (queueMode) await removeDeleteRequest(id) // 처리한 항목만 큐에서 뺀다(살아남은 다음 run이 잔여분 처리).
  }

  // 스코어카드 정리 + 코호트 순위 재계산은 전체에 대해 한 번만.
  removeFromScorecards(new Set(ids))

  // 레지스트리 재생성 (남은 데이터 파일 기준).
  execSync('npx tsx scripts/publish-tenant.ts', { stdio: 'inherit' })

  console.log(`\n✓ 삭제 완료: ${ids.join(', ')}. 다음: git add -A && git commit 후 배포(git push).`)
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
