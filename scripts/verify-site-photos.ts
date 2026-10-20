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
