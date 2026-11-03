/**
 * 사진 자리 자동 채우기 1단계(src/lib/photoAutoPick.ts)의 규칙을 확인한다. 가짜 원고 · 가짜 주소만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 틀린 사진은 빈자리보다 나쁘다 — 문턱에 못 미치면 비워야 하고, 화면 자리 · 사람 사진 · 일러스트 · 출처 표시가 필요한 공공 사진은
 *   넣지 않아야 한다.
 * - 사람이 고르거나 뺀 자리는 자동 채우기가 덮지 않아야 한다.
 * - 같은 사진이 한 글 · 한 작성자 안에서 되풀이되거나 브랜드 전체에서 상한을 넘지 않아야 한다.
 * - 같은 입력이면 같은 결과여야 한다(운영자가 본 미리보기와 다시 돌린 결과가 같게).
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
