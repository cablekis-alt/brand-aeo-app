/**
 * 올린 글 주소와 인용 주소를 맞추는 규칙(src/lib/publishedUrl.ts)과, 실행 항목에 붙는 이번 주 결과(computeGapActions의 publishedHits)를
 * 확인한다. 화면 · 서버 · AI는 부르지 않는다.
 *
 * 왜: 예전 규칙은 "인용 주소가 올린 주소로 시작하면 같은 글"이라 `…/1`을 올렸는데 `…/12`가 인용돼도 「인용됨」이 됐다. 반대로
 * 네이버 블로그 PostView 주소 · m. 주소 · OpenAI가 붙이는 utm_source=openai는 같은 글인데 못 맞췄다. 올리기 전에 한 측정을
 * 「인용됨」으로 세면 집행 효과가 부풀고, 질문 은행을 못 읽은 주를 0으로 보이면 없는 결과를 지어낸다.
 *
 *   npx tsx scripts/verify-published-url.ts
 */
const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const { trackingKey, isArticleUrl, matchKind, indexWeekCitations, measuredWindow, timingOf, isoWeekOf } = await import('../src/lib/publishedUrl')
const { computeGapActions } = await import('../src/lib/gapActions')
const { analyzeCitationSources } = await import('../server/citationSources')
type Analyses = Parameters<typeof computeGapActions>[0]
type Questions = Parameters<typeof computeGapActions>[1]
type Posts = NonNullable<Parameters<typeof computeGapActions>[4]>

// 1) 비교 키 — 같은 글은 같은 키
const same = (a: string, b: string) => trackingKey(a) !== null && trackingKey(a) === trackingKey(b)
ok('OpenAI 추적 파라미터를 뗀다', same('https://example.com/post/7?utm_source=openai', 'https://example.com/post/7'))
ok('fbclid · gclid · 해시를 뗀다', same('https://example.com/post/7?fbclid=x&gclid=y#top', 'https://example.com/post/7'))
ok('www · m. · 끝 슬래시 · 대소문자', same('HTTPS://WWW.Example.com/Post/7/', 'https://m.example.com/post/7'))
ok('네이버 블로그 PostView → /아이디/글번호', same('https://blog.naver.com/PostView.naver?blogId=fakeblog&logNo=2233&trackingCode=rss', 'https://m.blog.naver.com/fakeblog/2233'))
ok('네이버 블로그 PostView.nhn도', same('https://blog.naver.com/PostView.nhn?blogId=fakeblog&logNo=2233', 'https://blog.naver.com/fakeblog/2233?fromRss=true'))
ok('티스토리 모바일 /m/N → /N', same('https://fake.tistory.com/m/12', 'https://fake.tistory.com/12'))
ok('퍼센트 인코딩된 한글 경로', same('https://example.com/%EA%B0%80%EC%83%81', 'https://example.com/가상'))
ok('남은 질의는 키 순으로', same('https://example.com/view?b=2&a=1', 'https://example.com/view?a=1&b=2'))
ok('http(s)가 아니면 null', trackingKey('ftp://example.com/a') === null && trackingKey('그냥 글자') === null)
// 질의가 글을 가리키지 않는 플랫폼 — 그대로 적으면 인용과 하나도 맞지 않았다(검토 실측: 티스토리 8,311건 중 0건)
ok('티스토리 ?category=는 같은 글', same('https://fake.tistory.com/12?category=998877', 'https://fake.tistory.com/12'))
ok('티스토리 모바일 /m/entry/글제목 → /entry/글제목', same('https://fake.tistory.com/m/entry/가상-글', 'https://fake.tistory.com/entry/가상-글'))
ok('네이버 블로그 /아이디?Redirect=Log&logNo=N → /아이디/N', same('https://blog.naver.com/fakeblog?Redirect=Log&logNo=2233', 'https://blog.naver.com/fakeblog/2233'))
ok('인스타그램 「링크 복사」 ?igsh= · ?hl=는 같은 글', same('https://www.instagram.com/p/FAKE01/?igsh=abc', 'https://instagram.com/p/FAKE01/?hl=ko'))
ok('유튜브 youtu.be · shorts · watch?v=&pp=&t=는 같은 영상', same('https://youtu.be/AbCdEfGhIjK?si=Zz9', 'https://www.youtube.com/watch?v=AbCdEfGhIjK&pp=x&t=30') && same('https://m.youtube.com/shorts/AbCdEfGhIjK', 'https://www.youtube.com/watch?v=AbCdEfGhIjK'))
ok('유튜브 영상 id는 대소문자를 가린다', trackingKey('https://youtu.be/AbCdEfGhIjK') !== trackingKey('https://youtu.be/abcdefghijk'))
ok('si는 유튜브 밖에서는 떼지 않는다(지역 코드 등 뜻이 있는 값)', !same('https://example.or.kr/page?si=11', 'https://example.or.kr/page'))

