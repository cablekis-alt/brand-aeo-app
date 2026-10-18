/**
 * 채널 다듬기(src/prompts/b9d-channel-adapt.ts · server/channelAdapt.ts)가 블로그 글 형식 원문의 서식 · 사진 자리 · 링크를 지키고,
 * 원문에 없는 사진 자리 · 주소는 남기지 않는지 확인한다. 가짜 브랜드 · 가짜 글만 쓰고 임시 폴더를 APP_DATA_DIR로 쓴다.
 * AI는 부르지 않는다(글쓰기 · 격상 검사는 가짜 EngineClient).
 *
 * 왜: 다듬은 글은 판정이 다시 쓴 글이다. 판정이 사진 장면이나 주소를 지어내면 확인할 길이 없고, 그대로 블로그에 올라간다.
 *
 *   npx tsx scripts/verify-channel-adapt.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-channel-adapt-'))
process.env.APP_DATA_DIR = dir

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const ROBOTS = 'https://developers.google.com/search/docs/crawling-indexing/robots/intro'

try {
  const { buildChannelAdaptPrompt } = await import('../src/prompts/b9d-channel-adapt')
  const { adaptForChannel, keepSourceMedia } = await import('../server/channelAdapt')
  const { channelCopyOf } = await import('../src/lib/publishArticle')

  const source = [
    '# 가상시 여행 사이트 고를 때 확인할 2가지',
    '',
    '가상시 여행은 출발 장소부터 보면 됩니다.',
    '',
    '## 1. 어디서 출발하나요?',
    '',
    '**가상 여행은 가상역 2번 출구에서 출발합니다.**',
    '',
    '> 출발 장소가 가상역 2번 출구가 맞나요?',
    '',
    '![가상역 2번 출구 앞 집결 장소](#image-slot)',
    '*출발 전 모이는 곳*',
    '',
    `참고: [Google 검색 센터 — robots.txt 소개](${ROBOTS})`,
    '',
    '## 2. 언제 운영하나요?',
    '',
    '**가상 여행은 오전 9시부터 운영합니다.**',
    '',
  ].join('\n')
  const facts = [
    { id: 'f1', type: 'location' as const, claim: '출발 장소', value: '가상역 2번 출구', updatedAt: '2026-10-18' },
    { id: 'f2', type: 'other' as const, claim: '운영 시작', value: '오전 9시부터', updatedAt: '2026-10-18' },
  ]
  const base = { brandName: '가상 여행', channelDomain: 'vblog.example', sourceMarkdown: source, factGraph: facts }

  // 1) 프롬프트 — 블로그 글 형식 원문을 블로그로 다듬을 때만 서식 유지 규칙
  const articleBlog = buildChannelAdaptPrompt({ ...base, style: 'blog', format: 'article' })
  const oldBlog = buildChannelAdaptPrompt({ ...base, style: 'blog' })
  const articleWiki = buildChannelAdaptPrompt({ ...base, style: 'wiki', format: 'article' })
  ok('블로그 글 형식 + 블로그 — 구조 · 사진 자리 · 링크 · 90~100%', articleBlog.system.includes('사진 자리 줄') && articleBlog.system.includes('원문의 90~100%') && articleBlog.system.includes('새 링크를 만들지 않는다'))
  ok('옛 형식 블로그는 옛 규칙 그대로', oldBlog.system.includes('길이는 원문과 비슷하거나 조금 짧게') && !oldBlog.system.includes('사진 자리 줄'))
  ok('블로그가 아닌 채널은 형식과 무관', articleWiki.system === buildChannelAdaptPrompt({ ...base, style: 'wiki' }).system)

  // 2) 사진 자리 · 링크 거르기
  const body = [
    '## 1. 어디서 출발하나요?',
    '',
    '**가상 여행은 가상역 2번 출구에서 출발해요.**',
    '',
    '> 출발 장소가 가상역 2번 출구가 맞나요?',
    '',
    '![가상역 2번 출구 앞 집결 장소](#image-slot)',
    '*출발 전 모이는 곳*',
    '',
    '![수상 기념 사진](#image-slot)',
    '*상을 받는 모습*',
    '',
    `참고: [Google 검색 센터 — robots.txt 소개](${ROBOTS})`,
    '',
    '자세한 지도는 [가상 지도](https://fake.example/map)에서 볼 수 있어요. 예약은 https://fake.example/book 에서 해요.',
    '',
    '## 2. 언제 운영하나요?',
    '',
    '**가상 여행은 오전 9시부터 운영해요.** 하루 300명이 찾아요.',
  ].join('\n')
  const media = keepSourceMedia(body, source)
  const flat = media.lines.map((l) => (typeof l === 'string' ? l : l.media))
  ok('원문에 있던 사진 자리와 설명은 그대로', flat.includes('![가상역 2번 출구 앞 집결 장소](#image-slot)') && flat.includes('*출발 전 모이는 곳*'))
  ok('원문에 없는 사진 자리는 설명까지 뺀다', !flat.some((l) => l.includes('수상 기념') || l.includes('상을 받는 모습')))
  ok('원문에 있던 링크는 그대로', flat.some((l) => l.includes(`](${ROBOTS})`)))
  ok('원문에 없는 링크는 글자만', flat.some((l) => l.includes('자세한 지도는 가상 지도에서')) && !flat.some((l) => l.includes('](https://fake.example/map)')))
  ok('뺀 것을 기록한다', media.notes.some((n) => n.includes('사진 자리 1곳')) && media.notes.some((n) => n.includes('링크 1개')))

  const writer = {
    call: async () => ({ text: JSON.stringify({ title: '가상시 여행 사이트, 이렇게 고르세요', body }), citations: [], usedWebSearch: false }),
  }
  const checker = { call: async () => ({ text: '[]', citations: [], usedWebSearch: false }) }
  const adapted = await adaptForChannel('vtravel', { contentActionId: 'content:a', channelActionId: 'listing:b' }, { ...base, style: 'blog', format: 'article' }, writer, checker)
  const out = adapted.markdown
  ok('다듬은 글 — 굵게 · 인용 · 번호 소제목이 남는다', out.includes('**가상 여행은 가상역 2번 출구에서 출발해요.**') && out.includes('> 출발 장소가 가상역 2번 출구가 맞나요?') && out.includes('## 1. 어디서 출발하나요?'))
  ok('다듬은 글 — 사진 자리와 설명이 붙어 남는다', out.includes('![가상역 2번 출구 앞 집결 장소](#image-slot)\n*출발 전 모이는 곳*'))
  ok('다듬은 글 — 지어낸 사진 자리는 없다', !out.includes('수상 기념'))
  ok('다듬은 글 — 원문 링크는 남고 지어낸 링크는 글자만', out.includes(`](${ROBOTS})`) && !out.includes('](https://fake.example'))
  ok('다듬은 글 — 원문에 없는 맨 주소가 든 문장은 뺀다', !out.includes('https://fake.example/book') && (adapted.notes ?? []).some((n) => n.includes('원문에 없는 주소')))
  ok('다듬은 글 — 원문에 없는 숫자 문장은 여전히 뺀다', !out.includes('300명') && out.includes('**가상 여행은 오전 9시부터 운영해요.**'))

  // 2-1) 제목 · 주소 · 통째 줄
  const body2 = [
    '## 1. 어디서 출발하나요?',
    '',
    '**가상 여행은 가상역 2번 출구에서 출발해요. 매년 3만 명이 이곳에서 출발해요.**',
    '',
    '> 출발 장소가 가상역 2번 출구가 맞나요? 주차는 50대까지 되나요?',
    '',
    '가상역 2번 출구에서 만나요. 예약은 www.fake-booking.example 에서 받아요. 지도는 fake-booking.co.kr/map 에서 봐요.',
    '',
    `자세한 내용은 [https://fake-booking.example/guide](${ROBOTS})에 있어요.`,
    '',
    '**Q.** 마지막 출발은 언제인가요? **A.** 마지막 출발은 오후 5시 30분이에요.',
  ].join('\n')
  const writer2 = { call: async () => ({ text: JSON.stringify({ title: '가상시 1위 여행, 50% 할인 https://evil.example.com', body: body2 }), citations: [], usedWebSearch: false }) }
  const adapted2 = await adaptForChannel('vtravel', { contentActionId: 'content:a', channelActionId: 'listing:c' }, { ...base, style: 'blog', format: 'article' }, writer2, checker)
  const out2 = adapted2.markdown
  ok('제목 — 사실 대조에 걸리면 원문 제목으로 되돌리고 기록', adapted2.title === '가상시 여행 사이트 고를 때 확인할 2가지' && adapted2.titleChecked === true && (adapted2.notes ?? []).some((n) => n.includes('원문 제목으로 되돌렸습니다')))
  ok('굵은 핵심 줄 — 한 문장이라도 걸리면 줄째 뺀다(별표가 남지 않게)', !out2.includes('3만') && out2.split('\n').every((l) => ((l.match(/\*\*/g) ?? []).length % 2) === 0) && !out2.includes('**가상 여행은 가상역 2번 출구에서 출발해요.'))
  ok('인용 줄 — 한 문장이라도 걸리면 줄째 뺀다', !out2.includes('> 출발 장소가'))
  ok('www · 도메인 꼴 주소가 든 문장은 뺀다', out2.includes('가상역 2번 출구에서 만나요.') && !out2.includes('fake-booking.example 에서') && !out2.includes('fake-booking.co.kr'))
  ok('링크 글자에 지어낸 주소를 쓴 문장도 뺀다', !out2.includes('https://fake-booking.example/guide'))
  ok('「**Q.**」 꼬리표는 그 문장과 함께 남거나 빠진다(답 없는 **A.** 없음)', out2.includes('**Q.** 마지막 출발은 언제인가요?') && !/\*\*A\.\*\*\s*$/m.test(out2))
  const okTitle = await adaptForChannel(
    'vtravel',
    { contentActionId: 'content:a', channelActionId: 'listing:d' },
    { ...base, style: 'blog', format: 'article' },
    { call: async () => ({ text: JSON.stringify({ title: '가상시 여행 사이트, 이렇게 고르세요', body: '## 1. 어디서 출발하나요?\n\n가상역 2번 출구에서 만나요.' }), citations: [], usedWebSearch: false }) },
    checker,
  )
  ok('제목 — 걸리지 않으면 다듬은 제목 그대로', okTitle.title === '가상시 여행 사이트, 이렇게 고르세요' && okTitle.titleChecked === true)

  // 3) 복사할 글 — 블로그 채널만 글 끝을 붙인다
  const brand = { brandName: '가상 여행', ownedDomains: ['vtravel.example'] }
  const settings = { ctaText: '가상 여행 사이트에서 코스를 비교해 보세요.' }
  const blogCopy = channelCopyOf({ markdown: out, style: 'blog' }, { brand, settings })
  ok('블로그 채널 — 다듬은 글 뒤에 글 끝(상담 안내 · 공식 사이트)', blogCopy.startsWith(out.trimEnd()) && blogCopy.includes('가상 여행 사이트에서 코스를 비교해 보세요.') && blogCopy.includes('[가상 여행 공식 사이트](https://vtravel.example/)'))
  ok('위키 · 커뮤니티는 그대로', channelCopyOf({ markdown: out, style: 'wiki' }, { brand, settings }) === out && channelCopyOf({ markdown: out, style: 'community' }, { brand, settings }) === out)
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
