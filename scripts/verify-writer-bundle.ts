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
import { MAP_CREDIT, mapAppSrc, mapVariantKey } from '../src/lib/mapImage'
import type { WriterPlan, WriterPlanArticle } from '../src/lib/probePlan'
import { screenAppSrc } from '../src/lib/screenCapture'
import { exportLeaks } from '../src/lib/screenExport'
import { ARTICLE_CREDITS_FILE, articlePhotoFiles, downloadArticlePhotos } from '../src/lib/sitePhotos'
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

// 1-c) 관광공사 사진(3단계 — TourAPI 관광사진, 촬영자 출처) — 같은 출처 줄 · ImageObject · 출처 파일
const GALLERY_PAGE = 'https://www.data.go.kr/data/15101914/openapi.do'
const TOUR_GAL = 'https://tong.visitkorea.or.kr/cms2/website/00/0000001.jpg'
const tourPhoto = photo({ src: TOUR_GAL, alt: '가상해양테마공원', pageUrl: GALLERY_PAGE, origin: 'public', license: 'kogl-1', credit: '한국관광공사 가상촬영', creditUrl: KOGL1, auto: true })
const tb = writerBundle({ ...input, drafts: { ...drafts, [a4.id]: { ...drafts[a4.id]!, photos: [tourPhoto] } }, settings: publicRights })
const tourHtml = tb.files.find((f): f is Extract<typeof f, { kind: 'html' }> => f.kind === 'html' && f.name.startsWith('03-'))?.text ?? ''
const tourCredits = tb.files.find((f): f is Extract<typeof f, { kind: 'credits' }> => f.kind === 'credits')
const tourRow = (tourCredits ? photoCreditsText(tourCredits, () => undefined) : '').split('\r\n').find((l) => l.startsWith('03\t')) ?? ''
ok(
  '관광공사 사진 — .html 사진 설명에 촬영자 출처와 이용 허락 링크',
  tourHtml.includes(`<figcaption>골목 입구 (사진: 한국관광공사 가상촬영, <a href="${KOGL1}" rel="noopener">공공누리 제1유형</a>)</figcaption>`),
)
ok('관광공사 사진 — JSON-LD ImageObject의 creditText', tourHtml.includes(`"creditText": "한국관광공사 가상촬영"`) && tourHtml.includes(`"contentUrl": "${TOUR_GAL}"`))
ok('관광공사 사진 — 「00-사진 출처.txt」에 출처 · 원 주소', tourRow === ['03', '03-사진1-무엇부터-보나요.jpg', '한국관광공사 가상촬영', `공공누리 제1유형 (${KOGL1})`, TOUR_GAL, '2026-11-02'].join('\t'))

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

  // 5) 사진을 받다 멈춰도 — 이미 저장한 공공 사진 옆에 「00-사진 출처.txt」가 남아야 한다(01 글의 공공 사진은 받았고 03 글의 사진에서 502)
  const failDrafts: Record<string, StoredDraft> = { ...drafts, [a1.id]: { ...drafts[a1.id]!, photos: [publicPhoto] }, [a4.id]: { ...drafts[a4.id]!, photos: [photo()] } }
  const fb = writerBundle({ ...pubInput, drafts: failDrafts })
  const okFetch = g.fetch
  let photoCalls = 0
  g.fetch = async (url: string) => {
    photoCalls += 1
    if (photoCalls === 2) return new Response(JSON.stringify({ error: '사진 주소가 답하지 않아요' }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    return (okFetch as (u: string) => Promise<Response>)(url)
  }
  const midWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', midWritten, []) }
  let midError = ''
  try {
    await saveWriterBundle('vstay', fb)
  } catch (err) {
    midError = err instanceof Error ? err.message : String(err)
  }
  const midCredits = await midWritten.get(`${fb.folder}/${PHOTO_CREDITS_FILE}`)?.blob?.text()
  ok(
    '폴더 저장 — 사진을 받다 멈춰도 저장한 공공 사진의 출처 파일이 남는다(원래 오류는 그대로)',
    midError === '사진 주소가 답하지 않아요' && midWritten.has(`${fb.folder}/01-사진1-무엇부터-보나요.jpg`) && Boolean(midCredits?.includes(['01', '01-사진1-무엇부터-보나요.jpg', '가상관광공사'].join('\t'))),
  )
  photoCalls = 0
  const midDownloads: string[] = []
  g.window = { setTimeout: () => 0 }
  g.document = {
    createElement: () => ({ href: '', download: '', click() { midDownloads.push(this.download) }, remove() {} }),
    body: { appendChild: () => undefined },
  }
  let midDownError = ''
  try {
    await saveWriterBundle('vstay', fb)
  } catch (err) {
    midDownError = err instanceof Error ? err.message : String(err)
  }
  ok(
    '내려받기 — 사진을 받다 멈춰도 받은 공공 사진의 출처 파일을 내려받는다',
    midDownError === '사진 주소가 답하지 않아요' && midDownloads.includes(`${fb.folder}-01-사진1-무엇부터-보나요.jpg`) && midDownloads.includes(`${fb.folder}-${PHOTO_CREDITS_FILE}`),
  )
  g.fetch = okFetch

  // 6) 글 카드 · 올리기 목록의 「사진 N장 받기」(글 하나) — 공공 사진이 있으면 출처 파일도 함께
  const singleDownloads: { name: string; blob: Blob }[] = []
  let lastBlob: Blob | null = null
  urlApi.createObjectURL = (blob: Blob) => {
    lastBlob = blob
    return 'blob:fake'
  }
  g.document = {
    createElement: () => ({
      href: '',
      download: '',
      click() {
        if (lastBlob) singleDownloads.push({ name: this.download, blob: lastBlob })
      },
      remove() {},
    }),
    body: { appendChild: () => undefined },
  }
  const pubDraft = failDrafts[a1.id]!
  const singleFiles = articlePhotoFiles(pubDraft, { settings: publicRights, industry: brand.industry })
  await downloadArticlePhotos('vstay', pubDraft, singleFiles)
  const singleCredit = singleDownloads.find((d) => d.name === ARTICLE_CREDITS_FILE)
  const singleText = (await singleCredit?.blob.text()) ?? ''
  ok(
    '글 하나 사진 받기 — 공공 사진이 있으면 「사진 출처.txt」(사진 파일 이름 · 출처 · 유형 · 원 주소)',
    singleDownloads.some((d) => d.name === '사진1-무엇부터-보나요.jpg') &&
      singleText.includes(['사진1-무엇부터-보나요.jpg', '가상관광공사', `공공누리 제1유형 (${KOGL1})`, TOUR].join('\t')) &&
      singleText.endsWith('\r\n'),
  )
  singleDownloads.length = 0
  await downloadArticlePhotos('vstay', drafts[a1.id]!, articlePhotoFiles(drafts[a1.id]!, { settings: rights, industry: brand.industry }))
  ok('글 하나 사진 받기 — 홈페이지 사진뿐이면 출처 파일은 없다', singleDownloads.length === 1 && !singleDownloads.some((d) => d.name === ARTICLE_CREDITS_FILE))

  // 7) 자사 화면(origin screen — 운영자 PC에 찍어 둔 화면) — 묶음의 .html에는 저장할 때 그림을 문서 안(data:image/png)에 넣고, 사진 파일은
  //    photo-file 라우트가 준 PNG 그대로(「NN-사진k-소제목.png」). 앱 주소가 작성자에게 가면 작성자 PC에서 깨진다.
  const SCREEN_SRC = screenAppSrc('vstay', '0123456789abcdef')
  const screenPhoto = photo({
    src: SCREEN_SRC, alt: "가상 스테이 웹사이트 'AI 코스 만들기' 화면", pageUrl: 'https://gunsan.webforai.kr/plan/', origin: 'screen', screenId: 'course', variantId: 'default',
    capturedAt: '2026-11-04T05:00:00.000Z',
  })
  const sb = writerBundle({ ...input, drafts: { ...drafts, [a1.id]: { ...drafts[a1.id]!, photos: [screenPhoto] } } })
  const sbHtml = sb.files.find((f): f is Extract<typeof f, { kind: 'html' }> => f.kind === 'html' && f.name.startsWith('01-'))!
  const sbPhoto = sb.files.find((f): f is Extract<typeof f, { kind: 'photo' }> => f.kind === 'photo')
  ok(
    '자사 화면 — 묶음 계산의 .html 글자는 앱 주소(저장할 때 넣는다), 화면 사진 파일 하나 · 출처 파일 없음',
    sbHtml.text.includes(`<img src="${SCREEN_SRC}"`) && sb.photos === 1 && sbPhoto?.photo.screen?.screenId === 'course' && !sb.files.some((f) => f.kind === 'credits'),
  )
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const screenFetches: string[] = []
  const pngFetch = async (url: string) => {
    screenFetches.push(url)
    return new Response(new Blob([PNG], { type: 'image/png' }), { status: 200 })
  }
  g.fetch = pngFetch
  const screenWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', screenWritten, []) }
  const screenSaved = await saveWriterBundle('vstay', sb)
  const savedScreenHtml = (await screenWritten.get(`${sb.folder}/${sbHtml.name}`)?.blob?.text()) ?? ''
  ok(
    '저장한 .html — 화면 그림은 문서 안(data:image/png), 앱 주소 · 이 PC 주소가 없다',
    savedScreenHtml.includes(`<img src="data:image/png;base64,${Buffer.from(PNG).toString('base64')}"`) && exportLeaks(savedScreenHtml).length === 0 && screenSaved?.screensDropped === 0,
  )
  ok(
    '화면 사진 파일은 photo-file 라우트에서 받아 .png로(그림은 앱 주소로 한 번 더 받는다)',
    screenWritten.has(`${sb.folder}/01-사진1-무엇부터-보나요.png`) && screenFetches.some((u) => u.includes('/photo-file?')) && screenFetches.includes(SCREEN_SRC),
  )
  g.fetch = async (url: string) => (url.startsWith('/api/screens/') ? new Response(JSON.stringify({ error: '그 화면 파일이 없어요.' }), { status: 404 }) : pngFetch(url))
  const lostWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', lostWritten, []) }
  const lostSaved = await saveWriterBundle('vstay', sb)
  const lostHtml = (await lostWritten.get(`${sb.folder}/${sbHtml.name}`)?.blob?.text()) ?? ''
  ok(
    '화면 그림을 받지 못하면 .html에는 「[화면: 이름]」 글자 — 앱 주소 없이, screensDropped로 알린다',
    lostHtml.includes('<figure class="image-slot"><p>[화면: AI 코스 만들기]</p>') && exportLeaks(lostHtml).length === 0 && lostSaved?.screensDropped === 1,
  )

  // 8) 앱이 그린 군산 지도(origin osm-map) — 묶음의 .html에는 저장할 때 지도 그림을 문서 안(data:image/png)에 넣고 그림 바로 아래에 OSM 출처 줄,
  //    그다음 줄에 위치 문장. 지도 파일은 photo-file 라우트가 준 PNG 그대로, 「00-사진 출처.txt」에 지도 파일 이름과 출처 줄. og:image ·
  //    JSON-LD image에는 넣지 않는다. 지도 그림을 받지 못하면 「[지도: …]」 글자(출처 줄은 그대로)이고 mapsDropped로 따로 센다.
  const MAP_ID = '00000000000000cd'
  const MAP_SRC = mapAppSrc('vstay', MAP_ID)
  const MAP_ALT = '군산 지도 — 가상역사관 · 가상바다공원 위치'
  const MAP_CAPTION = '가상역사관 · 가상바다공원 위치를 지도에 표시했습니다.'
  const mapPhoto = photo({
    src: MAP_SRC, alt: MAP_ALT, pageUrl: 'https://gunsan.webforai.kr/map/', auto: true, origin: 'osm-map', mapId: MAP_ID,
    mapVariant: mapVariantKey(['가상역사관', '가상바다공원']), caption: MAP_CAPTION, credit: MAP_CREDIT,
  })
  const mb = writerBundle({ ...input, drafts: { ...drafts, [a1.id]: { ...drafts[a1.id]!, photos: [mapPhoto] } } })
  const mbHtml = mb.files.find((f): f is Extract<typeof f, { kind: 'html' }> => f.kind === 'html' && f.name.startsWith('01-'))!
  const mbCredits = mb.files.find((f): f is Extract<typeof f, { kind: 'credits' }> => f.kind === 'credits')
  ok(
    '지도 — 묶음 계산의 .html은 앱 주소(저장할 때 넣는다) · 그림 설명이 출처 줄 · og:image · JSON-LD image 없음, 지도 파일 하나 · 출처 파일',
    mbHtml.text.includes(`<img src="${MAP_SRC}"`) && mbHtml.text.includes(`<figcaption>${MAP_CREDIT}</figcaption></figure>\n<p><em>${MAP_CAPTION}</em></p>`) &&
      !mbHtml.text.includes('og:image') && !mbHtml.text.includes('"image"') && mb.photos === 1 && mbCredits?.photos.length === 1 && mb.files.at(-1) === mbCredits,
  )
  photoRequests.length = 0
  screenFetches.length = 0
  g.fetch = pngFetch
  const mapWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', mapWritten, []) }
  const mapSaved = await saveWriterBundle('vstay', mb)
  const savedMapHtml = (await mapWritten.get(`${mb.folder}/${mbHtml.name}`)?.blob?.text()) ?? ''
  const savedMapCredits = (await mapWritten.get(`${mb.folder}/${PHOTO_CREDITS_FILE}`)?.blob?.text()) ?? ''
  ok(
    '저장한 .html — 지도 그림은 문서 안(data:image/png), 그 바로 아래 출처 줄 · 그다음 위치 문장, 앱 주소 · 이 PC 주소 없음',
    savedMapHtml.includes(`<img src="data:image/png;base64,${Buffer.from(PNG).toString('base64')}" alt="${MAP_ALT}"`) &&
      savedMapHtml.includes(`<figcaption>${MAP_CREDIT}</figcaption></figure>\n<p><em>${MAP_CAPTION}</em></p>`) && exportLeaks(savedMapHtml).length === 0 &&
      mapSaved?.screensDropped === 0 && mapSaved.mapsDropped === 0,
  )
  ok(
    '지도 파일은 photo-file 라우트에서 받아 .png로, 「00-사진 출처.txt」에 그 파일 이름 · 출처 줄',
    mapWritten.has(`${mb.folder}/01-사진1-무엇부터-보나요.png`) && screenFetches.some((u) => u.includes('/photo-file?')) && screenFetches.includes(MAP_SRC) &&
      savedMapCredits.includes(['01', '01-사진1-무엇부터-보나요.png', MAP_CREDIT].join('\t')) && savedMapCredits.includes(MAP_CREDIT),
  )
  g.fetch = async (url: string) => (url.startsWith('/api/maps/') ? new Response(JSON.stringify({ error: '그 지도 파일이 없어요.' }), { status: 404 }) : pngFetch(url))
  const lostMapWritten: Written = new Map()
  g.window = { showDirectoryPicker: async () => fakeFolder('바탕 화면', lostMapWritten, []) }
  const lostMapSaved = await saveWriterBundle('vstay', mb)
  const lostMapHtml = (await lostMapWritten.get(`${mb.folder}/${mbHtml.name}`)?.blob?.text()) ?? ''
  ok(
    '지도 그림을 받지 못하면 .html에는 「[지도: …]」 글자와 그 아래 출처 줄 — 앱 주소 없이, mapsDropped로 알린다',
    lostMapHtml.includes(`<figure class="image-slot"><p>[지도: ${MAP_ALT}]</p><figcaption>${MAP_CREDIT}</figcaption></figure>`) && exportLeaks(lostMapHtml).length === 0 &&
      lostMapSaved?.screensDropped === 0 && lostMapSaved.mapsDropped === 1,
  )
  g.fetch = pngFetch
  g.window = { setTimeout: () => 0 }
  singleDownloads.length = 0
  const mapDraft = { ...drafts[a1.id]!, photos: [mapPhoto] }
  await downloadArticlePhotos('vstay', mapDraft, articlePhotoFiles(mapDraft, { settings: rights, industry: brand.industry }))
  const mapSingleText = (await singleDownloads.find((d) => d.name === ARTICLE_CREDITS_FILE)?.blob.text()) ?? ''
  ok(
    '글 하나 사진 받기 — 지도가 있으면 지도 파일과 「사진 출처.txt」(지도 파일 이름 · 출처 줄)',
    singleDownloads.some((d) => d.name === '사진1-무엇부터-보나요.png') && mapSingleText.includes(['사진1-무엇부터-보나요.png', MAP_CREDIT].join('\t')),
  )
  g.fetch = okFetch

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
