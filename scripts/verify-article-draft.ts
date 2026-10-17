/**
 * 블로그 글 형식 초안(format 'article' — src/prompts/b9c-content-draft.ts · server/contentDraft.ts · src/lib/markdownFile.ts)을
 * 확인한다. 가짜 브랜드 · 가짜 사실만 쓰고 임시 폴더를 APP_DATA_DIR로 쓴다. AI는 부르지 않는다(글쓰기 · 격상 검사는 가짜 EngineClient).
 *
 * 왜: 글이 길어지고 모양(굵게 · 인용 · 사진 자리 · 절 번호)이 붙으면서 사실 가드를 비켜 가는 길이 생기면 안 된다.
 * 핵심 문장 · 그대로 쓸 말은 일부만 남기면 뜻이 바뀌므로 칸째 빼고, 주소가 든 문장은 넣지 않는다. 그리고 옛 형식
 * 초안의 내보내기는 한 글자도 바뀌면 안 된다(다듬은 글이 「원문 바뀜」이 되지 않게).
 *
 *   npx tsx scripts/verify-article-draft.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-article-draft-'))
process.env.APP_DATA_DIR = dir

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const NOW = '2026-10-18T00:00:00.000Z'
const facts = [
  { id: 'f1', type: 'other' as const, claim: '운영 시간', value: '오전 9시부터 오후 6시까지', updatedAt: NOW },
  { id: 'f2', type: 'location' as const, claim: '출발 장소', value: '가상역 2번 출구', updatedAt: NOW },
  { id: 'f3', type: 'other' as const, claim: '대표 코스', value: '가상 해안 산책길', updatedAt: NOW },
]
const brief = {
  titles: ['가상시 여행 코스 고르기'],
  audience: '가상시를 처음 찾는 여행자',
  questionsToAnswer: ['가상시 여행 코스 추천'],
  mustIncludeFacts: [],
  doNotClaim: [],
  structure: [
    { heading: '출발 장소', answers: 'q1', format: 'paragraph' as const },
    { heading: '운영 시간', answers: 'q2', format: 'paragraph' as const },
    { heading: '코스', answers: 'q3', format: 'paragraph' as const },
    { heading: '준비물', answers: 'q4', format: 'paragraph' as const },
  ],
  citableSentences: [],
  channelNotes: [],
}
const request = {
  brandName: '가상 여행',
  industry: '관광안내',
  region: '가상시',
  factGraph: facts,
  questionTexts: brief.questionsToAnswer,
  brief,
}

/** 엔진이 쓴 글 — 가드가 걸러야 할 것을 골고루 섞었다. */
const ARTICLE_JSON = {
  title: '**가상시 여행 코스 고를 때 확인할 {N}가지**',
  lead: '가상시 여행은 출발 장소와 운영 시간을 먼저 보면 됩니다. 가상 여행은 가상역 2번 출구에서 출발합니다.',
  sections: [
    {
      heading: '1. 어디서 출발하나요?',
      answers: 'q1',
      blocks: [
        { kind: 'text', role: 'key', body: '가상 여행은 **가상역 2번 출구**에서 출발합니다.' },
        { kind: 'text', role: 'action', body: '출발 30분 전에 도착해 일행을 확인하세요. 짐은 가볍게 챙기세요.' },
        { kind: 'text', role: 'quote', body: '출발 장소가 가상역 2번 출구가 맞나요? 주차가 되는지도 알려 주세요.' },
        { kind: 'text', role: 'why', body: '자세한 안내는 https://vtravel.example/guide 에서 볼 수 있습니다.' },
      ],
      image: { alt: '가상역 2번 출구 앞 집결 장소', caption: '*출발 전 모이는 곳*' },
    },
    {
      heading: 'Q2) 몇 시까지 운영하나요?',
      answers: 'q2',
      blocks: [
        { kind: 'text', role: 'key', body: '가상 여행은 오전 9시부터 오후 6시까지 운영합니다.' },
        { kind: 'text', role: 'quote', body: '마지막 출발이 언제인가요? 오후 5시 이후에도 출발하나요?' },
        { kind: 'text', role: 'why', body: '가상 해안 산책길은 오전 9시부터 오후 6시까지 열려 있습니다. 그래서 오후에도 걸을 수 있습니다.' },
        { kind: 'text', role: 'limit', body: '날씨에 따라 운영이 바뀔 수 있습니다.' },
        { kind: 'text', role: 'bogus', body: '구실이 이상한 문단입니다.' },
      ],
      image: { alt: '운영 시간 안내판', caption: '하루 100명이 찾는 안내판' },
    },
    {
      heading: '3. 어떤 코스가 있나요?',
      answers: 'q3',
      blocks: [
        { kind: 'text', role: 'key', body: '대표 코스는 가상 해안 산책길입니다.' },
        { kind: 'text', role: 'action', body: '산책길 입구에서 지도를 받아 걸으세요.' },
        { kind: 'gap', need: '코스별 소요 시간 — 팩트 그래프에 없음' },
      ],
      image: { alt: '바닷가 산책로 풍경', caption: '바다를 따라 걷는 가상 해안 산책길' },
    },
    {
      heading: '4. 무엇을 준비하나요?',
      answers: 'q4',
      blocks: [{ kind: 'gap', need: '준비물 목록 — 팩트 그래프에 없음' }],
      image: { alt: '준비물을 펼쳐 놓은 모습', caption: '챙겨 갈 것' },
    },
  ],
}

