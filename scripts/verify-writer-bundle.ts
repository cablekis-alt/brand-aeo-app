/**
 * 작성자 묶음(src/lib/writerBundle.ts)을 확인한다. 가짜 브랜드 · 가짜 초안만 쓰고 서버 · AI는 부르지 않는다. 폴더 고르기 · 사진 받기 ·
 * 내려받기는 가짜 창(window · fetch · document)으로 흉내 낸다 — 디스크에는 아무것도 쓰지 않는다.
 *
 * 왜: 작성자는 받은 묶음만 보고 글을 올린다. 다른 작성자의 글이 섞이거나, 파일 번호가 배정표와 어긋나거나, 묶음의 .html이 글 카드의
 * 「홈페이지용 .html」과 다르거나(빈칸 줄 · 사진 · 글 끝), 사진이 어느 글 것인지 모르면 잘못 올린다. 공공 사진(공공누리 제1유형)은 출처
 * 표시가 이용 조건이라, .html의 사진 설명 · JSON-LD와 「00-사진 출처.txt」에 출처가 빠지면 안 되고, 출처 없는 공공 사진은 묶음에 넣지 않는다.
 *
 *   npx tsx scripts/verify-writer-bundle.ts
 */
import type { StoredDraft, TenantSummary } from '../src/lib/api'
import type { PhotoPick } from '../src/lib/articlePhotos'
import { buildPublishHtml } from '../src/lib/htmlFile'
import type { WriterPlan, WriterPlanArticle } from '../src/lib/probePlan'
import { bundlePhotoName, canSaveToFolder, PHOTO_CREDITS_FILE, photoCreditsText, saveWriterBundle, writerBundle } from '../src/lib/writerBundle'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const brand: TenantSummary = {
  tenantId: 'vstay', brandName: '가상 스테이', aliases: ['가상 스테이'], ownedDomains: ['vstay.example'],
  industry: '숙박', region: '가상시', engines: [], questionBankSize: 40, competitors: [],
}
const rights = { photoRights: { confirmedAt: '2026-10-20T10:00:00.000Z' } }

const art = (n: number, key: string, name: string): WriterPlanArticle => {
  const questionIds = [`c1-${String(n).padStart(3, '0')}`, `c1-${String(n + 50).padStart(3, '0')}`]
  return {
    id: `topic:${questionIds.join('+')}`,
    name,
    angle: `${name} 각도`,
    writer: { key, name: key === 'w1' ? '가나다' : '라마바' },
    blog: '',
    questionIds,
    questionTexts: questionIds.map((q) => `가상시 숙소 질문 ${q}?`),
  }
}
const plan: WriterPlan = {
  format: 'probe-plan/2',
  tenantId: 'vstay',
  bankVersion: 'v6',
  activeUntil: '2027-03-31',
  source: { writers: 'docs/writers.json', seed: 1 },
  articles: [art(1, 'w1', '가상시 독채 고르기 (가족 여행)'), art(2, 'w2', '가상시 야경 (혼자 여행)'), art(3, 'w1', '가상시 조식 (가족 여행)'), art(4, 'w1', '가상시 주차: 고르는 법')],
}