// 2) 경계 — 다른 글은 섞지 않는다
const k = (u: string) => trackingKey(u)!
ok('/1과 /12는 다른 글', matchKind(k('https://fake.tistory.com/1'), k('https://fake.tistory.com/12')) === null)
ok('?no=1과 ?no=12는 다른 글', matchKind(k('https://example.com/view?no=1'), k('https://example.com/view?no=12')) === null)
ok('/1/comments는 /1이 아니다', matchKind(k('https://example.com/post/1'), k('https://example.com/post/1/comments')) === null)
ok('질의만 붙은 인용은 query-variant(숫자에 넣지 않는다)', matchKind(k('https://namu.wiki/w/가상'), k('https://namu.wiki/w/가상?uuid=abc')) === 'query-variant')
ok('같은 글은 exact', matchKind(k('https://example.com/post/1'), k('https://example.com/post/1?utm_source=openai')) === 'exact')
// 반대 방향(올린 쪽에만 질의)은 힌트로 보지 않는다 — 게시판 글(…?idx=47)마다 질의 없는 목록 · 첫 화면 인용이 같은 숫자로
// 붙었다(2차 검토 실측: 힌트 약 3배, 그 쌍의 82%가 다른 페이지).
ok('올린 쪽에만 질의가 있으면 질의만 다른 주소로 보지 않는다', matchKind(k('https://example.com/board/view?idx=47'), k('https://example.com/board/view')) === null)
ok('네이버 블로그 GoPost · PostList 끝점 → /아이디/글번호', same('https://blog.naver.com/GoPost.naver?blogId=fakeblog&logNo=2233', 'https://blog.naver.com/fakeblog/2233') && same('https://blog.naver.com/PostList.naver?blogId=fakeblog&from=postList&categoryNo=5&logNo=2233', 'https://blog.naver.com/fakeblog/2233'))
ok('인스타그램 /reel/ · /p/ · /계정/p/ 는 같은 게시물', same('https://www.instagram.com/reel/FAKE01/', 'https://www.instagram.com/p/FAKE01/') && same('https://www.instagram.com/fakeacct/p/FAKE01/', 'https://instagram.com/p/FAKE01/?igsh=x'))
ok('인스타그램 게시물 코드는 대소문자를 가린다', trackingKey('https://www.instagram.com/p/FAKE01/') !== trackingKey('https://www.instagram.com/p/fake01/'))

// 3) 받지 않는 주소
const reason = (u: string) => {
  const r = isArticleUrl(u)
  return r.ok ? 'ok' : r.reason
}
ok('첫 화면은 거절', reason('https://example.com/') === 'homepage' && reason('https://www.example.com') === 'homepage')
ok('블로그 홈 · 유튜브 채널 홈은 거절', reason('https://blog.naver.com/fakeblog') === 'blog-home' && reason('https://brunch.co.kr/@fake') === 'blog-home' && reason('https://www.youtube.com/@fake') === 'blog-home')
ok('유튜브 채널의 다른 주소 형태 · 인스타그램 프로필도 거절', ['https://www.youtube.com/@fake/videos', 'https://www.youtube.com/channel/UCfake123', 'https://www.youtube.com/c/fake', 'https://www.youtube.com/user/fake', 'https://www.youtube.com/fakechannel', 'https://www.instagram.com/fakeacct/'].every((u) => reason(u) === 'blog-home'))
ok('유튜브 재생목록 · 인스타그램 게시물은 받는다', reason('https://www.youtube.com/playlist?list=PLfake') === 'ok' && reason('https://www.instagram.com/reel/FAKE01/') === 'ok')
ok('네이버 블로그 ?logNo= 글 주소 · 유튜브 공유 주소는 받는다', reason('https://blog.naver.com/fakeblog?Redirect=Log&logNo=2233') === 'ok' && reason('https://youtu.be/AbCdEfGhIjK') === 'ok')
ok('단축 주소는 거절', reason('https://naver.me/abc') === 'short-link')
ok('글 주소는 받는다', reason('https://blog.naver.com/fakeblog/2233') === 'ok' && reason('https://fake.tistory.com/12') === 'ok' && reason('https://example.com/?p=12') === 'ok')

