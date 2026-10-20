/**
 * 홈페이지 사진으로 사진 자리 채우기(src/lib/articlePhotos.ts)를 확인한다. 가짜 원고 · 가짜 주소만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 사진은 사람이 고른 그 자리에만 들어가야 한다. 절이 빠지거나(빈칸 뺌) 사람이 고친 글에서 자리가 흔들리면, 엉뚱한 절에 넣지
 *   말고 다시 물어야 한다.
 * - 사진 주소의 공백 · 괄호 · 한글이 마크다운 이미지 문법을 깨면 사진 대신 글자가 나간다.
 *
 *   npx tsx scripts/verify-site-photos.ts
 */
import { canonicalPhotoSrc, cleanPhotoAlt, isPhotoMedical, matchPhotos, photoSlotsOf, withPhotos, type PhotoPick } from '../src/lib/articlePhotos'
import { countImageSlots } from '../src/lib/markdownFile'
import { JSDOM } from 'jsdom'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const md = [
  '# 가상 글',
  '',
  '## 1. 지역 고르기',
  '',
  '본문.',
  '',
  '![가상 골목 풍경](#image-slot)',
  '*골목 입구*',
  '',
  '## 2. 사례: 가상스테이',
  '',
  '본문.',
  '',
  '![  가상스테이   정원 ](#image-slot)',
  '',
  '## 3. 또 다른 사례',
  '',
  '![가상스테이 정원](#image-slot)',
  '',
  '문장 속 ![지도](#image-slot) 은 자리가 아니다.',
].join('\n')
const pick = (over: Partial<PhotoPick> = {}): PhotoPick => ({
  slot: '가상스테이 정원', nth: 1, same: 2, heading: '사례: 가상스테이', src: 'https://stay.example/img/a.jpg',
  alt: '정원 나무와 석등', pageUrl: 'https://stay.example/', confirmedAt: '2026-10-20T10:00:00.000Z', ...over,
})

// 1) 자리 찾기 — 한 줄 전체가 사진 자리인 줄만(올리기 목록의 개수와 같다)
const slots = photoSlotsOf(md)
ok('자리 수가 countImageSlots와 같다', slots.length === 3 && countImageSlots(md) === 3)
ok('소제목은 번호를 떼고, 같은 장면 글자는 몇 번째인지 센다', slots[1]!.heading === '사례: 가상스테이' && slots[1]!.key === '가상스테이 정원' && slots[1]!.nth === 1 && slots[2]!.nth === 2 && slots[2]!.same === 2)

// 2) 짝짓기
ok('① 장면 글자 + 소제목', matchPhotos(md, [pick()]).applied[0]?.slot.line === slots[1]!.line)
ok('① 둘째 같은 장면도 소제목으로', matchPhotos(md, [pick({ nth: 2, heading: '또 다른 사례' })]).applied[0]?.slot.line === slots[2]!.line)
const renamed = md.replace('## 2. 사례: 가상스테이', '## 2. 사례 하나')
ok('② 소제목만 고쳤으면(같은 장면 자리 수가 그대로) 몇 번째로', matchPhotos(renamed, [pick()]).applied[0]?.slot.line === slots[1]!.line)
const dropped = md.replace('## 2. 사례: 가상스테이\n\n본문.\n\n![  가상스테이   정원 ](#image-slot)\n\n', '')
const droppedMatch = matchPhotos(dropped, [pick()])
ok('같은 장면 자리 하나가 빠지면 남은 자리로 옮기지 않고 제안만', droppedMatch.applied.length === 0 && droppedMatch.suggested.length === 1)
const sceneEdited = md.replace('![  가상스테이   정원 ](#image-slot)', '![가상스테이 거실](#image-slot)')
const sceneMatch = matchPhotos(sceneEdited, [pick()])
ok('장면 글자를 사람이 바꾸면 넣지 않고 같은 소제목 자리를 제안', sceneMatch.applied.length === 0 && sceneMatch.suggested[0]?.slot.key === '가상스테이 거실')
ok('자리가 없으면 못 찾음', matchPhotos('# 글\n\n본문.', [pick()]).unmatched.length === 1)
ok('확인하지 않은 사진은 보지 않는다', JSON.stringify(matchPhotos(md, [pick({ confirmedAt: '' })])) === JSON.stringify({ applied: [], suggested: [], unmatched: [] }))
const two = matchPhotos(md, [pick(), pick({ src: 'https://stay.example/img/b.jpg' })])
ok('한 자리에는 사진 하나', two.applied.length === 1 && two.applied[0]!.pick.src === 'https://stay.example/img/a.jpg')

