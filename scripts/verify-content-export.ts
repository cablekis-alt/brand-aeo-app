/**
 * 발행 내보내기(src/lib/publishArticle.ts · htmlFile.ts · draftGaps.ts)를 확인한다. 가짜 초안만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜:
 * - 옛 형식 초안의 발행 원고 · 지문(sourceKeyOf)이 한 글자라도 바뀌면, 다듬어 둔 채널 글이 전부 「원문이 바뀌었습니다」가 된다.
 *   아래 기준 문자열은 글 끝 · 이미지 문법을 넣기 전의 출력이다 — 바뀌면 안 된다.
 * - 코드가 붙이는 글 끝(공식 사이트 링크)은 발행본에만 있고 본문 · 지문에는 섞이지 않아야 한다.
 * - 이미지 문법은 「!」 + 링크로 깨지지 않고, 사진 자리 · 캡션은 그림 하나로, javascript: 주소는 글자로 남아야 한다.
 *
 *   npx tsx scripts/verify-content-export.ts
 */
import { publishMarkdownOf, workMarkdownOf } from '../src/lib/draftGaps'
import { buildPublishHtml, markdownToHtml } from '../src/lib/htmlFile'
import { articleTailMarkdown, brandSiteUrl, publishArticleOf } from '../src/lib/publishArticle'
import { sourceKeyOf } from '../src/prompts/b9d-channel-adapt'
import type { StoredDraft, TenantSummary } from '../src/lib/api'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// 가짜 초안 — 빈칸 하나는 채웠고, 하나는 빈칸만 있는 절(발행본에서 빠진다).
const legacy: StoredDraft = {
  actionId: 'content:category-agnostic',
  generatedAt: '2026-10-01T09:00:00.000Z',
  draft: {
    title: '가상 여행 정보, 어디서 찾나요?',
    lead: '가상시 여행 정보는 공식 관광 안내와 지역 정보 사이트를 함께 보면 빠릅니다. 아래에서 고르는 기준을 정리했습니다.',
    sections: [
      { heading: '어떤 기준으로 고르나요?', answers: 'v3-001', blocks: [{ kind: 'text', body: '코스와 맛집을 한곳에서 볼 수 있는지 먼저 확인하세요. 최신 정보인지도 봐야 합니다.' }, { kind: 'gap', need: '운영 시간 — 팩트 그래프에 운영 시간 항목 없음' }] },
      { heading: '가상 여행은 무엇을 다루나요?', answers: 'v3-002', blocks: [{ kind: 'text', body: '가상 여행은 관광지·맛집·숙소를 모아 둔 정보 사이트입니다.' }] },
      { heading: '비어 있는 절', answers: '', blocks: [{ kind: 'gap', need: '가격 — 항목 없음' }] },
    ],
    gapCount: 2,
    usedFacts: ['서비스: 관광지·맛집·숙소 정보'],
  },
  gapFills: { '0:1': { value: '오전 9시~오후 6시' } },
}
const edited: StoredDraft = {
  ...legacy,
  actionId: 'content:comparison',
  editedMarkdown: '# 고친 글\n\n첫 문단 **굵게**와 [링크](https://example.com/a).\n\n> **채워야 함:** 남은 빈칸\n\n- 목록 하나\n- 목록 둘\n\n> 인용 한 줄\n',
  editedAt: '2026-10-02T09:00:00.000Z',
}
const brand: TenantSummary = {
  tenantId: 'vtravel', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtravel.example'],
  industry: '관광안내', region: '가상시', engines: [], questionBankSize: 36, competitors: [],
}

// 1) 옛 형식 — 글 끝 · 이미지 문법을 넣기 전과 같은 출력
ok('옛 초안 발행 원고가 그대로', publishMarkdownOf(legacy) === "# 가상 여행 정보, 어디서 찾나요?\n\n가상시 여행 정보는 공식 관광 안내와 지역 정보 사이트를 함께 보면 빠릅니다. 아래에서 고르는 기준을 정리했습니다.\n\n## 어떤 기준으로 고르나요?\n\n코스와 맛집을 한곳에서 볼 수 있는지 먼저 확인하세요. 최신 정보인지도 봐야 합니다.\n\n운영 시간: 오전 9시~오후 6시\n\n## 가상 여행은 무엇을 다루나요?\n\n가상 여행은 관광지·맛집·숙소를 모아 둔 정보 사이트입니다.\n")
ok('옛 초안 지문이 그대로', sourceKeyOf(publishMarkdownOf(legacy)) === "6e-1nsk2go")
ok('옛 초안 본문 HTML이 그대로', markdownToHtml(publishMarkdownOf(legacy)) === "<h1>가상 여행 정보, 어디서 찾나요?</h1>\n<p>가상시 여행 정보는 공식 관광 안내와 지역 정보 사이트를 함께 보면 빠릅니다. 아래에서 고르는 기준을 정리했습니다.</p>\n<h2>어떤 기준으로 고르나요?</h2>\n<p>코스와 맛집을 한곳에서 볼 수 있는지 먼저 확인하세요. 최신 정보인지도 봐야 합니다.</p>\n<p>운영 시간: 오전 9시~오후 6시</p>\n<h2>가상 여행은 무엇을 다루나요?</h2>\n<p>가상 여행은 관광지·맛집·숙소를 모아 둔 정보 사이트입니다.</p>")
ok('옛 초안 작업용 원고가 그대로', workMarkdownOf(legacy) === "# 가상 여행 정보, 어디서 찾나요?\n\n가상시 여행 정보는 공식 관광 안내와 지역 정보 사이트를 함께 보면 빠릅니다. 아래에서 고르는 기준을 정리했습니다.\n\n## 어떤 기준으로 고르나요?\n코스와 맛집을 한곳에서 볼 수 있는지 먼저 확인하세요. 최신 정보인지도 봐야 합니다.\n\n운영 시간: 오전 9시~오후 6시\n\n## 가상 여행은 무엇을 다루나요?\n가상 여행은 관광지·맛집·숙소를 모아 둔 정보 사이트입니다.\n\n## 비어 있는 절\n> **채워야 함:** 가격 — 항목 없음\n\n---\n\n**이 글이 쓴 사실**\n- 서비스: 관광지·맛집·숙소 정보\n")
ok('고친 글 발행 원고가 그대로', publishMarkdownOf(edited) === "# 고친 글\n\n첫 문단 **굵게**와 [링크](https://example.com/a).\n\n- 목록 하나\n- 목록 둘\n\n> 인용 한 줄")
ok('고친 글 지문이 그대로', sourceKeyOf(publishMarkdownOf(edited)) === "23-9glnvn")
ok('고친 글 본문 HTML이 그대로', markdownToHtml(publishMarkdownOf(edited)) === "<h1>고친 글</h1>\n<p>첫 문단 <strong>굵게</strong>와 <a href=\"https://example.com/a\" rel=\"noopener\">링크</a>.</p>\n<ul><li>목록 하나</li><li>목록 둘</li></ul>\n<blockquote><p>인용 한 줄</p></blockquote>")

