/**
 * 사진 자리 빼기(2026-11-05 결정 D5(d))를 확인한다 — 사람이 「이 자리 빼기」로 뺀 자리(ClearedPhotoPlace.drop)와 발행 설정 「빈 사진 자리 빼고
 * 내보내기」(dropEmptyPhotoSlots). 가짜 원고 · 가짜 주소만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 사진으로 채울 수 없는 자리(다른 회사 앱 화면 · 실시간 예약 달력)의 「[사진 넣을 자리] …」 글자가 블로그에 그대로 나갔다 — 빼는 길이
 *   없었다(올리기 목록 안내뿐).
 * - 본문을 고치면 다듬은 채널 글이 「원문 바뀜」이 된다 — 빼기는 본문을 고치지 않고 내보낼 때만 줄을 빼야 한다.
 * - 뺀 자리는 「사람이 뺀 자리도 다시 채우기」를 켜도 다시 채우면 안 된다.
 * - 아무것도 빼지 않으면 내보내기가 바이트까지 예전과 같아야 한다.
 *
 *   npx tsx scripts/verify-photo-slot-drops.ts
 */
import { withPhotos, withPhotosFromSource, type ClearedPhotoPlace, type PhotoPick } from '../src/lib/articlePhotos'
import { autoPickPhotos, photoSlotStats, type AutoCandidate } from '../src/lib/photoAutoPick'
import { normalizePublishSettings } from '../src/lib/publishSettings'
import { publishArticleParts, photoSlotDropsOf } from '../src/lib/publishArticle'
import { markdownToHtml } from '../src/lib/htmlFile'
import type { StoredDraft } from '../src/lib/api'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const AT = '2026-11-05T00:00:00.000Z'
const MD = [
  '# 가상 글',
  '',
  '## 1. 정원',
  '',
  '![가상스테이 독채 앞 정원](#image-slot)',
  '*정원이 있습니다.*',
  '',
  '## 2. 예약',
  '',
  '![네이버 플레이스 예약 화면의 날짜별 예약 달력](#image-slot)',
  '*날짜를 먼저 확인하세요.*',
  '',
  '## 3. 거실',
  '',
  '![가상스테이 거실](#image-slot)',
  '',
  '끝 문단.',
  '',
].join('\n')
const pick = (slot: string, heading: string, name: string): PhotoPick => ({
  slot, nth: 1, same: 1, heading, src: `https://stay.example/img/${name}.jpg`, alt: `${slot} 사진`, pageUrl: 'https://stay.example/', confirmedAt: AT,
})
const garden = pick('가상스테이 독채 앞 정원', '정원', 'garden')
const dropCal: ClearedPhotoPlace = { slot: '네이버 플레이스 예약 화면의 날짜별 예약 달력', nth: 1, heading: '예약', drop: true }

// 1) 아무것도 빼지 않으면 그대로
ok('뺄 것이 없으면 원고 그대로(사진 없음 · 바이트까지)', withPhotos(MD, []).markdown === MD && withPhotos(MD, undefined, {}).markdown === MD)
const plain = withPhotos(MD, [garden])
ok('뺄 것이 없으면 사진만 넣는다(빈 자리 줄은 남는다)', plain.markdown.includes('](https://stay.example/img/garden.jpg)') && plain.markdown.includes('(#image-slot)'))

// 2) 사람이 뺀 자리
const dropped = withPhotos(MD, [garden], { dropped: [dropCal] })
ok(
  '뺀 자리 — 그 사진 자리 줄만 빠지고 설명 줄 · 다른 빈 자리 · 넣은 사진은 그대로',
  !dropped.markdown.includes('예약 달력](#image-slot)') &&
    dropped.markdown.includes('*날짜를 먼저 확인하세요.*') &&
    dropped.markdown.includes('![가상스테이 거실](#image-slot)') &&
    dropped.markdown.includes('garden.jpg') &&
    dropped.applied.length === 1,
)
ok('뺀 자리 앞뒤 빈 줄이 겹치지 않는다', !/\n\n\n/.test(dropped.markdown))
ok('drop 표시가 없는 뺀 기록(사람이 사진만 뺀 자리)은 줄을 빼지 않는다', withPhotos(MD, [], { dropped: [{ ...dropCal, drop: undefined }] }).markdown === MD)
const pickedAnyway = withPhotos(MD, [{ ...pick(dropCal.slot, '예약', 'cal') }], { dropped: [dropCal] })
ok('뺀 자리에 사진이 있으면(그사이 사람이 넣음) 사진을 넣는다', pickedAnyway.markdown.includes('cal.jpg'))