// 3) 넣기
const put = withPhotos(md, [pick()])
ok('짝지은 자리 줄만 사진으로, 설명 줄은 그대로', put.markdown.split('\n')[13] === '![정원 나무와 석등](https://stay.example/img/a.jpg)' && put.markdown.includes('![가상 골목 풍경](#image-slot)\n*골목 입구*') && put.applied.length === 1)
ok('넣은 사진이 없으면 원고 그대로', withPhotos(md, []).markdown === md && withPhotos(md, undefined).markdown === md && withPhotos(md, [pick({ slot: '없는 자리' })]).markdown === md)
const crlf = md.replace(/\n/g, '\r\n')
ok('CRLF 원고에서도 줄 끝을 지킨다', withPhotos(crlf, [pick()]).markdown.includes('![정원 나무와 석등](https://stay.example/img/a.jpg)\r\n'))
ok('사이트 설명이 비면 자리 글자', withPhotos(md, [pick({ alt: '' })]).markdown.includes('![가상스테이 정원](https://stay.example/img/a.jpg)'))

// 4) 주소 · 설명 정리
ok('공백 · 괄호 · 한글 · 별표는 인코딩', canonicalPhotoSrc('https://stay.example/img/객실 1(밤)*.jpg') === 'https://stay.example/img/%EA%B0%9D%EC%8B%A4%201%28%EB%B0%A4%29%2A.jpg')
ok('http · 계정 · 포트 · 깨진 주소는 거절', [
  'http://stay.example/a.jpg', 'https://user:pw@stay.example/a.jpg', 'https://stay.example:8443/a.jpg', 'javascript:alert(1)', 'not a url',
].every((u) => canonicalPhotoSrc(u) === null))
ok('조각(#…)은 뗀다', canonicalPhotoSrc('https://stay.example/a.jpg#x') === 'https://stay.example/a.jpg')
ok('설명의 대괄호 · 줄바꿈 · 제어 문자를 걷고 160자', cleanPhotoAlt('[정원]\n나무\u0007') === '정원 나무' && cleanPhotoAlt('가'.repeat(200)).length === 160)

// 5) 의료 업종 — 사진 기능은 넓게 본다
ok('의료 업종(진료과 · 영문 포함)', ['정형외과', '이비인후과', '피부과', '치과', 'Dental clinic', '한방병원', '소아청소년과'].every(isPhotoMedical))
ok('의료가 아닌 업종', ['펜션', '관광안내', '통신', '셋톱박스 제조', ''].every((i) => !isPhotoMedical(i)) && !isPhotoMedical(undefined))