/** 격상 검사가 「크게 말한다」고 볼 문장. */
const OVERCLAIMED = new Set([
  '가상 해안 산책길은 오전 9시부터 오후 6시까지 열려 있습니다.',
  '대표 코스는 가상 해안 산책길입니다.',
  '바다를 따라 걷는 가상 해안 산책길',
])

const prompts: { system: string; user: string }[] = []
const writerOf = (json: unknown) => ({
  call: async (p: { system: string; user: string }) => {
    prompts.push(p)
    return { text: JSON.stringify(json), citations: [], usedWebSearch: false }
  },
})
const checker = {
  call: async (p: { system: string; user: string }) => {
    const verdicts = [...p.user.matchAll(/^\[(\d+)\] 문장: (.+)$/gm)].map((m) => ({
      id: Number(m[1]),
      verdict: OVERCLAIMED.has(m[2]!) ? 'overclaim' : 'ok',
      ...(OVERCLAIMED.has(m[2]!) ? { reason: '가짜 격상 판정' } : {}),
    }))
    return { text: JSON.stringify(verdicts), citations: [], usedWebSearch: false }
  },
}

try {
  const { articleFormatOf, buildContentDraftPrompt } = await import('../src/prompts/b9c-content-draft')
  const drafts = await import('../server/contentDraft')
  const md = await import('../src/lib/markdownFile')
  const { applyGapFills, draftRequestOf, publishMarkdownOf, workMarkdownOf } = await import('../src/lib/draftGaps')
  const { buildPublishHtml, markdownToHtml } = await import('../src/lib/htmlFile')

  // 1) 프롬프트 — 블로그 글 형식일 때만 규칙 8과 role 스키마가 붙는다
  const oldPrompt = buildContentDraftPrompt(request)
  const articlePrompt = buildContentDraftPrompt({ ...request, format: 'article' })
  const enPrompt = buildContentDraftPrompt({ ...request, format: 'article', language: 'en' })
  ok('옛 형식 프롬프트에는 블로그 규칙이 없다', !oldPrompt.system.includes('블로그 긴 글') && oldPrompt.system.includes('각 절의 blocks는 1~4개'))
  ok('블로그 글 형식 프롬프트에 규칙 8 · role · {N}', articlePrompt.system.includes('블로그 긴 글') && articlePrompt.system.includes('"role":"key"') && articlePrompt.system.includes('{N}'))
  ok('블로그 글 형식은 1~4개 규칙 대신 2~6개', !articlePrompt.system.includes('blocks는 1~4개') && articlePrompt.system.includes('blocks는 2~6개'))
  ok('영어 원고는 블로그 형식을 쓰지 않는다', !enPrompt.system.includes('블로그 긴 글') && enPrompt.system.includes('영어 원고'))
  ok('articleFormatOf — 영어는 없음', articleFormatOf({ format: 'article', language: 'en' }) === undefined && articleFormatOf({ format: 'article' }) === 'article')
  ok('user 메시지는 형식과 무관', oldPrompt.user === articlePrompt.user)

  // 2) 정규화 · 가드
  const stored = await drafts.generateDraft('vtravel', 'content:a', { ...request, format: 'article' }, writerOf(ARTICLE_JSON), checker)
  const d = stored.draft
  const [s1, s2, s3, s4] = d.sections
  ok('형식이 기록된다', d.format === 'article')
  ok('제목의 굵게는 걷고 {N}은 남긴다', d.title === '가상시 여행 코스 고를 때 확인할 {N}가지')
  ok('절 제목 앞 번호를 뗀다(1. · Q2))', s1?.heading === '어디서 출발하나요?' && s2?.heading === '몇 시까지 운영하나요?')
  ok('핵심 문장 — 굵게 기호를 걷고 role key', s1?.blocks[0]?.role === 'key' && s1.blocks[0].body === '가상 여행은 가상역 2번 출구에서 출발합니다.')
  ok('할 일 — 출처 없는 숫자 문장만 빼고 role 유지', s1?.blocks[1]?.role === 'action' && s1.blocks[1].body === '짐은 가볍게 챙기세요.')
  ok('그대로 쓸 말 — 통과하면 role quote', s1?.blocks[2]?.role === 'quote' && s1.blocks[2].body === '출발 장소가 가상역 2번 출구가 맞나요? 주차가 되는지도 알려 주세요.')
  ok('주소가 든 문단은 빈칸이 된다', s1?.blocks[3]?.kind === 'gap' && (d.guardNotes ?? []).some((n) => n.includes('주소가 든 문장')))
  ok('그대로 쓸 말은 한 문장이라도 걸리면 칸째 뺀다(빈칸 아님)', !s2?.blocks.some((b) => b.role === 'quote') && (d.guardNotes ?? []).some((n) => n.includes('그대로 쓸 말의 문장 일부가 걸려 칸째')))
  ok('격상 — 이유 문단은 걸린 문장만 빼고 role 유지', s2?.blocks.some((b) => b.role === 'why' && b.body === '그래서 오후에도 걸을 수 있습니다.') === true)
  ok('모르는 role은 버린다', s2?.blocks.some((b) => b.body === '구실이 이상한 문단입니다.' && b.role === undefined) === true)
  ok('격상 — 핵심 문장은 칸째 뺀다(빈칸 아님)', s3?.blocks.length === 2 && s3.blocks[0]?.role === 'action' && s3.blocks[1]?.kind === 'gap')
  ok('사진 설명의 * 를 걷는다', s1?.image?.alt === '가상역 2번 출구 앞 집결 장소' && s1.image.caption === '출발 전 모이는 곳')
  ok('사진 설명에 출처 없는 숫자 — 설명만 뺀다', s2?.image?.alt === '운영 시간 안내판' && s2.image.caption === undefined)
  ok('격상 — 사진 설명만 뺀다', s3?.image?.alt === '바닷가 산책로 풍경' && s3.image.caption === undefined)
  ok('사진 자리는 3곳까지', s4 !== undefined && s4.image === undefined)
  ok('빈칸 수', d.gapCount === 3)

  // 3) 내보내기
  const pub = publishMarkdownOf(stored)
  const work = workMarkdownOf(stored)
  ok('발행본 제목 — {N}을 실린 절 수로', pub.startsWith('# 가상시 여행 코스 고를 때 확인할 3가지\n'))
  ok('draftTitle도 같은 수', md.draftTitle(d) === '가상시 여행 코스 고를 때 확인할 3가지')
  ok('발행본 — 실린 절에 번호, 빈칸만 있던 절은 없다', pub.includes('\n## 1. 어디서 출발하나요?\n') && pub.includes('\n## 3. 어떤 코스가 있나요?\n') && !pub.includes('## 4.'))
  ok('발행본 — 핵심 문장은 굵게', pub.includes('\n**가상 여행은 가상역 2번 출구에서 출발합니다.**\n'))
  ok('발행본 — 그대로 쓸 말은 인용', pub.includes('\n> 출발 장소가 가상역 2번 출구가 맞나요? 주차가 되는지도 알려 주세요.\n'))
  ok('발행본 — 사진 자리와 설명 줄', pub.includes('\n![가상역 2번 출구 앞 집결 장소](#image-slot)\n*출발 전 모이는 곳*\n'))
  ok('발행본 — 빈칸 표시 · 쓴 사실 없음', !pub.includes('채워야 함') && !pub.includes('이 글이 쓴 사실'))
  ok('사진 자리 3곳', md.countImageSlots(pub) === 3)
  ok('작업용 — 빈칸만 있는 절도 번호를 달고 남는다', work.startsWith('# 가상시 여행 코스 고를 때 확인할 4가지\n') && work.includes('## 4. 무엇을 준비하나요?') && work.includes('> **채워야 함:** 준비물 목록'))
  ok('작업용 — 쓴 사실 목록', work.includes('**이 글이 쓴 사실**'))
  const html = markdownToHtml(pub)
  ok('HTML — 굵게 · 인용 · 사진 자리 · 설명 · 번호 제목',
    html.includes('<p><strong>가상 여행은 가상역 2번 출구에서 출발합니다.</strong></p>') &&
      html.includes('<blockquote><p>출발 장소가') &&
      html.includes('<figure class="image-slot"><p>[사진 넣을 자리] 가상역 2번 출구 앞 집결 장소</p><figcaption>출발 전 모이는 곳</figcaption></figure>') &&
      html.includes('<h2>1. 어디서 출발하나요?</h2>'))
  const doc = buildPublishHtml({ stored, brand: { brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtravel.example'] } as never, facts: [] })
  ok('완성 HTML의 <title> · headline도 채운 제목', doc.includes('<title>가상시 여행 코스 고를 때 확인할 3가지</title>') && doc.includes('"headline": "가상시 여행 코스 고를 때 확인할 3가지"'))

  // 빈칸 처리 — 뺀 절은 번호에서 빠지고, 채운 값은 그 절에 들어간다
  const filled = applyGapFills(d, { '3:0': { omit: true }, '2:1': { value: '약 2시간' } })
  const filledWork = md.draftToMarkdown(filled)
  ok('빈칸을 모두 뺀 절은 작업용에서도 빠진다', !filledWork.includes('무엇을 준비하나요') && filledWork.startsWith('# 가상시 여행 코스 고를 때 확인할 3가지'))
  ok('채운 값은 그 절의 문단', md.draftToPublishMarkdown(filled).includes('\n코스별 소요 시간: 약 2시간\n'))

  // 4) 옛 형식은 그대로
  const oldStored = await drafts.generateDraft('vtravel', 'content:old', request, writerOf(ARTICLE_JSON), checker)
  const od = oldStored.draft
  ok('옛 형식 — format · role · image가 붙지 않는다', od.format === undefined && od.sections.every((s) => s.image === undefined && s.blocks.every((b) => b.role === undefined)))
  ok('옛 형식 — 제목 · 절 번호 · 굵게를 건드리지 않는다', od.title === ARTICLE_JSON.title && od.sections[0]?.heading === '1. 어디서 출발하나요?' && od.sections[0].blocks[0]?.body === '가상 여행은 **가상역 2번 출구**에서 출발합니다.')
  ok('옛 형식 — 그대로 쓸 말도 문장 단위로 거른다(칸째 빼지 않음)', od.sections[1]?.blocks[1]?.body === '마지막 출발이 언제인가요?')
  const fixture = {
    title: 'T',
    lead: 'L',
    sections: [
      { heading: 'H1', answers: 'a', blocks: [{ kind: 'text' as const, body: 'B1' }] },
      { heading: 'H2', answers: 'b', blocks: [{ kind: 'gap' as const, need: 'n' }] },
    ],
    gapCount: 1,
    usedFacts: ['f'],
  }
  ok('옛 형식 작업용 마크다운 — 글자 그대로', md.draftToMarkdown(fixture) === '# T\n\nL\n\n## H1\nB1\n\n## H2\n> **채워야 함:** n\n\n---\n\n**이 글이 쓴 사실**\n- f\n')
  ok('옛 형식 발행용 마크다운 — 글자 그대로', md.draftToPublishMarkdown(fixture) === '# T\n\nL\n\n## H1\n\nB1\n')
  ok('옛 형식 draftTitle — 그대로', md.draftTitle({ ...fixture, title: '{N}가지' }) === '{N}가지')

  // 5) 초안 요청 — 자사 글만 블로그 형식
  ok('자사 글(content)은 블로그 형식으로 요청', draftRequestOf({ id: 'content:a', kind: 'content' }).format === 'article')
  ok('등재형(listing)은 옛 형식', draftRequestOf({ id: 'listing:x', kind: 'listing', targetDomain: 'x.example' }).format === undefined)

  // 6) 고친 글 저장 — 절 번호 · 채운 제목 수 · 링크 주소 · 사진 자리 줄은 「출처 없는 숫자」가 아니다
  ok('editedLinePlain — 절 번호', drafts.editedLinePlain('## 1. 어디서 출발하나요?') === '어디서 출발하나요?')
  ok('editedLinePlain — 사진 자리 줄은 건너뛴다', drafts.editedLinePlain('![사진 2장](#image-slot)') === '')
  ok('editedLinePlain — 링크는 글자만', drafts.editedLinePlain('[문의하기](https://vtravel.example/123)') === '문의하기')
  ok('editedLinePlain — 설명 줄 · 굵게 기호', drafts.editedLinePlain('*출발 전 모이는 곳*') === '출발 전 모이는 곳' && drafts.editedLinePlain('**핵심**입니다.') === '핵심입니다.')
  const saved = await drafts.saveEditedDraft('vtravel', 'content:a', work, facts, brief.questionsToAnswer)
  ok('블로그 형식 작업용 그대로 저장 — 경고 없음', saved.editWarnings === undefined)
  const savedWithNumber = await drafts.saveEditedDraft('vtravel', 'content:a', `${work}\n하루 100명이 찾습니다.\n`, facts, brief.questionsToAnswer)
  ok('사람이 넣은 출처 없는 숫자는 여전히 알린다', (savedWithNumber.editWarnings ?? []).some((w) => w.includes('숫자 100')))
  const otherTitle = await drafts.saveEditedDraft('vtravel', 'content:a', work.replace('확인할 4가지', '확인할 4가지와 7곳'), facts, brief.questionsToAnswer)
  ok('제목 모양이 바뀌면 그 숫자도 알린다', (otherTitle.editWarnings ?? []).some((w) => w.includes('확인할 4가지와 7곳')))
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
