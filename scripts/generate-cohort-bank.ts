/**
 * 코호트 공통 질문지를 만든다(또는 저장소 기준본을 가져온다) — 측정은 돌리지 않는다.
 *
 * 기준본은 저장소의 cohort-banks/<코호트 키>/<버전>.json 하나다. 데스크톱과 CI가 각자 만들면 같은
 * 코호트가 두 벌의 질문지를 갖게 되므로(server/cohortQuestionBank.ts 참고), 여기서 한 번 만들어
 * 커밋하고 측정은 그 기준본을 쓴다.
 *
 *   npx tsx scripts/generate-cohort-bank.ts <tenantId> <코호트 버전>                         # 저장소(dev)
 *   npx tsx scripts/generate-cohort-bank.ts ktcorp c1 "$env:APPDATA\brand-aeo-app"          # 데스크톱 데이터
 *
 * 데스크톱 대상일 때:
 *   - 데스크톱에 없고 저장소에 기준본이 있으면 → 기준본을 데스크톱으로 복사한다(새로 만들지 않는다).
 *   - 둘 다 없으면 → 판정 엔진으로 만들고(1~3회 호출), 저장소에도 같은 파일을 써 둔다. 커밋은 직접 한다.
 *   - 둘이 다르면 → 아무것도 덮어쓰지 않고 멈춘다.
 *
 * <tenantId>는 코호트(업종·지역)와 제외할 이름(그 브랜드·경쟁사)을 정하는 데만 쓴다. 테넌트 설정은
 * 바꾸지 않는다 — 브랜드가 이 질문지를 쓰게 하려면 cohortQuestionBank와 새 questionBankVersion을 따로 넣는다.
 */
import 'dotenv/config'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [tenantId, version, rawDir] = args
if (!tenantId || !version) {
  console.error('사용법: npx tsx scripts/generate-cohort-bank.ts <tenantId> <코호트 버전> [userData 경로]')
  process.exit(1)
}

// 셸이 확장하지 못한 환경변수 토큰을 풀어준다(rescore-local.ts와 같은 이유).
const expand = (s: string) =>
  s
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => process.env[n] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, n: string) => process.env[n] ?? m)
const repoRoot = process.cwd()
// APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로 import 전에 정한다.
if (rawDir) process.env.APP_DATA_DIR = path.resolve(expand(rawDir))

const { COHORT_BANK_DIR } = await import('../server/appPaths')
const { cohortKey, ensureCohortBank } = await import('../server/cohortQuestionBank')
const { loadRuntimeTenants } = await import('../server/tenantRegistry')

const tenant = (await loadRuntimeTenants()).find((t) => t.tenantId === tenantId)
if (!tenant) {
  console.error(`테넌트를 찾지 못했습니다: ${tenantId}`)
  process.exit(1)
}

const key = cohortKey(tenant.industry, tenant.region)
const target = path.join(COHORT_BANK_DIR, key, `${version}.json`)
const reference = path.join(repoRoot, 'cohort-banks', key, `${version}.json`)
const sameFile = path.resolve(target) === path.resolve(reference)

if (!sameFile && !existsSync(target) && existsSync(reference)) {
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(reference, target)
  console.log(`저장소 기준본을 가져왔습니다: ${reference} → ${target}`)
} else if (!sameFile && existsSync(target) && existsSync(reference)) {
  if (readFileSync(target, 'utf8') !== readFileSync(reference, 'utf8')) {
    console.error(`질문지가 두 벌입니다 — 덮어쓰지 않고 멈춥니다.\n  대상: ${target}\n  기준본: ${reference}`)
    process.exit(1)
  }
}

const bank = await ensureCohortBank({ ...tenant, cohortQuestionBank: version })

if (!sameFile && !existsSync(reference)) {
  mkdirSync(path.dirname(reference), { recursive: true })
  writeFileSync(reference, readFileSync(target, 'utf8'), 'utf8')
  console.log(`저장소 기준본으로도 써 두었습니다(커밋 필요): ${reference}`)
}

const stages = bank.questions.reduce<Record<string, number>>((acc, q) => {
  const s = q.stage ?? '미분류'
  acc[s] = (acc[s] ?? 0) + 1
  return acc
}, {})
console.log(`\n코호트 ${key} / ${version} — 일반 질문 ${bank.questions.length}개 · 단계 ${JSON.stringify(stages)}`)
for (const q of bank.questions) console.log(`  ${q.questionId} [${q.stage ?? '-'} · ${q.topic ?? '-'}] ${q.text}`)
