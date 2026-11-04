/**
 * 사진 자리 자동 채우기(src/lib/photoAutoPick.ts — 1단계 홈페이지 사진, 2단계 공공 사진과 출처 줄, 3단계 관광공사 사진)의 규칙을 확인한다. 가짜 원고 · 가짜 주소만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 틀린 사진은 빈자리보다 나쁘다 — 문턱에 못 미치면 비워야 하고, 화면 자리 · 사람 사진 · 일러스트 · 출처 표시가 필요한 공공 사진은
 *   넣지 않아야 한다.
 * - 사람이 고르거나 뺀 자리는 자동 채우기가 덮지 않아야 한다.
 * - 같은 사진이 한 글 · 한 작성자 안에서 되풀이되거나 브랜드 전체에서 상한을 넘지 않아야 한다.
 * - 같은 입력이면 같은 결과여야 한다(운영자가 본 미리보기와 다시 돌린 결과가 같게).
 * - 공공 사진은 공공누리 제1유형 · 출처가 있을 때만, 내보낼 때 사진 바로 아래에 출처 줄이 붙어야 한다(출처 표시는 이용 조건이다).
 * - 단계 순서(홈페이지 → 장소 페이지 → 관광공사)를 지켜야 한다 — 장소 페이지를 읽지 못한 장소의 자리를 관광공사 사진으로 먼저 채우면
 *   다음에 눌러도 그 자리의 장소 페이지 사진을 다시 보지 않는다.
 * - 장소 안내 화면은 자리 글자의 장소를 사이트 장소 사전에서 찾아야 한다 — 다른 장소 · 사전 밖의 주소를 찍으면 틀린 화면이다. 설명 줄의
 *   시각 · 요금 · 요일이 찍은 글자에 없으면 「확인 필요」여야 한다.
 *
 *   npx tsx scripts/verify-photo-autopick.ts
 */
import { JSDOM } from 'jsdom'
import { matchPhotos, withPhotos, type PhotoPick } from '../src/lib/articlePhotos'
import {
  AUTO_PICK_RULES,
  autoCandidateSkip,
  autoPickPhotos,
  autoPreviewCounts,
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
  type AutoMapDrawn,
  type AutoScreenShot,
} from '../src/lib/photoAutoPick'
import { MAP_CREDIT, mapAppSrc, mapVariantKey } from '../src/lib/mapImage'
import { screenAppSrc } from '../src/lib/screenCapture'

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
ok(
  '「화면」 · 「사이트」 · 「스크린」만 있는 자리는 사진 자리(좁힌 판정 — 2026-11-04)',
  !isScreenSlot('가상스테이 가옥 외관과 정원이 한 화면에 담긴 장면') && !isScreenSlot('오토캠핑 사이트 전경') && !isScreenSlot('스크린 골프장 내부'),
)
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

// 12) 3단계 — 관광공사 사진(TourAPI 공공누리 제1유형). 장소 페이지에 쓸 사진이 없던 장소 자리만, 장소 페이지 사진 다음에.
const { tourPlacesWanted } = await import('../src/lib/photoAutoPick')
const { extractPlaceInfo, tourCandidatesOf, tourQueryOf } = await import('../src/lib/sitePhotos')
const { isTourSourcePage, TOUR_SOURCES } = await import('../src/lib/tourPhotos')
const tourPlaces = ['가상근대박물관', '가상섬', '가상해양공원']
const tourCand = (name: string, place: string, source: 'kor' | 'gallery', over: Partial<AutoCandidate> = {}): AutoCandidate => ({
  src: `https://tong.visitkorea.or.kr/cms2/website/00/${name}.jpg`, alt: place === '가상해양공원' ? '가상해양테마공원' : place, pageUrl: TOUR_SOURCES[source].page,
  origin: 'public', place, license: 'kogl-1', licenseType: 1, creditText: source === 'gallery' ? '한국관광공사 가상촬영' : '한국관광공사', tour: source, ...over,
})
const mdTour = [
  '## 1. 박물관', '', '![가상근대박물관 외관](#image-slot)', '',
  '## 2. 섬', '', '![가상섬 바닷가](#image-slot)', '*가상섬 앞바다*', '',
  '## 3. 공원', '', '![가상해양공원 전시 함정](#image-slot)', '',
  '## 4. 화면', '', '![가상해양공원 웹사이트 화면](#image-slot)',
]
const stage2 = autoPickPhotos({ articles: [article('t', mdTour)], candidates: [], publicCandidates: [pub1, island3], places: tourPlaces })
ok(
  '관광공사 사진을 찾을 장소 — 장소 페이지 사진이 없던(제1유형 아님 · 사진 없음) 장소 자리만, 화면 자리는 빼고',
  JSON.stringify(tourPlacesWanted(stage2, new Set(tourPlaces))) === JSON.stringify(['가상섬', '가상해양공원']) && stage2.articles[0]!.rows[0]!.pick?.src === pub1.src,
)
const korIsland1 = tourCand('k-island1', '가상섬', 'kor')
const korIsland2 = tourCand('k-island2', '가상섬', 'kor')
const galIsland = tourCand('g-island1', '가상섬', 'gallery', { alt: '가상섬' })
const galPark1 = tourCand('g-park1', '가상해양공원', 'gallery')
const galPark2 = tourCand('g-park2', '가상해양공원', 'gallery')
const tourPeople = tourCand('g-people', '가상해양공원', 'gallery', { alt: '가상해양테마공원 관광객' })
const tourDup = { ...tourCand('dup', '가상섬', 'kor'), src: pub1.src }
const tourAll = [korIsland1, korIsland2, galIsland, galPark1, galPark2, tourPeople, tourDup]
const rTour = autoPickPhotos({ articles: [article('t', mdTour)], candidates: [], publicCandidates: [pub1, island3], tourCandidates: tourAll, places: tourPlaces })
const tTour = rTour.articles[0]!.rows
ok('장소 페이지 사진이 있는 장소는 그대로 장소 페이지 사진(관광공사 사진보다 먼저)', tTour[0]!.pick?.src === pub1.src && !tTour[0]!.candidate?.tour)
ok(
  '제1유형이 아니던 장소 자리는 관광공사 사진 — 국문 관광정보 사진이 먼저, 출처 · 이용 허락 · 찾은 페이지(데이터 페이지)와 함께',
  tTour[1]!.state === 'filled' && tTour[1]!.pick?.src === korIsland1.src && tTour[1]!.candidate?.tour === 'kor' && tTour[1]!.pick?.credit === '한국관광공사' &&
    tTour[1]!.pick?.license === 'kogl-1' && tTour[1]!.pick?.creditUrl === KOGL1 && tTour[1]!.pick?.pageUrl === TOUR_SOURCES.kor.page && isTourSourcePage(tTour[1]!.pick?.pageUrl),
)
ok(
  '사진이 없던 장소 자리는 관광사진(촬영자 출처) · 늘 「확인 필요」',
  tTour[2]!.state === 'filled' && tTour[2]!.pick?.src === galPark1.src && tTour[2]!.pick?.credit === '한국관광공사 가상촬영' && tTour[1]!.review === true && tTour[2]!.review === true,
)
ok('화면 자리는 관광공사 사진도 넣지 않는다', tTour[3]!.state === 'screen' && !tTour[3]!.pick)
ok(
  '관광공사 사진 수 · 사람 낱말 · 이미 본 사진은 뺀 이유와 함께',
  rTour.usableTour === 5 && rTour.skipped.some((x) => x.candidate.src === tourPeople.src && x.reason === 'people') && rTour.skipped.some((x) => x.candidate === tourDup && x.reason === 'duplicate'),
)
ok('같은 입력이면 같은 결과(관광공사 사진 포함)', JSON.stringify(autoPickPhotos({ articles: [article('t', mdTour)], candidates: [], publicCandidates: [pub1, island3], tourCandidates: tourAll, places: tourPlaces })) === JSON.stringify(rTour))
const islandOnly = ['## 1. 섬', '', '![가상섬 바닷가](#image-slot)']
const rSpread = autoPickPhotos({
  articles: [article('s1', islandOnly, { group: 'A' }), article('s2', islandOnly, { group: 'B' }), article('s3', islandOnly, { group: 'C' }), article('s4', islandOnly, { group: 'D' })],
  candidates: [],
  tourCandidates: [korIsland1, korIsland2, galIsland],
  places: tourPlaces,
})
ok(
  '같은 장소의 여러 자리에는 다른 사진부터(브랜드에서 덜 쓴 사진, 같으면 국문 관광정보 먼저)',
  JSON.stringify(rSpread.articles.map((a) => a.picks[0]?.src)) === JSON.stringify([korIsland1.src, korIsland2.src, galIsland.src, korIsland1.src]),
)
const rCap = autoPickPhotos({ articles: [article('c1', islandOnly)], candidates: [], tourCandidates: [korIsland1], places: tourPlaces, others: [{ src: korIsland1.src }, { src: korIsland1.src }, { src: korIsland1.src }] })
ok('브랜드 반복 상한(3회)도 관광공사 사진에 그대로 — 다 쓰면 used', rCap.articles[0]!.rows[0]!.state === 'used' && !rCap.articles[0]!.picks.length)
const rLicense = autoPickPhotos({ articles: [article('l', mdTour)], candidates: [], publicCandidates: [pub1, island3], tourCandidates: [], places: tourPlaces })
ok('관광공사 사진이 없으면 그대로 「제1유형 아님」 · 「맞는 사진 없음」', rLicense.articles[0]!.rows[1]!.state === 'license' && rLicense.articles[0]!.rows[2]!.state === 'nomatch')
const tourPick: PhotoPick = {
  slot: '가상해양공원 전시 함정', nth: 1, same: 1, heading: '공원', src: galPark1.src, alt: '가상해양테마공원', pageUrl: TOUR_SOURCES.gallery.page,
  confirmedAt: '2026-11-03T00:00:00.000Z', auto: true, origin: 'public', license: 'kogl-1', credit: '한국관광공사 가상촬영', creditUrl: KOGL1,
}
const mdTourArt = article('t', mdTour).markdown
const tourOut = withPhotos(mdTourArt, [tourPick]).markdown.split('\n')
ok(
  '내보내기 — 관광공사 사진 아래 출처 줄(촬영자 · 공공누리 제1유형 링크)',
  tourOut[tourOut.indexOf(`![가상해양테마공원](${galPark1.src})`) + 1] === `*사진: 한국관광공사 가상촬영, [공공누리 제1유형](${KOGL1})*`,
)
const tourStats = photoSlotStats([{ markdown: mdTourArt, picks: [tourPick] }])
ok('작성자 줄 셈 — 관광공사 사진도 공공 사진 채움', tourStats.filled === 1 && tourStats.public === 1 && tourStats.noCredit === 0)
ok('관광공사 사진도 출처가 없으면 내보내지 않는다(공공 사진 호스트)', withPhotos(mdTourArt, [{ ...tourPick, origin: undefined, license: undefined, credit: undefined, creditUrl: undefined }]).markdown === mdTourArt)
const tourResult = {
  place: '가상해양공원', city: '가상', resolved: { contentId: '9100', title: '가상해양테마공원', addr: '전북특별자치도 가상시 내항길 2' }, rejectedType: 0, rejectedGallery: 0,
  photos: [{ src: galPark1.src, title: '가상해양테마공원', place: '가상해양공원', source: 'gallery' as const, license: 'kogl-1' as const, licenseType: 1 as const, creditText: '한국관광공사 가상촬영', creditUrl: KOGL1, sourcePageUrl: TOUR_SOURCES.gallery.page, photographer: '한국관광공사 가상촬영', contentId: '1', location: '전라북도 가상' }],
}
ok(
  '관광공사 사진 → 자동 채우기 후보(공공 사진 · 사이트 장소 이름 · 데이터 페이지)',
  JSON.stringify(tourCandidatesOf([tourResult])) ===
    JSON.stringify([{ src: galPark1.src, alt: '가상해양테마공원', pageUrl: TOUR_SOURCES.gallery.page, origin: 'public', place: '가상해양공원', license: 'kogl-1', licenseType: 1, creditText: '한국관광공사 가상촬영', tour: 'gallery' }]),
)
const parkPage = [
  ld({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: '가상해양공원 이용시간' },
    { '@type': ['Park', 'TouristAttraction'], name: '가상해양공원', alternateName: '가상해양테마공원',
      address: { '@type': 'PostalAddress', addressRegion: '전북특별자치도', streetAddress: '가상 내항길 2 가상해양테마공원' },
      geo: { '@type': 'GeoCoordinates', latitude: 35.98, longitude: 126.71 } },
  ] }),
].join('')
const parkInfo = extractPlaceInfo(parkPage, '가상해양공원')
ok('장소 페이지의 다른 이름 · 주소 · 좌표를 읽는다', JSON.stringify(parkInfo) === JSON.stringify({ names: ['가상해양테마공원'], address: '가상 내항길 2 가상해양테마공원', lat: 35.98, lng: 126.71 }))
ok('장소 정보가 없는 페이지는 null', extractPlaceInfo(ld({ '@type': 'WebPage', name: '가상' }), '가상섬') === null)
ok(
  '관광공사 사진 묻기 — 읽은 장소 페이지가 있으면 그 단서를, 없으면 이름만',
  JSON.stringify(tourQueryOf('가상해양공원', [{ place: '가상해양공원', pageUrl: 'https://site.example/places/가상해양공원/', photos: [], info: parkInfo }])) ===
    JSON.stringify({ place: '가상해양공원', names: ['가상해양테마공원'], address: '가상 내항길 2 가상해양테마공원', lat: 35.98, lng: 126.71 }) &&
    JSON.stringify(tourQueryOf('가상섬', [])) === JSON.stringify({ place: '가상섬' }),
)
const restaurantInfo = extractPlaceInfo(
  ld({ '@context': 'https://schema.org', '@type': 'Restaurant', name: '가상당', address: { '@type': 'PostalAddress', addressLocality: '가상시', streetAddress: '중앙로 1' }, geo: { '@type': 'GeoCoordinates', latitude: 35.98, longitude: 126.71 } }),
  '가상당',
)
const hotelInfo = extractPlaceInfo(ld({ '@type': 'LodgingBusiness', name: '가상스테이', address: { '@type': 'PostalAddress', addressLocality: '가상시', streetAddress: '해변로 2' } }), '가상스테이')
ok(
  '식당 · 숙소 장소 페이지(Restaurant · LodgingBusiness)도 주소 · 좌표를 읽는다',
  JSON.stringify(restaurantInfo) === JSON.stringify({ names: [], address: '가상시 중앙로 1', lat: 35.98, lng: 126.71 }) && hotelInfo?.address === '가상시 해변로 2',
)