const draftOf = (actionId: string, title: string, over: Partial<StoredDraft> = {}): StoredDraft => ({
  actionId,
  generatedAt: '2026-11-02T09:00:00.000Z',
  draft: {
    format: 'article',
    title,
    lead: `${title}에 바로 답합니다.`,
    sections: [
      { heading: '무엇부터 보나요?', answers: 'c1-001', blocks: [{ kind: 'text', role: 'key', body: '목적지에 가까운 곳이 편합니다.' }], image: { alt: '가상 골목 풍경', caption: '골목 입구' } },
      { heading: '사례: 가상 스테이', answers: 'c1-051', blocks: [{ kind: 'text', body: '가상 스테이는 독채 두 동입니다.' }, { kind: 'gap', need: '가격 — 항목 없음' }] },
    ],
    gapCount: 1,
    usedFacts: [],
  },
  ...over,
})
const photo = (over: Partial<PhotoPick> = {}): PhotoPick => ({
  slot: '가상 골목 풍경', nth: 1, same: 1, heading: '무엇부터 보나요?', src: 'https://vstay.example/img/alley.jpg',
  alt: '골목 입구의 돌담', pageUrl: 'https://vstay.example/', confirmedAt: '2026-10-20T10:00:00.000Z', ...over,
})
const [a1, a2, a3, a4] = plan.articles as [WriterPlanArticle, WriterPlanArticle, WriterPlanArticle, WriterPlanArticle]
const drafts: Record<string, StoredDraft> = {
  [a1.id]: draftOf(a1.id, '가상시 독채 고르는 기준 {N}가지', { photos: [photo()] }),
  [a2.id]: draftOf(a2.id, '가상시 야경 명소 {N}곳'),
  // a3는 초안이 없다. a4는 빈칸을 모두 채웠다.
  [a4.id]: draftOf(a4.id, '가상시 주차 안내', { gapFills: { '1:1': { value: '1박 10만 원부터' } } }),
}

// 1) 묶음 계산 — 그 작성자 글만, 배정 순서 번호, 글 카드 .html과 같은 문서
const input = { plan, writerKey: 'w1', drafts, brand, facts: [], settings: rights, today: '2026-11-02' }
const b = writerBundle(input)
const htmls = b.files.filter((f): f is Extract<typeof f, { kind: 'html' }> => f.kind === 'html')
const photos = b.files.filter((f): f is Extract<typeof f, { kind: 'photo' }> => f.kind === 'photo')
ok('묶음 폴더 이름은 브랜드-작성자 키-이름-날짜', b.folder === '가상-스테이-w1-가나다-2026-11-02')
ok('그 작성자 글만 담는다(다른 작성자 글은 없다)', htmls.length === 2 && !htmls.some((f) => f.name.includes('야경')))
ok(
  '번호는 배정표 번호(작성자 안 배정 순서) — 초안 없는 2번은 비고 다음 글은 3번',
  htmls[0]?.name === '01-가상시-독채-고르기-(가족-여행).html' && htmls[1]?.name === '03-가상시-주차-고르는-법.html' && !htmls.some((f) => f.name.startsWith('02-')),
)
ok('파일 이름에 쓸 수 없는 글자(:)는 빠진다', !b.files.some((f) => f.kind === 'html' && f.name.includes(':')))
ok('초안이 없는 글은 빼고 이름을 알린다', b.missing.length === 1 && b.missing[0] === a3.name && b.articles === 2)
ok('빈칸이 남은 글을 센다(채운 글은 세지 않는다)', b.withGaps === 1)
ok('.html은 글 카드 「홈페이지용 .html」과 같은 문서', htmls[0]?.text === buildPublishHtml({ stored: drafts[a1.id]!, brand, facts: [], settings: rights }))
ok('.html에서 빈칸 줄은 빠진다', !htmls.some((f) => f.text.includes('채워야 함')))
ok('사진은 그 글 번호를 달고 하나', photos.length === 1 && b.photos === 1 && photos[0]?.prefix === '01' && photos[0]?.actionId === a1.id && photos[0]?.photo.place.slot === '가상 골목 풍경')
ok('사진 파일 이름은 글 번호 + 사진 번호 + 소제목 + 받은 형식의 확장자', photos[0] ? bundlePhotoName(photos[0], 'image/png') === '01-사진1-무엇부터-보나요.png' : false)
ok('사진 사용 확인이 없으면 사진도 없다', writerBundle({ ...input, settings: null }).files.every((f) => f.kind === 'html'))
ok('배정에 없는 작성자는 빈 묶음', writerBundle({ ...input, writerKey: 'w9' }).files.length === 0)
ok('공공 사진이 없으면 출처 파일도 없다', !b.files.some((f) => f.kind === 'credits'))

