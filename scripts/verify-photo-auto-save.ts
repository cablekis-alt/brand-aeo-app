/**
 * 사진 자동 채우기 저장(server/contentDraft.ts saveAutoPhotoPicks · src/lib/api.ts saveDraftPhotosAuto)을 확인한다. 가짜 초안 · 가짜
 * 주소만 쓰고 임시 폴더를 APP_DATA_DIR로 쓴다. 서버 · AI는 부르지 않는다(fetch는 가짜).
 *
 * 왜:
 * - 작성자당 같은 사진 한 번은 미리보기를 계산할 때만 지키면 깨진다 — 열어 둔 미리보기가 오래되거나(다른 미리보기 · 사람이 고른
 *   사진이 그사이 저장됨) 미리보기 두 개를 차례로 저장하면 같은 작성자의 두 글에 같은 사진이 들어갔다. 저장(쓰기 안)에서도 막아야 한다.
 * - 여러 묶음으로 나눠 저장하다 연결이 끊기면, 앞 묶음은 이미 저장됐다 — 그 결과(partial)를 화면에 돌려줘야 화면과 저장소가 어긋나지 않는다.
 *
 *   npx tsx scripts/verify-photo-auto-save.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-photo-auto-save-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const TENANT = 'fake-stay'
const draftsFile = path.join(dir, 'data', TENANT, 'drafts.json')
const AT = '2026-11-03T00:00:00.000Z'
const P = 'https://stay.example/img/garden.jpg'
const Q = 'https://stay.example/img/living.jpg'
const pick = (src: string, slot = '정원 석등 풍경') => ({
  slot, nth: 1, same: 1, heading: '정원', src, alt: '정원 석등', pageUrl: 'https://stay.example/', confirmedAt: AT, auto: true as const,
})
const draft = (id: string, photos: ReturnType<typeof pick>[] = []) => ({
  actionId: id, generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [] }, ...(photos.length ? { photos } : {}),
})
const writeDrafts = (map: Record<string, unknown>) => {
  mkdirSync(path.dirname(draftsFile), { recursive: true })
  writeFileSync(draftsFile, JSON.stringify(map))
}
const readMap = () => JSON.parse(readFileSync(draftsFile, 'utf-8')) as Record<string, { photos?: { src: string }[] }>

try {
  const { saveAutoPhotoPicks } = await import('../server/contentDraft')
  const groups: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' }
  const groupOf = (id: string) => groups[id]

  // 1) 작성자 A의 a1에 P가 이미 있다(사람이 골랐거나 다른 미리보기가 저장함) — 오래된 미리보기가 a2에 P를 보낸다.
  writeDrafts({ a1: draft('a1', [pick(P)]), a2: draft('a2'), b1: draft('b1') })
  const r1 = await saveAutoPhotoPicks(TENANT, [{ actionId: 'a2', generatedAt: AT, picks: [pick(P)] }], 3, groupOf)
  ok('같은 작성자의 다른 글에 있는 사진은 저장하지 않는다', r1.saved === 0 && r1.skipped === 1 && !readMap().a2?.photos)

  // 다른 작성자의 글에는 같은 사진을 넣을 수 있다(브랜드 상한 안).
  const r2 = await saveAutoPhotoPicks(TENANT, [{ actionId: 'b1', generatedAt: AT, picks: [pick(P)] }], 3, groupOf)
  ok('다른 작성자의 글에는 같은 사진을 넣는다', r2.saved === 1 && readMap().b1?.photos?.[0]?.src === P)

  // 2) 한 번에 보낸 묶음 안에서도 — 같은 작성자의 두 글에 같은 사진이 오면 앞 글만.
  writeDrafts({ a1: draft('a1'), a2: draft('a2'), b1: draft('b1') })
  const r3 = await saveAutoPhotoPicks(
    TENANT,
    [
      { actionId: 'a1', generatedAt: AT, picks: [pick(Q)] },
      { actionId: 'a2', generatedAt: AT, picks: [pick(Q)] },
    ],
    3,
    groupOf,
  )
  ok('한 묶음 안에서도 같은 작성자의 둘째 글에는 넣지 않는다', r3.saved === 1 && r3.skipped === 1 && readMap().a1?.photos?.[0]?.src === Q && !readMap().a2?.photos)

  // 3) 작성자를 모르면(배정 없음) 글 · 브랜드 상한만 — 지금과 같다.
  writeDrafts({ a1: draft('a1', [pick(P)]), a2: draft('a2') })
  const r4 = await saveAutoPhotoPicks(TENANT, [{ actionId: 'a2', generatedAt: AT, picks: [pick(P)] }], 3)
  ok('작성자를 모르면 다른 글의 같은 사진도 넣는다(브랜드 상한 안)', r4.saved === 1 && readMap().a2?.photos?.[0]?.src === P)

  // 배정 파일이 없으면 서버는 작성자를 모른다(글 · 브랜드 상한만).
  const { writerGroupOf } = await import('../server/probePlanStore')
  ok('배정 파일이 없으면 작성자 상한을 두지 않는다', (await writerGroupOf(TENANT))('a1') === undefined)

  // 3-b) 출처 붙이기 — 출처 없는 공공 사진(공공 사진 호스트)에만, 자리 · 주소가 같을 때만. 확인 시각 · 자동 표시는 그대로, 사진 없이도 저장.
  const T = 'https://tong.visitkorea.or.kr/cms/legacy.jpg'
  const KOGL1 = 'https://www.kogl.or.kr/info/licenseType1.do'
  const legacy = { ...pick(T), auto: undefined }
  writeDrafts({ a1: draft('a1', [legacy as unknown as ReturnType<typeof pick>]), a2: draft('a2', [pick(P)]) })
  const fields = { origin: 'public' as const, license: 'kogl-1' as const, credit: '가상관광공사', creditUrl: KOGL1 }
  const place = { slot: legacy.slot, nth: 1, heading: legacy.heading }
  const r5 = await saveAutoPhotoPicks(
    TENANT,
    [
      { actionId: 'a1', generatedAt: AT, picks: [], credits: [{ place, src: T, fields, pageUrl: 'https://site.example/places/x/' }] },
      { actionId: 'a2', generatedAt: AT, picks: [], credits: [{ place, src: P, fields, pageUrl: 'https://site.example/places/x/' }] },
    ],
    3,
  )
  const fixed = readMap().a1?.photos?.[0] as Record<string, unknown> | undefined
  ok(
    '출처 없는 공공 사진에 출처를 붙인다(확인 시각 · 찾은 페이지)',
    r5.credited === 1 && r5.saved === 0 && fixed?.origin === 'public' && fixed.credit === '가상관광공사' && fixed.creditUrl === KOGL1 && fixed.confirmedAt === AT && fixed.pageUrl === 'https://site.example/places/x/',
  )
  ok('홈페이지 사진(출처가 필요 없는 사진)에는 붙이지 않는다', !(readMap().a2?.photos?.[0] as Record<string, unknown> | undefined)?.origin && r5.drafts.length === 1)

  // 4) 둘째 묶음에서 연결이 끊김 — 앞 묶음의 결과가 partial로 온다.
  const { saveDraftPhotosAuto } = await import('../src/lib/api')
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      const body = { drafts: [draft('x1', [pick(P)])], saved: 1, skipped: 0, changed: [], missing: [] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  const many = Array.from({ length: 12 }, (_, i) => ({ actionId: `x${i + 1}`, generatedAt: AT, picks: [pick(P)] }))
  let partial: { saved?: number; drafts?: unknown[] } | undefined
  let message = ''
  try {
    await saveDraftPhotosAuto(TENANT, many)
  } catch (e) {
    partial = (e as { partial?: { saved?: number; drafts?: unknown[] } }).partial
    message = e instanceof Error ? e.message : String(e)
  }
  ok('둘째 묶음 요청이 끊기면 앞 묶음 결과를 partial로 돌려준다', calls === 2 && partial?.saved === 1 && partial.drafts?.length === 1)
  ok('끊긴 이유는 오류 문구에 남는다', message.includes('Failed to fetch'))
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
