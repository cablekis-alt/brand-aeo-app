/**
 * 글의 실측 사례(src/lib/answerEvidence.ts · server/articleEvidence.ts · server/contentDraft.ts saveEvidence)를 확인한다.
 * 가짜 브랜드 · 가짜 응답만 쓰고 임시 폴더를 APP_DATA_DIR로 쓴다. AI는 부르지 않는다(글쓰기는 가짜 EngineClient).
 *
 * 왜: AI 답변을 글에 옮기는 일은 한 글자도 틀리면 안 되고, 판정 모델의 「언급」에는 틀린 것이 섞인다. 되물음 ·
 * 원문에 없는 문장 · 이름 없는 「언급」 · 조건부 지목 · 「틀림」 판정 · 경쟁사 이름 · 숫자가 든 문장은 고르지 않아야 하고,
 * 사람이 확인하기 전에는 발행본에 들어가지 않아야 한다. 「스크린샷」 · 「순위」 같은 말도 쓰지 않는다.
 *
 *   npx tsx scripts/verify-answer-evidence.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-answer-evidence-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

try {
  const ev = await import('../src/lib/answerEvidence')
  const { publishArticleOf } = await import('../src/lib/publishArticle')
  const { publishMarkdownOf } = await import('../src/lib/draftGaps')
  const { markdownToHtml } = await import('../src/lib/htmlFile')
  const { sourceKeyOf } = await import('../src/prompts/b9d-channel-adapt')

  const q = (id: string, text: string, named = false) => ({
    questionId: id, text, category: named ? 'brand-direct' : 'category-agnostic', industry: '관광안내', region: '가상시', containsBrandName: named, version: 'v3',
  }) as const
  const questions = [
    q('v3-001', '가상시 여행 정보를 한곳에서 볼 수 있는 사이트 알려줘'),
    q('v3-002', '가상시 맛집 코스 추천해줘'),
    q('v3-003', '가상 여행은 어떤 사이트야?', true),
  ]
  const A = (o: Partial<Record<string, unknown>> & { questionId: string; engine: string; sentences?: string[] }) => ({
    questionId: o.questionId,
    engine: o.engine,
    callIndex: 1,
    mentioned: o.mentioned ?? true,
    mentionSentences: (o.sentences ?? []).map((s) => ({ sentence: s, sentiment: 'positive' })),
    competitorMentions: [],
    shareOfMention: 1,
    citations: [],
    topRecommendation: (o.topRecommendation as string | null) ?? null,
    brandRank: 1,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: (o.factualityContradicted as number) ?? 0,
    brandOwnedCitation: false,
    ...(o.clarifying ? { clarifying: true } : {}),
  })
  const R = (questionId: string, engine: string, rawText: string, extra: Record<string, unknown> = {}) => ({
    engine, questionId, callIndex: 1, rawText, usedWebSearch: true, calledAt: '2026-10-14T16:30:00.000Z', ...extra,
  })
  const base = {
    weekOf: '2026-W42',
    questionIds: ['v3-001', 'v3-002', 'v3-003'],
    questions: [...questions],
    brandName: '가상 여행',
    aliases: ['가상여행'],
    competitorNames: ['가상 관광공사'],
    card: { enginesUsed: ['openai', 'perplexity'], modelsUsed: { openai: 'gpt-6-luna', perplexity: 'preset:low' }, judgeEngine: 'claude', judgeModel: 'claude-sonnet-5-5', repeatsPerQuestion: 1, questionBankVersion: 'v3' },
    sameConditionWeeks: 1,
    industry: '관광안내',
    builtAt: '2026-10-18T00:00:00.000Z',
  }

  // 1) 고르는 규칙
  const good = '**가상 여행**은 가상시 관광지와 맛집을 함께 정리한 정보 사이트입니다.'
  const built = ev.buildAnswerEvidence({
    ...base,
    analyses: [
      A({ questionId: 'v3-001', engine: 'openai', sentences: [good] }),
      A({ questionId: 'v3-001', engine: 'perplexity', sentences: ['가상 여행을 말씀하시는 것이라면 가상시 공식 관광 사이트를 보세요.'] }),
      A({ questionId: 'v3-002', engine: 'perplexity', sentences: ['코스를 고를 때는 가상여행 사이트의 지도를 참고하세요.'] }),
      A({ questionId: 'v3-002', engine: 'openai', sentences: ['가상 여행도 좋은 선택입니다.'] }),
    ],
    raw: [
      R('v3-001', 'openai', `가상시를 여행한다면 ${good} 길 안내도 있습니다.`, { model: 'gpt-6-luna' }),
      R('v3-001', 'perplexity', '가상 여행을 말씀하시는 것이라면 가상시 공식 관광 사이트를 보세요.', { model: 'preset:low' }),
      R('v3-002', 'perplexity', '코스를 고를 때는 가상여행 사이트의 지도를 참고하세요.', { model: 'preset:low', usedWebSearch: false }),
      R('v3-002', 'openai', '가상 여행도 좋은 선택입니다.'),
    ],
  })
  ok('엔진마다 하나, 최대 둘', built.items.length === 2 && new Set(built.items.map((i) => i.engine)).size === 2)
  ok('조건부 지목은 고르지 않는다', !built.items.some((i) => i.excerpt.includes('말씀하시는')))
  ok('발췌는 원문 그대로(서식만 걷음)', built.items[0]?.excerpt === '가상 여행은 가상시 관광지와 맛집을 함께 정리한 정보 사이트입니다.')
  ok('별칭으로 나온 이름도 이름이다', built.items.some((i) => i.engine === 'perplexity' && i.excerpt.startsWith('코스를 고를 때는 가상여행')))
  ok('한국 날짜(UTC 16:30 → 다음 날)', built.items[0]?.measuredDate === '2026-10-15' && ev.kstDate('2026-10-14T14:59:59Z') === '2026-10-14')
  ok('라벨 — 모델 · 웹 검색은 호출마다', ev.evidenceLabel(built.items[0]!) === 'ChatGPT(API · gpt-6-luna · 웹 검색) 응답 · 2026-10-15 측정')
  ok('라벨 — Perplexity 프리셋 · 웹 검색 없음', ev.evidenceLabel(built.items[1]!) === 'Perplexity(API · 프리셋 low · 웹 검색 없음) 응답 · 2026-10-15 측정')
  ok('같은 엔진의 다른 질문은 고르지 않는다(엔진당 하나)', built.items.filter((i) => i.engine === 'openai').length === 1)
  ok('답변 수 · 이름 나온 수', built.answered.asked === 4 && built.answered.mentioned === 4)
  ok('비교 질문은 이름 없는 질문 먼저', built.compareQuestions[0] === questions[0]!.text && built.compareQuestions.at(-1) === questions[2]!.text)
  ok('측정 조건', built.conditions.collect === 'ChatGPT (gpt-6-luna) · Perplexity (preset:low)' && built.conditions.repeats === '질문당 1회')
  ok('확인 전이고 넣기는 켜짐', built.include === true && built.confirmedAt === undefined)

  const reject = (label: string, analyses: ReturnType<typeof A>[], raw: ReturnType<typeof R>[]) =>
    ok(label, ev.buildAnswerEvidence({ ...base, analyses, raw }).items.length === 0)
  reject('되물은 응답은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: [good], clarifying: true })], [R('v3-001', 'openai', good)])
  reject('가짜 엔진(mock)은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'mock', sentences: [good] })], [R('v3-001', 'mock', good)])
  reject('원문에 없는 문장은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: [good] })], [R('v3-001', 'openai', '전혀 다른 답변입니다.')])
  reject('이름이 없는 「언급」은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['여행 정보를 모은 사이트입니다.'] })], [R('v3-001', 'openai', '여행 정보를 모은 사이트입니다.')])
  reject('「틀림」 판정이 있는 답은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: [good], factualityContradicted: 1 })], [R('v3-001', 'openai', good)])
  reject('경쟁사 이름이 든 문장은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['가상 여행과 가상 관광공사를 함께 보세요.'] })], [R('v3-001', 'openai', '가상 여행과 가상 관광공사를 함께 보세요.')])
  reject('1순위가 다른 곳이면 그 이름이 든 문장도', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['가상 여행보다 다른곳닷컴이 자세합니다.'], topRecommendation: '다른곳닷컴' })], [R('v3-001', 'openai', '가상 여행보다 다른곳닷컴이 자세합니다.')])
  reject('숫자가 든 문장은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['가상 여행은 코스 열두 곳을 소개합니다. 가상 여행 입장료는 5천원입니다.'.split('. ')[1]!] })], [R('v3-001', 'openai', '가상 여행 입장료는 5천원입니다.')])
  reject('이 글의 질문이 아니면 고르지 않는다', [A({ questionId: 'v3-099', engine: 'openai', sentences: [good] })], [R('v3-099', 'openai', good)])
  reject('목록 조각은 고르지 않는다(문장 끝이 없음)', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['가상 여행 기준 (예: 가상 여행 코스 등)'] })], [R('v3-001', 'openai', '- 가상 여행 기준 (예: 가상 여행 코스 등)')])
  reject('너무 짧은 조각은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['가상 여행입니다.'] })], [R('v3-001', 'openai', '가상 여행입니다.')])
  reject('표 줄은 고르지 않는다', [A({ questionId: 'v3-001', engine: 'openai', sentences: ['| 가상 여행 | 정보 사이트 |'] })], [R('v3-001', 'openai', '| 가상 여행 | 정보 사이트 |')])

  const none = ev.buildAnswerEvidence({ ...base, analyses: [A({ questionId: 'v3-001', engine: 'openai', mentioned: false })], raw: [] })
  ok('이름이 안 나왔으면 그렇게 적는다', none.items.length === 0 && (none.emptyReason ?? '').includes('1건에서 가상 여행 이름이 나오지 않았습니다'))
  ok('잰 기록이 없으면 그렇게 적는다', (ev.buildAnswerEvidence({ ...base, analyses: [], raw: [] }).emptyReason ?? '').includes('잰 기록이 없습니다'))
  ok('의료 업종은 넣기를 기본으로 끈다', ev.buildAnswerEvidence({ ...base, industry: '성형외과', analyses: [], raw: [] }).include === false)

  // 2) 발행본 — 확인 전 · 끔이면 없고, 확인하면 붙는다
  ok('확인 전에는 발행본에 없다', ev.renderEvidenceMarkdown(built) === '')
  const confirmed = { ...built, confirmedAt: '2026-10-18T01:00:00.000Z' }
  const md = ev.renderEvidenceMarkdown(confirmed)
  ok('확인하면 사례 · 확인 방법 · 비교 질문', md.startsWith('## 실제로 AI에 물어본 결과') && md.includes('### 이렇게 확인했습니다') && md.includes('## 같은 질문으로 비교해 보세요'))
  ok('라벨과 발췌 인용', md.includes('**ChatGPT(API · gpt-6-luna · 웹 검색) 응답 · 2026-10-15 측정**') && md.includes('> 가상 여행은 가상시 관광지와 맛집을 함께 정리한 정보 사이트입니다.'))
  ok('이름 넣어 물은 질문 표시는 그 질문에만', !md.includes('— 이름을 넣어 물은 질문'))
  ok('한 번 잰 결과라고 적는다', md.includes('한 번 물어본 결과입니다'))
  ok('여러 주 잰 경우', ev.renderEvidenceMarkdown({ ...confirmed, sameConditionWeeks: 3 }).includes('같은 질문 · 같은 엔진으로 3주 쟀습니다'))
  ok('앱 화면이 아니라 API 응답이라고 적는다', md.includes('앱 화면이 아니라 API로 받은 응답입니다'))
  ok('판정 모델 표기에 괄호가 겹치지 않는다', md.includes('판정 모델이 골랐고(Claude · claude-sonnet-5-5)'))
  ok('스크린샷 · 캡처 · 순위라는 말이 없다', !/스크린샷|캡처|screenshot|순위/i.test(md))
  ok('넣기를 끄면 없다', ev.renderEvidenceMarkdown({ ...confirmed, include: false }) === '')
  const html = markdownToHtml(md)
  ok('HTML로 바꿔도 인용 · 목록이 산다', html.includes('<blockquote><p>가상 여행은') && html.includes('<ul><li>이 글의 질문을'))

  // 3) 발행본에 붙이는 자리 — 본문 다음, 글 끝(공식 사이트) 앞. 본문 · 지문은 그대로
  const stored = {
    actionId: 'content:a',
    generatedAt: '2026-10-01T09:00:00.000Z',
    draft: { title: '가상 제목', lead: '가상 첫머리입니다.', sections: [{ heading: '가상 소제목', answers: 'v3-001', blocks: [{ kind: 'text' as const, body: '가상 본문입니다.' }] }], gapCount: 0, usedFacts: [] },
  }
  const brand = { tenantId: 'vtravel', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtravel.example'], industry: '관광안내', region: '가상시', engines: [], questionBankSize: 36, competitors: [] }
  const article = publishArticleOf({ ...stored, evidence: confirmed }, { brand })
  const iEvidence = article.indexOf('## 실제로 AI에 물어본 결과')
  const iSite = article.indexOf('[가상 여행 공식 사이트]')
  ok('사례는 본문 뒤, 공식 사이트 링크 앞', article.startsWith(publishMarkdownOf(stored).trimEnd()) && iEvidence > 0 && iSite > iEvidence)
  ok('사례를 붙여도 본문 · 지문은 그대로', publishMarkdownOf({ ...stored, evidence: confirmed }) === publishMarkdownOf(stored) && sourceKeyOf(publishMarkdownOf({ ...stored, evidence: confirmed })) === sourceKeyOf(publishMarkdownOf(stored)))
  ok('확인 전 사례는 발행본에 없다', publishArticleOf({ ...stored, evidence: built }, { brand }) === publishArticleOf(stored, { brand }))

  // 4) 저장 — 초안 기록에 붙이고, 다시 만들어도 남고, 쓰기가 서로 덮지 않는다
  const drafts = await import('../server/contentDraft')
  writeJson('data/vtravel/drafts.json', { 'content:a': stored })
  await Promise.all([
    drafts.saveEvidence('vtravel', 'content:a', () => built),
    drafts.saveGapFills('vtravel', 'content:a', { '0:0': { omit: true } }),
  ])
  const both = (await drafts.readDrafts('vtravel'))['content:a']
  ok('동시에 써도 둘 다 남는다(사례 · 빈칸)', Boolean(both?.evidence) && both?.gapFills?.['0:0']?.omit === true)
  const writer = {
    call: async () => ({
      text: JSON.stringify({ title: '새 가상 제목', lead: '새 첫머리입니다.', sections: [{ heading: '새 소제목', answers: 'v3-001', blocks: [{ kind: 'text', body: '새 본문입니다.' }] }] }),
      citations: [],
      usedWebSearch: false,
    }),
  }
  const regenerated = await drafts.generateDraft(
    'vtravel',
    'content:a',
    { brandName: '가상 여행', industry: '관광안내', region: '가상시', factGraph: [], questionTexts: ['가상시 여행 정보'], brief: { titles: ['새 가상 제목'], audience: '', questionsToAnswer: ['가상시 여행 정보'], mustIncludeFacts: [], doNotClaim: [], structure: [{ heading: '새 소제목', answers: 'v3-001', format: 'paragraph' }], citableSentences: [], channelNotes: '' } as never },
    writer,
  )
  ok('다시 만들어도 사례는 남고 빈칸 기록은 지운다', Boolean(regenerated.evidence) && regenerated.gapFills === undefined && regenerated.draft.title === '새 가상 제목')
  const cleared = await drafts.saveEvidence('vtravel', 'content:a', () => undefined)
  ok('사례를 지울 수 있다', cleared.evidence === undefined)
  let missing = false
  try {
    await drafts.saveEvidence('vtravel', 'content:none', () => built)
  } catch (err) {
    missing = err instanceof Error && err.message.includes('초안이 없습니다')
  }
  ok('초안이 없으면 사례를 저장하지 않는다', missing)
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