// 6) 홈페이지 사진 후보(src/lib/sitePhotos.ts) — 업체 노드의 사진만, 꼬리표가 아닌 장면 설명
const dom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as unknown as Record<string, unknown>).DOMParser = dom.window.DOMParser
const { extractSitePhotos, photoPageOf } = await import('../src/lib/sitePhotos')
const ld = (v: unknown, type = 'application/ld+json') => `<script type="${type}">${JSON.stringify(v)}</script>`
const tag = '체크인 · 가상스테이 사진'
const page = [
  '<html><head>',
  ld({
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: '가상스테이',
    logo: 'https://stay.example/img/logo.png',
    image: ['https://stay.example/img/living.jpg', '/img/garden.jpg?v=3', 'https://stay.example/img/logo.png', 'http://stay.example/img/old.jpg'],
    containsPlace: [{ '@type': 'HotelRoom', name: 'A동', image: { '@type': 'ImageObject', contentUrl: '/img/a-room.jpg' } }],
    review: [{ '@type': 'Review', image: 'https://stay.example/img/review.jpg' }],
  }),
  ld({ '@graph': [{ '@type': 'TouristAttraction', name: '가상 축제', image: 'https://stay.example/img/festival.jpg' }, { '@type': 'Person', image: 'https://stay.example/img/star.jpg' }] }, 'application/ld+json; charset=utf-8'),
  '<script type="application/ld+json">{ 깨진 </script>',
  '<meta property="og:image" content="https://stay.example/img/og.jpg">',
  '</head><body>',
  // 장면 설명 ×2 · 꼬리표 ×여러 사진(일정 카드 썸네일)
  '<img src="/img/garden.jpg" alt="밤에 창 너머로 본 정원 나무와 석등"><img src="/img/garden.jpg?w=300" alt="밤에 창 너머로 본 정원 나무와 석등">',
  ...['garden', 'living', 'a-room', 'x1', 'x2'].map((n) => `<img src="/img/${n}.jpg" alt="${tag}">`),
  '<img src="/_next/image?url=%2Fimg%2Fliving.jpg&w=640" alt="가상스테이 A동 거실의 서까래">',
  '<img data-src="/img/a-room.jpg" alt="A동 침실">',
  // 일정 카드 썸네일 — 한 사진에만 꼬리표가 여러 번(장면 설명보다 많이) 붙는다
  ...Array.from({ length: 6 }, () => '<img src="/img/a-room.jpg" alt="침실로 · 가상스테이 사진">'),
  '</body></html>',
].join('')
const got = extractSitePhotos(page, 'https://stay.example/s/stay')
const srcs = got.photos.map((p) => p.src)
ok('업체 · 객실 노드의 사진만(관광지 · 인물 · 후기 · 로고 빼고, http는 세어 뺀다)', srcs.join() === 'https://stay.example/img/living.jpg,https://stay.example/img/garden.jpg?v=3,https://stay.example/img/a-room.jpg' && got.skippedHttp === 1)
ok('구조화 데이터 사진이 있으면 대표 사진(og)은 후보에 넣지 않는다', !srcs.some((s) => s.includes('og.jpg')))
const altOf = (part: string) => got.photos.find((p) => p.src.includes(part))?.alt
ok('여러 사진에 붙은 꼬리표가 아닌 장면 설명을 고른다', altOf('garden') === '밤에 창 너머로 본 정원 나무와 석등')
ok('최적화 주소(/_next/image) · 지연 로딩 속성도 같은 사진으로 읽는다 · 많이 붙은 꼬리표 모양보다 장면 설명', altOf('living') === '가상스테이 A동 거실의 서까래' && altOf('a-room') === 'A동 침실')
ok('장면 설명이 없으면 비운다(사진 자리 글자를 쓴다)', extractSitePhotos(ld({ '@type': 'Hotel', image: 'https://s.example/q.jpg' }) + '<img src="https://s.example/q.jpg" alt="객실로 · 가상 사진">', 'https://s.example/').photos[0]?.alt === '')
ok('가진 곳 이름', got.photos.find((p) => p.src.includes('a-room'))?.where === 'A동' && got.photos[0]?.where === '가상스테이' && got.photos.every((p) => p.source === 'jsonld'))
const noLd = extractSitePhotos(
  '<html><head><base href="https://cdn-free.example/stay/"><meta property="og:image" content="hero.jpg"><meta property="og:image:alt" content="가상스테이 외관"></head><body><img src="room.jpg" alt="객실"><img src="https://other.example/ad.jpg" alt="광고"><img src="noalt.jpg"></body></html>',
  'https://cdn-free.example/stay/index.html',
)
ok('구조화 데이터가 없으면 대표 사진 → 같은 사이트의 설명 있는 사진(다른 사이트 · 설명 없는 사진 빼고)', noLd.photos.map((p) => `${p.source}:${p.src}:${p.alt}`).join() === 'og:https://cdn-free.example/stay/hero.jpg:가상스테이 외관,img:https://cdn-free.example/stay/room.jpg:객실')
const httpOnly = extractSitePhotos(ld({ '@type': 'LocalBusiness', image: ['http://old.example/a.jpg', 'http://old.example/b.jpg'] }), 'http://old.example/')
ok('http로만 열리는 사이트는 0장 · 뺀 수를 알린다', httpOnly.photos.length === 0 && httpOnly.skippedHttp === 2)
ok('사진을 찾을 페이지 — 공식 사이트 → 브랜드 페이지 → 도메인 루트', [
  photoPageOf({ brandName: 'x', ownedDomains: ['a.example'], brandPageUrl: 'https://a.example/brand' }, { siteUrl: 'https://a.example/s/x' }) === 'https://a.example/s/x',
  photoPageOf({ brandName: 'x', ownedDomains: ['a.example'], brandPageUrl: 'https://a.example/brand' }, null) === 'https://a.example/brand',
  photoPageOf({ brandName: 'x', ownedDomains: ['a.example'] }, null) === 'https://a.example/',
].every(Boolean))

