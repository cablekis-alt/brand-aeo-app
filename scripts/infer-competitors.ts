/**
 * 자동 채우기용 경쟁사 추론(그라운딩)을 CI 러너에서 실행하고 결과를 Blob에 저장한다.
 * Vercel 리전은 한국어 브랜드 회상이 헛소리·빈 결과라 이 추론은 러너에서만 돈다.
 *   INFER_BRAND=... INFER_INDUSTRY=... INFER_REGION=... INFER_DOMAIN=... npx tsx scripts/infer-competitors.ts
 */
import 'dotenv/config'
import { inferCompetitors } from '../server/brandInference'
import { markInferPending, slugFromDomain, writeInferResult } from '../server/inferResults'

async function main(): Promise<void> {
  const brandName = (process.env.INFER_BRAND || process.argv[2] || '').trim()
  const industry = (process.env.INFER_INDUSTRY || process.argv[3] || '').trim()
  const region = (process.env.INFER_REGION || process.argv[4] || '').trim()
  const domain = (process.env.INFER_DOMAIN || process.argv[5] || '').trim()
  if (!brandName || !industry || !domain) {
    throw new Error('INFER_BRAND / INFER_INDUSTRY / INFER_DOMAIN 이 필요합니다.')
  }
  const slug = slugFromDomain(domain)
  console.log(`[infer] ${brandName} (${industry} · ${region}) → slug=${slug}`)
  try {
    const competitors = await inferCompetitors(brandName, industry, region)
    console.log(`[infer] 결과 ${competitors.length}건: ${competitors.map((c) => c.name).join(', ')}`)
    await writeInferResult(slug, competitors)
  } catch (err) {
    // 실패해도 pending은 풀어 폼이 무한 대기하지 않게 한다.
    console.error(`[infer] 실패: ${err instanceof Error ? err.message : err}`)
    await markInferPending(slug).catch(() => {})
    await writeInferResult(slug, []).catch(() => {})
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
