/**
 * 등록된 브랜드를 완전히 삭제한다 — config·데이터 파일·레지스트리·스코어카드에서 제거하고
 * 코호트 순위를 재계산한다. Blob이 있으면 오버레이·대기열도 정리한다.
 *   npx tsx scripts/delete-tenant.ts <tenantId>
 * 이후: git add -A && git commit -m "data: delete <tenantId>" && (배포)
 */
import 'dotenv/config'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { computeCohortRank } from '../server/scoring'
import { blobStoreEnabled, removeOverlayTenant } from '../server/tenantOverlay'
import { removeMeasureRequest } from '../server/measureRequests'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { TenantConfig } from '../server/types'

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

// 시드 브랜드는 파일명이 다르다(publish-tenant.ts와 동일 규칙).
const SEED_FILES: Record<string, string[]> = {
  'example-brand': ['src/data/live-question-bank.json', 'src/data/live-question-analyses.json'],
  'stay-meomum': ['src/data/live-stay-question-bank.json', 'src/data/live-stay-question-analyses.json'],
}

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) throw new Error('사용법: npx tsx scripts/delete-tenant.ts <tenantId>')

  // 1) tenants.config.json에서 제거
  const cfgPath = 'server/tenants.config.json'
  const tenants = read<TenantConfig[]>(cfgPath)
  const nextTenants = tenants.filter((t) => t.tenantId !== tenantId)
  const inConfig = nextTenants.length !== tenants.length
  if (inConfig) writeFileSync(cfgPath, JSON.stringify(nextTenants, null, 2) + '\n')
  console.log(`config: ${inConfig ? '제거됨' : '없음'} (${tenants.length} → ${nextTenants.length})`)

  // 2) 데이터 파일 삭제
  const files = SEED_FILES[tenantId] ?? [
    `src/data/live-${tenantId}-question-bank.json`,
    `src/data/live-${tenantId}-question-analyses.json`,
  ]
  for (const f of files) {
    if (existsSync(f)) {
      rmSync(f)
      console.log(`데이터 파일 삭제: ${f}`)
    }
  }

  // 3) demo-scorecards.json에서 제거 + 코호트 순위 재계산
  const cardsPath = 'src/data/demo-scorecards.json'
  const cards = read<WeeklyScorecard[]>(cardsPath)
  const nextCards = cards.filter((c) => c.tenantId !== tenantId)
  for (const card of nextCards) {
    const group = nextCards.filter(
      (c) => c.industry === card.industry && c.region === card.region && c.weekOf === card.weekOf,
    )
    card.cohortRank = computeCohortRank(card.aeoScore.current, group)
  }
  if (nextCards.length !== cards.length) writeFileSync(cardsPath, JSON.stringify(nextCards, null, 2) + '\n')
  console.log(`demo-scorecards: ${cards.length} → ${nextCards.length}`)

  // 4) 레지스트리 재생성 (남은 데이터 파일 기준)
  execSync('npx tsx scripts/publish-tenant.ts', { stdio: 'inherit' })

  // 5) 런타임 상태(오버레이·대기열) 정리 — Blob 또는 로컬 파일이 있을 때만
  if (blobStoreEnabled() || !process.env.VERCEL) {
    try {
      const { removed } = await removeOverlayTenant(tenantId)
      await removeMeasureRequest(tenantId)
      console.log(`오버레이: ${removed ? '제거됨' : '없음'} · 대기열 정리 완료`)
    } catch (err) {
      console.warn(`오버레이/대기열 정리 건너뜀: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\n✓ ${tenantId} 삭제 완료. 다음: git add -A && git commit -m "data: delete ${tenantId}" 후 배포(git push).`)
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
