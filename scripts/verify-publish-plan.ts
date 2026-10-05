/**
 * 콘텐츠 생성 「② 올리기 목록」 계산(src/lib/publishPlan.ts)을 확인한다. AI는 부르지 않는다.
 *
 * 왜: 예전 화면은 같은 채널을 글 카드의 채널 탭과 「채널별 올림 현황」 두 곳에 보여 서로 다른 일로 읽혔다.
 * 한 목록으로 합치면서 정한 규칙 — 채널은 한 줄(가장 많이 덮는 글에), 확인 전 글의 줄은 잠금, 할 수 있는
 * 줄이 위, 진행 수는 올린 줄이 덮는 질문(중복 없이) — 이 깨지면 같은 채널을 두 번 올리거나 순서가 뒤집힌다.
 *
 *   npx tsx scripts/verify-publish-plan.ts
 */
import type { StoredDraft } from '../src/lib/api'
import type { GapAction } from '../src/lib/gapActions'
import { buildPublishPlan, openUrlOf, pregenerateTargets, verbOf } from '../src/lib/publishPlan'

function action(id: string, kind: GapAction['kind'], questionIds: string[], extra: Partial<GapAction> = {}): GapAction {
  return {
    id,
    kind,
    title: id,
    badge: kind === 'content' ? '콘텐츠' : '블로그 플랫폼',
    evidence: '',
    questionIds,
    questionTexts: questionIds,
    reach: questionIds.length,
    satisfied: false,
    status: 'todo',
    publishedUrls: [],
    citedPublishedUrls: [],
    doneSignal: '',
    ...extra,
  }
}

