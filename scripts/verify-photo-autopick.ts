/**
 * 사진 자리 자동 채우기(src/lib/photoAutoPick.ts — 1단계 홈페이지 사진, 2단계 공공 사진과 출처 줄)의 규칙을 확인한다. 가짜 원고 · 가짜 주소만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 틀린 사진은 빈자리보다 나쁘다 — 문턱에 못 미치면 비워야 하고, 화면 자리 · 사람 사진 · 일러스트 · 출처 표시가 필요한 공공 사진은
 *   넣지 않아야 한다.
 * - 사람이 고르거나 뺀 자리는 자동 채우기가 덮지 않아야 한다.
 * - 같은 사진이 한 글 · 한 작성자 안에서 되풀이되거나 브랜드 전체에서 상한을 넘지 않아야 한다.
 * - 같은 입력이면 같은 결과여야 한다(운영자가 본 미리보기와 다시 돌린 결과가 같게).
 * - 공공 사진은 공공누리 제1유형 · 출처가 있을 때만, 내보낼 때 사진 바로 아래에 출처 줄이 붙어야 한다(출처 표시는 이용 조건이다).
 *
 *   npx tsx scripts/verify-photo-autopick.ts
 */
import { JSDOM } from 'jsdom'
import { matchPhotos, withPhotos, type PhotoPick } from '../src/lib/articlePhotos'
import {
  AUTO_PICK_RULES,
  autoCandidateSkip,
  autoPickPhotos,
  contentWords,
  isPeopleScene,
  isScreenSlot,
  needsPhotoCredit,
  otherPhotoUses,
  photoSlotStats,
  photoStateKey,
  scoreSlot,
  type AutoArticle,
  type AutoCandidate,
} from '../src/lib/photoAutoPick'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const PAGE = 'https://stay.example/'
const cand = (name: string, alt: string, over: Partial<AutoCandidate> = {}): AutoCandidate => ({ src: `https://stay.example/img/${name}.jpg`, alt, pageUrl: PAGE, ...over })
const C = {
  garden: cand('garden', '창밖으로 조명을 비춘 정원 나무와 석등이 보이는 풍경'),
  living: cand('living', '목재 서까래 천장과 미닫이창, 테이블이 있는 거실 공간'),
  kitchen: cand('kitchen', '싱크대와 냉장고, 전자레인지가 구비된 실내 주방 공간'),
  person: cand('person', '주방 싱크대 앞에서 포즈를 취하고 있는 여성의 모습'),
  drawing: cand('drawing', '일러스트: 정원과 가옥이 있는 골목'),
  blank: cand('blank', ''),
  kogl: cand('kogl', '정원 연못과 석등', { credit: true }),
  tour: { src: 'https://tong.visitkorea.or.kr/cms/resource/1/1_image2_1.jpg', alt: '가상섬 정원 풍경', pageUrl: PAGE },
  http: { src: 'http://stay.example/img/old.jpg', alt: '정원 연못', pageUrl: PAGE },
}

const article = (id: string, body: string[], over: Partial<AutoArticle> = {}): AutoArticle => ({
  actionId: id,
  generatedAt: '2026-11-03T00:00:00.000Z',
  markdown: ['# 가상 글', '', ...body].join('\n'),
  ...over,
})
const md1 = [
  '## 1. 가상스테이 정원',
  '',
  '![가상스테이 독채 앞의 아담한 정원 풍경](#image-slot)',
  '*가상스테이에는 독립된 아담한 정원이 있습니다.*',
  '',
  '## 2. 거실',
  '',
  '![서까래 천장 아래 거실과 테이블](#image-slot)',
  '',
  '## 3. 화면',
  '',
  '![가상스테이 웹사이트의 예약 화면](#image-slot)',
  '',
  '## 4. 외관',
  '',
  '![가상스테이 독채 앞 정원과 일본식 가옥 외관](#image-slot)',
  '*1920년대 가옥을 고친 독채와 정원*',
]

// 1) 후보 거르기
ok('설명이 없는 후보는 뺀다', autoCandidateSkip(C.blank) === 'no-alt')
ok('일러스트는 뺀다', autoCandidateSkip(C.drawing) === 'illustration')
ok('사람이 찍힌 사진은 뺀다(여성 · 포즈)', autoCandidateSkip(C.person) === 'people')
ok('「아이보리」는 사람 낱말이 아니다', autoCandidateSkip(cand('ivory', '아이보리색 소파가 놓인 거실')) === null)
ok('공공누리 표시(credit)가 있는 사진은 뺀다', autoCandidateSkip(C.kogl) === 'credit')
ok('한국관광공사 사진 호스트는 표시가 없어도 뺀다', autoCandidateSkip(C.tour) === 'credit' && needsPhotoCredit(C.tour.src))
ok('정부 기관(.go.kr) 사진도 출처 표시 대상으로 본다', needsPhotoCredit('https://www.gunsan.go.kr/a.jpg') && !needsPhotoCredit('https://stay.example/a.jpg'))
ok('https가 아닌 사진은 뺀다', autoCandidateSkip(C.http) === 'bad-src')
ok('업체 실내 사진은 쓴다', autoCandidateSkip(C.living) === null)

