/**
 * 업주 사진 보관함(src/lib/ownerPhotos.ts · server/ownerPhotos.ts, 2026-11-06)을 확인한다 — 형식 · 크기 가리기, 서버 길(올리기 · 목록 · 파일 ·
 * 설명 고치기 · 빼기 · 사진 넣기 · 자동 채우기 저장 · 사진 받기), 내보내기(.html · 서식째 복사 — 문서 안 그림, JSON-LD에서 빼기), 자동 채우기
 * 후보. 임시 데이터 폴더 · 모의 엔진으로 서버(server/index.ts)를 포트 4126에 띄워 HTTP로 부른다. AI · 바깥 사이트는 부르지 않는다(Claude
 * 키를 빼서 장면 읽기는 「키 없음」으로 남는다).
 *
 * 왜:
 * - 업주 사진은 공개 https 주소가 아니다 — 앱 주소(/api/owner-photos/…)가 블로그로 그대로 나가면 독자에게 깨진다. 내보낼 때 문서 안에 넣고,
 *   구조화 데이터(JSON-LD image · og:image)에는 넣지 않아야 한다.
 * - 화면이 보낸 주소 · 설명은 믿지 않는다 — 서버가 보관함의 id로 찾아 단다. 권리 확인 없이 올리지 못해야 한다.
 * - 사진이 아닌 파일 · 큰 파일은 받지 않는다(앞 바이트로 가린다).
 *
 *   npx tsx scripts/verify-owner-photos.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ownerPhotoAppSrc,
  ownerPhotoSize,
  parseOwnerPhotoAppSrc,
  sniffOwnerPhotoType,
} from '../src/lib/ownerPhotos'
import { photoCreditState, photoPickSrc, withPhotos, type PhotoPick } from '../src/lib/articlePhotos'
import { exportLeaks, inlineScreens, screenPlainText } from '../src/lib/screenExport'
import { markdownToHtml } from '../src/lib/htmlFile'
import { autoPickPhotos, autoCandidateSkip, ownPhotoExempt } from '../src/lib/photoAutoPick'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// 1x1 PNG · 작은 JPEG(SOF0 2x3) · WEBP(VP8X 5x4) 머리
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGBkAFwQB/5LDqo0AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
const WEBP = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8X', 'latin1'), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0])])

// 1) 형식 · 크기 · 앱 주소
ok('앞 바이트로 형식을 가린다(jpg · png · webp, 그 밖은 null)', sniffOwnerPhotoType(PNG) === 'image/png' && sniffOwnerPhotoType(JPEG) === 'image/jpeg' && sniffOwnerPhotoType(WEBP) === 'image/webp' && sniffOwnerPhotoType(Buffer.from('<svg/>')) === null)
ok(
  '그림 크기 — PNG IHDR · JPEG SOF · WEBP VP8X',
  JSON.stringify(ownerPhotoSize(PNG, 'image/png')) === '{"width":1,"height":1}' &&
    JSON.stringify(ownerPhotoSize(JPEG, 'image/jpeg')) === '{"width":2,"height":3}' &&
    JSON.stringify(ownerPhotoSize(WEBP, 'image/webp')) === '{"width":5,"height":4}',
)
const SRC = ownerPhotoAppSrc('vowner', '0123456789abcdef', 'jpg')
ok(
  '앱 주소 — 만들고 읽는다, 다른 모양 · 경로 글자는 아니다',
  SRC === '/api/owner-photos/vowner/0123456789abcdef.jpg' && parseOwnerPhotoAppSrc(SRC)?.id === '0123456789abcdef' &&
    parseOwnerPhotoAppSrc('/api/owner-photos/../0123456789abcdef.jpg') === null && parseOwnerPhotoAppSrc('/api/owner-photos/x/0123.jpg') === null &&
    parseOwnerPhotoAppSrc('https://x.example/a.jpg') === null,
)

// 2) 사진 기록 · 내보내기
const AT = '2026-11-06T00:00:00.000Z'
const ownerPick: PhotoPick = {
  slot: '가상스테이 독채 앞 정원', nth: 1, same: 1, heading: '정원', src: SRC, alt: '가상스테이 독채 앞 정원과 나무 데크', pageUrl: 'https://stay.example/',
  confirmedAt: AT, origin: 'owner', ownerPhotoId: '0123456789abcdef',
}
ok('업주 사진은 출처 표시가 필요 없고(site) 앱 주소 그대로 넣는다 · id가 다르면 넣지 않는다', photoCreditState(ownerPick) === 'site' && photoPickSrc(ownerPick) === SRC && photoPickSrc({ ...ownerPick, ownerPhotoId: 'ffffffffffffffff' }) === null)
const MD = ['# 가상 글', '', '## 정원', '', '![가상스테이 독채 앞 정원](#image-slot)', '*정원 설명*', ''].join('\n')
const placed = withPhotos(MD, [ownerPick])
ok('발행본에 앱 주소 그림으로 들어가고 applied에 owner 표시', placed.markdown.includes(`](${SRC})`) && placed.applied[0]?.owner?.id === '0123456789abcdef')
const html = markdownToHtml(placed.markdown)
ok('.html 본문에 그림으로(앱 주소 — 내보낼 때 문서 안에 넣는다)', html.includes(`<img src="${SRC}"`))
const inlined = await inlineScreens(html, async () => new Blob([JPEG], { type: 'image/jpeg' }))
ok('내보낼 때 업주 사진을 문서 안(data:image/jpeg)에 넣고 앱 주소가 남지 않는다', inlined.inlined === 1 && inlined.html.includes('data:image/jpeg;base64,') && exportLeaks(inlined.html).length === 0)
const notFetched = await inlineScreens(html, async () => {
  throw new Error('없음')
})
ok('받지 못하면 「[사진: 설명]」 글자로 둔다', notFetched.dropped === 1 && notFetched.html.includes('[사진: 가상스테이 독채 앞 정원과 나무 데크]') && exportLeaks(notFetched.html).length === 0)
ok('서식째 복사의 글자 쪽도 「[사진: 설명]」', screenPlainText(placed.markdown).includes('[사진: 가상스테이 독채 앞 정원과 나무 데크]') && exportLeaks(screenPlainText(placed.markdown)).length === 0)
ok('남으면 안 되는 주소에 업주 사진 앱 주소도 든다', exportLeaks(`x ${SRC}`).includes('/api/owner-photos/'))

// 3) 자동 채우기 후보
const ownerCand = { src: SRC, alt: '가상스테이 독채 앞 아담한 정원과 나무 데크', pageUrl: 'https://stay.example/', origin: 'owner' as const, ownerPhotoId: '0123456789abcdef' }
ok('업주 사진 후보 — 앱 주소라도 받는다(https 검사 대신 주소 모양) · 모양이 틀리면 bad-src', autoCandidateSkip(ownerCand) === null && autoCandidateSkip({ ...ownerCand, src: '/api/x.jpg' }) === 'bad-src')
const groups = ['w1', 'w2', 'w3', 'w4', 'w5']
const run = autoPickPhotos({
  articles: groups.map((g) => ({ actionId: `a-${g}`, generatedAt: AT, markdown: MD.replace('가상스테이 독채 앞 정원', '가상스테이 독채 앞의 아담한 정원 풍경'), group: g })),
  candidates: [ownerCand],
  brandName: '가상스테이',
})
ok(
  '자기 시설 정원 자리에 업주 사진 — origin owner · id를 싣고, 작성자 다섯에게 모두(브랜드 상한 3 면제)',
  run.articles.every((a) => a.picks[0]?.origin === 'owner' && a.picks[0]?.ownerPhotoId === '0123456789abcdef' && a.picks[0]?.src === SRC),
)
ok('업주 사진은 자기 시설 자리에서 브랜드 상한을 받지 않는다(서버도 같은 판정)', ownPhotoExempt({ slot: '가상스테이 독채 앞 정원', origin: 'owner' }, '가상스테이'))

// 4) 서버 길
const PORT = 4126
const BASE = `http://127.0.0.1:${PORT}`
const TENANT = 'vowner'
const portFree = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
const dir = mkdtempSync(path.join(tmpdir(), 'verify-owner-photos-'))
const tenantDir = path.join(dir, 'data', TENANT)
mkdirSync(tenantDir, { recursive: true })
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    {
      tenantId: TENANT, brandName: '가상스테이', aliases: ['가상스테이'], ownedDomains: ['stay.example'], brandPageUrl: 'https://stay.example/s/stay', industry: '숙박', region: '가상시',
      engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
    },
  ]),
)
const draft = (id: string) => ({ actionId: id, generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] } })
writeFileSync(path.join(tenantDir, 'drafts.json'), JSON.stringify({ 'content:a': draft('content:a'), 'content:b': draft('content:b') }))
writeFileSync(path.join(tenantDir, 'publish-settings.json'), JSON.stringify({ photoRights: { confirmedAt: AT } }))
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
const upload = (bytes: Buffer, q: Record<string, string>, type = 'image/png') =>
  fetch(`${BASE}/api/owner-photos/${TENANT}?${new URLSearchParams(q).toString()}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }))
const put = (body: unknown) =>
  fetch(`${BASE}/api/content-draft/${TENANT}/photos`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }))
const stored = () => JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: Record<string, unknown>[] }>
try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  ok('권리 확인 없이 올리면 400', (await upload(PNG, { alt: '정원', holder: '업주' })).status === 400)
  ok('사진이 아닌 파일은 400', (await upload(Buffer.from('<svg></svg>'), { confirmed: '1', alt: '정원' }, 'application/octet-stream')).status === 400)
  const first = await upload(PNG, { confirmed: '1', alt: '가상스테이 독채 앞 정원과 나무 데크', holder: '업주 지인(촬영자)', note: '문자로 받음' })
  const photo = first.body.photo as Record<string, unknown> | undefined
  const id = String(photo?.id ?? '')
  ok(
    '올리기 — 201 · id(sha256 앞 16자) · 앱 주소 · 크기 · 권리 기록 · 키가 없으면 장면 못 읽음',
    first.status === 201 && /^[0-9a-f]{16}$/.test(id) && photo?.src === ownerPhotoAppSrc(TENANT, id, 'png') && photo?.width === 1 &&
      (photo?.rights as Record<string, unknown>)?.holder === '업주 지인(촬영자)' && !photo?.scene && typeof photo?.sceneError === 'string',
  )
  const again = await upload(PNG, { confirmed: '1', alt: '가상스테이 독채 앞 정원, 맑은 낮', holder: '업주' })
  ok('같은 사진을 다시 올리면 200 existed — 설명만 새로', again.status === 200 && again.body.existed === true && (again.body.photo as Record<string, unknown>)?.alt === '가상스테이 독채 앞 정원, 맑은 낮')
  await upload(PNG2, { confirmed: '1', alt: '가상스테이 거실', holder: '업주' })
  const list = (await (await fetch(`${BASE}/api/owner-photos/${TENANT}`)).json()) as { photos: Record<string, unknown>[]; scenesAvailable: boolean }
  ok('목록 — 두 장 · 장면을 읽을 수 없는 PC', list.photos.length === 2 && list.scenesAvailable === false)
  const fileRes = await fetch(`${BASE}${ownerPhotoAppSrc(TENANT, id, 'png')}`)
  ok('파일 — 그 형식 · 바이트 그대로', fileRes.status === 200 && fileRes.headers.get('content-type') === 'image/png' && Buffer.from(await fileRes.arrayBuffer()).equals(PNG))
  ok('확장자가 다르면 404', (await fetch(`${BASE}${ownerPhotoAppSrc(TENANT, id, 'jpg')}`)).status === 404)
  const patched = await fetch(`${BASE}/api/owner-photos/${TENANT}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alt: '가상스테이 독채 앞 디딤돌 마당과 정원' }) })
  ok('설명 고치기', patched.status === 200 && ((await patched.json()) as { photo: { alt: string } }).photo.alt === '가상스테이 독채 앞 디딤돌 마당과 정원')

  // 사진 넣기 — 화면이 보낸 src · alt는 쓰지 않는다
  const pickRes = await put({
    actionId: 'content:a', generatedAt: AT, op: 'pick',
    pick: { slot: '가상스테이 독채 앞 정원', nth: 1, same: 1, heading: '정원', src: 'https://evil.example/x.jpg', alt: '아무 글자', pageUrl: 'https://evil.example/', origin: 'owner', ownerPhotoId: id },
  })
  const savedPick = stored()['content:a']?.photos?.[0]
  ok(
    '사진 넣기 — 서버가 보관함에서 앱 주소 · 설명 · 브랜드 페이지를 단다(화면이 보낸 주소 · 설명은 버린다)',
    pickRes.status === 200 && savedPick?.origin === 'owner' && savedPick.ownerPhotoId === id && savedPick.src === ownerPhotoAppSrc(TENANT, id, 'png') &&
      savedPick.alt === '가상스테이 독채 앞 디딤돌 마당과 정원' && savedPick.pageUrl === 'https://stay.example/s/stay',
  )
  ok('없는 업주 사진은 400', (await put({ actionId: 'content:a', generatedAt: AT, op: 'pick', pick: { slot: '가상스테이 거실', nth: 1, same: 1, heading: '거실', src: 'x', alt: 'x', pageUrl: 'x', origin: 'owner', ownerPhotoId: 'ffffffffffffffff' } })).status === 400)
  const auto = await put({
    op: 'auto',
    articles: [{ actionId: 'content:b', generatedAt: AT, picks: [{ slot: '가상스테이 독채 앞 정원', nth: 1, same: 1, heading: '정원', src: 'x', alt: 'x', pageUrl: 'x', auto: true, origin: 'owner', ownerPhotoId: id }] }],
  })
  ok('자동 채우기 저장 — 업주 사진(자동 표시)', auto.status === 200 && auto.body.saved === 1 && stored()['content:b']?.photos?.[0]?.origin === 'owner' && stored()['content:b']?.photos?.[0]?.auto === true)
  const q = new URLSearchParams({ actionId: 'content:a', generatedAt: AT, slot: '가상스테이 독채 앞 정원', nth: '1', heading: '정원' })
  const pf = await fetch(`${BASE}/api/content-draft/${TENANT}/photo-file?${q.toString()}`)
  ok('사진 받기 — 이 PC의 업주 사진 파일을 그대로', pf.status === 200 && pf.headers.get('content-type') === 'image/png' && Buffer.from(await pf.arrayBuffer()).equals(PNG))

  const del = await fetch(`${BASE}/api/owner-photos/${TENANT}/${id}`, { method: 'DELETE' })
  ok('빼기 — 목록 · 파일이 없어지고, 넣어 둔 글의 사진 받기는 404', del.status === 200 && (await fetch(`${BASE}${ownerPhotoAppSrc(TENANT, id, 'png')}`)).status === 404 &&
    (await fetch(`${BASE}/api/content-draft/${TENANT}/photo-file?${q.toString()}`)).status === 404)
  ok('없는 사진 빼기는 404', (await fetch(`${BASE}/api/owner-photos/${TENANT}/${id}`, { method: 'DELETE' })).status === 404)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 800))
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