// 4) 한 주 인용 집계 — 응답 단위, 은행을 못 읽으면 확인 불가
const response = (questionId: string, callIndex: number, mentioned: boolean, cites: [string, boolean][], startedAt?: string) => ({
  questionId,
  engine: 'gemini',
  callIndex,
  mentioned,
  mentionSentences: [],
  competitorMentions: [],
  shareOfMention: 0,
  topRecommendation: null,
  brandRank: null,
  factualityClaims: [],
  factualitySupported: 0,
  factualityContradicted: 0,
  brandOwnedCitation: false,
  clarifying: false,
  citations: cites.map(([raw, supportsBrandMention]) => ({ raw, domain: null, ownerType: 'third-party-ugc', supportsBrandMention })),
  ...(startedAt ? { timing: { startedAt } } : {}),
})
const week = [
  // 한 응답에 같은 글이 두 번 — 한 번만 센다
  response('v9-001', 0, false, [['https://fake.tistory.com/1', false], ['https://fake.tistory.com/1?utm_source=openai', true]], '2026-10-14T01:00:00Z'),
  response('v9-001', 1, true, [['https://fake.tistory.com/1', true]], '2026-10-14T02:00:00Z'),
  response('v9-002', 0, true, [['https://fake.tistory.com/1', false], ['https://fake.tistory.com/12', true]], '2026-10-15T03:00:00Z'),
]
const named = new Map([['v9-001', false], ['v9-002', true]])
const t = indexWeekCitations(week, named).get('fake.tistory.com/1')
ok('응답 단위로 센다(한 응답 안 중복은 1회)', t?.all.cited === 3 && t.all.supporting === 2)
ok('이름 없는/이름 댄 질문을 가른다', t?.unnamed?.cited === 2 && t.unnamed.supporting === 2 && t.named?.cited === 1 && t.named.supporting === 0)
ok('답변에 우리 이름이 나온 응답은 보조로 센다', t?.all.mentioned === 2)
const unknownBank = indexWeekCitations(week, null).get('fake.tistory.com/1')
ok('은행을 못 읽으면 이름 없는/이름 댄 질문은 null(0이 아니다)', unknownBank?.unnamed === null && unknownBank.named === null && unknownBank.all.cited === 3)

// 5) 올린 날과 측정 시점
const win = measuredWindow(week)
ok('측정 날짜 범위(한국 날짜)', win?.first === '2026-10-14' && win.last === '2026-10-15')
ok('측정 전에 올렸으면 after', timingOf('2026-10-13', win, '2026-W42') === 'after')
ok('측정 뒤에 올렸으면 before', timingOf('2026-10-16', win, '2026-W42') === 'before')
ok('측정하던 날 올렸으면 during', timingOf('2026-10-14', win, '2026-W42') === 'during')
ok('측정 시각이 없으면 주차로 — 같은 주면 ambiguous', timingOf('2026-10-14', null, '2026-W42') === 'ambiguous' && timingOf('2026-10-05', null, '2026-W42') === 'after')
ok('올린 날을 모르면 unknown', timingOf(null, win, '2026-W42') === 'unknown')
ok('ISO 주차(연말 경계)', isoWeekOf('2026-10-19') === '2026-W43' && isoWeekOf('2027-01-01') === '2026-W53')