// 2) 낱말과 점수
ok('조사를 떼고 꾸밈말 · 불용어 · 숫자 낱말을 버린다', JSON.stringify(contentWords('독채 앞의 독립된 아담한 정원이 보이는 1920년대 풍경')) === JSON.stringify(['독채', '정원']))
const stop = new Set(contentWords('가상스테이'))
ok('브랜드 이름은 낱말에서 뺀다', !contentWords('가상스테이 정원', stop).includes('가상스테이'))
const s1 = scoreSlot({ key: '가상스테이 독채 앞의 아담한 정원 풍경', caption: '가상스테이에는 독립된 아담한 정원이 있습니다.', heading: '가상스테이 정원' }, C.garden.alt, stop)
ok('장면 글자 · 설명 줄이 맞으면 문턱을 넘는다', s1.pass && s1.words.includes('정원') && s1.score >= AUTO_PICK_RULES.threshold)
const s2 = scoreSlot({ key: '가상스테이 독채 앞 정원과 일본식 가옥 외관', caption: '1920년대 가옥을 고친 독채와 정원', heading: '외관' }, C.garden.alt, stop)
ok('내용어 일부만 맞으면(외관 자리에 정원만) 비율 문턱에서 떨어진다', !s2.pass && s2.coverage < AUTO_PICK_RULES.coverage)
const s3 = scoreSlot({ key: '서까래 천장 아래 거실과 테이블', caption: '', heading: '거실' }, C.kitchen.alt, stop)
ok('장면 글자가 하나도 맞지 않으면 넣지 않는다', !s3.pass)

// 3) 자리 거르기
ok('웹사이트 화면 자리', isScreenSlot('군산각 웹사이트의 지도에서 찾기 화면') && isScreenSlot('앱 검색 결과') && !isScreenSlot('정원 풍경'))
ok('사람이 나오는 장면 자리', isPeopleScene('진포해양공원 산책로를 둘이 나란히 걷는 모습') && isPeopleScene('가족이 걷는 장면') && !isPeopleScene('정원 풍경'))

// 4) 배정
const all = [C.garden, C.living, C.kitchen, C.person, C.drawing, C.blank, C.kogl, C.tour, C.http]
const r1 = autoPickPhotos({ articles: [article('a1', md1)], candidates: all, brandName: '가상스테이' })
const rows1 = r1.articles[0]!.rows
ok('쓸 수 있는 후보는 3장(나머지는 이유와 함께 뺌)', r1.usable === 3 && r1.skipped.length === 6)
ok('정원 자리에 정원 사진', rows1[0]!.state === 'filled' && rows1[0]!.pick?.src === C.garden.src && rows1[0]!.pick?.auto === true)
ok('거실 자리에 거실 사진', rows1[1]!.state === 'filled' && rows1[1]!.pick?.src === C.living.src)
ok('화면 자리는 비워 둔다', rows1[2]!.state === 'screen' && !rows1[2]!.pick)
ok('외관 자리는 맞는 사진이 없어 비워 둔다(정원 사진은 이미 썼고, 비율도 못 넘는다)', rows1[3]!.state === 'nomatch' && !rows1[3]!.pick)
ok('보낼 사진은 채운 자리 수와 같다', r1.articles[0]!.picks.length === 2)
const gardenPick = r1.articles[0]!.picks.find((p) => p.src === C.garden.src)
ok('넣을 사진에 자리 열쇠가 담긴다', gardenPick?.slot === '가상스테이 독채 앞의 아담한 정원 풍경' && gardenPick.nth === 1 && gardenPick.same === 1 && gardenPick.heading === '가상스테이 정원')

// 결정적 — 후보 순서를 바꿔도, 다시 돌려도 같다.
const again = autoPickPhotos({ articles: [article('a1', md1)], candidates: [...all].reverse(), brandName: '가상스테이' })
ok('같은 입력이면 같은 결과(후보 순서와 무관)', JSON.stringify(again.articles) === JSON.stringify(r1.articles))

// 사람이 고른 사진 · 사람이 뺀 자리는 덮지 않는다
const human: PhotoPick = {
  slot: '가상스테이 독채 앞의 아담한 정원 풍경', nth: 1, same: 1, heading: '가상스테이 정원', src: C.kitchen.src,
  alt: C.kitchen.alt, pageUrl: PAGE, confirmedAt: '2026-11-01T00:00:00.000Z',
}
const r2 = autoPickPhotos({
  articles: [article('a1', md1, { picks: [human], cleared: [{ slot: '서까래 천장 아래 거실과 테이블', nth: 1, heading: '거실' }] })],
  candidates: all,
  brandName: '가상스테이',
})
const rows2 = r2.articles[0]!.rows
ok('사람이 고른 자리는 그대로(kept)', rows2[0]!.state === 'kept' && !rows2[0]!.pick)
ok('사람이 뺀 자리는 다시 채우지 않는다(cleared)', rows2[1]!.state === 'cleared' && !rows2[1]!.pick)
ok('덮을 사진이 없으면 보낼 사진도 없다', r2.articles[0]!.picks.length === 0)
const kept = withPhotos(article('a1', md1).markdown, [human])
ok('자동 채우기를 돌려도 사람이 고른 사진의 자리는 그대로 짝지어진다', kept.applied.length === 1 && kept.applied[0]!.src === human.src)

// 글 하나에 3장까지 — 사람이 고른 사진(자리를 찾지 못한 것 포함)도 센다
const lost = (n: number): PhotoPick => ({ ...human, slot: `없어진 자리 ${n}`, heading: '없어진 절', src: `https://stay.example/img/lost${n}.jpg` })
const r3 = autoPickPhotos({ articles: [article('a1', md1, { picks: [lost(1), lost(2)] })], candidates: all, brandName: '가상스테이' })
ok('사진이 이미 2장이면 한 장만 더 넣고 나머지는 「다 참」', r3.articles[0]!.picks.length === 1 && r3.articles[0]!.rows.some((r) => r.state === 'full'))