// 7) 사진 받기 — 형식은 파일 앞 바이트로, 같은 사진은 한 번, 파일 이름에 글 순서 · 소제목
const { photoTypeOf } = await import('../server/sitePhoto')
const { articlePhotoFiles, photoFileName } = await import('../src/lib/sitePhotos')
const bytes = (...b: number[]) => new Uint8Array(b)
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
ok('사진 형식은 앞 바이트로(jpg · png · gif · webp · avif)', [
  photoTypeOf(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext === 'jpg',
  photoTypeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))?.ext === 'png',
  photoTypeOf(ascii('GIF89a...'))?.ext === 'gif',
  photoTypeOf(ascii('RIFF....WEBPVP8 '))?.ext === 'webp',
  photoTypeOf(ascii('....ftypavif....'))?.ext === 'avif',
].every(Boolean))
ok('HTML · SVG · 빈 파일은 사진이 아니다', photoTypeOf(ascii('<!doctype html>')) === null && photoTypeOf(ascii('<svg xmlns=')) === null && photoTypeOf(new Uint8Array(0)) === null)
ok('파일 이름 — 사진1-소제목.jpg (소제목 없으면 자리 글자, 쓸 수 없는 글자는 뺀다)', photoFileName(1, { heading: '사례: 가상스테이', slotAlt: 'x' }, 'image/jpeg') === '사진1-사례-가상스테이.jpg' && photoFileName(2, { heading: '', slotAlt: '정원 풍경' }, 'image/webp') === '사진2-정원-풍경.webp')
const storedWith = (photos: PhotoPick[]) => ({ actionId: 'content:a', generatedAt: 'g', draft: { title: '가상 글', lead: '리드', sections: [], gapCount: 0, usedFacts: [] }, editedMarkdown: md, photos })
const allowed = { settings: { photoRights: { confirmedAt: '2026-10-20T10:00:00.000Z' } }, industry: '펜션' }
const files = articlePhotoFiles(storedWith([pick({ nth: 2, heading: '또 다른 사례' }), pick()]), allowed)
ok('같은 사진을 두 자리에 쓰면 한 번만 받는다(글 순서)', files.length === 1 && files[0]!.heading === '사례: 가상스테이' && files[0]!.place.heading === '사례: 가상스테이')
ok('사진 사용 확인이 없으면(의료 업종은 의료광고 확인까지) 받을 사진도 없다', [
  articlePhotoFiles(storedWith([pick()]), { settings: null, industry: '펜션' }).length === 0,
  articlePhotoFiles(storedWith([pick()]), { ...allowed, industry: '정형외과' }).length === 0,
  articlePhotoFiles(storedWith([pick()]), { settings: { photoRights: { confirmedAt: 'x', medical: true as const } }, industry: '정형외과' }).length === 1,
].every(Boolean))