// 1-b) 공공 사진(공공누리 제1유형) — 출처 줄 · JSON-LD ImageObject · 「00-사진 출처.txt」, 출처 없는 공공 사진은 빼기
const KOGL1 = 'https://www.kogl.or.kr/info/licenseType1.do'
const TOUR = 'https://tong.example.or.kr/cms/a1_image2_1.jpg'
const publicPhoto = photo({ src: TOUR, alt: '가상섬', pageUrl: 'https://vstay.example/places/가상섬/', origin: 'public', license: 'kogl-1', credit: '가상관광공사', creditUrl: KOGL1 })
const publicRights = { photoRights: { confirmedAt: '2026-10-20T10:00:00.000Z', publicAt: '2026-11-03T01:00:00.000Z' } }
const pubDrafts: Record<string, StoredDraft> = { ...drafts, [a4.id]: { ...drafts[a4.id]!, photos: [publicPhoto] } }
const pubInput = { ...input, drafts: pubDrafts, settings: publicRights }
const pb = writerBundle(pubInput)
const creditsFile = pb.files.find((f): f is Extract<typeof f, { kind: 'credits' }> => f.kind === 'credits')
const pubHtml = pb.files.find((f): f is Extract<typeof f, { kind: 'html' }> => f.kind === 'html' && f.name.startsWith('03-'))?.text ?? ''
ok('공공 사진이 있으면 묶음 끝에 「00-사진 출처.txt」', creditsFile?.name === PHOTO_CREDITS_FILE && pb.files.at(-1) === creditsFile && creditsFile.photos.length === 1 && pb.photos === 2)
ok(
  '.html 사진 설명에 출처와 이용 허락 링크(「제공」 · 「협찬」 · 「공식」 없이)',
  pubHtml.includes(`<figcaption>골목 입구 (사진: 가상관광공사, <a href="${KOGL1}" rel="noopener">공공누리 제1유형</a>)</figcaption>`) && !/제공|협찬|공식/.test(/<figcaption>[^<]*/.exec(pubHtml)?.[0] ?? ''),
)
const ldText = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(pubHtml)?.[1] ?? '{}'
const ldImage = (JSON.parse(ldText.replace(/<\\\//g, '</')) as { image?: unknown[] }).image ?? []
ok(
  'JSON-LD image는 ImageObject(contentUrl · creditText · license · acquireLicensePage)',
  JSON.stringify(ldImage) === JSON.stringify([{ '@type': 'ImageObject', contentUrl: TOUR, creditText: '가상관광공사', license: KOGL1, acquireLicensePage: KOGL1 }]),
)
ok('홈페이지 사진의 JSON-LD image는 지금처럼 주소 글자', htmls[0]!.text.includes('"image": [\n    "https://vstay.example/img/alley.jpg"\n  ]'))
const creditText = creditsFile ? photoCreditsText(creditsFile, () => undefined) : ''
const creditRow = creditText.split('\r\n').find((l) => l.startsWith('03\t')) ?? ''
ok(
  '출처 파일 — 글 번호 · 사진 파일 이름 · 출처 · 유형 · 원 주소 · 받은 날(탭, CRLF)',
  creditRow === ['03', '03-사진1-무엇부터-보나요.jpg', '가상관광공사', `공공누리 제1유형 (${KOGL1})`, TOUR, '2026-11-02'].join('\t') && creditText.endsWith('\r\n') && creditText.includes('글 번호\t사진 파일 이름\t출처\t유형\t원 주소\t받은 날'),
)
ok('공공 사진 사용 확인(publicAt)이 없으면 공공 사진도 출처 파일도 없다', (() => {
  const nb = writerBundle({ ...pubInput, settings: rights })
  return nb.photos === 1 && !nb.files.some((f) => f.kind === 'credits') && !nb.files.some((f) => f.kind === 'html' && f.text.includes(TOUR))
})())
const noCreditDrafts: Record<string, StoredDraft> = { ...drafts, [a4.id]: { ...drafts[a4.id]!, photos: [photo({ src: 'https://tong.visitkorea.or.kr/cms/x_image2_1.jpg' })] } }
const ncb = writerBundle({ ...input, drafts: noCreditDrafts, settings: publicRights })
ok('출처 없는 공공 사진(공공 사진 호스트 · 출처 없음)은 .html · 사진 파일에 넣지 않는다', ncb.photos === 1 && !ncb.files.some((f) => f.kind === 'html' && f.text.includes('tong.visitkorea')) && !ncb.files.some((f) => f.kind === 'credits'))

// 2) 저장 — 폴더 고르기(가짜 창)
type Written = Map<string, { type: string; size: number; blob?: Blob }>
/** folders는 이번에 만든 폴더, existing은 처음부터 있던(또는 만든) 폴더, plainFiles는 고른 폴더에 있던 같은 이름의 파일. */
function fakeFolder(name: string, written: Written, folders: string[], failOn?: string, existing = new Set<string>(), plainFiles = new Set<string>()) {
  return {
    name,
    async getDirectoryHandle(child: string, opts?: { create?: boolean }) {
      if (plainFiles.has(child)) throw new DOMException('같은 이름의 파일', 'TypeMismatchError')
      if (!opts?.create && !existing.has(child)) throw new DOMException('없음', 'NotFoundError')
      if (opts?.create && !existing.has(child)) {
        folders.push(child)
        existing.add(child)
      }
      return {
        name: child,
        async getFileHandle(file: string, o?: { create?: boolean }) {
          if (!o?.create) throw new Error('create 없이 열었다')
          let data: Blob | null = null
          return {
            async createWritable() {
              return {
                async write(blob: Blob) {
                  if (file === failOn) throw new Error('디스크가 가득 찼다')
                  data = blob
                },
                async close() {
                  if (data) written.set(`${child}/${file}`, { type: data.type, size: data.size, blob: data })
                },
                async abort() {
                  written.set(`${child}/${file}#aborted`, { type: '', size: 0 })
                },
              }
            },
          }
        },
      }
    },
  }
}
const g = globalThis as Record<string, unknown>
const photoRequests: string[] = []
g.fetch = async (url: string) => {
  photoRequests.push(url)
  return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), { status: 200 })
}

async function main(): Promise<void> {
  const written: Written = new Map()
  const folders: string[] = []
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', written, folders) }
  ok('폴더 고르기가 있으면 폴더로 저장한다', canSaveToFolder())
  const saved = await saveWriterBundle('vstay', b)
  ok('고른 폴더 안에 묶음 폴더 하나', folders.length === 1 && folders[0] === b.folder && saved?.where === `바탕 화면/${b.folder}`)
  ok('파일이 모두 그 폴더에 저장된다', saved?.saved === 3 && written.size === 3 && [...written.keys()].every((k) => k.startsWith(`${b.folder}/`)))
  ok('.html은 html 형식, 사진은 받은 형식(jpg)으로', written.get(`${b.folder}/${htmls[0]!.name}`)?.type === 'text/html;charset=utf-8' && written.has(`${b.folder}/01-사진1-무엇부터-보나요.jpg`))
  const asked = photoRequests[0] ? new URL(photoRequests[0], 'http://127.0.0.1/').searchParams : null
  ok(
    '사진은 그 글 · 그 판 · 그 자리로 청한다',
    photoRequests.length === 1 && asked?.get('actionId') === a1.id && asked.get('generatedAt') === drafts[a1.id]!.generatedAt && asked.get('slot') === '가상 골목 풍경',
  )

  // 같은 날 같은 곳에 다시 받으면 — 있는 묶음 폴더를 다시 쓰면 지난번에만 있던 사진이 섞여 남는다. 새 폴더(…-2)에 쓴다.
  const againWritten: Written = new Map()
  const againFolders: string[] = []
  const existing = new Set<string>()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', againWritten, againFolders, undefined, existing) }
  await saveWriterBundle('vstay', b)
  const firstFiles = [...againWritten.keys()].sort()
  const noPhotos = writerBundle({ ...input, settings: null })
  const again = await saveWriterBundle('vstay', noPhotos)
  const secondFiles = [...againWritten.keys()].filter((k) => k.startsWith(`${b.folder}-2/`))
  ok(
    '다시 받으면 새 묶음 폴더(…-2)에 쓰고 지난 폴더는 건드리지 않는다',
    again?.where === `바탕 화면/${b.folder}-2` &&
      JSON.stringify(againFolders) === JSON.stringify([b.folder, `${b.folder}-2`]) &&
      JSON.stringify([...againWritten.keys()].filter((k) => k.startsWith(`${b.folder}/`)).sort()) === JSON.stringify(firstFiles),
  )
  ok('새 묶음 폴더에는 이번 묶음 파일만 — 지난번 사진이 섞이지 않는다', secondFiles.length === noPhotos.files.length && secondFiles.every((k) => k.endsWith('.html')))
  ok('세 번째는 …-3', (await saveWriterBundle('vstay', b))?.where === `바탕 화면/${b.folder}-3`)
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', new Map(), [], undefined, new Set(), new Set([b.folder])) }
  const besideFile = await saveWriterBundle('vstay', b)
  ok('같은 이름의 파일이 있으면 그 이름도 피한다', besideFile?.where === `바탕 화면/${b.folder}-2`)

  g.window = {
    showDirectoryPicker: async () => {
      throw new DOMException('닫음', 'AbortError')
    },
  }
  ok('폴더 고르기를 닫으면 null(아무것도 쓰지 않는다)', (await saveWriterBundle('vstay', b)) === null)

  const failWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', failWritten, [], htmls[1]!.name) }
  let error = ''
  try {
    await saveWriterBundle('vstay', b)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  ok('쓰다 실패하면 그 파일은 버리고(abort) 원래 오류를 올린다', error === '디스크가 가득 찼다' && failWritten.has(`${b.folder}/${htmls[1]!.name}#aborted`) && !failWritten.has(`${b.folder}/${htmls[1]!.name}`))

  // 3) 폴더 고르기가 없는 곳 — 파일마다 내려받기(이름 앞에 묶음 이름)
  const downloads: string[] = []
  g.window = { setTimeout: () => 0 }
  g.document = {
    createElement: () => ({ href: '', download: '', click() { downloads.push(this.download) }, remove() {} }),
    body: { appendChild: () => undefined },
  }
  const urlApi = URL as unknown as Record<string, unknown>
  urlApi.createObjectURL = () => 'blob:fake'
  urlApi.revokeObjectURL = () => undefined
  ok('폴더 고르기가 없으면 내려받기로', !canSaveToFolder())
  const down = await saveWriterBundle('vstay', b)
  ok('파일마다 내려받고 이름 앞에 묶음 이름', down?.saved === 3 && downloads.length === 3 && downloads.every((n) => n.startsWith(`${b.folder}-`)) && downloads.includes(`${b.folder}-01-사진1-무엇부터-보나요.jpg`))

  // 4) 공공 사진 묶음 저장 — 사진은 받은 바이트 그대로, 출처 파일은 저장한 사진 이름으로(맨 마지막)
  const pubWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', pubWritten, []) }
  photoRequests.length = 0
  const pubSaved = await saveWriterBundle('vstay', pb)
  const savedCredits = await pubWritten.get(`${pb.folder}/${PHOTO_CREDITS_FILE}`)?.blob?.text()
  const savedPhoto = pubWritten.get(`${pb.folder}/03-사진1-무엇부터-보나요.jpg`)
  ok('공공 사진 묶음 — 사진 2장 · .html 2개 · 출처 파일 1개', pubSaved?.saved === 5 && pubWritten.size === 5 && photoRequests.length === 2)
  ok('사진 파일은 서버가 보낸 바이트 그대로(다시 인코딩하지 않는다)', savedPhoto?.size === 3 && savedPhoto.type === 'image/jpeg')
  ok(
    '출처 파일에 저장한 사진 파일 이름과 출처가 적힌다',
    Boolean(savedCredits?.includes(['03', '03-사진1-무엇부터-보나요.jpg', '가상관광공사'].join('\t'))) && pubWritten.get(`${pb.folder}/${PHOTO_CREDITS_FILE}`)?.type === 'text/plain;charset=utf-8',
  )

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
}

await main()