// 같은 작성자 글 사이에 한 번, 다른 작성자는 다시 쓸 수 있다, 브랜드 전체 3번까지
const one = ['## 1. 정원', '', '![가상스테이 독채 앞의 아담한 정원 풍경](#image-slot)', '*독립된 정원*']
const r4 = autoPickPhotos({
  articles: [
    article('w1-a', one, { group: 'w1' }),
    article('w1-b', one, { group: 'w1' }),
    article('w2-a', one, { group: 'w2' }),
    article('w3-a', one, { group: 'w3' }),
    article('w4-a', one, { group: 'w4' }),
  ],
  candidates: [C.garden],
  brandName: '가상스테이',
})
const states4 = r4.articles.map((a) => a.rows[0]!.state).join(',')
ok('같은 작성자의 둘째 글에는 같은 사진을 다시 넣지 않는다', r4.articles[1]!.rows[0]!.state === 'used')
ok('다른 작성자는 같은 사진을 쓸 수 있고, 브랜드 전체 3번에서 멈춘다', states4 === 'filled,used,filled,filled,used')
const r5 = autoPickPhotos({
  articles: [article('x', one)],
  candidates: [C.garden],
  others: otherPhotoUses(
    { o1: { photos: [{ ...human, src: C.garden.src }] }, o2: { photos: [{ ...human, src: C.garden.src }] }, o3: { photos: [{ ...human, src: C.garden.src }] }, x: { photos: [] } },
    new Set(['x']),
  ),
  brandName: '가상스테이',
})
ok('돌지 않는 글에서 이미 3번 쓴 사진은 넣지 않는다', r5.articles[0]!.rows[0]!.state === 'used')
const r6 = autoPickPhotos({
  articles: [article('x', one, { group: 'w1' })],
  candidates: [C.garden],
  others: otherPhotoUses({ o1: { photos: [{ ...human, src: C.garden.src }] } }, new Set(['x']), () => 'w1'),
  brandName: '가상스테이',
})
ok('같은 작성자의 다른 글(이번에 돌지 않는 글)에 있는 사진도 피한다', r6.articles[0]!.rows[0]!.state === 'used')

// 같은 글 안에서 한 사진은 한 번
const twice = ['## 1. 정원', '', '![정원 석등 풍경](#image-slot)', '', '## 2. 또 정원', '', '![정원 나무와 석등](#image-slot)']
const r7 = autoPickPhotos({ articles: [article('t', twice)], candidates: [C.garden] })
ok('같은 글의 두 자리에 같은 사진을 넣지 않는다', r7.articles[0]!.picks.length === 1)

// 사람이 나오는 장면 자리 — 풍경이 맞으면 넣되 확인 필요
const people = ['## 1. 산책', '', '![정원 석등 앞을 둘이 걷는 모습](#image-slot)', '*정원 산책*']
const r8 = autoPickPhotos({ articles: [article('p', people)], candidates: [C.garden] })
ok('사람 장면 자리에 넣은 사진은 「확인 필요」', r8.articles[0]!.rows[0]!.state === 'filled' && r8.articles[0]!.rows[0]!.review === true)

// 넣은 자동 사진은 기존 짝짓기로 그 자리에 들어간다(확인 시각은 서버가 찍는다)
const saved: PhotoPick[] = r1.articles[0]!.picks.map((p) => ({ ...p, confirmedAt: '2026-11-03T01:00:00.000Z' }))
const placed = matchPhotos(article('a1', md1).markdown, saved)
ok('저장된 자동 사진은 고른 자리에 그대로 짝지어진다', placed.applied.length === 2 && placed.suggested.length === 0 && placed.unmatched.length === 0)
const stats = photoSlotStats([{ markdown: article('a1', md1).markdown, picks: [saved.find((p) => p.src === C.garden.src)!, { ...human, slot: '서까래 천장 아래 거실과 테이블', heading: '거실' }] }])
ok('작성자 줄 셈 — 사진 자리 4 · 채움 2 · 자동 1 · 빈자리 2', stats.slots === 4 && stats.filled === 2 && stats.auto === 1 && stats.empty === 2)
ok('사진이 없으면 원고는 바이트까지 그대로', withPhotos(article('a1', md1).markdown, []).markdown === article('a1', md1).markdown)

// 사람 사진 후보 · 사람 장면 자리 — 흔한 사람 낱말(관광객 · 투숙객 · 직원 …)도 사람으로 본다
const peopleAlts = [
  '관광객들이 해변을 걷는 모습',
  '방문객이 정원을 둘러보는 모습',
  '직원이 커피를 내리는 모습',
  '셰프가 요리하는 주방',
  '투숙객이 테라스에서 쉬는 모습',
  '어르신과 손주가 산책하는 길',
  '신랑 신부 웨딩 촬영',
]
ok('관광객 · 방문객 · 직원 · 셰프 · 투숙객 · 어르신 · 신랑 신부 사진은 뺀다', peopleAlts.every((alt) => autoCandidateSkip(cand('p', alt)) === 'people'))
ok('관광객 · 방문객이 나오는 자리는 사람 장면', isPeopleScene('해변을 걷는 관광객') && isPeopleScene('정원을 둘러보는 방문객'))
const beach = ['## 1. 해변', '', '![가상해변 해변 산책로](#image-slot)']
const r9 = autoPickPhotos({ articles: [article('b', beach)], candidates: [cand('tourists', '관광객들이 가상해변 해변 산책로를 걷는 모습')] })
ok('관광객 사진은 산책로 자리에 자동으로 넣지 않는다', r9.articles[0]!.picks.length === 0 && r9.skipped[0]?.reason === 'people')