// 2) 글 끝 — 공식 사이트 링크는 발행본에만
const article = publishArticleOf(legacy, { brand })
ok('공식 사이트 주소', brandSiteUrl(brand) === 'https://vtravel.example/' && brandSiteUrl({ ...brand, ownedDomains: ['https://www.vtravel.example/about'] }) === 'https://www.vtravel.example/')
ok('발행본 끝에 공식 사이트 링크', article.endsWith('---\n\n[가상 여행 공식 사이트](https://vtravel.example/)\n'))
ok('발행본 앞부분은 본문 그대로', article.startsWith(publishMarkdownOf(legacy).trimEnd()))
ok('본문 · 지문에는 글 끝이 없다', !publishMarkdownOf(legacy).includes('공식 사이트') && sourceKeyOf(publishMarkdownOf(legacy)) === "6e-1nsk2go")
ok('본문에 이미 그 사이트 링크가 있으면 또 붙이지 않는다', articleTailMarkdown('[홈](https://www.vtravel.example/courses/1)', { brand }) === '')
ok('도메인이 없으면 글 끝도 없다', publishArticleOf(legacy, { brand: { ...brand, ownedDomains: [] } }) === publishMarkdownOf(legacy))
ok('고친 글에도 발행할 때만 붙는다', publishArticleOf(edited, { brand }).endsWith('[가상 여행 공식 사이트](https://vtravel.example/)\n') && !(edited.editedMarkdown ?? '').includes('공식 사이트'))
const doc = buildPublishHtml({ stored: legacy, brand, facts: [] })
ok('자사 사이트용 .html 본문에 링크', doc.includes('<a href="https://vtravel.example/" rel="noopener">가상 여행 공식 사이트</a>'))

// 3) 이미지 · 사진 자리 · 캡션
const slot = markdownToHtml('![군산 시간여행마을 골목 사진](#image-slot)\n*골목 입구에서 본 모습*')
ok('사진 자리는 그림 하나 + 캡션', slot === '<figure class="image-slot"><p>[사진 넣을 자리] 군산 시간여행마을 골목 사진</p><figcaption>골목 입구에서 본 모습</figcaption></figure>')
const real = markdownToHtml('![지도](https://img.example/a.png)\n*캡션*')
ok('https 이미지는 img + alt + 캡션', real === '<figure><img src="https://img.example/a.png" alt="지도"><figcaption>캡션</figcaption></figure>')
ok('캡션은 바로 다음 줄만', markdownToHtml('![지도](https://img.example/a.png)\n\n*떨어진 문단*') === '<figure><img src="https://img.example/a.png" alt="지도"></figure>\n<p><em>떨어진 문단</em></p>')
ok('굵은 줄은 캡션이 아니다', markdownToHtml('![지도](#image-slot)\n**굵게**').includes('<p><strong>굵게</strong></p>'))
ok('alt의 태그는 글자로', markdownToHtml('![<script>x</script>](#image-slot)').includes('[사진 넣을 자리] &lt;script&gt;x&lt;/script&gt;'))
ok('javascript: 이미지는 글자로', markdownToHtml('![x](javascript:alert(1))') === '<p>![x](javascript:alert(1))</p>')
const inlineImg = markdownToHtml('문장 속 ![아이콘](https://img.example/i.png) 그림과 [링크](https://example.com/).')
ok('문장 속 이미지에 「!」가 남지 않는다', !inlineImg.includes('!<a') && inlineImg.includes('<img src="https://img.example/i.png" alt="아이콘">') && inlineImg.includes('<a href="https://example.com/"'))
ok('문장 속 사진 자리는 글자로 알린다', markdownToHtml('여기에 ![지도](#image-slot) 넣기').includes('[사진: 지도]'))

// 4) 인용 — 빈 `>` 줄은 문단 나눔
ok('여러 문단 인용', markdownToHtml('> 첫 문단\n>\n> 둘째 문단') === '<blockquote><p>첫 문단</p><p>둘째 문단</p></blockquote>')
ok('한 문단 인용은 그대로', markdownToHtml('> 한 줄\n> 이어진 줄') === '<blockquote><p>한 줄 이어진 줄</p></blockquote>')

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