function draft(actionId: string, gaps: number, fills: number): StoredDraft {
  const blocks = Array.from({ length: gaps }, () => ({ kind: 'gap' as const, need: '비용 — 사실 없음' }))
  return {
    actionId,
    generatedAt: '2026-10-05T00:00:00Z',
    draft: {
      title: actionId,
      lead: '',
      sections: [{ heading: 'h', blocks: [{ kind: 'text', body: 'b' }, ...blocks] } as never],
      gapCount: gaps,
      usedFacts: [],
    },
    gapFills: Object.fromEntries(Array.from({ length: fills }, (_, i) => [`0:${i + 1}`, { value: 'x' }])),
  }
}

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// 글 두 편: 글1(q1~q6) 확인됨, 글2(q7~q8) 빈칸 2곳 중 1곳만 처리.
const c1 = action('content:a', 'content', ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'])
const c2 = action('content:b', 'content', ['q7', 'q8'])
const naver = action('listing:platform:blog.naver.com', 'listing', ['q1', 'q2', 'q3', 'q7'], {
  title: '네이버 블로그 발행',
  targetDomain: 'blog.naver.com',
  publishedUrls: ['https://blog.naver.com/x/1'],
})
// 글1과 1개, 글2와 2개 겹친다 → 글2에 붙는다.
const tistory = action('listing:platform:tistory.com', 'listing', ['q4', 'q7', 'q8'], { title: '티스토리 발행', targetDomain: 'tistory.com' })
const wiki = action('listing:namu.wiki', 'listing', ['q5'], { title: 'namu.wiki 문서 보완', badge: '위키', targetDomain: 'namu.wiki' })
const triple = action('listing:triple.guide', 'listing', ['q6'], { title: 'triple.guide 등재', badge: '후기·예약 플랫폼', targetDomain: 'triple.guide' })
const news = action('listing:__news__', 'listing', ['q2'], { title: '언론 3곳 보도·기고', badge: '언론' })
// 어떤 글과도 겹치지 않는 채널 → 따로 쓴 초안이 올릴 글.
const orphan = action('listing:cafe.daum.net', 'listing', ['q9'], { title: 'cafe.daum.net 커뮤니티 노출', badge: '커뮤니티', targetDomain: 'cafe.daum.net' })

const drafts = { [c1.id]: draft(c1.id, 1, 1), [c2.id]: draft(c2.id, 2, 1), [orphan.id]: draft(orphan.id, 0, 0) }
const plan = buildPublishPlan([c1, c2], [naver, tistory, wiki, triple, news, orphan], drafts)
const row = (key: string) => plan.rows.find((r) => r.key === key)!

ok('줄 수 = 자사 사이트 2 + 채널 6', plan.rows.length === 8)
ok('채널은 한 줄씩(같은 채널 두 줄 없음)', new Set(plan.rows.map((r) => r.key)).size === plan.rows.length)
ok('글 = 콘텐츠 2 + 따로 쓸 채널 1', plan.articles.length === 3 && plan.articles[2]!.action.id === orphan.id)
ok('네이버 블로그는 글1에(3개 겹침 > 1개)', row(naver.id).article.action.id === c1.id && row(naver.id).questionIds.length === 3)
ok('티스토리는 글2에(2개 겹침 > 1개)', row(tistory.id).article.action.id === c2.id)
ok('카페는 orphan · 다듬기 없음', row(orphan.id).kind === 'orphan' && !row(orphan.id).needsAdapt)
ok('채널 줄은 다듬기 필요', row(naver.id).needsAdapt && !row(`own:${c1.id}`).needsAdapt)
ok('글1 확인됨 → 줄 열림', !row(`own:${c1.id}`).locked && !row(naver.id).locked)
ok('글2 빈칸 남음 → 줄 잠김', row(`own:${c2.id}`).locked && row(tistory.id).locked)
ok('빈칸 0인 따로 쓴 글 → 열림', !row(orphan.id).locked)
ok('잠긴 줄은 모두 열린 줄 아래', plan.rows.findIndex((r) => r.locked) > plan.rows.map((r) => r.locked).lastIndexOf(false))
const unlocked = plan.rows.filter((r) => !r.locked).map((r) => r.questionIds.length)
ok('열린 줄은 덮는 질문 많은 순', unlocked.every((n, i) => i === 0 || unlocked[i - 1]! >= n))
ok('맨 위는 글1 자사 사이트(6개)', plan.rows[0]!.key === `own:${c1.id}`)
ok('올린 줄 1(네이버 주소 기록)', plan.done === 1 && row(naver.id).done)
ok('덮은 질문 = 네이버가 덮는 3개', plan.coveredQuestions === 3)
ok('전체 질문 = q1~q9', plan.totalQuestions === 9)

ok('버튼: 자사 사이트는 복사', row(`own:${c1.id}`).verb === 'copy' && row(`own:${c1.id}`).openUrl === null)
ok('버튼: 블로그는 글쓰기 열기', verbOf(naver) === 'write')
ok('버튼: 위키는 문서 열기', verbOf(wiki) === 'doc')
ok('버튼: 후기·예약은 등록 페이지', verbOf(triple) === 'place')
ok('버튼: 언론 묶음(도메인 없음)은 복사만', verbOf(news) === 'copy' && row(news.id).openUrl === null)
ok('주소: 네이버 블로그는 글쓰기 화면', openUrlOf('blog.naver.com') === 'https://blog.naver.com/GoBlogWrite.naver')
ok('주소: 그 밖은 첫 화면', openUrlOf('namu.wiki') === 'https://namu.wiki')

// 미리 다듬기: 확인된 글의, 아직 안 올린 외부 채널 위쪽 2곳.
const pre = pregenerateTargets(plan).map((r) => r.key)
ok('미리 다듬기 = 열린 · 안 올린 채널 2곳', pre.length === 2 && pre.every((k) => [wiki.id, triple.id, news.id].includes(k)))
ok('미리 다듬기에 올린 채널 · 잠긴 채널 · 따로 쓴 글 없음', !pre.includes(naver.id) && !pre.includes(tistory.id) && !pre.includes(orphan.id))

// 초안이 없으면 확인 전(잠금), 웹(초안 라우트 없음)도 같다.
const noDraft = buildPublishPlan([c1], [naver], null)
ok('초안 없음 → 잠금', noDraft.rows.every((r) => r.locked) && !noDraft.articles[0]!.confirmed)

// 고친 글은 남은 빈칸 표시 줄로 센다.
const edited = { ...draft(c1.id, 1, 0), editedMarkdown: '# t\n\n본문' }
ok('고친 글에 빈칸 표시 없음 → 확인됨', buildPublishPlan([c1], [], { [c1.id]: edited }).articles[0]!.confirmed)

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