// 「아이스」 · 「모델하우스」는 사람 낱말이 아니다(사람 없는 사진을 「사람이 찍힘」으로 빼지 않는다)
ok('「아이스 아메리카노」 · 「아이스링크」 · 「모델하우스」 사진은 사람 사진이 아니다', ['아이스 아메리카노와 디저트', '아이스링크', '모델하우스 거실'].every((alt) => autoCandidateSkip(cand('n', alt)) === null))
ok('「아이스크림 가게 앞」 자리는 사람 장면이 아니다', !isPeopleScene('아이스크림 가게 앞'))
ok('아이 · 모델이 나오면 여전히 사람 사진', autoCandidateSkip(cand('k', '아이스크림을 든 아이')) === 'people' && autoCandidateSkip(cand('m', '화보 모델 촬영')) === 'people')

// 브랜드 이름은 2-gram 점수에도 넣지 않는다 — 내용어 하나만 맞는 사진이 브랜드 이름 덕에 문턱을 넘지 않게
const gstop = new Set(contentWords('군산각'))
const brandSlot = { key: '군산각 객실 창밖 바다 전망', caption: '', heading: '' }
const withBrand = scoreSlot(brandSlot, '군산각 바다', gstop)
const noBrand = scoreSlot(brandSlot, '바다', gstop)
ok('브랜드 이름이 양쪽에 있어도 점수는 같다(낱말 하나만 맞으면 넣지 않는다)', withBrand.score === noBrand.score && !withBrand.pass)
ok('브랜드 이름에 조사가 붙어도 2-gram에서 뺀다', scoreSlot({ key: '군산각의 객실 창밖 바다 전망', caption: '', heading: '' }, '군산각에서 바다', gstop).score === noBrand.score)
const r10 = autoPickPhotos({ articles: [article('g', ['## 1. 객실', '', '![군산각 객실 창밖 바다 전망](#image-slot)'])], candidates: [cand('sea', '군산각 바다')], brandName: '군산각' })
ok('객실 창밖 전망 자리에 바다 사진만 맞으면 비워 둔다', r10.articles[0]!.rows[0]!.state === 'nomatch')

// 미리보기를 계산한 뒤 사진 · 초안이 바뀌었는지 — 바뀌면 그 미리보기로 저장하지 않는다
const base = {
  a1: { generatedAt: '2026-11-03T00:00:00.000Z', photos: [] as PhotoPick[] },
  a2: { generatedAt: '2026-11-03T00:00:00.000Z' },
  other: { generatedAt: '2026-11-03T00:00:00.000Z' },
}
const k0 = photoStateKey(base, new Set(['a1', 'a2']))
ok('같은 초안이면 같은 열쇠', k0 === photoStateKey({ ...base }, new Set(['a1', 'a2'])))
ok('다른 글에 사진을 고르면 열쇠가 바뀐다', k0 !== photoStateKey({ ...base, other: { ...base.other, photos: [{ ...human, src: C.garden.src }] } }, new Set(['a1', 'a2'])))
ok('미리보기 글에 사진을 고르면 열쇠가 바뀐다', k0 !== photoStateKey({ ...base, a2: { ...base.a2, photos: [{ ...human, src: C.garden.src }] } }, new Set(['a1', 'a2'])))
ok('사람이 자리를 빼면 열쇠가 바뀐다', k0 !== photoStateKey({ ...base, a1: { ...base.a1, photoCleared: [{ slot: '정원', nth: 1, heading: '정원' }] } }, new Set(['a1', 'a2'])))
ok('미리보기 글을 고치거나 다시 만들면 열쇠가 바뀐다', k0 !== photoStateKey({ ...base, a1: { ...base.a1, editedAt: '2026-11-03T02:00:00.000Z' } }, new Set(['a1', 'a2'])) && k0 !== photoStateKey({ ...base, a2: { generatedAt: '2026-11-03T03:00:00.000Z' } }, new Set(['a1', 'a2'])))
ok('사진 없는 다른 글이 새로 생기는 것은 상관없다', k0 === photoStateKey({ ...base, fresh: { generatedAt: '2026-11-03T04:00:00.000Z' } }, new Set(['a1', 'a2'])))

// 5) 홈페이지 사진의 출처 표시(sitePhotos.ts credit)
const dom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as unknown as Record<string, unknown>).DOMParser = dom.window.DOMParser
const { extractSitePhotos } = await import('../src/lib/sitePhotos')
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const page = extractSitePhotos(
  ld({
    '@type': 'LodgingBusiness',
    name: '가상스테이',
    image: [
      'https://stay.example/img/own.jpg',
      { '@type': 'ImageObject', contentUrl: 'https://stay.example/img/licensed.jpg', license: 'https://www.kogl.or.kr/info/licenseType1.do', creditText: '가상기관' },
      'https://stay.example/img/marked.jpg',
    ],
  }) +
    '<img src="https://stay.example/img/own.jpg" alt="정원 석등"><img src="https://stay.example/img/marked.jpg" alt="정원 연못" data-kogl="1">',
  PAGE,
)
const byName = (n: string) => page.photos.find((p) => p.src.endsWith(`/${n}.jpg`))
ok('업체 사진은 출처 표시 없음', byName('own') !== undefined && !byName('own')!.credit)
ok('ImageObject에 license · creditText가 있으면 출처 표시 사진', byName('licensed')?.credit === true)
ok('<img data-kogl>은 출처 표시 사진', byName('marked')?.credit === true)