// 13) 3단계는 2단계(장소 페이지)가 본 장소에만 — 읽지 못했거나(일시 실패) 상한에 걸려 읽지 않은 장소를 관광공사 사진으로 먼저 채우지 않는다.
const mdLake = ['## 1. 호수', '', '![가상호수공원 물빛다리 풍경](#image-slot)']
const rLake = autoPickPhotos({ articles: [article('lake', mdLake)], candidates: [], publicCandidates: [], places: ['가상호수공원'] })
ok(
  '장소 페이지를 읽지 못한 장소는 관광공사 사진을 찾지 않는다 — 읽은 장소만',
  JSON.stringify(tourPlacesWanted(rLake, new Set())) === '[]' && JSON.stringify(tourPlacesWanted(rLake, new Set(['가상호수공원']))) === JSON.stringify(['가상호수공원']),
)
const mixPlaces = ['가상호수공원', '가상물빛다리']
const mdMix = ['## 1. 다리', '', '![가상호수공원 가상물빛다리 야경](#image-slot)', '', '## 2. 난간', '', '![가상물빛다리 난간](#image-slot)']
const bridgeTour = [tourCand('bridge1', '가상물빛다리', 'kor'), tourCand('bridge2', '가상물빛다리', 'kor')]
const mixInput = { articles: [article('mix', mdMix)], candidates: [], places: mixPlaces, pagesRead: new Set(['가상물빛다리']) }
const rMix = autoPickPhotos(mixInput)
const rMixTour = autoPickPhotos({ ...mixInput, tourCandidates: bridgeTour })
ok(
  '자리의 장소 가운데 하나라도 페이지를 읽지 못했으면 그 자리는 관광공사 사진을 찾지도 채우지도 않는다(다른 자리는 그대로)',
  JSON.stringify(tourPlacesWanted(rMix, mixInput.pagesRead)) === JSON.stringify(['가상물빛다리']) &&
    JSON.stringify(rMixTour.articles[0]!.rows.map((r) => r.state)) === JSON.stringify(['nomatch', 'filled']) &&
    autoPickPhotos({ ...mixInput, pagesRead: undefined, tourCandidates: bridgeTour }).articles[0]!.rows[0]!.state === 'filled',
)

// 14) 홈페이지 사진 짝만 반복 상한에 걸리고 장소 사진(장소 페이지 · 관광공사)이 없던 자리도 관광공사 사진을 찾는다.
const homePark = cand('home-park', '가상해양공원')
const mdShip = ['## 1. 함정', '', '![가상해양공원 위봉함](#image-slot)']
const shipInput = { articles: [article('ship', mdShip)], candidates: [homePark], places: ['가상해양공원'], others: [{ src: homePark.src }, { src: homePark.src }, { src: homePark.src }] }
const rShip = autoPickPhotos(shipInput)
const rShipTour = autoPickPhotos({ ...shipInput, tourCandidates: [tourCand('k-ship', '가상해양공원', 'kor')] })
ok(
  '홈페이지 사진 짝이 상한에 걸린 자리(장소 사진 없음)의 장소도 관광공사 사진을 찾고 채운다',
  rShip.articles[0]!.rows[0]!.state === 'used' && JSON.stringify(tourPlacesWanted(rShip, new Set(['가상해양공원']))) === JSON.stringify(['가상해양공원']) &&
    rShipTour.articles[0]!.rows[0]!.state === 'filled' && rShipTour.articles[0]!.rows[0]!.candidate?.tour === 'kor',
)
const shipPub = pubCand('ship-pub', { place: '가상해양공원', alt: '가상해양공원', pageUrl: 'https://site.example/places/가상해양공원/' })
const rShipPublic = autoPickPhotos({ ...shipInput, publicCandidates: [shipPub], others: [...shipInput.others, ...[0, 1, 2].map(() => ({ src: shipPub.src }))] })
ok('장소 페이지 사진까지 상한에 걸린 자리(used)는 그대로 묻지 않는다', rShipPublic.articles[0]!.rows[0]!.state === 'used' && JSON.stringify(tourPlacesWanted(rShipPublic, new Set(['가상해양공원']))) === '[]')

