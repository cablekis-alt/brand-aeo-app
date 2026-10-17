/**
 * 공식 출처 링크(src/lib/officialSources.ts)가 블로그 글 형식 초안의 맞는 절에만 붙는지 확인한다. 가짜 초안만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 링크는 사실 가드를 거치지 않고 발행본에 들어간다. 그래서 사람이 확인한 고정 목록의 https 주소만, 주제가 맞는 절에만,
 * 절마다 2개 · 글 전체에서 한 번씩만 붙어야 한다. 옛 형식 초안에는 붙지 않아야 한다(내보내기가 한 글자도 바뀌지 않게).
 *
 *   npx tsx scripts/verify-official-sources.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-official-sources-'))
process.env.APP_DATA_DIR = dir

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

try {
  const { articleSources, OFFICIAL_SOURCES, sourcesLine } = await import('../src/lib/officialSources')
  const md = await import('../src/lib/markdownFile')
  const { markdownToHtml } = await import('../src/lib/htmlFile')
  const { editedLinePlain } = await import('../server/contentDraft')

  // 1) 목록 — 확인한 공식 주소만
  const OFFICIAL_HOSTS = new Set(['developers.google.com', 'support.google.com', 'developers.openai.com', 'docs.perplexity.ai'])
  ok('주소는 모두 https · 공식 문서 도메인', OFFICIAL_SOURCES.every((s) => s.url.startsWith('https://') && OFFICIAL_HOSTS.has(new URL(s.url).hostname)))
  ok('id는 겹치지 않는다', new Set(OFFICIAL_SOURCES.map((s) => s.id)).size === OFFICIAL_SOURCES.length)
  ok('확인한 날이 적혀 있다', OFFICIAL_SOURCES.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.checkedAt)))
  ok('label에 숫자가 없다(고친 글 사실 확인에 걸리지 않게)', OFFICIAL_SOURCES.every((s) => !/\d/.test(s.label)))
  ok('label에 링크 문법을 깨는 글자가 없다', OFFICIAL_SOURCES.every((s) => !/[[\]*`]/.test(s.label)))

  // 2) 절마다 고르기
  const text = (body: string, role?: 'key' | 'action') => ({ kind: 'text' as const, body, ...(role ? { role } : {}) })
  const draft = {
    title: 'AI 검색에 노출되려면 확인할 {N}가지',
    lead: '사이트가 AI 검색에 잡히려면 크롤러가 읽을 수 있어야 합니다.',
    format: 'article' as const,
    sections: [
      {
        heading: 'robots.txt에서 무엇을 열어야 하나요?',
        answers: 'q1',
        blocks: [text('OAI-SearchBot과 GPTBot을 막지 않았는지 먼저 보세요.', 'key'), text('Search Console에서 차단 여부도 함께 확인하세요.')],
      },
      {
        heading: '색인이 됐는지는 어떻게 아나요?',
        answers: 'q2',
        blocks: [text('URL 검사로 색인 상태를 봅니다.', 'key'), text('robots.txt를 고친 뒤에는 다시 확인하세요.')],
      },
      { heading: '사이트맵은 꼭 있어야 하나요?', answers: 'q3', blocks: [{ kind: 'gap' as const, need: '사이트 규모 — 팩트 그래프에 없음' }] },
      {
        heading: '구조화 데이터는 무엇부터 넣나요?',
        answers: 'q4',
        blocks: [text('JSON-LD로 회사 정보를 적습니다.', 'key'), text('사이트맵도 함께 제출하면 좋습니다.')],
      },
      { heading: '글은 얼마나 자주 올리나요?', answers: 'q5', blocks: [text('꾸준히 올리는 것이 중요합니다.', 'key')] },
    ],
    gapCount: 1,
    usedFacts: [],
  }
  const picked = articleSources(draft).map((xs) => xs.map((s) => s.id))
  ok('절마다 2개까지 — 목록 순서대로', JSON.stringify(picked[0]) === JSON.stringify(['google-robots', 'openai-bots']))
  ok('같은 출처는 글 전체에서 한 번 — 다음 절에는 남은 주제만', JSON.stringify(picked[1]) === JSON.stringify(['google-url-inspection']))
  ok('빈칸만 있는 절에는 붙이지 않는다(그 주제는 뒤 절로)', picked[2]!.length === 0 && picked[3]!.includes('google-sitemaps'))
  ok('주제가 둘이면 둘 다(구조화 데이터 · 사이트맵)', JSON.stringify(picked[3]) === JSON.stringify(['google-structured-data', 'google-sitemaps']))
  ok('주제가 없는 절에는 없다', picked[4]!.length === 0)
  ok('옛 형식 초안에는 붙지 않는다', articleSources({ ...draft, format: undefined }).every((xs) => xs.length === 0))

  // 3) 내보내기
  const pub = md.draftToPublishMarkdown(draft)
  const line0 = sourcesLine(OFFICIAL_SOURCES.filter((s) => ['google-robots', 'openai-bots'].includes(s.id)))
  ok('발행본 — 절 끝 「참고:」 줄', pub.includes(`\n${line0}\n`) && line0.startsWith('참고: [Google 검색 센터 — robots.txt 소개](https://developers.google.com/'))
  ok('발행본 — 출처마다 한 번', OFFICIAL_SOURCES.every((s) => pub.split(s.url).length - 1 <= 1))
  ok('발행본 — 참고 줄은 그 절 안(다음 절 제목 앞)', pub.indexOf(line0) < pub.indexOf('## 2. 색인이 됐는지는'))
  const work = md.draftToMarkdown(draft)
  ok('작업용에도 같은 자리에 붙는다', work.includes(`\n${line0}\n`) && work.indexOf(line0) < work.indexOf('## 2. 색인이 됐는지는'))
  const html = markdownToHtml(pub)
  ok('HTML — 링크로 바뀐다', html.includes('<a href="https://developers.google.com/search/docs/crawling-indexing/robots/intro" rel="noopener">Google 검색 센터 — robots.txt 소개</a>') && html.includes('<a href="https://developers.openai.com/api/docs/bots" rel="noopener">OpenAI — 크롤러 안내(OAI-SearchBot · GPTBot)</a>'))
  ok('고친 글 사실 확인 — 참고 줄에 숫자가 남지 않는다', !/\d/.test(editedLinePlain(line0)))

  // 4) 옛 형식 내보내기는 그대로
  const fixture = {
    title: 'T',
    lead: 'L',
    sections: [{ heading: 'robots.txt', answers: 'a', blocks: [{ kind: 'text' as const, body: 'OAI-SearchBot을 여세요.' }] }],
    gapCount: 0,
    usedFacts: [],
  }
  ok('옛 형식 — 주제가 맞아도 링크를 붙이지 않는다', md.draftToPublishMarkdown(fixture) === '# T\n\nL\n\n## robots.txt\n\nOAI-SearchBot을 여세요.\n')
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