// 6) 2단계 — 공공 사진(자사 사이트 장소 페이지의 공공누리 제1유형 사진)
const {
  cleanPhotoCredit,
  exportPhotoPicks,
  koglTypeOf,
  PHOTO_LICENSES,
  photoCreditLine,
  photoCreditState,
  publicPhotoFields,
  withPhotosFromSource,
} = await import('../src/lib/articlePhotos')
const { findPlace, placesToRead, slotPlace } = await import('../src/lib/photoAutoPick')
const KOGL1 = PHOTO_LICENSES['kogl-1'].url
ok('공공누리 유형은 kogl.or.kr의 licenseType{n}.do로만 읽는다', [
  koglTypeOf('https://www.kogl.or.kr/info/licenseType1.do') === 1,
  koglTypeOf('http://kogl.or.kr/info/licenseType3.do?x=1') === 3,
  koglTypeOf('https://www.kogl.or.kr/info/license.do') === null,
  koglTypeOf('https://evil.example/info/licenseType1.do') === null,
  koglTypeOf(undefined) === null,
].every(Boolean))
ok('출처 글자 — 「제공」 · 「협찬」 · 「공식」이 들어가면 쓰지 않는다', cleanPhotoCredit('한국관광공사') === '한국관광공사' && cleanPhotoCredit('한국관광공사 제공') === '' && cleanPhotoCredit('공식 사진') === '' && cleanPhotoCredit('') === '')
ok('공공 사진 표시 — 제1유형 · 출처 · 그 유형의 이용 허락 주소가 모두 맞아야', [
  typeof publicPhotoFields({ origin: 'public', license: 'kogl-1', credit: '가상기관', creditUrl: KOGL1 }) === 'object',
  typeof publicPhotoFields({ origin: 'public', license: 'kogl-3', credit: '가상기관', creditUrl: KOGL1 }) === 'string',
  typeof publicPhotoFields({ origin: 'public', license: 'kogl-1', credit: '', creditUrl: KOGL1 }) === 'string',
  typeof publicPhotoFields({ origin: 'public', license: 'kogl-1', credit: '가상기관', creditUrl: 'https://www.kogl.or.kr/info/licenseType3.do' }) === 'string',
  publicPhotoFields({ src: 'x' } as never) === null,
].every(Boolean))

const PLACE_PAGE = 'https://site.example/places/가상근대박물관/'
const pubCand = (name: string, over: Partial<AutoCandidate> = {}): AutoCandidate => ({
  src: `https://tong.visitkorea.or.kr/cms/${name}.jpg`, alt: '가상근대박물관', pageUrl: PLACE_PAGE, origin: 'public', place: '가상근대박물관',
  license: 'kogl-1', licenseType: 1, creditText: '가상관광공사', ...over,
})
ok('공공 사진 후보 — 제1유형 · 출처가 있으면 쓴다(공공 사진 호스트여도)', autoCandidateSkip(pubCand('p1')) === null)
ok('제3유형 · 유형 모름은 license, 출처 없음은 credit', autoCandidateSkip(pubCand('p3', { license: null, licenseType: 3 })) === 'license' && autoCandidateSkip(pubCand('p0', { creditText: '' })) === 'credit')
ok('공공 사진도 사람 · 일러스트 설명이면 뺀다', autoCandidateSkip(pubCand('pp', { alt: '가상근대박물관 앞의 관람객' })) === 'people')

const places = ['가상근대박물관', '근대박물관', '가상섬', '달', '하늘']
ok('가장 긴 장소 이름 — 「군산 근대역사박물관」은 「근대역사박물관」', findPlace('가상시 가상근대박물관 건물 외관', places) === '가상근대박물관' && findPlace('군산 근대역사박물관 외관', ['근대역사박물관']) === '근대역사박물관')
ok('띄어쓰기가 달라도 맞는다', findPlace('가상 근대 박물관 앞마당', places) === '가상근대박물관')
ok('세 글자보다 짧은 장소 이름은 맞추지 않는다(달 · 하늘)', findPlace('하늘과 달이 보이는 바다', places) === null)
ok('자리 장소는 장면 글자 먼저, 없으면 설명 줄', slotPlace({ key: '바다 풍경', caption: '가상섬 앞바다' }, places) === '가상섬' && slotPlace({ key: '가상근대박물관 외관', caption: '가상섬' }, places) === '가상근대박물관')