// 15) 사이트의 두 장소가 같은 관광공사 장소로 풀려 같은 사진을 받아도, 뒤 장소의 자리도 채운다(조회 순서와 무관).
const peakPlaces = ['가상봉', '가상봉 전망대']
const mdPeak = ['## 1. 봉우리', '', '![가상봉 능선](#image-slot)', '', '## 2. 전망대', '', '![가상봉 전망대에서 본 바다](#image-slot)']
const peakA = [tourCand('peak1', '가상봉', 'kor'), tourCand('peak2', '가상봉', 'kor')]
const peakB = peakA.map((c) => ({ ...c, place: '가상봉 전망대' }))
const peakRows = (tourCandidates: AutoCandidate[]) =>
  autoPickPhotos({ articles: [article('peak', mdPeak)], candidates: [], tourCandidates, places: peakPlaces }).articles[0]!.rows.map((r) => `${r.state}:${r.pick?.src ?? ''}`)
ok(
  '같은 관광공사 사진을 받은 두 장소 — 두 자리 모두 다른 사진으로',
  JSON.stringify(peakRows([...peakA, ...peakB])) === JSON.stringify([`filled:${peakA[0]!.src}`, `filled:${peakA[1]!.src}`]) &&
    JSON.stringify(peakRows([...peakB, ...peakA])) === JSON.stringify([`filled:${peakA[0]!.src}`, `filled:${peakA[1]!.src}`]),
)

// 16) 자사 화면 단계(src/lib/screenCapture.ts) — 화면 자리 가운데 코스 · 지도 자리만, 찍어 둔 화면으로. 지도는 미리보기만(결정 4),
//     화면은 브랜드 상한 없이 글 하나 · 작성자 한 사람에게 「화면 + 변형」 한 번(결정 3). 브랜드 이름은 가짜, 프로필 호스트는 표에 있는 것.
const SCREEN_HOST = ['gunsan.webforai.kr']
const SB = '가상각'
const shotOf = (screenId: string, variantId: string, n: number, path: string): AutoScreenShot => {
  const id = n.toString(16).padStart(16, '0')
  return { id, screenId, variantId, url: `https://gunsan.webforai.kr${path}`, capturedAt: '2026-11-04T05:00:00.000Z', src: screenAppSrc('fake-gunsan', id) }
}
const SHOTS = {
  cDefault: shotOf('course', 'default', 1, '/plan/'),
  cKids: shotOf('course', 'kids', 2, '/plan/?with=kids&kids=7'),
  cParents: shotOf('course', 'parents', 3, '/plan/?with=parents&adults=3&seniors=2'),
  mDefault: shotOf('map', 'default', 4, '/map/'),
  mOld: shotOf('map', 'r-원도심', 5, '/map/#r-원도심'),
  cSolo: shotOf('course', 'solo', 6, '/plan/?with=solo&adults=1'),
  cCouple: shotOf('course', 'couple', 7, '/plan/?with=couple&adults=2'),
}
const ALL_SHOTS = Object.values(SHOTS)
const COURSE_SLOT = `${SB} 웹사이트의 AI 코스 만들기 화면에서 조건을 고르는 모습`
const MAP_SLOT = `${SB} 웹사이트의 지도에서 찾기 화면에 근대역사박물관 위치가 표시된 모습`
const mdScreen = [
  '## 1. 코스', '', `![${COURSE_SLOT}](#image-slot)`, '*조건만 고르면 일정을 짜 줍니다.*',
  '', '## 2. 지도', '', `![${MAP_SLOT}](#image-slot)`,
  '', '## 3. 결과', '', '![코스 결과 화면에서 한 장소를 눌러 요금이 보이는 모습](#image-slot)',
  // 예전에는 「'아이와 함께' 안내 화면」을 목록에 없는 화면(unrelated)의 예로 썼다 — 4단계에서 그 자리가 찍는 화면(가이드)이 되어 「이번 주
  // 행사」 안내로 바꿨다(이 묶음의 기대값 screen:unrelated · 보낼 사진 1장 · 찍을 화면 없음은 그대로).
  '', '## 4. 안내', '', `![${SB} 웹사이트의 '이번 주 행사' 안내 화면](#image-slot)`,
  '', '## 5. 정원', '', `![${SB} 정원과 한옥이 한 화면에 담긴 장면](#image-slot)`,
]
const screenRun = (articles: AutoArticle[], screens?: { available: boolean; shots: readonly AutoScreenShot[] }, over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}) =>
  autoPickPhotos({ articles, candidates: [], brandName: SB, ownedDomains: SCREEN_HOST, ...(screens ? { screens } : {}), ...over })
const plain = screenRun([article('s1', mdScreen)]).articles[0]!
ok(
  '화면을 주지 않으면 화면 자리는 지금처럼 비워 두고(screen) 종류만 단다 — 「한 화면에 담긴」 자리는 사진 자리(nomatch)',
  JSON.stringify(plain.rows.map((r) => `${r.state}:${r.screenSlot ?? ''}`)) === JSON.stringify(['screen:course', 'screen:map', 'screen:action', 'screen:unrelated', 'nomatch:']) &&
    plain.picks.length === 0,
)
const sRun = screenRun([article('s1', mdScreen)], { available: true, shots: ALL_SHOTS })
const sRows = sRun.articles[0]!.rows
const coursePick = sRows[0]!.pick
ok(
  '코스 화면 자리 — 찍어 둔 코스 화면으로 채운다(앱 주소 · 찍은 주소 · 화면 이름 대체 텍스트 · 화면 · 변형 · 찍은 화면 id)',
  sRows[0]!.state === 'filled' && coursePick?.origin === 'screen' && coursePick.src === SHOTS.cDefault.src && coursePick.pageUrl === SHOTS.cDefault.url &&
    coursePick.alt === "가상각 웹사이트 'AI 코스 만들기' 화면" && coursePick.screenId === 'course' && coursePick.variantId === 'default' &&
    coursePick.shotId === SHOTS.cDefault.id && coursePick.capturedAt === SHOTS.cDefault.capturedAt && coursePick.auto === true && !sRows[0]!.review,
)
ok(
  '지도 화면 자리 — 원도심 장소를 말하면 #r-원도심, 미리보기만(preview · 보낼 사진에 없음) · 늘 확인 필요',
  sRows[1]!.state === 'preview' && sRows[1]!.pick?.variantId === 'r-원도심' && sRows[1]!.screenPick?.by === 'region' && sRows[1]!.screenPick.saveAllowed === false &&
    sRows[1]!.review === true && !sRun.articles[0]!.picks.some((p) => p.screenId === 'map'),
)
ok(
  '누르기 · 결과 화면 · 목록에 없는 화면은 비워 둔다(screen + 까닭)',
  sRows[2]!.state === 'screen' && sRows[2]!.screenSlot === 'action' && !sRows[2]!.pick && sRows[3]!.state === 'screen' && sRows[3]!.screenSlot === 'unrelated' && !sRows[3]!.pick,
)
ok('보낼 사진은 코스 화면 한 장뿐(지도 미리보기는 저장하지 않는다)', sRun.articles[0]!.picks.length === 1 && sRun.articles[0]!.picks[0] === coursePick)
ok('미리보기 셈 — 채울 자리는 코스 화면만', autoPreviewCounts(sRows).filled.all === 1)
ok('찍어 둔 화면으로 다 채우면 찍을 화면이 없다', sRun.screenWanted.length === 0)
ok(
  '같은 입력이면 같은 결과(찍어 둔 화면 순서와 무관)',
  JSON.stringify(screenRun([article('s1', mdScreen)], { available: true, shots: [...ALL_SHOTS].reverse() }).articles) === JSON.stringify(sRun.articles),
)

// 아직 찍지 않은 화면 — 찍을 수 있으면 같은 변형을 고르고 uncaptured로 두어 찍기를 청한다(찍은 뒤 같은 결과).
const uRun = screenRun([article('s1', mdScreen)], { available: true, shots: [] })
const uRows = uRun.articles[0]!.rows
ok(
  '아직 찍지 않은 화면 — uncaptured, 같은 변형, screenWanted로 청한다(보낼 사진 없음)',
  uRows[0]!.state === 'uncaptured' && uRows[0]!.screenPick?.variantId === 'default' && !uRows[0]!.pick && uRows[1]!.state === 'uncaptured' &&
    uRows[1]!.screenPick?.variantId === 'r-원도심' && uRun.articles[0]!.picks.length === 0 &&
    JSON.stringify(uRun.screenWanted) === JSON.stringify([{ screenId: 'course', variantId: 'default' }, { screenId: 'map', variantId: 'r-원도심' }]),
)
const noCap = screenRun([article('s1', mdScreen)], { available: false, shots: [SHOTS.cParents] })
ok(
  '찍을 수 없으면(웹 · dev) 찍어 둔 변형을 먼저 — 없으면 uncaptured로 두되 청하지 않는다',
  noCap.articles[0]!.rows[0]!.state === 'filled' && noCap.articles[0]!.rows[0]!.pick?.variantId === 'parents' && noCap.articles[0]!.rows[1]!.state === 'uncaptured' &&
    noCap.screenWanted.length === 0,
)

