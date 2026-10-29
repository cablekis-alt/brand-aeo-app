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
  const { channelArticleParts, channelCopyOf } = await import('../src/lib/publishArticle')
  const { withPhotos, withPhotosFromSource } = await import('../src/lib/articlePhotos')

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
  // 이미 등록된 후기·예약 플랫폼 — 새 등록 글이 아니라 우리 업체 페이지의 소개 보강. 업종에 묶인 말(진료)을 넣지 않는다.
  const { channelStyleOf } = await import('../src/prompts/b9d-channel-adapt')
  ok('배지 「등록됨」은 소개 보강 문체, 그냥 후기·예약은 등록 문체', channelStyleOf('후기·예약 플랫폼 · 등록됨') === 'listing-update' && channelStyleOf('후기·예약 플랫폼') === 'listing')
  const update = buildChannelAdaptPrompt({ ...base, style: 'listing-update' })
  ok('소개 보강 규칙 — 새로 등록하는 글이 아니고 「진료」가 없다', update.system.includes('새로 등록하는 글이 아니다') && !update.system.includes('진료'))

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

  // 2-2) 빠진 문장에 기대던 문장 — 가드가 앞 문장을 빼면 「그다음 그곳…」도 함께 빼고 기록한다(초안과 같은 규칙, server/factGuard.ts keepSentences)
  const body3 = ['## 1. 어디서 출발하나요?', '', '출발 40분 전에 도착하세요. 그다음 그곳에서 일행을 확인하세요. 짐은 가볍게 챙기세요.'].join('\n')
  const writer3 = { call: async () => ({ text: JSON.stringify({ title: '가상시 여행 준비', body: body3 }), citations: [], usedWebSearch: false }) }
  const adapted3 = await adaptForChannel('vtravel', { contentActionId: 'content:a', channelActionId: 'listing:d' }, { ...base, style: 'blog', format: 'article' }, writer3, checker)
  ok(
    '다듬은 글 — 앞 문장이 빠지면 기대던 「그다음 그곳…」도 함께 뺀다',
    adapted3.markdown.includes('짐은 가볍게 챙기세요.') && !adapted3.markdown.includes('그다음 그곳에서') && (adapted3.notes ?? []).some((n) => n.includes('앞 문장이 빠져')),
  )
  // 격상 가드 경로도 같다 — 크게 말한 앞 문장이 빠지면 「그래서 …」도 함께 뺀다.
  const body4 = ['## 1. 어디서 출발하나요?', '', '가상 여행만 가상역 2번 출구에서 출발하는 유일한 여행이에요. 그래서 늘 줄이 길어요. 짐은 가볍게 챙기세요.'].join('\n')
  const writer4 = { call: async () => ({ text: JSON.stringify({ title: '가상시 여행 준비', body: body4 }), citations: [], usedWebSearch: false }) }
  const overChecker = {
    call: async () => ({ text: JSON.stringify([{ id: 1, verdict: 'overclaim', reason: '「유일한」은 등록된 사실보다 큽니다.' }]), citations: [], usedWebSearch: false }),
  }
  const adapted4 = await adaptForChannel('vtravel', { contentActionId: 'content:a', channelActionId: 'listing:o' }, { ...base, style: 'blog', format: 'article' }, writer4, overChecker)
  ok(
    '다듬은 글 — 격상 가드가 앞 문장을 빼면 「그래서 …」도 함께 뺀다',
    adapted4.markdown.includes('짐은 가볍게 챙기세요.') &&
      !adapted4.markdown.includes('유일한') &&
      !adapted4.markdown.includes('그래서 늘') &&
      (adapted4.notes ?? []).some((n) => n.includes('앞 문장이 빠져')),
  )
  const okTitle = await adaptForChannel(
    'vtravel',
    { contentActionId: 'content:a', channelActionId: 'listing:d' },
    { ...base, style: 'blog', format: 'article' },
    { call: async () => ({ text: JSON.stringify({ title: '가상시 여행 사이트, 이렇게 고르세요', body: '## 1. 어디서 출발하나요?\n\n가상역 2번 출구에서 만나요.' }), citations: [], usedWebSearch: false }) },
    checker,
  )
  ok('제목 — 걸리지 않으면 다듬은 제목 그대로', okTitle.title === '가상시 여행 사이트, 이렇게 고르세요' && okTitle.titleChecked === true)

  // 2-2) 제목 링크 · 원문 제목 없음 · 섞인 굵게 · 주소 단위
  const run = (title: string, body: string, src = source, key = 'listing:e') =>
    adaptForChannel('vtravel', { contentActionId: 'content:a', channelActionId: key }, { ...base, sourceMarkdown: src, style: 'blog', format: 'article' }, { call: async () => ({ text: JSON.stringify({ title, body }), citations: [], usedWebSearch: false }) }, checker)
  const linkTitle = await run('가상 여행 [자세한 안내](https://evil-guide.example.com/x)', '가상역 2번 출구에서 만나요.')
  ok('제목 링크 속 지어낸 주소도 잡아 원문 제목으로', linkTitle.title === '가상시 여행 사이트 고를 때 확인할 2가지')
  const okLinkTitle = await run(`가상 여행 [안내](${ROBOTS})`, '가상역 2번 출구에서 만나요.', source, 'listing:f')
  ok('원문 링크가 든 제목은 링크 표시만 걷어 쓴다', okLinkTitle.title === '가상 여행 안내')
  const noH1 = await run('가상 여행 3일 만에 설치', '가상역 2번 출구에서 만나요.', source.replace(/^# .*\n/, ''), 'listing:g')
  ok('원문 제목이 없으면 비우고 그렇게 적는다', noH1.title === '' && (noH1.notes ?? []).some((n) => n.includes('비워 두었습니다')))
  const mixed = await run('가상 여행 안내', '**가상 여행**을 쓰면 가상역 2번 출구에서 바로 만나요. 설치 전에는 **3일 정도 여유를 두는 게 좋아요.**', source, 'listing:h')
  ok('굵게로 시작 · 끝나는 섞인 문단은 걸린 문장만 뺀다', mixed.markdown.includes('**가상 여행**을 쓰면 가상역 2번 출구에서 바로 만나요.') && !mixed.markdown.includes('3일'))
  const span = await run('가상 여행 안내', '**가상 여행은 가상역 2번 출구에서 출발해요. 설치는 3일이면 끝나요.** 손님이 직원을 부르지 않아도 돼요.', source, 'listing:i')
  ok('여러 문장에 걸친 굵게의 가운데가 빠지면 굵게를 걷는다(별표가 남지 않게)', !span.markdown.includes('**') && span.markdown.includes('가상 여행은 가상역 2번 출구에서 출발해요.'))
  const particle = await run('가상 여행 안내', `자세한 내용은 ${ROBOTS}에서 봐요.`, source, 'listing:j')
  ok('원문 주소에 조사가 붙은 문장은 남는다', particle.markdown.includes(`${ROBOTS}에서 봐요.`))

  const glued = await run(
    '가상 여행 안내',
    '- 홈페이지: https://www.gasang.co.kr\n- 예약은 https://www.gasang.co.kr로 하세요.\n- 공식 홈페이지는 https://www.gasang.co.kr이에요.',
    `${source}\n자세한 내용은 https://www.gasang.co.kr에서 확인하세요.\n`,
    'listing:k',
  )
  ok('원문 주소에 조사가 붙어 있어도 다른 어미로 쓴 같은 주소는 남는다', glued.markdown.includes('- 홈페이지: https://www.gasang.co.kr') && glued.markdown.includes('https://www.gasang.co.kr로 하세요.') && glued.markdown.includes('https://www.gasang.co.kr이에요.'))

  // 3) 복사할 글 — 블로그 채널만 글 끝을 붙인다
  const brand = { brandName: '가상 여행', ownedDomains: ['vtravel.example'] }
  const settings = { ctaText: '가상 여행 사이트에서 코스를 비교해 보세요.' }
  const blogCopy = channelCopyOf({ markdown: out, style: 'blog' }, { brand, settings })
  ok('블로그 채널 — 다듬은 글 뒤에 글 끝(상담 안내 · 공식 사이트)', blogCopy.startsWith(out.trimEnd()) && blogCopy.includes('가상 여행 사이트에서 코스를 비교해 보세요.') && blogCopy.includes('[가상 여행 공식 사이트](https://vtravel.example/)'))
  ok('위키 · 커뮤니티는 그대로', channelCopyOf({ markdown: out, style: 'wiki' }, { brand, settings }) === out && channelCopyOf({ markdown: out, style: 'community' }, { brand, settings }) === out)

  // 4) 블로그 채널 줄에도 고른 홈페이지 사진 — 2026-10-29 티스토리 채널 줄 글에 「[사진 넣을 자리]」 글자만 남았다.
  //    사진 자리는 다듬기 원문에서 찾아(소제목까지) 다듬은 글의 같은 자리로 옮긴다.
  const pick = {
    slot: '가상역 2번 출구 앞 집결 장소',
    nth: 1,
    same: 1,
    heading: '어디서 출발하나요?',
    src: 'https://vtravel.example/img/exit2.webp',
    alt: '가상역 2번 출구 앞 광장',
    pageUrl: 'https://vtravel.example/',
    confirmedAt: '2026-10-29T00:00:00.000Z',
  }
  const rights = { ...settings, photoRights: { confirmedAt: '2026-10-29T00:00:00.000Z' } }
  const blog = { markdown: out, style: 'blog' }
  const from = (picks: (typeof pick)[]) => ({ markdown: source, picks })
  const withPick = channelArticleParts(blog, { brand, settings: rights }, from([pick]))
  ok(
    '블로그 채널 — 사진 자리에 고른 사진, 설명 줄 · 글 끝은 그대로',
    withPick.markdown.includes('![가상역 2번 출구 앞 광장](https://vtravel.example/img/exit2.webp)\n*출발 전 모이는 곳*') &&
      !withPick.markdown.includes('](#image-slot)\n*출발 전 모이는 곳*') &&
      withPick.markdown.includes('[가상 여행 공식 사이트](https://vtravel.example/)'),
  )
  ok('블로그 채널 — 들어간 사진을 돌려준다(사진 받기)', withPick.photos.length === 1 && withPick.photos[0]!.place.slot === pick.slot && withPick.photos[0]!.place.heading === pick.heading)
  ok('고른 사진이 없으면 채널 복사본은 예전과 같다', channelCopyOf(blog, { brand, settings: rights }) === channelArticleParts(blog, { brand, settings: rights }, from([])).markdown)
  ok('원문을 넘기지 않으면(옛 판 다듬은 글) 사진을 넣지 않는다', channelArticleParts(blog, { brand, settings: rights }).photos.length === 0 && channelArticleParts(blog, { brand, settings: rights }).markdown === channelCopyOf(blog, { brand, settings: rights }))
  ok('위키 · 커뮤니티에는 사진을 넣지 않는다', channelArticleParts({ markdown: out, style: 'wiki' }, { brand, settings: rights }, from([pick])).markdown === out && channelArticleParts({ markdown: out, style: 'community' }, { brand, settings: rights }, from([pick])).photos.length === 0)
  ok('사진 사용 확인이 없으면 넣지 않는다', channelArticleParts(blog, { brand, settings }, from([pick])).photos.length === 0 && channelArticleParts(blog, { brand, settings }, from([pick])).markdown === blogCopy)
  ok(
    '의료 업종은 의료광고 확인까지 있어야 넣는다',
    channelArticleParts(blog, { brand: { ...brand, industry: '피부과' }, settings: rights }, from([pick])).photos.length === 0 &&
      channelArticleParts(blog, { brand: { ...brand, industry: '피부과' }, settings: { ...rights, photoRights: { ...rights.photoRights, medical: true as const } } }, from([pick])).photos.length === 1,
  )
  ok('확인하지 않은 사진은 넣지 않는다', channelArticleParts(blog, { brand, settings: rights }, from([{ ...pick, confirmedAt: '' }])).photos.length === 0)
  ok('다듬은 글에 없는 자리의 사진은 넣지 않는다', channelArticleParts(blog, { brand, settings: rights }, from([{ ...pick, slot: '없는 장면' }])).photos.length === 0)
  ok(
    '다듬은 글의 같은 장면 자리 수가 원문과 다르면 넣지 않는다',
    channelArticleParts({ markdown: out.replace(/^\*출발 전 모이는 곳\*$/m, '*출발 전 모이는 곳*\n\n![가상역 2번 출구 앞 집결 장소](#image-slot)'), style: 'blog' }, { brand, settings: rights }, from([pick])).photos.length === 0,
  )

  // 같은 장면 글자의 자리가 둘이고 절 순서가 바뀐 원문 — 사진은 고른 절(주차 안내)로. 다듬은 글은 소제목을 바꿔 써도 설명 줄은 원문 그대로다.
  const twin = (first: string, second: string) =>
    [first, second]
      .map((h) => [`## ${h}`, '', '![매장 외관](#image-slot)', h === '주차 안내' ? '*건물 뒤 주차장 입구*' : '*역에서 걸어오면 보이는 정문*', ''].join('\n'))
      .join('\n')
  const parking = { ...pick, slot: '매장 외관', nth: 2, same: 2, heading: '주차 안내', src: 'https://vtravel.example/img/parking.webp', alt: '주차장 입구' }
  const reordered = twin('주차 안내', '찾아오는 길')
  const reworded = reordered.replace('## 주차 안내', '## 차는 어디에 대나요').replace('## 찾아오는 길', '## 오시는 방법')
  const moved = withPhotosFromSource(reworded, reordered, [parking])
  ok(
    '같은 장면 자리가 둘 — 절 순서가 바뀌어도 고른 절에 넣는다',
    moved.applied.length === 1 && moved.markdown.indexOf('parking.webp') < moved.markdown.indexOf('## 오시는 방법') && moved.markdown.includes('![주차장 입구](https://vtravel.example/img/parking.webp)\n*건물 뒤 주차장 입구*'),
  )
  ok('자사 발행본과 같은 절', withPhotos(reordered, [parking]).markdown.indexOf('parking.webp') < withPhotos(reordered, [parking]).markdown.indexOf('## 찾아오는 길'))
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