const mdPub = [
  '## 1. 박물관',
  '',
  '![가상시 가상근대박물관 건물 외관](#image-slot)',
  '*입장 마감 전에 들르세요.*',
  '',
  '## 2. 화면',
  '',
  '![가상스테이 웹사이트의 가상근대박물관 안내 화면](#image-slot)',
  '',
  '## 3. 정원',
  '',
  '![가상스테이 독채 앞의 아담한 정원 풍경](#image-slot)',
  '',
  '## 4. 섬',
  '',
  '![가상섬 바닷가](#image-slot)',
]
const pub1 = pubCand('museum1')
const pub2 = pubCand('museum2')
const island3 = pubCand('island3', { place: '가상섬', alt: '가상섬', pageUrl: 'https://site.example/places/가상섬/', license: null, licenseType: 3 })
ok('읽을 장소 — 빈 자리에 나온 장소만(화면 자리 빼고), 나온 순서', JSON.stringify(placesToRead([article('p', mdPub)], places)) === JSON.stringify(['가상근대박물관', '가상섬']))
const rp = autoPickPhotos({ articles: [article('p', mdPub)], candidates: [C.garden], publicCandidates: [pub1, pub2, island3], places, brandName: '가상스테이' })
const prow = rp.articles[0]!.rows
ok('홈페이지 사진이 먼저 — 정원 자리는 홈페이지 사진', prow[2]!.state === 'filled' && prow[2]!.pick?.src === C.garden.src && !prow[2]!.pick?.origin)
ok(
  '장소가 나온 빈 자리에는 그 장소의 첫 공공 사진(출처 · 이용 허락 함께)',
  prow[0]!.state === 'filled' && prow[0]!.place === '가상근대박물관' && prow[0]!.pick?.src === pub1.src &&
    JSON.stringify([prow[0]!.pick?.origin, prow[0]!.pick?.license, prow[0]!.pick?.credit, prow[0]!.pick?.creditUrl]) === JSON.stringify(['public', 'kogl-1', '가상관광공사', KOGL1]),
)
ok('화면 자리는 장소가 나와도 비워 둔다', prow[1]!.state === 'screen' && !prow[1]!.pick)
ok('장소 사진이 제1유형이 아니면 license로 비워 둔다', prow[3]!.state === 'license' && prow[3]!.place === '가상섬' && !prow[3]!.pick)
ok('공공 사진 수 · 제1유형이 아닌 사진은 뺀 이유와 함께', rp.usablePublic === 2 && rp.skipped.some((x) => x.candidate.src === island3.src && x.reason === 'license'))
const twoMuseum = ['## 1. 외관', '', '![가상근대박물관 외관](#image-slot)', '', '## 2. 입구', '', '![가상근대박물관 입구](#image-slot)', '', '## 3. 또', '', '![가상근대박물관 전시실](#image-slot)']
const rp2 = autoPickPhotos({ articles: [article('m', twoMuseum)], candidates: [], publicCandidates: [pub1, pub2], places })
ok('한 글 안에서 같은 공공 사진은 한 번 — 장소 사진이 다 떨어지면 used', JSON.stringify(rp2.articles[0]!.rows.map((r) => r.pick?.src ?? r.state)) === JSON.stringify([pub1.src, pub2.src, 'used']))
const rp3 = autoPickPhotos({
  articles: [article('w1', twoMuseum.slice(0, 3), { group: 'A' }), article('w2', twoMuseum.slice(0, 3), { group: 'A' }), article('w3', twoMuseum.slice(0, 3), { group: 'B' })],
  candidates: [],
  publicCandidates: [pub1, pub2],
  places,
})
ok('같은 작성자의 글 사이에도 같은 공공 사진은 한 번', rp3.articles[0]!.picks[0]?.src === pub1.src && rp3.articles[1]!.picks[0]?.src === pub2.src && rp3.articles[2]!.picks[0]?.src === pub1.src)
const rp4 = autoPickPhotos({ articles: [article('x', twoMuseum.slice(0, 3))], candidates: [], publicCandidates: [pub1], places, others: [{ src: pub1.src }, { src: pub1.src }, { src: pub1.src }] })
ok('브랜드 반복 상한(3회)도 공공 사진에 그대로', rp4.articles[0]!.rows[0]!.state === 'used')
ok('공공 사진 후보가 없으면(사용 확인 전) 장소만 보이고 비워 둔다', (() => {
  const r = autoPickPhotos({ articles: [article('p', mdPub)], candidates: [], places })
  return r.articles[0]!.rows[0]!.state === 'nomatch' && r.articles[0]!.rows[0]!.place === '가상근대박물관'
})())
ok('같은 입력이면 같은 결과(공공 사진 포함)', JSON.stringify(autoPickPhotos({ articles: [article('p', mdPub)], candidates: [C.garden], publicCandidates: [pub1, pub2, island3], places, brandName: '가상스테이' })) === JSON.stringify(rp))

// 출처 없는 공공 사진 — 같은 사진이 장소 페이지에 제1유형으로 있으면 출처를 붙인다(자동 채우기 저장에 함께)
const legacy: PhotoPick = { slot: '가상섬 바닷가', nth: 1, same: 1, heading: '섬', src: pub2.src, alt: '', pageUrl: 'https://site.example/', confirmedAt: '2026-10-21T00:00:00.000Z' }
const legacyOther: PhotoPick = { ...legacy, slot: '가상근대박물관 외관', heading: '외관', src: 'https://tong.visitkorea.or.kr/cms/none.jpg' }
ok('공공 사진 호스트의 사진을 출처 없이 고른 기록은 missing', photoCreditState(legacy) === 'missing' && photoCreditState({ ...legacy, src: C.garden.src }) === 'site')
const rc = autoPickPhotos({ articles: [article('p', mdPub, { picks: [legacy, legacyOther] })], candidates: [], publicCandidates: [pub1, pub2], places })
ok(
  '출처를 찾은 사진만 출처 붙이기(못 찾은 사진은 그대로 — 지우지 않는다)',
  rc.articles[0]!.credits.length === 1 && rc.articles[0]!.credits[0]!.src === pub2.src && rc.articles[0]!.credits[0]!.fields.credit === '가상관광공사' && rc.articles[0]!.credits[0]!.pageUrl === PLACE_PAGE,
)

