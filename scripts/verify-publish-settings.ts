/**
 * 브랜드별 발행 설정(src/lib/publishSettings.ts · server/publishSettingsStore.ts)과 글 끝(src/lib/publishArticle.ts)을
 * 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 쓴다. 서버 · AI는 부르지 않는다.
 *
 * 왜: 상담 안내 · 문의 링크는 사실 가드를 거치지 않고 발행본에 그대로 들어간다. 그래서 주소는 http(s)만, 문구는
 * 마크다운 제목 · 목록이 되지 않게 걸러야 하고, 설정을 바꿔도 본문 · 지문은 그대로여야 한다(다듬은 글이
 * 「원문 바뀜」이 되지 않게).
 *
 *   npx tsx scripts/verify-publish-settings.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-publish-settings-'))
process.env.APP_DATA_DIR = dir

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const throws = (fn: () => unknown, text: string) => {
  try {
    fn()
    return false
  } catch (err) {
    return err instanceof Error && err.message.includes(text)
  }
}

try {
  const { blogWriteUrl, normalizePublishSettings } = await import('../src/lib/publishSettings')
  const store = await import('../server/publishSettingsStore')
  const { publishMarkdownOf } = await import('../src/lib/draftGaps')
  const { articleTailMarkdown, publishArticleOf } = await import('../src/lib/publishArticle')
  const { buildPublishHtml } = await import('../src/lib/htmlFile')
  const { sourceKeyOf } = await import('../src/prompts/b9d-channel-adapt')

  // 1) 값 고르기
  ok('빈 값은 빈 설정', JSON.stringify(normalizePublishSettings({})) === '{}' && JSON.stringify(normalizePublishSettings({ ctaText: '  ', tags: '' })) === '{}')
  const s = normalizePublishSettings({
    ctaText: '## - 사이트 주소와\n자주 받는 질문을 준비해 문의해 주세요.',
    inquiryUrl: 'vtravel.example/contact',
    tags: '#가상여행, 가상 관광 ,#가상여행,  ',
    category: ' 여행  정보 ',
    blogUrl: 'https://vblog.tistory.com',
  })
  ok('상담 안내 앞의 #·- 는 떼고 줄바꿈은 한 칸', s.ctaText === '사이트 주소와 자주 받는 질문을 준비해 문의해 주세요.')
  const cta = (t: string) => normalizePublishSettings({ ctaText: t }).ctaText
  ok('공백 없는 맨 앞 숫자 · 기호는 그대로(1.5배 · +82 · -10% · **굵게**)',
    cta('1.5배 빠른 상담을 받아 보세요.') === '1.5배 빠른 상담을 받아 보세요.' &&
      cta('+82 문의 환영') === '+82 문의 환영' &&
      cta('-10% 할인 상담') === '-10% 할인 상담' &&
      cta('**무료 상담**을 받아 보세요.') === '**무료 상담**을 받아 보세요.')
  ok('인용 표시 > 는 공백 없이도 뗀다', cta('>상담은 무료입니다.') === '상담은 무료입니다.' && cta('1. > 상담은 무료입니다.') === '상담은 무료입니다.')
  ok('주소 앞에 https를 붙인다', s.inquiryUrl === 'https://vtravel.example/contact')
  ok('태그는 # 떼고 같은 것은 한 번', JSON.stringify(s.tags) === JSON.stringify(['가상여행', '가상 관광']))
  ok('카테고리 공백 정리', s.category === '여행 정보')
  ok('블로그 주소', s.blogUrl === 'https://vblog.tistory.com/')
  ok('javascript: 문의 링크는 거절', throws(() => normalizePublishSettings({ inquiryUrl: 'javascript:alert(1)' }), 'http · https'))
  ok('data: 블로그 주소는 거절', throws(() => normalizePublishSettings({ blogUrl: 'data:text/html,x' }), 'http · https'))
  ok('상담 안내는 200자까지', throws(() => normalizePublishSettings({ ctaText: '가'.repeat(201) }), '200자'))
  ok('태그는 10개까지', throws(() => normalizePublishSettings({ tags: Array.from({ length: 11 }, (_, i) => `태그${i}`) }), '10개'))
  ok('태그 하나는 30자까지', throws(() => normalizePublishSettings({ tags: ['가'.repeat(31)] }), '30자'))

  // 2) 블로그 글쓰기 화면
  ok('티스토리 글쓰기', blogWriteUrl('https://vblog.tistory.com/') === 'https://vblog.tistory.com/manage/newpost')
  ok('네이버 블로그 글쓰기', blogWriteUrl('https://blog.naver.com/vblog') === 'https://blog.naver.com/GoBlogWrite.naver')
  ok('티스토리 첫 화면은 블로그가 아니다', blogWriteUrl('https://www.tistory.com/') === 'https://www.tistory.com/')

  // 3) 저장 — 없으면 null, 쓰고 읽으면 같다, 깨진 파일은 알리고 null
  ok('저장 전에는 없다', (await store.readPublishSettings('vtravel')) === null)
  const saved = await store.writePublishSettings('vtravel', s)
  const read = await store.readPublishSettings('vtravel')
  ok('쓰고 읽으면 같다', read?.ctaText === s.ctaText && read?.tags?.join() === s.tags?.join() && typeof read?.updatedAt === 'string' && read.updatedAt === saved.updatedAt)
  mkdirSync(path.join(dir, 'data', 'vbroken'), { recursive: true })
  writeFileSync(path.join(dir, 'data', 'vbroken', 'publish-settings.json'), '{ 깨진')
  const errors: unknown[] = []
  const origError = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  const broken = await store.readPublishSettings('vbroken')
  console.error = origError
  ok('깨진 파일은 알리고 null', broken === null && errors.length === 1)

  // 4) 글 끝 — 상담 안내 → 문의 링크 → 공식 사이트, 본문 · 지문은 그대로
  const stored = {
    actionId: 'content:a',
    generatedAt: '2026-10-01T09:00:00.000Z',
    draft: { title: '가상 제목', lead: '가상 첫머리입니다.', sections: [{ heading: '가상 소제목', answers: 'q1', blocks: [{ kind: 'text' as const, body: '가상 본문입니다.' }] }], gapCount: 0, usedFacts: [] },
  }
  const brand = { tenantId: 'vtravel', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtravel.example'], industry: '관광안내', region: '가상시', engines: [], questionBankSize: 36, competitors: [] }
  const tail = articleTailMarkdown(publishMarkdownOf(stored), { brand, settings: s })
  ok(
    '글 끝 순서',
    tail === '---\n\n사이트 주소와 자주 받는 질문을 준비해 문의해 주세요.\n\n[문의하기](https://vtravel.example/contact)\n\n[가상 여행 공식 사이트](https://vtravel.example/)',
  )
  ok('문의 링크가 공식 사이트와 같으면 한 번만', !articleTailMarkdown('', { brand, settings: { inquiryUrl: 'https://vtravel.example/' } }).includes('공식 사이트'))
  ok('설정이 없으면 공식 사이트만', articleTailMarkdown('', { brand, settings: null }) === '---\n\n[가상 여행 공식 사이트](https://vtravel.example/)')
  const before = sourceKeyOf(publishMarkdownOf(stored))
  ok('설정을 붙여도 본문 · 지문은 그대로', publishArticleOf(stored, { brand, settings: s }).startsWith(publishMarkdownOf(stored).trimEnd()) && sourceKeyOf(publishMarkdownOf(stored)) === before)
  const doc = buildPublishHtml({ stored, brand, facts: [], settings: s })
  ok('JSON-LD 태그 · 카테고리', doc.includes('"keywords": "가상여행, 가상 관광"') && doc.includes('"articleSection": "여행 정보"'))
  ok('meta keywords', doc.includes('<meta name="keywords" content="가상여행, 가상 관광">'))
  ok('본문에 상담 안내 · 문의 링크', doc.includes('<p>사이트 주소와 자주 받는 질문을 준비해 문의해 주세요.</p>') && doc.includes('<a href="https://vtravel.example/contact" rel="noopener">문의하기</a>'))
  ok('설정이 없으면 keywords 없음', !buildPublishHtml({ stored, brand, facts: [] }).includes('keywords'))
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