// 변형 고르기 — 아이 · 부모님 자리는 그 조건, 브랜드에서 덜 쓴 변형, 사람 장면 규칙은 보지 않는다.
const KIDS_SLOT = `아이와 함께 ${SB} 웹사이트의 AI 코스 만들기 화면에서 조건을 고르는 모습`
const kidsRow = screenRun([article('k1', ['## 아이', '', `![${KIDS_SLOT}](#image-slot)`])], { available: true, shots: ALL_SHOTS }).articles[0]!.rows[0]!
ok('「아이」 자리는 아이와 변형 — 사람 장면 자리여도 「확인 필요」를 달지 않는다', isPeopleScene(KIDS_SLOT) && kidsRow.state === 'filled' && kidsRow.pick?.variantId === 'kids' && !kidsRow.review && kidsRow.screenPick?.by === 'prefer')
// 조건을 말하지 않는 코스 자리는 기본 화면 먼저 — 예전 기대값은 parents(세 변형 가운데 브랜드에서 덜 쓴 것)였다. 그러면 조건을 말하지 않는
// 자리에 아이와 · 부모님 조건 화면이 「확인 필요」 없이 들어간다(검토 2026-11-04). 덜 쓴 변형은 이제 같은 묶음(조건 화면) 안에서만 본다.
const leastUsed = screenRun([article('l1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`])], { available: true, shots: ALL_SHOTS }, {
  others: [{ src: 'screen:course:default' }, { src: 'screen:course:kids' }],
}).articles[0]!.rows[0]!
ok(
  '조건을 말하지 않는 코스 자리는 기본 화면 먼저 — 다른 글에서 기본 · 아이와를 썼어도(브랜드 상한 면제)',
  leastUsed.pick?.variantId === 'default' && !leastUsed.review && leastUsed.screenPick?.by === 'general',
)
const fallback = screenRun([article('l2', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w5' })], { available: true, shots: ALL_SHOTS }, {
  others: [{ src: 'screen:course:default', group: 'w5' }, { src: 'screen:course:kids', group: 'o1' }],
}).articles[0]!.rows[0]!
ok(
  '이 작성자가 기본을 이미 썼으면 조건 화면 가운데 브랜드에서 덜 쓴 것 — 자리가 말하지 않은 조건이라 「확인 필요」',
  fallback.state === 'filled' && fallback.pick?.variantId === 'parents' && fallback.review === true && fallback.screenPick?.by === 'general',
)

// 조건은 소제목 · 설명 줄도 본다 — 실데이터의 코스 자리 글자는 거의 다 「조건을 고르는 모습」이고 조건은 소제목이 말한다.
const condRows = screenRun(
  [
    article('h1', [
      '## 혼자·연인 코스는 어떻게 짜나요?', '', `![${COURSE_SLOT}](#image-slot)`,
      '', `## ${SB} '아이와 함께' 안내로 시간표 짜기`, '', `![${COURSE_SLOT}](#image-slot)`,
      '', '## 혼자 여행', '', `![${COURSE_SLOT}](#image-slot)`,
    ]),
  ],
  { available: true, shots: ALL_SHOTS },
).articles[0]!.rows
// 예전 기대값은 첫 자리가 default(by other), 셋째 자리가 used였다 — 그때는 혼자 · 연인 자리에 기본 화면만 썼다. 이제 혼자 · 연인·친구
// 변형이 있어 첫 자리(혼자·연인)는 그 둘 가운데 표 순서로 혼자, 셋째 자리(혼자 여행)는 이 글에 혼자를 이미 써서 기본(확인 필요)이다.
ok(
  '소제목이 혼자 · 연인을 말하면 그 동행의 변형 — 이 글에 이미 썼으면 기본 화면(확인 필요), 다른 동행의 조건 화면은 쓰지 않는다',
  condRows[0]!.state === 'filled' && condRows[0]!.pick?.variantId === 'solo' && condRows[0]!.screenPick?.by === 'prefer' && !condRows[0]!.review &&
    condRows[2]!.state === 'filled' && condRows[2]!.pick?.variantId === 'default' && condRows[2]!.screenPick?.by === 'prefer' && condRows[2]!.review === true,
)
ok('「아이와 함께」 소제목 아래 코스 자리는 아이와 변형', condRows[1]!.state === 'filled' && condRows[1]!.pick?.variantId === 'kids' && condRows[1]!.screenPick?.by === 'prefer' && !condRows[1]!.review)
const captionParents = screenRun([article('h2', ['## 1박 2일 일정', '', `![${COURSE_SLOT}](#image-slot)`, '*부모님과 함께라면 어르신 인원을 넣어 보세요.*'])], { available: true, shots: ALL_SHOTS }).articles[0]!.rows[0]!
ok('설명 줄이 부모님을 말하면 부모님 변형', captionParents.state === 'filled' && captionParents.pick?.variantId === 'parents' && captionParents.screenPick?.by === 'prefer')
// 예전 기대값은 used였다(연인 자리는 기본만 — 작성자가 기본을 이미 써서 비움). 이제 연인·친구 변형이 먼저다.
const coupleRow = screenRun([article('h3', ['## 연인과 걷는 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w6' })], { available: true, shots: ALL_SHOTS }, {
  others: [{ src: 'screen:course:default', group: 'w6' }],
}).articles[0]!.rows[0]!
ok(
  '「연인」 자리는 연인·친구 변형 — 이 작성자가 기본을 이미 썼어도 넣고 「확인 필요」는 달지 않는다',
  coupleRow.state === 'filled' && coupleRow.pick?.variantId === 'couple' && coupleRow.screenPick?.by === 'prefer' && !coupleRow.review,
)
const soloRow = screenRun([article('h4', [`## ${SB}으로 계절별 혼자 코스 짜기`, '', `![${COURSE_SLOT}](#image-slot)`, '*조건만 고르면 일정을 짜 드려요.*'])], { available: true, shots: ALL_SHOTS }).articles[0]!.rows[0]!
ok('「혼자」 소제목 아래 코스 자리는 혼자 변형(찍은 주소 with=solo)', soloRow.state === 'filled' && soloRow.pick?.variantId === 'solo' && soloRow.pick.pageUrl === SHOTS.cSolo.url && !soloRow.review)
// 동행을 말한 자리는 그 동행의 변형 · 기본을 이 작성자가 다 썼으면 비워 둔다 — 다른 동행(아이와 · 부모님)의 화면은 남아 있어도 쓰지 않는다.
const companionFull = screenRun([article('h5', ['## 혼자·친구 여행에 가상각을 쓰는 법', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w3' })], { available: true, shots: ALL_SHOTS }, {
  others: ['default', 'solo', 'couple'].map((v) => ({ src: `screen:course:${v}`, group: 'w3' })),
}).articles[0]!.rows[0]!
ok('「혼자·친구」 자리에서 혼자 · 연인·친구 · 기본을 이 작성자가 다 썼으면 used(아이와 · 부모님은 쓰지 않는다)', companionFull.state === 'used' && !companionFull.pick)
const friendCaption = screenRun([article('h6', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`, '*친구 같은 사장님이 추천한 곳도 조건에 넣을 수 있어요.*'])], { available: true, shots: ALL_SHOTS }).articles[0]!.rows[0]!
ok('설명 줄의 「친구 같은 사장님」은 동행이 아니다 — 기본 화면(조건을 말하지 않은 자리)', friendCaption.pick?.variantId === 'default' && friendCaption.screenPick?.by === 'general' && !friendCaption.review)

// 상한 — 화면은 브랜드 상한을 받지 않고, 글 하나 · 작성자 한 사람에게 「화면 + 변형」 한 번.
const busy = ['default', 'kids', 'parents'].flatMap((v) => [0, 1, 2, 3].map((i) => ({ src: `screen:course:${v}`, group: `o${i}` })))
const exempt = screenRun([article('e1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w1' })], { available: true, shots: ALL_SHOTS }, { others: busy }).articles[0]!.rows[0]!
ok('브랜드에서 모든 변형을 네 번씩 썼어도 화면은 넣는다(브랜드 상한 3 면제)', exempt.state === 'filled' && exempt.pick?.variantId === 'default')
// 예전에는 세 변형(기본 · 아이와 · 부모님)을 다 쓰면 used였다 — 이제 코스 변형이 다섯이라 셋을 썼으면 혼자 변형(확인 필요), 다섯을 다 써야 used.
const writerUsed = (variants: string[]) =>
  screenRun([article('w1a', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w1' })], { available: true, shots: ALL_SHOTS }, {
    others: variants.map((v) => ({ src: `screen:course:${v}`, group: 'w1' })),
  }).articles[0]!.rows[0]!
const writerThree = writerUsed(['default', 'kids', 'parents'])
const writerFull = writerUsed(['default', 'kids', 'parents', 'solo', 'couple'])
ok(
  '조건을 말하지 않는 자리 — 이 작성자가 기본 · 아이와 · 부모님을 썼으면 혼자 변형(확인 필요), 다섯 변형을 다 썼으면 used',
  writerThree.state === 'filled' && writerThree.pick?.variantId === 'solo' && writerThree.review === true && writerThree.screenPick?.by === 'general' &&
    writerFull.state === 'used' && !writerFull.pick,
)
const twoInArticle = screenRun([article('t1', ['## 1', '', `![${COURSE_SLOT}](#image-slot)`, '', '## 2', '', `![${COURSE_SLOT}](#image-slot)`])], { available: true, shots: ALL_SHOTS })
ok(
  '한 글의 두 코스 자리는 다른 변형',
  twoInArticle.articles[0]!.rows.every((r) => r.state === 'filled') && new Set(twoInArticle.articles[0]!.picks.map((p) => p.variantId)).size === 2,
)
const twoWriters = screenRun(
  [
    article('g1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w2' }),
    article('g2', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w2' }),
    article('g3', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { group: 'w3' }),
  ],
  { available: true, shots: ALL_SHOTS },
)
const gv = twoWriters.articles.map((a) => a.picks[0]?.variantId)
// 예전 기대값은 셋째 글(다른 작성자)이 parents(브랜드에서 덜 쓴 변형)였다 — 조건을 말하지 않는 자리는 이제 기본 화면 먼저라 default다.
ok(
  '같은 작성자의 두 글은 다른 변형(뒤 글은 조건 화면 · 확인 필요), 다른 작성자는 기본 화면을 다시 쓸 수 있다',
  gv[0] === 'default' && gv[1] === 'kids' && twoWriters.articles[1]!.rows[0]!.review === true && gv[2] === 'default' && !twoWriters.articles[2]!.rows[0]!.review,
)

// 사람이 넣은 사진(일러스트) · 사람이 뺀 화면 · 다 찬 글
const illustration: PhotoPick = {
  slot: COURSE_SLOT, nth: 1, same: 1, heading: '코스', src: 'https://gunsan.webforai.kr/img/course-illust.png', alt: '일러스트: 코스 만들기', pageUrl: 'https://gunsan.webforai.kr/', confirmedAt: '2026-11-01T00:00:00.000Z',
}
const keptIllust = screenRun([article('i1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { picks: [illustration] })], { available: true, shots: ALL_SHOTS }).articles[0]!
ok('사람이 이미 넣은 일러스트는 덮지 않는다(kept)', keptIllust.rows[0]!.state === 'kept' && !keptIllust.rows[0]!.pick && keptIllust.picks.length === 0)
const clearedScreen = { slot: COURSE_SLOT, nth: 1, heading: '코스', removed: ['screen:course:default'] }
const notRefilled = screenRun([article('c1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { cleared: [clearedScreen] })], { available: true, shots: ALL_SHOTS }).articles[0]!.rows[0]!
const refilled = screenRun([article('c1', ['## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { cleared: [clearedScreen] })], { available: true, shots: ALL_SHOTS }, { refillCleared: true }).articles[0]!.rows[0]!
ok('사람이 뺀 화면 자리는 다시 채우지 않고, 다시 채우기를 켜도 뺀 「화면 + 변형」은 고르지 않는다', notRefilled.state === 'cleared' && refilled.state === 'filled' && refilled.refill === true && refilled.pick?.variantId === 'kids')
const fullScreen = screenRun([article('f1', ['## 지도', '', `![${MAP_SLOT}](#image-slot)`, '', '## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { picks: [lost(1), lost(2), lost(3)] })], {
  available: true,
  shots: ALL_SHOTS,
}).articles[0]!.rows
ok('사진 3장이 다 찬 글의 화면 자리는 full', fullScreen.every((r) => r.state === 'full' && !r.pick))
const oneLeft = screenRun([article('o1', ['## 지도', '', `![${MAP_SLOT}](#image-slot)`, '', '## 코스', '', `![${COURSE_SLOT}](#image-slot)`], { picks: [lost(1), lost(2)] })], {
  available: true,
  shots: ALL_SHOTS,
}).articles[0]!
ok('지도 미리보기는 글의 사진 자리를 쓰지 않는다 — 남은 한 자리는 코스 화면', oneLeft.rows[0]!.state === 'preview' && oneLeft.rows[1]!.state === 'filled' && oneLeft.picks.length === 1)

// 사진 단계가 먼저 — 사진 자리 · 화면 자리가 함께 있는 글
const mixed = screenRun(
  [article('m1', ['## 1. 가상스테이 정원', '', '![가상스테이 독채 앞의 아담한 정원 풍경](#image-slot)', '*가상스테이에는 독립된 아담한 정원이 있습니다.*', '', '## 2. 코스', '', `![${COURSE_SLOT}](#image-slot)`])],
  { available: true, shots: ALL_SHOTS },
  { candidates: all, brandName: '가상스테이' },
).articles[0]!
ok(
  '사진 자리는 지금처럼 사진으로, 화면 자리는 화면으로 — 보낼 사진은 사진이 먼저',
  mixed.rows[0]!.state === 'filled' && mixed.rows[0]!.pick?.src === C.garden.src && mixed.rows[1]!.state === 'filled' && mixed.rows[1]!.pick?.origin === 'screen' &&
    mixed.picks.map((p) => p.origin ?? 'site').join(',') === 'site,screen',
)
ok(
  '다른 글의 화면은 「화면 + 변형」 열쇠로 센다(otherPhotoUses)',
  JSON.stringify(
    otherPhotoUses(
      { x: { photos: [{ ...illustration, src: SHOTS.cKids.src, origin: 'screen', screenId: 'course', variantId: 'kids' }, illustration] } },
      new Set(),
      () => 'w1',
    ),
  ) === JSON.stringify([{ src: 'screen:course:kids', group: 'w1' }, { src: illustration.src, group: 'w1' }]),
)
ok(
  '프로필이 없는 브랜드는 화면 자리를 비워 둔다(none)',
  (() => {
    const r = autoPickPhotos({ articles: [article('n1', md1)], candidates: [], brandName: '가상스테이', ownedDomains: ['stay.example'], screens: { available: true, shots: ALL_SHOTS } })
    const row = r.articles[0]!.rows[2]!
    return row.state === 'screen' && row.screenSlot === 'none' && !row.pick && r.screenWanted.length === 0
  })(),
)

// 17) 장소 안내 · 가이드(4단계 잘라 찍기) — 장소 안내는 자리 글자(장면 · 설명 줄 · 소제목)의 장소를 사이트 장소 사전(이름 · 주소)에서 찾아
//     그 주소의 변형을 쓴다. 잘라 찍은 화면은 자리 글자의 사실(시각 · 요금 · 요일 · 휴관)이 찍은 글자(text)에 없으면 「확인 필요」.
const PLACE_PAGES = [
  { name: '가상박물관', url: 'https://gunsan.webforai.kr/places/가상박물관/' },
  { name: '가상 해양공원', url: `https://gunsan.webforai.kr/places/${encodeURIComponent('가상-해양공원')}/` },
  { name: '바깥박물관', url: 'https://evil.example/places/바깥박물관/' },
  { name: '영문박물관', url: 'https://gunsan.webforai.kr/en/places/virtual/' },
]
const PLACE_TEXT = '관광지\n가상박물관\n이용시간\n3~10월 09:00–18:00(입장마감 17:30)\n쉬는 날\n매주 월요일\n요금\n개별 성인 2,000원'
const placeShotOf = (variantId: string, n: number, text = PLACE_TEXT): AutoScreenShot => ({
  ...shotOf('place-info', variantId, n, `/places/${encodeURIComponent(variantId)}/`),
  width: 425,
  height: 677,
  text,
})
const GUIDE_SHOT: AutoScreenShot = { ...shotOf('kids-guide', 'default', 31, `/guides/${encodeURIComponent('아이와-함께-군산')}/`), width: 824, height: 364, text: '목적별 가이드\n아이와 함께 가상 여행, 어디를 어떻게 갈까?\n두 묶음으로 나눠 다니면 됩니다.' }
const PLACE_SLOT = `${SB} 웹사이트에서 가상박물관의 이용시간과 휴관일, 입장료가 표시된 화면`
const PLACE_CAPTION = '*가상박물관 3~10월 이용시간은 09:00–18:00 (입장마감 17:30)입니다.*'
const GUIDE_SLOT = `${SB} 웹사이트의 '아이와 함께' 안내 화면`
const placeRun = (articles: AutoArticle[], shots: readonly AutoScreenShot[], over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}) =>
  screenRun(articles, { available: true, shots: [...ALL_SHOTS, ...shots] }, { places: PLACE_PAGES.map((p) => p.name), placePages: PLACE_PAGES, ...over })
const placeOne = (body: string[], shots: readonly AutoScreenShot[] = [placeShotOf('가상박물관', 21)], over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}, group?: string) =>
  placeRun([article('p1', body, group ? { group } : {})], shots, over).articles[0]!
const placeFilled = placeOne(['## 가상박물관 일정', '', `![${PLACE_SLOT}](#image-slot)`, PLACE_CAPTION])
const pRow = placeFilled.rows[0]!
ok(
  '장소 안내 자리 — 자리 글자의 장소(사이트 장소 사전)의 화면으로 채운다(장소 이름을 넣은 대체 텍스트 · 찍은 주소)',
  pRow.state === 'filled' && pRow.screenSlot === 'place' && pRow.pick?.origin === 'screen' && pRow.pick.screenId === 'place-info' && pRow.pick.variantId === '가상박물관' &&
    pRow.pick.alt === "가상각 웹사이트 '가상박물관 장소 안내' 화면" && pRow.pick.pageUrl === `https://gunsan.webforai.kr/places/${encodeURIComponent('가상박물관')}/` &&
    pRow.screenPick?.by === 'place' && pRow.screenPick.saveAllowed === true && placeFilled.picks.length === 1,
)
ok('장소 안내 자리 — 설명 줄 · 장면 글자의 시각 · 입장 마감 · 휴관 · 입장료가 찍은 글자에 있으면 「확인 필요」 없음', !pRow.review && !pRow.factGaps)
const gapRow = placeOne(['## 가상박물관 일정', '', `![${PLACE_SLOT}](#image-slot)`, PLACE_CAPTION], [placeShotOf('가상박물관', 22, PLACE_TEXT.replace('(입장마감 17:30)', ''))]).rows[0]!
ok(
  '장소 안내 자리 — 설명 줄의 시각 · 입장 마감이 찍은 글자에 없으면 넣되 「확인 필요」(빠진 사실을 적는다)',
  gapRow.state === 'filled' && gapRow.review === true && JSON.stringify(gapRow.factGaps) === JSON.stringify(['17:30', '입장 마감']),
)
const wantRun = placeRun([article('p2', ['## 가상박물관 일정', '', `![${PLACE_SLOT}](#image-slot)`, PLACE_CAPTION])], [])
ok(
  '장소 안내 — 아직 찍지 않았으면 uncaptured로 두고 그 장소를 찍기 청한다(변형 id는 장소 이름, 이름표 함께)',
  wantRun.articles[0]!.rows[0]!.state === 'uncaptured' && JSON.stringify(wantRun.screenWanted) === JSON.stringify([{ screenId: 'place-info', variantId: '가상박물관', variantLabel: '가상박물관' }]),
)
// 예전에는 장면 글자가 「관광정보 사이트에서 …」였다 — 브랜드를 말하지 않는 장소 안내 자리는 이제 unowned라(아래 검사), 장소 이름이 없는
// 경우를 보려고 브랜드 이름을 넣었다(기대값 screen · place · no-place는 그대로).
const noPlace = placeOne(['## 관광정보 서비스 고르기', '', `![${SB} 웹사이트에서 한 장소의 여는 시간, 요금, 가는 길이 함께 표시된 화면](#image-slot)`, '*장소마다 여는 시간과 요금이 따로 적혀 있는지 먼저 확인하세요.*']).rows[0]!
ok(
  '장소 이름이 자리 글자 · 소제목 어디에도 없으면 비워 둔다(screenMiss no-place · 찍기 청하지 않음)',
  noPlace.state === 'screen' && noPlace.screenSlot === 'place' && noPlace.screenMiss === 'no-place' && !noPlace.screenPick && !noPlace.pick,
)
// 장면 글자는 위와 같은 까닭으로 「관광정보 사이트에서 …」에서 브랜드 웹사이트로 바꿨다(기대값 그대로).
const headingPlace = placeOne(['## 가상 해양공원 둘러보기', '', `![${SB} 웹사이트에서 한 장소의 여는 시간, 요금이 함께 표시된 화면](#image-slot)`], [placeShotOf('가상-해양공원', 23, '가상 해양공원\n이용시간\n09:00–21:00\n요금\n무료')]).rows[0]!
ok(
  '소제목에만 장소가 나오면 그 장소(by heading) · 「확인 필요」 — 이름의 띄어쓰기는 사전 주소의 하이픈',
  headingPlace.state === 'filled' && headingPlace.pick?.variantId === '가상-해양공원' && headingPlace.screenPick?.by === 'heading' && headingPlace.review === true && !headingPlace.factGaps,
)
const twoPlaces = placeOne(['## 일정', '', `![${SB} 웹사이트에서 가상박물관과 가상 해양공원의 이용시간이 표시된 화면](#image-slot)`], [placeShotOf('가상박물관', 21), placeShotOf('가상-해양공원', 23)]).rows[0]!
ok('장면 글자가 장소를 둘 이상 말하면 한 곳의 화면만 찍히므로 「확인 필요」', twoPlaces.state === 'filled' && twoPlaces.review === true && twoPlaces.screenPick?.by === 'place')
const foreign = placeOne(['## 일정', '', `![${SB} 웹사이트에서 바깥박물관의 이용시간이 표시된 화면](#image-slot)`]).rows[0]!
const english = placeOne(['## 일정', '', `![${SB} 웹사이트에서 영문박물관의 이용시간이 표시된 화면](#image-slot)`]).rows[0]!
ok(
  '사전의 주소가 프로필 호스트의 /places/<이름>/가 아니면(다른 사이트 · 언어 경로) 그 장소로 찍지 않는다',
  foreign.state === 'screen' && foreign.screenMiss === 'no-place' && english.state === 'screen' && english.screenMiss === 'no-place',
)
const noDir = placeRun([article('p3', ['## 가상박물관 일정', '', `![${PLACE_SLOT}](#image-slot)`])], [placeShotOf('가상박물관', 21)], { placePages: undefined }).articles[0]!.rows[0]!
ok('장소 사전이 없으면 장소 안내 자리는 비워 둔다(screenMiss no-directory)', noDir.state === 'screen' && noDir.screenMiss === 'no-directory' && !noDir.pick)
const sameWriter = placeRun(
  [article('q1', ['## 가상박물관', '', `![${PLACE_SLOT}](#image-slot)`], { group: 'w1' }), article('q2', ['## 가상박물관', '', `![${PLACE_SLOT}](#image-slot)`], { group: 'w1' })],
  [placeShotOf('가상박물관', 21)],
)
const otherWriter = placeRun(
  [article('q3', ['## 가상박물관', '', `![${PLACE_SLOT}](#image-slot)`], { group: 'w1' }), article('q4', ['## 가상박물관', '', `![${PLACE_SLOT}](#image-slot)`], { group: 'w2' })],
  [placeShotOf('가상박물관', 21)],
)
ok(
  '같은 장소 안내는 작성자 한 사람에게 한 번(뒤 글은 used) · 다른 작성자는 다시 쓴다(브랜드 상한 면제)',
  sameWriter.articles[0]!.rows[0]!.state === 'filled' && sameWriter.articles[1]!.rows[0]!.state === 'used' &&
    otherWriter.articles.every((a) => a.rows[0]!.state === 'filled' && a.picks[0]?.variantId === '가상박물관'),
)
const guideRow = placeOne(['## 아이와 가는 1박 2일', '', `![${GUIDE_SLOT}](#image-slot)`], [GUIDE_SHOT]).rows[0]!
ok(
  '가이드 자리 — 「아이와 함께」 안내 화면으로 채운다(화면 이름 대체 텍스트 · 사실을 말하지 않는 자리는 「확인 필요」 없음)',
  guideRow.state === 'filled' && guideRow.screenSlot === 'guide' && guideRow.pick?.screenId === 'kids-guide' && guideRow.pick.variantId === 'default' &&
    guideRow.pick.alt === "가상각 웹사이트 '아이와 함께 안내' 화면" && !guideRow.review,
)
const guideGap = placeOne(['## 처음 가는 날', '', `![${GUIDE_SLOT}](#image-slot)`, '*아이와 함께 안내에서 월요일에도 여는 곳을 확인할 수 있습니다.*'], [GUIDE_SHOT]).rows[0]!
ok('가이드 자리 — 설명 줄의 「월요일」이 찍은 글자에 없으면 「확인 필요」', guideGap.state === 'filled' && guideGap.review === true && JSON.stringify(guideGap.factGaps) === JSON.stringify(['월요일']))
const notStolen = placeRun(
  [
    article('n1', [
      '## 1', '', `![${SB} '지도에서 찾기' 화면에서 가상박물관을 선택해 이용시간과 입장료가 보이는 모습](#image-slot)`, PLACE_CAPTION,
      '', '## 2', '', '![코스 결과 화면에서 한 장소를 눌러 여는 시간과 요금, 가는 길이 함께 표시된 모습](#image-slot)',
      '', '## 3', '', `![${COURSE_SLOT}](#image-slot)`,
    ]),
  ],
  [placeShotOf('가상박물관', 21)],
).articles[0]!.rows
ok(
  '지도에서 고르기 · 코스 결과 자리는 장소 안내가 아니다(action — 비워 둠), 코스 자리는 그대로 코스',
  notStolen[0]!.screenSlot === 'action' && notStolen[0]!.state === 'screen' && notStolen[1]!.screenSlot === 'action' && notStolen[1]!.state === 'screen' &&
    notStolen[2]!.screenSlot === 'course' && notStolen[2]!.pick?.screenId === 'course',
)
// 다른 기관 사이트를 말하는 화면 자리 · 사이트를 말하지 않는 장소 안내 자리에 자사 화면을 넣지 않는다 — 예전에는 안내 낱말(관람시간 · 입장료)만
// 보고 「확인 필요」 없이 장소 안내 화면을 넣었다(검토 2026-11-04).
const otherSites = placeRun(
  [
    article('o1', [
      '## 가상박물관 가기 전에', '', '![가상박물관 공식 홈페이지의 관람시간 안내 화면](#image-slot)', '*관람시간은 09:00–18:00입니다.*',
      '', '## 2', '', '![한국관광공사 대한민국 구석구석 사이트에서 가상박물관의 이용시간과 입장료가 표시된 화면](#image-slot)',
      '', '## 3', '', '![웹사이트에서 가상박물관의 이용시간이 표시된 화면](#image-slot)',
    ]),
  ],
  [placeShotOf('가상박물관', 21)],
).articles[0]!
ok(
  '다른 기관 사이트(공식 홈페이지 · 관광공사)를 말하는 화면 자리는 other, 사이트를 말하지 않는 장소 안내 자리는 unowned — 비워 둔다',
  JSON.stringify(otherSites.rows.map((r) => `${r.state}:${r.screenSlot ?? ''}`)) === JSON.stringify(['screen:other', 'screen:other', 'screen:unowned']) &&
    otherSites.picks.length === 0 && otherSites.rows.every((r) => !r.screenPick),
)
// 실물 안내판 사진 자리 — 「장소 안내 화면」 · 「아이와 함께 안내 화면」 이름만으로는 화면 자리가 아니다(사진 자리 그대로).
const physical = placeRun(
  [article('ph', ['## 가상박물관', '', '![가상박물관 로비의 장소 안내 화면 앞 풍경](#image-slot)', '', '## 어린이박물관', '', '![가상박물관 어린이박물관 입구의 아이와 함께 안내 화면](#image-slot)'])],
  [placeShotOf('가상박물관', 21), GUIDE_SHOT],
).articles[0]!
ok(
  '「장소 안내 화면」 · 「아이와 함께 안내 화면」 실물 안내판 자리는 사진 자리(화면을 넣지 않는다)',
  physical.rows.every((r) => r.state === 'nomatch' && !r.screenSlot && !r.pick) && physical.picks.length === 0,
)
// 장면 글자가 장소를 둘 이상 말하고 설명 줄의 사실도 빠졌으면 까닭 둘을 다 남긴다 — 장소들(screenPlaces)과 빠진 사실(factGaps).
const twoPlacesGap = placeOne(
  ['## 원도심', '', `![${SB} 웹사이트에서 가상박물관과 가상 해양공원의 이용시간이 표시된 화면](#image-slot)`, '*두 곳 모두 화요일에 쉽니다.*'],
  [placeShotOf('가상박물관', 21), placeShotOf('가상-해양공원', 23)],
).rows[0]!
ok(
  '장소가 둘 이상 · 사실 빠짐이 함께면 둘 다 남긴다(screenPlaces · factGaps)',
  twoPlacesGap.state === 'filled' && twoPlacesGap.review === true && JSON.stringify([...(twoPlacesGap.screenPlaces ?? [])].sort()) === JSON.stringify(['가상 해양공원', '가상박물관']) &&
    (twoPlacesGap.factGaps ?? []).includes('화요일'),
)
ok('장소가 한 곳이면 screenPlaces를 달지 않는다', !pRow.screenPlaces && !gapRow.screenPlaces)
// 동행 낱말 — 「어린이 친구들」 소제목은 아이와(연인·친구 아님), 「혼자 하는 여행」 소제목은 혼자.
const kidsFriends = screenRun([article('kf', ['## 어린이 친구들이 좋아하는 가상 체험 코스', '', `![${COURSE_SLOT}](#image-slot)`, '*조건만 고르면 일정을 짜 드려요.*'], { group: 'w1' })], { available: true, shots: ALL_SHOTS }, {
  others: [0, 1, 2].map((i) => ({ src: 'screen:course:kids', group: `o${i}` })),
}).articles[0]!.rows[0]!
const soloTrip = screenRun([article('st', ['## 혼자 하는 가상 여행, 코스는 이렇게', '', `![${COURSE_SLOT}](#image-slot)`, '*조건만 고르면 일정을 짜 드려요.*'], { group: 'w1' })], { available: true, shots: ALL_SHOTS }, {
  others: [{ src: 'screen:course:default', group: 'w1' }],
}).articles[0]!.rows[0]!
ok(
  '「어린이 친구들」 소제목 아래 코스 자리는 아이와(브랜드에서 많이 썼어도 연인·친구를 넣지 않는다) · 「혼자 하는 여행」은 혼자',
  kidsFriends.state === 'filled' && kidsFriends.pick?.variantId === 'kids' && kidsFriends.screenPick?.by === 'prefer' && !kidsFriends.review &&
    soloTrip.state === 'filled' && soloTrip.pick?.variantId === 'solo' && soloTrip.screenPick?.by === 'prefer' && !soloTrip.review,
)
// 18) 군산 지도 그림(OSM — src/lib/mapImage.ts) — 장소 목록 출처가 있는 프로필의 지도 자리는 카카오 지도 미리보기 대신 앱이 그린 지도로
//     채운다(maps를 줄 때). 늘 「확인 필요」, 같은 장소 묶음(변형 열쇠)은 글 하나 · 작성자 한 사람에게 한 번(브랜드 상한 없음), 아직 그리지
//     않았으면 undrawn + mapWanted. 장소 · 좌표는 가짜.
const MP = (id: string, name: string, kind: 'attraction' | 'food' | 'stay', lng: number, lat: number, region = '원도심') => ({ id, name, kind, lng, lat, region })
const MAP_POINTS = [
  MP('m1', '가상역사관', 'attraction', 126.7121, 35.9908),
  MP('m2', '가상바다공원', 'attraction', 126.7175, 35.9893),
  MP('m3', '가상곰전시관', 'attraction', 126.7146, 35.9897),
  MP('m4', '가상동산', 'attraction', 126.7035, 35.9904),
  MP('m5', '가상빵집', 'food', 126.7112, 35.987),
  MP('m6', '가상국숫집', 'food', 126.7096, 35.9853),
  MP('m7', '기지옆골프장', 'attraction', 126.64, 35.92, '은파'),
]
const MAP_VERSION = 'v-points-1'
const MSLOT = `${SB} 웹사이트의 지도에서 찾기 화면에 가상역사관·가상바다공원 위치가 표시된 모습`
const mdMap = (slot = MSLOT) => ['## 1. 지도', '', `![${slot}](#image-slot)`, '*지도에서 찾기로 위치를 확인할 수 있습니다.*']
const drawnOf = (ids: string[], n: number, over: Partial<AutoMapDrawn> = {}): AutoMapDrawn => {
  const id = (0xa00 + n).toString(16).padStart(16, '0')
  const markers = ids.map((x) => MAP_POINTS.find((p) => p.id === x)!).map((p) => ({ id: p.id, label: p.name, kind: p.kind }))
  return {
    id,
    src: mapAppSrc('fake-gunsan', id),
    variant: mapVariantKey(ids),
    pointsVersion: MAP_VERSION,
    alt: `군산 지도 — ${markers.map((x) => x.label).join(' · ')} 위치`,
    caption: `${markers.map((x) => x.label).join(' · ')} 위치를 지도에 표시했습니다.`,
    source: 'https://gunsan.webforai.kr/map/',
    drawnAt: '2026-11-05T01:00:00.000Z',
    markers,
    ...over,
  }
}
const mapRun = (articles: AutoArticle[], maps: { available: boolean; drawn: AutoMapDrawn[]; points?: typeof MAP_POINTS } | undefined, over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}) =>
  screenRun(articles, { available: true, shots: ALL_SHOTS }, { ...(maps ? { maps: { available: maps.available, points: maps.points ?? MAP_POINTS, pointsVersion: MAP_VERSION, drawn: maps.drawn } } : {}), ...over })
const undrawn = mapRun([article('mp1', mdMap(), { group: 'w1' })], { available: true, drawn: [] })
const uRow = undrawn.articles[0]!.rows[0]!
ok(
  '지도 자리 — 아직 그리지 않았으면 undrawn · 고른 표지(이름이 나온 장소) · 늘 확인 필요 · mapWanted로 청한다(카카오 지도는 찍지 않는다)',
  uRow.state === 'undrawn' && uRow.screenSlot === 'map' && uRow.review === true && !uRow.pick && !uRow.screenPick &&
    uRow.mapPick?.key === mapVariantKey(['m1', 'm2']) && uRow.mapPick.by === 'named' && uRow.mapPick.alt === '군산 지도 — 가상역사관 · 가상바다공원 위치' &&
    JSON.stringify(undrawn.mapWanted) === JSON.stringify([{ key: mapVariantKey(['m1', 'm2']), ids: ['m1', 'm2'] }]) &&
    undrawn.screenWanted.every((w) => w.screenId !== 'map') && undrawn.articles[0]!.picks.length === 0,
)
const D12 = drawnOf(['m1', 'm2'], 1)
const filledMap = mapRun([article('mp1', mdMap(), { group: 'w1' })], { available: true, drawn: [D12] })
const fRow = filledMap.articles[0]!.rows[0]!
ok(
  '그려 둔 지도가 있으면 채운다 — origin osm-map · 앱 주소 · 지도 대체 텍스트 · 위치 문장 · 출처 줄 · 지도 id · 변형 열쇠 · 확인 필요',
  fRow.state === 'filled' && fRow.review === true && fRow.pick?.origin === 'osm-map' && fRow.pick.src === D12.src && fRow.pick.alt === D12.alt &&
    fRow.pick.caption === D12.caption && fRow.pick.credit === MAP_CREDIT && fRow.pick.mapId === D12.id && fRow.pick.mapVariant === D12.variant &&
    fRow.pick.pageUrl === D12.source && fRow.pick.auto === true && filledMap.articles[0]!.picks.length === 1 && filledMap.mapWanted.length === 0,
)
ok(
  '자리의 장면 글자 · 설명 줄은 고치지 않는다(사진 기록에만 위치 문장)',
  fRow.pick?.slot === MSLOT && fRow.caption === '지도에서 찾기로 위치를 확인할 수 있습니다.',
)
const staleVer = mapRun([article('mp1', mdMap())], { available: true, drawn: [drawnOf(['m1', 'm2'], 2, { pointsVersion: 'old' })] })
ok('장소 목록 판이 다른 지도는 쓰지 않는다(다시 그린다)', staleVer.articles[0]!.rows[0]!.state === 'undrawn' && staleVer.mapWanted.length === 1)
const cantDraw = mapRun([article('mp1', mdMap())], { available: false, drawn: [] })
ok('그릴 수 없는 실행(웹 · dev) — undrawn이지만 청하지 않는다', cantDraw.articles[0]!.rows[0]!.state === 'undrawn' && cantDraw.mapWanted.length === 0)
const twoSame = mapRun(
  [article('mw1', mdMap(), { group: 'w1' }), article('mw2', mdMap(), { group: 'w1' }), article('mw3', mdMap(), { group: 'w1' })],
  { available: true, drawn: [D12] },
)
const tier1 = twoSame.articles[1]!.rows[0]!
ok(
  '같은 작성자의 두 번째 같은 자리 — 넓힌 묶음(tier 1, 다른 열쇠)으로, 세 번째는 used',
  twoSame.articles[0]!.rows[0]!.state === 'filled' && tier1.state === 'undrawn' && tier1.mapPick?.tier === 1 && tier1.mapPick.key !== D12.variant &&
    tier1.mapPick.ids.includes('m1') && tier1.mapPick.ids.includes('m2') && twoSame.articles[2]!.rows[0]!.state === 'used',
)
const fourWriters = mapRun(
  ['w1', 'w2', 'w3', 'w4'].map((g, i) => article(`mx${i}`, mdMap(), { group: g })),
  { available: true, drawn: [D12] },
)
ok('작성자가 다르면 같은 지도를 다시 쓴다(브랜드 상한 없음)', fourWriters.articles.every((a) => a.rows[0]!.state === 'filled' && a.picks[0]?.mapId === D12.id))
const inOne = mapRun([article('mi', [...mdMap(), '', '## 2. 또 지도', '', `![${MSLOT}](#image-slot)`])], { available: true, drawn: [D12] }).articles[0]!
ok('한 글의 두 자리에 같은 묶음이면 두 번째는 넓힌 묶음', inOne.rows[0]!.state === 'filled' && inOne.rows[1]!.mapPick?.tier === 1)
const avoidSlot = mapRun([article('ma', mdMap(`${SB} 웹사이트의 지도에서 찾기 화면에 기지옆골프장 위치가 표시된 모습`))], { available: true, drawn: [] }).articles[0]!.rows[0]!
ok('공군기지 상자 안 장소만 말한 자리 — 표지가 없어 비워 둔다(screen · mapMiss no-markers)', avoidSlot.state === 'screen' && avoidSlot.mapMiss === 'no-markers' && !avoidSlot.mapPick && !avoidSlot.pick)
const anchorRow = mapRun(
  [article('mn', ['## 1. 동선', '', '가상곰전시관을 먼저 본 뒤 식사합니다.', '', `![${SB} 웹사이트의 지도에서 찾기 화면에 식당과 주변 관광지가 함께 표시된 모습](#image-slot)`, '*지도에서 찾기로 식당 주변을 봅니다.*'])],
  { available: true, drawn: [] },
).articles[0]!.rows[0]!
ok(
  '이름 없는 「식당 … 관광지」 자리 — 절 글자의 장소를 기준점으로 음식점 · 관광지',
  anchorRow.state === 'undrawn' && anchorRow.mapPick?.by === 'anchor' && anchorRow.mapPick.markers[0]?.label === '가상곰전시관' &&
    anchorRow.mapPick.markers.some((x) => x.kind === 'food') && /절 글자/.test(anchorRow.mapPick.why),
)
const fullMap = mapRun([article('mf', mdMap(), { picks: [lost(1), lost(2), lost(3)] })], { available: true, drawn: [D12] }).articles[0]!.rows
ok('사진 3장이 다 찬 글의 지도 자리는 full', fullMap[0]!.state === 'full' && !fullMap[0]!.pick)
const clearedMap = mapRun(
  [article('mc', mdMap(), { group: 'w1', cleared: [{ slot: MSLOT, nth: 1, heading: '지도', removed: [`osm-map:${D12.variant}`] }] })],
  { available: true, drawn: [D12] },
  { refillCleared: true },
).articles[0]!.rows[0]!
ok('사람이 그 자리에서 뺀 지도(osm-map 열쇠)는 다시 고르지 않는다 — 넓힌 묶음으로', clearedMap.refill === true && clearedMap.mapPick?.tier === 1 && clearedMap.mapPick.key !== D12.variant)
ok(
  '다른 글의 지도는 「osm-map:변형」으로 센다(otherPhotoUses)',
  JSON.stringify(otherPhotoUses({ x: { photos: [{ ...illustration, src: D12.src, origin: 'osm-map', mapId: D12.id, mapVariant: D12.variant, credit: MAP_CREDIT }] } }, new Set(), () => 'w1')) ===
    JSON.stringify([{ src: `osm-map:${D12.variant}`, group: 'w1' }]),
)
const othersMap = mapRun([article('mo', mdMap(), { group: 'w1' })], { available: true, drawn: [D12] }, { others: [{ src: `osm-map:${D12.variant}`, group: 'w1' }] }).articles[0]!.rows[0]!
ok('같은 작성자의 다른 글에 이미 들어간 지도 묶음이면 넓힌 묶음', othersMap.mapPick?.tier === 1)
const noMapsInput = mapRun([article('mk', mdMap())], undefined).articles[0]!.rows[0]!
ok('maps를 주지 않으면 지금처럼 카카오 지도 미리보기(preview)', noMapsInput.state === 'preview' && noMapsInput.screenPick?.screenId === 'map' && !noMapsInput.mapPick)
const otherBrand = autoPickPhotos({
  articles: [article('ob', mdMap())],
  candidates: [],
  brandName: SB,
  ownedDomains: ['stay.example'],
  screens: { available: true, shots: ALL_SHOTS },
  maps: { available: true, points: MAP_POINTS, pointsVersion: MAP_VERSION, drawn: [D12] },
}).articles[0]!.rows[0]!
ok('장소 목록 출처가 없는 브랜드(프로필 없음)는 그대로 — 지도 자리를 비워 둔다', otherBrand.state === 'screen' && otherBrand.screenSlot === 'none' && !otherBrand.mapPick && !otherBrand.pick)
const noPoints = mapRun([article('np', mdMap())], { available: true, drawn: [], points: [] }).articles[0]!.rows[0]!
ok('장소 목록이 비면 비워 둔다(mapMiss no-points)', noPoints.state === 'screen' && noPoints.mapMiss === 'no-points' && !noPoints.pick)
ok('미리보기 셈 — 채운 지도는 채울 자리 · 확인 필요에 센다', (() => {
  const c = autoPreviewCounts(filledMap.articles[0]!.rows)
  return c.filled.all === 1 && c.filled.review === 1
})())
ok(
  '같은 입력이면 같은 결과(그려 둔 지도 순서와 무관)',
  JSON.stringify(mapRun([article('mp1', mdMap(), { group: 'w1' })], { available: true, drawn: [drawnOf(['m3'], 9), D12] }).articles) ===
    JSON.stringify(mapRun([article('mp1', mdMap(), { group: 'w1' })], { available: true, drawn: [D12, drawnOf(['m3'], 9)] }).articles),
)
ok(
  '장소 사전을 주어도 코스 · 지도 · 목록에 없는 화면 자리의 결과는 같다',
  JSON.stringify(screenRun([article('s1', mdScreen)], { available: true, shots: ALL_SHOTS }, { places: PLACE_PAGES.map((p) => p.name), placePages: PLACE_PAGES }).articles) ===
    JSON.stringify(screenRun([article('s1', mdScreen)], { available: true, shots: ALL_SHOTS }, { places: PLACE_PAGES.map((p) => p.name) }).articles),
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