// 6) 실행 항목에 붙는 결과
const questions = [
  { questionId: 'v9-001', text: '군산 숙소 추천', category: 'category-agnostic', containsBrandName: false },
  { questionId: 'v9-002', text: '가상펜션 어때?', category: 'brand-direct', containsBrandName: true },
] as unknown as Questions
const post = (id: string, url: string, target: string, publishedOn: string | null, extra: object = {}) => ({
  id,
  url,
  key: trackingKey(url)!,
  publishedOn,
  publishedOnSource: 'user' as const,
  recordedAt: '2026-10-10T00:00:00Z',
  articleId: target,
  targetActionId: target,
  via: 'own' as const,
  ...extra,
})
// 인용 출처 집계로 등재형 항목(티스토리 플랫폼)이 생긴다 — 기록은 그 항목에 붙인다.
const citations = analyzeCitationSources(week as never)
const plan = (posts: Posts) => computeGapActions(week as unknown as Analyses, questions, citations, {}, posts, '2026-W42')
const target = plan([]).actions.find((a) => a.kind === 'listing')?.id ?? 'listing:none'
ok('검사용 등재형 항목이 생긴다', target !== 'listing:none')
const p12only = plan([post('p1', 'https://fake.tistory.com/77', target, '2026-10-01')])
const action = p12only.actions.find((a) => a.id === target)
ok('상태가 없어도 기록이 항목에 붙는다', action?.publishedUrls.length === 1 && action.publishedHits?.length === 1)
ok('인용되지 않은 글은 citedPublishedUrls에 없다', action?.citedPublishedUrls.length === 0 && action.publishedHits?.[0]?.tally === null)
const slashOne = plan([post('p1', 'https://fake.tistory.com/12/', target, '2026-10-01')]).actions.find((a) => a.id === target)
ok('…/12를 올렸으면 …/12만 맞는다(…/1 인용을 끌어오지 않는다)', slashOne?.publishedHits?.[0]?.tally?.all.cited === 1)
const before = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-16')]).actions.find((a) => a.id === target)
ok('올리기 전에 한 측정은 인용으로 세지 않는다', before?.publishedHits?.[0]?.timing === 'before' && before.citedPublishedUrls.length === 0)
const after = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-01')]).actions.find((a) => a.id === target)
ok('올린 뒤 측정의 정확 일치 인용은 센다', after?.citedPublishedUrls.length === 1 && after.publishedHits?.[0]?.tally?.unnamed?.cited === 2)
const removed = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-01', { removedAt: '2026-10-19T03:00:00Z', removedReason: 'mistake' })]).actions.find((a) => a.id === target)
ok('「잘못 적은 주소」는 어느 주에서도 붙지 않는다', (removed?.publishedUrls.length ?? 0) === 0)
const takenAfter = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-01', { removedAt: '2026-10-19T03:00:00Z', removedReason: 'taken-down' })]).actions.find((a) => a.id === target)
ok('「글을 내렸어요」는 내리기 전 측정에서는 남고 인용을 센다', takenAfter?.publishedHits?.[0]?.takenDownOn === '2026-10-19' && takenAfter.citedPublishedUrls.length === 1)
const takenBefore = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-01', { removedAt: '2026-10-13T03:00:00Z', removedReason: 'taken-down' })]).actions.find((a) => a.id === target)
ok('내린 뒤에 한 측정에서는 붙지 않는다', (takenBefore?.publishedUrls.length ?? 0) === 0)
const takenNeverUp = plan([post('p1', 'https://fake.tistory.com/1', target, '2026-10-16', { removedAt: '2026-10-19T03:00:00Z', removedReason: 'taken-down' })]).actions.find((a) => a.id === target)
ok('올리기도 전에 한 측정에서는 내린 글을 「올라가 있던 때」로 붙이지 않는다', (takenNeverUp?.publishedUrls.length ?? 0) === 0)
// 한 응답이 질의만 다른 주소 둘을 인용해도 한 번이다
const variantWeek = [response('v9-001', 0, false, [['https://example.com/post/5?page=1', false], ['https://example.com/post/5?page=2', false], ['https://fake.tistory.com/1', false]], '2026-10-14T01:00:00Z')]
const variantPlan = computeGapActions(variantWeek as unknown as Analyses, questions, analyzeCitationSources(variantWeek as never), {}, [post('pv', 'https://example.com/post/5', 'listing:any', '2026-10-01')], '2026-W42')
const variantTarget = variantPlan.actions.find((a) => a.kind === 'listing')?.id ?? ''
const variantHit = computeGapActions(variantWeek as unknown as Analyses, questions, analyzeCitationSources(variantWeek as never), {}, [post('pv', 'https://example.com/post/5', variantTarget, '2026-10-01')], '2026-W42').actions.flatMap((a) => a.publishedHits ?? [])[0]
ok('질의만 다른 주소는 응답 단위로 센다(한 응답 · 변형 둘 = 1)', variantHit?.variantCited === 1 && variantHit.tally === null)
const noBank = computeGapActions(week as unknown as Analyses, [], citations, {}, [post('p1', 'https://fake.tistory.com/1', target, '2026-10-01')], '2026-W42')
const noBankHit = noBank.actions.flatMap((a) => a.publishedHits ?? [])[0]
ok('은행을 못 읽은 주는 이름 없는 질문 수가 null(인용 수는 남는다)', noBankHit?.tally?.unnamed === null && noBankHit.tally.all.cited === 3)

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