// 8) 검토 지적 — 짝짓기는 ①을 모두 먼저, 설명의 역슬래시, 추출의 대체 경로 · srcset · 지연 로딩 · query 주소 · 아이콘
const swapMd = ['## 1. 주차는 어디에', '![매장 외관](#image-slot)', '## 2. 위치', '![매장 외관](#image-slot)'].join('\n')
const parking = pick({ slot: '매장 외관', nth: 2, same: 2, heading: '주차', src: 'https://s.example/parking.jpg' })
const location = pick({ slot: '매장 외관', nth: 1, same: 2, heading: '위치', src: 'https://s.example/location.jpg' })
const swap = matchPhotos(swapMd, [parking, location])
ok('정확히 맞는 사진(①)이 먼저 — 고른 순서 때문에 두 사진이 서로 바뀌지 않는다', swap.applied.length === 1 && swap.applied[0]!.pick === location && swap.applied[0]!.slot.heading === '위치' && swap.suggested[0]?.pick === parking)
ok('설명 끝 역슬래시가 이미지 문법을 깨지 않는다', cleanPhotoAlt('정원\\') === '정원' && withPhotos(md, [pick({ alt: '정원\\' })]).markdown.includes('![정원](https://stay.example/img/a.jpg)'))
const logoOnly = extractSitePhotos(
  ld({ '@type': 'LocalBusiness', logo: 'https://s.example/logo.png', image: 'https://s.example/logo.png' }) +
    '<meta property="og:image" content="https://s.example/hero.jpg"><img src="/room.jpg" alt="가게 내부 테이블">',
  'https://s.example/',
)
ok('업체 사진이 로고뿐이면 대표 사진 · 페이지 사진으로 넘어간다', logoOnly.photos.map((p) => p.src).join() === 'https://s.example/hero.jpg,https://s.example/room.jpg')
const wp = extractSitePhotos(
  ld({ '@type': 'Hotel', image: 'https://s.example/up/room.jpg' }) +
    '<img src="/up/room-1024x683.jpg" srcset="/up/room-1024x683.jpg 1024w, /up/room-300x200.jpg 300w, /up/room-768x512.jpg 768w, /up/room.jpg 1600w" alt="오션뷰 객실의 킹사이즈 침대">',
  'https://s.example/',
)
ok('srcset 크기별 주소는 한 장으로 센다 — 장면 설명을 꼬리표로 버리지 않는다', wp.photos[0]?.alt === '오션뷰 객실의 킹사이즈 침대')
const lazy = extractSitePhotos('<img src="/blank.gif" data-src="/img/room.jpg" alt="객실 침대"><img src="data:image/gif;base64,R0lG" data-src="/img/pool.jpg" alt="수영장">', 'https://s.example/')
ok('대체 경로는 지연 로딩의 실제 주소를 쓴다(자리표시자 · data: 빼고)', lazy.photos.map((p) => `${p.src}:${p.alt}`).join() === 'https://s.example/img/room.jpg:객실 침대,https://s.example/img/pool.jpg:수영장')
const proxied = extractSitePhotos(
  '<img src="/_vercel/image?url=%2Fimg%2Froom.jpg&w=640" alt="객실 침대"><img src="/_vercel/image?url=%2Fimg%2Fpool.jpg&w=640" alt="루프탑 수영장 전경">' +
    ld({ '@type': 'Store', image: ['https://s.example/image.php?id=1', 'https://s.example/image.php?id=2'] }),
  'https://s.example/',
)
ok('query로 사진을 가르는 주소는 합치지 않는다', proxied.photos.length === 2 && proxied.photos[0]!.src === 'https://s.example/image.php?id=1')
const iconAlts = extractSitePhotos('<img src="/_vercel/image?url=%2Fimg%2Froom.jpg&w=640" alt="객실 침대"><img src="/_vercel/image?url=%2Fimg%2Fpool.jpg&w=640" alt="루프탑 수영장 전경">', 'https://s.example/')
const icons = extractSitePhotos('<img src="/icons/phone.svg" alt="전화"><img src="/icons/kakao.png" alt=""><img src="/img/room.jpg" alt="객실 침대">', 'https://s.example/')
ok('최적화 주소(/_vercel/image)는 안쪽 사진으로 가른다 — 두 사진 · 제 설명', iconAlts.photos.map((p) => p.alt).join() === '객실 침대,루프탑 수영장 전경')
ok('대체 경로에서 설명 없는 아이콘 · SVG는 뺀다', icons.photos.map((p) => p.src).join() === 'https://s.example/img/room.jpg')

// 9) 수정 검증 지적 — srcset을 HTML 규칙대로(주소 안 쉼표 · data: 자리표시자), 지연 로딩 자리표시자로 사진 수를 세지 않는다
const cf = extractSitePhotos(
  '<img src="/cdn-cgi/image/width=800,quality=75/uploads/room.jpg" srcset="/cdn-cgi/image/width=400,quality=75/uploads/room.jpg 400w, /cdn-cgi/image/width=800,quality=75/uploads/room.jpg 800w" alt="객실 내부">',
  'https://s.example/',
)
ok('주소 안에 쉼표가 든 변환 주소(srcset)를 조각내지 않는다', cf.photos.map((p) => p.src).join() === 'https://s.example/cdn-cgi/image/width=800,quality=75/uploads/room.jpg')
const lazysizes = extractSitePhotos(
  '<img src="/blank.gif" srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-srcset="/img/room-640.jpg 640w, /img/room-1280.jpg 1280w" alt="객실 침대">',
  'https://s.example/',
)
ok('srcset의 data: 자리표시자는 건너뛰고 data-srcset의 가장 큰 사진을 쓴다', lazysizes.photos.map((p) => p.src).join() === 'https://s.example/img/room-1280.jpg')
const sharedPlaceholder = extractSitePhotos(
  ld({ '@type': 'Hotel', image: [1, 2, 3, 4].map((n) => `https://s.example/img/p${n}.jpg`) }) +
    [1, 2, 3, 4].map((n) => `<img src="data:image/gif;base64,R0lG" data-src="/img/p${n}.jpg" alt="가상스테이">`).join(''),
  'https://s.example/',
)
ok('지연 로딩 사진이 같은 자리표시자를 써도 사진마다 붙은 이름 꼬리표는 거른다', sharedPlaceholder.photos.length === 4 && sharedPlaceholder.photos.every((p) => p.alt === ''))

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