// 내보내기 — 출처 줄, 설명 줄이 없으면 한 줄 끼우기, 출처 없는 사진 빼기, 공공 사진 사용 확인 전이면 빼기
const pubPick = (over: Partial<PhotoPick> = {}): PhotoPick => ({
  slot: '가상시 가상근대박물관 건물 외관', nth: 1, same: 1, heading: '박물관', src: pub1.src, alt: '가상근대박물관', pageUrl: PLACE_PAGE,
  confirmedAt: '2026-11-03T00:00:00.000Z', auto: true, origin: 'public', license: 'kogl-1', credit: '가상관광공사', creditUrl: KOGL1, ...over,
})
const islandPick = pubPick({ slot: '가상섬 바닷가', heading: '섬', src: 'https://tour.example.or.kr/cms/island1.jpg', alt: '가상섬' })
const mdArt = article('p', mdPub).markdown
const outPub = withPhotos(mdArt, [pubPick(), islandPick])
const outLines = outPub.markdown.split('\n')
const creditLine = `사진: 가상관광공사, [공공누리 제1유형](${KOGL1})`
ok('설명 줄 뒤에 출처를 붙인다', outLines.includes(`*입장 마감 전에 들르세요. (${creditLine})*`))
ok('설명 줄이 없으면 출처 줄을 한 줄 끼운다', outLines[outLines.indexOf(`![가상섬](${islandPick.src})`) + 1] === `*${creditLine}*`)
ok('줄을 끼워도 앞 자리 줄이 밀리지 않는다', outLines.indexOf(`![가상근대박물관](${pub1.src})`) === 4 && outPub.applied.length === 2 && outPub.applied.every((a) => a.credit?.license === 'kogl-1'))
ok('출처 줄에 「제공」 · 「협찬」 · 「공식」이 없다', !/제공|협찬|공식/.test(photoCreditLine(pubPick())))
ok('CRLF 원고에서도 줄 끝을 지킨다', (() => {
  const crlf = withPhotos(mdArt.replace(/\n/g, '\r\n'), [pubPick(), islandPick]).markdown
  return crlf.includes(`*입장 마감 전에 들르세요. (${creditLine})*\r\n`) && crlf.includes(`![가상섬](${islandPick.src})\r\n*${creditLine}*`) && !/[^\r]\n/.test(crlf)
})())
ok('출처가 틀린 공공 사진은 넣지 않는다(원고 그대로)', withPhotos(mdArt, [pubPick({ creditUrl: 'https://www.kogl.or.kr/info/licenseType3.do' })]).markdown === mdArt)
ok('출처 없는 공공 사진(공공 사진 호스트)은 넣지 않는다', withPhotos(mdArt, [{ ...legacyOther, slot: '가상시 가상근대박물관 건물 외관', heading: '박물관' }]).markdown === mdArt)
const siteOnly = { photoRights: { confirmedAt: '2026-10-20T00:00:00.000Z' } }
const withPublic = { photoRights: { confirmedAt: '2026-10-20T00:00:00.000Z', publicAt: '2026-11-03T00:00:00.000Z' } }
const sitePick = { ...human, src: C.garden.src }
ok('공공 사진 사용 확인 전에는 공공 사진을 내보내지 않는다(홈페이지 사진은 그대로)', JSON.stringify(exportPhotoPicks(siteOnly, '숙박', [pubPick(), sitePick])) === JSON.stringify([sitePick]))
ok('확인 뒤에는 공공 사진도 · 출처 없는 공공 사진은 여전히 뺀다', exportPhotoPicks(withPublic, '숙박', [pubPick(), sitePick, legacy]).length === 2 && exportPhotoPicks(null, '숙박', [sitePick]).length === 0)
// 블로그 채널 줄(다듬은 글) — 원문에서 짝지은 자리에 같은 출처 줄
const adapted = mdArt.replace('## 1. 박물관', '## 1. 가상근대박물관부터 보기')
const viaSource = withPhotosFromSource(adapted, mdArt, [pubPick()])
ok('블로그 채널 줄에도 같은 출처 줄', viaSource.applied.length === 1 && viaSource.markdown.includes(`*입장 마감 전에 들르세요. (${creditLine})*`))
const statsPub = photoSlotStats([{ markdown: mdArt, picks: [pubPick(), { ...legacy }, { ...human, slot: '가상스테이 독채 앞의 아담한 정원 풍경', heading: '정원', src: C.garden.src }] }])
ok('작성자 줄 셈 — 공공 사진은 채움에 세고, 출처 없는 공공 사진은 따로(채움 아님)', statsPub.slots === 4 && statsPub.filled === 2 && statsPub.public === 1 && statsPub.noCredit === 1 && statsPub.empty === 2)

// 7) 장소 맞춤 — 같은 길이면 뒤에 나온 이름(꾸밈말보다 머리 명사), 띄어 쓴 한 글자를 이어 붙이지 않기, 「○○공원」의 줄인 이름, 다음 장소로 넘어가기
ok(
  '같은 길이의 장소가 둘이면 뒤에 나온 이름 — 「푸르던 … 대장도」는 대장도, 「산마루 … 오성산」은 오성산',
  findPlace('푸르던 바다가 내려다보이는 대장도 전망', ['푸르던', '대장도']) === '대장도' && findPlace('산마루에 걸친 노을과 오성산', ['산마루', '오성산']) === '오성산',
)
ok('띄어 쓴 한 글자 낱말을 이어 붙여 장소로 맞추지 않는다 — 「이 성당」은 「이성당」이 아니다', findPlace('오래된 이 성당 앞 골목', ['이성당']) === null && findPlace('이성당 빵 진열대', ['이성당']) === '이성당')
ok(
  '「○○공원」은 네 글자 이상인 「○○」로도 맞춘다 — 은파호수 → 은파호수공원(어린이공원은 「어린이」로 맞추지 않는다)',
  findPlace('은파호수 둘레 산책로의 아침 풍경', ['은파호수공원', '은파호수공원 물빛다리', '호텔 은파 팰리스']) === '은파호수공원' && findPlace('어린이 놀이터', ['어린이공원']) === null,
)
const placeCand = (name: string, placeName: string, type: number) =>
  pubCand(name, { place: placeName, alt: placeName, pageUrl: `https://site.example/places/${placeName}/`, ...(type === 1 ? {} : { license: null, licenseType: type }) })
const mdFall = ['## 1. 섬', '', '![대장도 앞 푸르던 바다](#image-slot)']
const fallPlaces = ['푸르던', '대장도']
const rf = autoPickPhotos({ articles: [article('f', mdFall)], candidates: [], publicCandidates: [placeCand('pr1', '푸르던', 3), placeCand('dj1', '대장도', 1)], places: fallPlaces })
ok(
  '자리의 첫 장소에 쓸 사진이 없으면 다음 장소의 사진 — 「…푸르던 바다」 자리에 대장도 제1유형 사진',
  rf.articles[0]!.rows[0]!.state === 'filled' && rf.articles[0]!.rows[0]!.pick?.src === placeCand('dj1', '대장도', 1).src && rf.articles[0]!.rows[0]!.place === '대장도',
)
ok('읽을 장소에 자리의 다음 장소도(첫 장소들 뒤에)', JSON.stringify(placesToRead([article('f', mdFall)], fallPlaces)) === JSON.stringify(['푸르던', '대장도']))
ok('공공 사진은 장소 이름으로만 맞추므로 늘 「확인 필요」', rf.articles[0]!.rows[0]!.review === true && prow[0]!.review === true)

