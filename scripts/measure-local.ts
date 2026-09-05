/**
 * 로컬 PC(한국 리전 = 그라운딩 정확)에서 측정하고, 결과를 Vercel에 반영(git commit+push)까지 한 번에.
 *   npx tsx scripts/measure-local.ts <tenantId>   # 한 브랜드(+경쟁사 코호트)
 *   npx tsx scripts/measure-local.ts all           # 등록된 모든 본 브랜드
 *   npx tsx scripts/measure-local.ts <tenantId> --no-push   # 측정만(로컬 src/data에만, 반영 안 함)
 *
 * 측정 자체는 measureAndBake가 처리(경쟁사 자동 추론·코호트 측정·baking 포함).
 * git 반영 범위는 측정 산출물(src/data, server/liveRegistry.ts, server/tenants.config.json)로 한정한다.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { measureAndBake } from '../server/measureAndBake'
import { FileResultStore } from '../server/store'
import { loadRuntimeTenants } from '../server/tenantRegistry'

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' })
const capture = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' })

// 측정이 만드는 git 추적 산출물만 반영한다(.env·overlay·/data 등은 gitignore라 애초에 제외).
const BAKE_PATHS = ['src/data', 'server/liveRegistry.ts', 'server/tenants.config.json']

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const noPush = args.includes('--no-push')
  const target = args.find((a) => !a.startsWith('--')) ?? 'all'

  const tenants = await loadRuntimeTenants()
  let ids: string[]
  if (target === 'all') {
    ids = tenants.filter((t) => !t.cohortOnly).map((t) => t.tenantId)
    if (ids.length === 0) {
      console.log('측정할 본 브랜드가 없습니다.')
      return
    }
  } else {
    ids = [target]
  }

  console.log(`\n[measure-local] 측정 대상 ${ids.length}개: ${ids.join(', ')}\n`)
  const store = new FileResultStore()
  const done: string[] = []
  for (const id of ids) {
    const tenant = tenants.find((t) => t.tenantId === id)
    if (!tenant) {
      console.warn(`⚠ 건너뜀 — 없는 테넌트: ${id}`)
      continue
    }
    console.log(`\n===== 측정: ${tenant.brandName} (${id}) =====`)
    const r = await measureAndBake(tenant, store)
    console.log(`✓ ${id} — ${r.weekOf} · AEO ${r.aeoScore}`)
    done.push(id)
  }

  if (done.length === 0) {
    console.log('\n측정된 브랜드가 없습니다.')
    return
  }
  if (noPush) {
    console.log(`\n측정 완료(${done.join(', ')}). --no-push → git 반영 생략. 결과는 로컬(src/data)에만 있습니다.`)
    return
  }
  reflectToVercel(done)
}

/** 측정 산출물만 commit+push → Vercel Git 연동이 자동 배포. 시크릿 안전장치 포함. */
function reflectToVercel(ids: string[]): void {
  run('git', ['add', '--', ...BAKE_PATHS])
  const staged = capture('git', ['diff', '--cached', '--name-only']).trim()
  if (!staged) {
    console.log('\n반영할 변경이 없습니다(측정 결과가 이전과 동일).')
    return
  }
  // 안전장치 — 위험 파일/시크릿이 스테이징되면 중단.
  const danger = staged.split(/\r?\n/).filter((f) => /(^|\/)\.env$|secret|\.pem$|\.key$/i.test(f))
  if (danger.length) throw new Error(`위험 파일이 스테이징됨: ${danger.join(', ')} — 중단.`)
  const diff = capture('git', ['diff', '--cached'])
  if (/sk-[A-Za-z0-9]{20}|AIza[0-9A-Za-z_-]{20}|vercel_blob_rw_|ghp_|github_pat_/.test(diff)) {
    throw new Error('스테이징 변경에서 시크릿 패턴 발견 — 중단.')
  }

  const label = ids.length > 2 ? `${ids.slice(0, 2).join(', ')} 외 ${ids.length - 2}개` : ids.join(', ')
  console.log(`\n[measure-local] Vercel 반영: git commit + push (${staged.split(/\r?\n/).length}개 파일)`)
  run('git', ['commit', '-m', `data: measure ${label} (local)`])
  try {
    run('git', ['pull', '--rebase', 'origin', 'master'])
  } catch {
    console.warn('⚠ rebase 충돌 — 수동 해결 후 git push 하세요.')
    return
  }
  run('git', ['push', 'origin', 'master'])
  console.log('\n✓ Vercel에 반영됨(push 완료). Git 연동으로 자동 배포됩니다(수 분 뒤 사이트 갱신).')
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