// 3) 빈 사진 자리 빼고 내보내기
const empty = withPhotos(MD, [garden], { empty: true })
ok('빈 자리 모두 빼기 — 넣은 사진만 남고 「(#image-slot)」 줄이 없다', !empty.markdown.includes('(#image-slot)') && empty.markdown.includes('garden.jpg') && empty.markdown.includes('끝 문단.'))
const html = markdownToHtml(empty.markdown)
ok('.html에도 「[사진 넣을 자리]」 · 「[사진:」 글자가 없다', !html.includes('[사진 넣을 자리]') && !html.includes('[사진:') && html.includes('<figure>'))
const crlf = MD.replace(/\n/g, '\r\n')
ok('CRLF 원고도 줄 끝을 지킨다', !withPhotos(crlf, [], { empty: true }).markdown.includes('(#image-slot)') && !/[^\r]\n/.test(withPhotos(crlf, [], { empty: true }).markdown))

// 4) 발행본 · 설정
const stored: StoredDraft = {
  actionId: 'content:x',
  generatedAt: AT,
  draft: { format: 'legacy', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] },
  editedMarkdown: MD,
  photos: [garden],
  photoCleared: [dropCal],
} as unknown as StoredDraft
const brand = { brandName: '가상스테이', ownedDomains: ['stay.example'] }
const rights = { photoRights: { confirmedAt: AT } }
const out = publishArticleParts(stored, { brand, settings: rights })
ok('발행본 — 사람이 뺀 자리는 설정과 상관없이 늘 뺀다(다른 빈 자리는 남는다)', !out.markdown.includes('예약 달력](#image-slot)') && out.markdown.includes('거실](#image-slot)'))
const outEmpty = publishArticleParts(stored, { brand, settings: { ...rights, dropEmptyPhotoSlots: true } })
ok('발행본 — 「빈 사진 자리 빼고 내보내기」면 빈 자리 줄이 모두 빠진다', !outEmpty.markdown.includes('(#image-slot)') && outEmpty.markdown.includes('garden.jpg'))
ok('사진 사용 확인이 없어도 빈 자리 빼기는 된다(사진은 넣지 않음)', !publishArticleParts(stored, { brand, settings: { dropEmptyPhotoSlots: true } }).markdown.includes('(#image-slot)'))
ok(
  '발행 설정 — dropEmptyPhotoSlots는 true만 저장한다',
  normalizePublishSettings({ dropEmptyPhotoSlots: true }).dropEmptyPhotoSlots === true && normalizePublishSettings({ dropEmptyPhotoSlots: 'yes' }).dropEmptyPhotoSlots === undefined,
)
ok('뺄 것 묶음 — 뺀 기록이 없고 설정이 꺼져 있으면 빈 묶음', JSON.stringify(photoSlotDropsOf({}, null)) === '{}')

// 5) 다듬은 글(블로그 문체) — 원문 자리로 되짚어 뺀다
const adapted = MD.replace('## 2. 예약', '## 2. 예약은 이렇게').replace('끝 문단.', '다듬은 끝 문단.')
const ad = withPhotosFromSource(adapted, MD, [garden], { dropped: [dropCal] })
ok('다듬은 글 — 소제목이 바뀌어도 원문 자리로 되짚어 뺀 자리를 뺀다', !ad.markdown.includes('예약 달력](#image-slot)') && ad.markdown.includes('garden.jpg') && ad.markdown.includes('거실](#image-slot)'))
ok('다듬은 글 — 빈 자리 모두 빼기', !withPhotosFromSource(adapted, MD, [], { empty: true }).markdown.includes('(#image-slot)'))

// 6) 자동 채우기 · 셈
const living: AutoCandidate = { src: 'https://stay.example/img/living.jpg', alt: '네이버 플레이스 예약 달력 날짜 화면', pageUrl: 'https://stay.example/' }
const auto = autoPickPhotos({
  articles: [{ actionId: 'content:x', generatedAt: AT, markdown: MD, cleared: [dropCal] }],
  candidates: [living],
  brandName: '가상스테이',
  refillCleared: true,
})
const calRow = auto.articles[0]!.rows.find((r) => r.slot.key === dropCal.slot)!
ok('자동 채우기 — 뺀 자리는 「사람이 뺀 자리도 다시 채우기」를 켜도 채우지 않는다(dropped)', calRow.state === 'cleared' && calRow.dropped === true && !calRow.pick)
const stats = photoSlotStats([{ markdown: MD, picks: [garden], cleared: [dropCal] }])
ok('셈 — 뺀 자리는 사진 자리 · 빈자리에 세지 않는다', stats.slots === 2 && stats.filled === 1 && stats.empty === 1 && stats.dropped === 1)

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