// 8) 공공 사진의 사람 검사는 장소 이름에 걸리지 않는다 — 「새만금어린이랜드」 · 「먹방이와 친구들」
ok(
  '장소 이름의 「어린이」 · 「친구」는 사람 사진이 아니다(장소 페이지 주소로도 장소를 안다)',
  autoCandidateSkip(placeCand('kid', '가상어린이랜드', 1)) === null &&
    autoCandidateSkip({ ...placeCand('friends', '먹방이와 친구들', 1), place: undefined, pageUrl: 'https://site.example/places/%EB%A8%B9%EB%B0%A9%EC%9D%B4%EC%99%80-%EC%B9%9C%EA%B5%AC%EB%93%A4/' }) === null &&
    autoCandidateSkip(placeCand('kid2', '가상어린이랜드', 1)) === null &&
    autoCandidateSkip({ ...placeCand('kid3', '가상어린이랜드', 1), alt: '가상어린이랜드에서 노는 아이' }) === 'people',
)
const mdKid = ['## 1. 놀이', '', '![가상어린이랜드 입구](#image-slot)', '', '## 2. 박물관', '', '![가상근대박물관 외관](#image-slot)']
const rk = autoPickPhotos({ articles: [article('k', mdKid)], candidates: [], publicCandidates: [placeCand('kid', '가상어린이랜드', 1), pubCand('nocredit', { creditText: '' })], places: ['가상어린이랜드', '가상근대박물관'] })
ok('장소 이름에 사람 낱말이 있어도 제1유형 사진으로 채운다', rk.articles[0]!.rows[0]!.state === 'filled')
ok('장소 사진이 출처가 없어 빠졌으면 「제1유형 아님」(license)으로 적지 않는다', rk.articles[0]!.rows[1]!.state === 'nomatch')

// 9) 자사 사이트가 공공 사진 호스트(visitkorea.or.kr · go.kr)인 브랜드 — 자기 홈페이지 사진은 출처 없이 쓴다
const OWN = ['own.visitkorea.or.kr']
const ownSrc = 'https://own.visitkorea.or.kr/img/hall.jpg'
ok(
  '자사 사이트 주소의 사진은 공공 사진 호스트여도 출처 표시가 필요한 사진이 아니다(다른 하위 도메인은 그대로)',
  !needsPhotoCredit(ownSrc, OWN) && needsPhotoCredit(ownSrc) && needsPhotoCredit('https://tong.visitkorea.or.kr/cms/a.jpg', OWN) && !needsPhotoCredit('https://cdn.own.visitkorea.or.kr/a.jpg', ['https://own.visitkorea.or.kr/']),
)
ok('자동 채우기도 자사 사이트 사진은 쓴다', autoCandidateSkip({ src: ownSrc, alt: '전시관 로비', pageUrl: 'https://own.visitkorea.or.kr/' }, OWN) === null && autoCandidateSkip({ src: ownSrc, alt: '전시관 로비', pageUrl: PAGE }) === 'credit')
const ownPick: PhotoPick = { ...legacy, src: ownSrc, origin: 'site' }
ok('서버가 자사 사이트 사진으로 확인한 사진(origin site)은 출처 없이 내보낸다', photoCreditState(ownPick) === 'site' && exportPhotoPicks(siteOnly, '숙박', [ownPick]).length === 1)

// 10) 출처 표시 사진 판정 — 공공누리 유형이 있는 ImageObject만(© 표시 · 다른 라이선스만 있는 자사 사진은 고를 수 있다)
const own2 = extractSitePhotos(
  ld({
    '@type': 'LodgingBusiness',
    name: '가상스테이',
    image: [
      { '@type': 'ImageObject', contentUrl: 'https://stay.example/img/garden.jpg', copyrightNotice: '© 가상스테이' },
      { '@type': 'ImageObject', contentUrl: 'https://stay.example/img/cc.jpg', license: 'https://creativecommons.org/licenses/by/4.0/', creditText: '가상스테이' },
      { '@type': 'ImageObject', contentUrl: 'https://stay.example/img/kogl.jpg', acquireLicensePage: 'https://www.kogl.or.kr/info/licenseType1.do' },
    ],
  }),
  PAGE,
)
const own2By = (n: string) => own2.photos.find((p) => p.src.endsWith(`/${n}.jpg`))
ok('© 표시 · 다른 라이선스만 있는 자사 사진은 출처 표시 사진이 아니다(공공누리 유형이 있으면 그대로)', own2By('garden')?.credit === undefined && own2By('cc')?.credit === undefined && own2By('kogl')?.credit === true)

// 11) 제안 자리로 밀린 출처 없는 공공 사진도 작성자 줄의 「출처 없음」에 센다
const suggestedLegacy: PhotoPick = { ...legacy, slot: '가상섬 바닷가 풍경', same: 1 }
const statsSuggested = photoSlotStats([{ markdown: mdArt, picks: [suggestedLegacy] }])
ok('제안 자리(suggested)의 출처 없는 공공 사진도 noCredit에 센다', matchPhotos(mdArt, [suggestedLegacy]).suggested.length === 1 && statsSuggested.noCredit === 1 && statsSuggested.filled === 0)

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
