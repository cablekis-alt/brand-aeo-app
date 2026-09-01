import type {
  AeoReport,
  AuditContext,
  CategoryId,
  CategoryResult,
  ContentSuggestions,
  Finding,
  IssueFinding,
  PageSignals,
  Recommendation,
  Severity,
  TopIssue,
} from './types.ts'
import { DEFAULT_AUDIT_CONTEXT, DISCLAIMER } from './types.ts'
import { clip } from './clip.ts'
import { isBoilerplateText, isPlaceholderHost, isReferenceHost } from './extractPage.ts'
import { PAGE_TYPE_WEIGHTS } from './pageType.ts'
import { robotsBlocksPath } from './robots.ts'
import { areaQuality, CATEGORY_DEFS, scoreBand } from './scoreMeta.ts'

interface Deduction {
  severity: Severity
  title: string
  evidence: string
  aiImpact: string
  quote: string | null
  points: number
  rec?: Omit<Recommendation, 'priority'>
}

interface PendingRec {
  rec: Omit<Recommendation, 'priority'>
  severity: Severity
  points: number
}

type RecBag = PendingRec[]

const HYPE_RE = /독보적|유일|최고|최적의|완벽한|1위|넘버원|세계\s*최고|unparalleled|#1|best-in-class/i
const NUMBER_RE = /\d+(?:[.,]\d+)?\s*(?:%|원|명|건|개|점|배|억|만)?/

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function quoteFrom(s: PageSignals, pattern: RegExp): string | null {
  const hit = pattern.exec(`${s.title} ${s.h1s.join(' ')} ${s.firstText} ${s.mainText.slice(0, 1500)}`)
  return hit ? clip(hit[0], 80) : null
}

function finish(
  id: CategoryId,
  positives: Finding[],
  deductions: Deduction[],
  start: number,
  recs: RecBag,
): CategoryResult {
  const meta = CATEGORY_DEFS.find((c) => c.id === id)!
  const lost = deductions.reduce((sum, d) => sum + d.points, 0)
  const score = clamp(start - lost, 0, meta.max)
  const topIssue = deductions[0]
  for (const d of deductions) {
    if (d.rec) recs.push({ rec: d.rec, severity: d.severity, points: d.points })
  }
  return {
    id,
    name: meta.name,
    score,
    maxScore: meta.max,
    judgment: topIssue
      ? `${areaQuality(score, meta.max)}. ${topIssue.title}`
      : `${areaQuality(score, meta.max)}. 중요한 결함이 거의 없습니다.`,
    positives,
    issues: deductions.map((d) => ({
      severity: d.severity,
      title: d.title,
      evidence: d.evidence,
      aiImpact: d.aiImpact,
      quote: d.quote,
    })),
  }
}

function unknownCategory(id: CategoryId, judgment: string): CategoryResult {
  const meta = CATEGORY_DEFS.find((c) => c.id === id)!
  return {
    id,
    name: meta.name,
    score: 'unknown',
    maxScore: meta.max,
    judgment,
    positives: [],
    issues: [],
  }
}

function looksLikeLogoH1(text: string): boolean {
  return !text || text.length < 2
}

function isHubChrome(text: string): boolean {
  return /looking for work|job board|upcoming events|success stories/i.test(text)
}

function isLegalChrome(text: string): boolean {
  return /privacy (notice|policy|practices)|protected health information|cookie (policy|settings)|terms of (use|service)|if you are a .{0,60} patient/i.test(
    text,
  )
}

function looksLikeDefinition(text: string): boolean {
  return /는 |은 |입니다|제공|솔루션|정의|란 |\bis (a|an|the) |\bare (a|an|the) |official home|programming language|application-layer protocol/i.test(
    text,
  )
}

function definitionSentences(s: PageSignals): string[] {
  const parts = s.mainText.split(/(?<=다\.|요\.|\. )/g).map((p) => p.trim()).filter((p) => p.length > 24 && p.length < 180)
  const fromMeta = s.metaDescription.replace(/\s+/g, ' ').trim()
  const pool = fromMeta.length > 24 && fromMeta.length < 220 ? [fromMeta, ...parts] : parts
  return pool
    .filter(
      (p) => looksLikeDefinition(p) && !isBoilerplateText(p) && !isLegalChrome(p) && !isHubChrome(p),
    )
    .slice(0, 8)
}

function isHomePage(s: PageSignals): boolean {
  try {
    const path = new URL(s.finalUrl || s.requestedUrl).pathname.replace(/\/+$/, '') || '/'
    return path === '/' || /^\/index\.(html?|php)$/i.test(path) || /^welcome to\b/i.test(s.title)
  } catch {
    return /^welcome to\b/i.test(s.title)
  }
}

function scoreAccessibility(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  const robotsHit = robotsBlocksPath(s.robotsTxt, s.finalUrl || s.requestedUrl)

  if (s.status >= 200 && s.status < 400) {
    good.push({
      title: 'HTTP 응답이 정상입니다',
      evidence: `상태 ${s.status}, Content-Type ${s.contentType || '미확인'}.`,
      quote: null,
    })
  }
  if (s.wordCount >= 80 && !s.spaShell) {
    const source = s.collectionMode === 'browser' ? '브라우저에 표시된 본문' : '정적 HTML'
    good.push({
      title: '핵심 본문이 HTML에서 식별됩니다',
      evidence: `${source}에서 약 ${s.wordCount}단어가 추출되었습니다.`,
      quote: clip(s.firstText, 90),
    })
  }
  if (!s.noindex) {
    good.push({
      title: 'noindex 차단이 없습니다',
      evidence: 'robots meta / X-Robots-Tag에서 noindex가 확인되지 않았습니다.',
      quote: s.robotsMeta[0] ?? null,
    })
  }

  if (s.status >= 400) {
    bad.push({
      severity: 'critical',
      title: '페이지가 오류 응답을 반환합니다',
      evidence: `HTTP ${s.status}으로 본문을 신뢰할 수 없습니다.`,
      aiImpact: '답변 엔진이 페이지를 인용 후보로 가져가기 어렵습니다.',
      quote: null,
      points: 12,
      rec: {
        workType: 'dev',
        task: `공개 URL이 200을 반환하도록 라우팅·인증·도메인을 고치세요. 현재 응답은 ${s.status}입니다.`,
        expectedEffect: '크롤러가 HTML 본문을 가져와 인용 후보로 쓸 수 있습니다.',
        difficulty: '중간',
        before: `HTTP ${s.status}`,
        after: 'HTTP 200 + 본문 HTML',
      },
    })
  }
  if (s.noindex) {
    bad.push({
      severity: 'critical',
      title: 'noindex가 수집을 막습니다',
      evidence: `robots 신호: ${[...s.robotsMeta, s.xRobotsTag].filter(Boolean).join(' / ')}`,
      aiImpact: '검색·일부 답변 엔진이 페이지를 색인하지 않습니다.',
      quote: s.robotsMeta[0] ?? (s.xRobotsTag || null),
      points: 10,
      rec: {
        workType: 'dev',
        task: '공개 진단 대상 페이지에서 noindex를 제거하세요. 비공개 페이지만 noindex를 유지하세요.',
        expectedEffect: '수집·인용의 전제가 복구됩니다.',
        difficulty: '낮음',
        before: s.robotsMeta[0] || 'noindex',
        after: 'index, follow',
      },
    })
  }
  if (robotsHit?.blocked) {
    bad.push({
      severity: 'critical',
      title: 'robots.txt가 경로를 차단합니다',
      evidence: `${robotsHit.agent}: ${robotsHit.rule}`,
      aiImpact: '해당 크롤러가 본문에 접근하지 못합니다.',
      quote: robotsHit.rule,
      points: 8,
      rec: {
        workType: 'dev',
        task: `robots.txt에서 ${robotsHit.agent}에 대한 해당 경로 Disallow를 Allow로 바꾸세요.`,
        expectedEffect: 'AI·검색 크롤러가 페이지를 읽을 수 있습니다.',
        difficulty: '낮음',
        before: robotsHit.rule,
        after: 'User-agent: GPTBot\nAllow: /',
      },
    })
  }
  if (s.authWall) {
    bad.push({
      severity: 'critical',
      title: '로그인·페이월 신호가 있습니다',
      evidence: s.authWallEvidence || '인증 장벽 문구가 본문에 있습니다.',
      aiImpact: '공개 HTML이 없으면 인용 후보에서 제외됩니다.',
      quote: s.authWallEvidence || null,
      points: 8,
      rec: {
        workType: 'dev',
        task: '핵심 정의와 절차는 로그인 없이 HTML에 두고, 결제·개인정보만 가리세요.',
        expectedEffect: '크롤러가 미리보기만 보고 인용을 포기하지 않습니다.',
        difficulty: '중간',
        before: s.authWallEvidence,
        after: null,
      },
    })
  }
  if (s.spaShell || s.iframeOnly) {
    bad.push({
      severity: 'high',
      title: '본문이 스크립트 또는 iframe에 의존합니다',
      evidence: s.spaShell
        ? `추출 단어 ${s.wordCount}, script ${s.scriptCount}개로 SPA 셸이 의심됩니다.`
        : `본문 단어 ${s.wordCount}, iframe ${s.iframeCount}개입니다.`,
      aiImpact: '렌더하지 않는 수집기는 빈 페이지로 봅니다.',
      quote: null,
      points: 6,
      rec: {
        workType: 'dev',
        task: '핵심 문단을 서버 HTML(또는 prerender)로 출력하세요. iframe만으로 본문을 넣지 마세요.',
        expectedEffect: '렌더 없는 크롤러도 답을 추출할 수 있습니다.',
        difficulty: '높음',
        before: null,
        after: null,
      },
    })
  }
  if (!s.canonical) {
    bad.push({
      severity: 'medium',
      title: 'canonical이 없습니다',
      evidence: 'link[rel=canonical]과 og:url이 모두 비어 있습니다.',
      aiImpact: 'www/비www, HTTP/HTTPS 중복이 있으면 신호가 분산됩니다.',
      quote: null,
      points: 2,
      rec: {
        workType: 'dev',
        task: `canonical을 ${s.finalUrl || s.requestedUrl} 한 주소로 고정하고 HTTP→HTTPS 301을 거세요.`,
        expectedEffect: '동일 문서의 수집 신호가 한 URL로 모입니다.',
        difficulty: '낮음',
        before: 'canonical 없음',
        after: `<link rel="canonical" href="${s.finalUrl || s.requestedUrl}">`,
      },
    })
  }
  if (s.robotsTxtStatus === 404 || (!s.robotsTxt && s.robotsTxtStatus !== 200)) {
    bad.push({
      severity: 'low',
      title: 'robots.txt가 없습니다',
      evidence: `robots.txt 상태 ${s.robotsTxtStatus ?? '미수집'}. sitemap ${s.sitemapFound ? '있음' : '없음'}.`,
      aiImpact: '기본은 허용이지만, 크롤러 허용 범위와 사이트맵을 명시하지 못합니다.',
      quote: null,
      points: 1,
      rec: {
        workType: 'dev',
        task: 'Allow: / 와 Sitemap 위치를 담은 robots.txt를 루트에 두세요.',
        expectedEffect: '수집 경로가 분명해집니다.',
        difficulty: '낮음',
        before: '404',
        after: 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml',
      },
    })
  }

  const start = s.status >= 200 && s.status < 400 ? 13 : 4
  return finish('accessibility', good, bad, start, recs)
}

function scoreAnswer(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  const first = s.firstText
  const hasDefinition = /입니다|제공|솔루션|란 |is a |we (help|provide|build)/i.test(first)
  if (hasDefinition && s.wordCount >= 120) {
    good.push({
      title: '서두에 역할 설명이 있습니다',
      evidence: '첫 800자 안에 제공 가치 또는 정의형 문장이 있습니다.',
      quote: clip(first, 100),
    })
  }
  if (s.h2s.length >= 3) {
    good.push({
      title: '하위 주제를 나눈 제목이 있습니다',
      evidence: `H2 ${s.h2s.length}개.`,
      quote: s.h2s[0] ?? null,
    })
  }

  const h1 = s.h1s[0] ?? ''
  if (looksLikeLogoH1(h1) && !hasDefinition) {
    bad.push({
      severity: 'high',
      title: '핵심 질문과 답이 서두에 없습니다',
      evidence: 'H1이 비어 있거나 로고 수준이고, 첫 문단에 정의형 답이 약합니다.',
      aiImpact: 'AI가 “이 페이지는 무엇에 대한 답인가”를 한 문장으로 자르기 어렵습니다.',
      quote: h1 || s.title || null,
      points: 6,
      rec: {
        workType: 'content',
        task: '히어로 바로 아래에 누구인지·무엇을 제공하는지 40~70단어 요약문을 고정하세요.',
        expectedEffect: '첫 토큰에서 인용 가능한 정의가 생깁니다.',
        difficulty: '낮음',
        before: clip(first, 80) || '(서두 없음)',
        after: null,
      },
    })
  }
  if (HYPE_RE.test(first) || HYPE_RE.test(s.h2s.join(' '))) {
    bad.push({
      severity: 'medium',
      title: '홍보성·최상급 표현이 답을 가립니다',
      evidence: '서두 또는 제목에 독보적/유일/최고 등 검증 안 된 수사가 있습니다.',
      aiImpact: '일반론·광고 문장으로 분류되면 인용 우선순위가 떨어집니다.',
      quote: quoteFrom(s, HYPE_RE),
      points: 3,
      rec: {
        workType: 'content',
        task: '최상급을 빼고 제품 기능·대상 고객·검증된 사실만 남기세요.',
        expectedEffect: '문장이 독립적으로 인용 가능해집니다.',
        difficulty: '낮음',
        before: quoteFrom(s, HYPE_RE),
        after: null,
      },
    })
  }
  if (s.wordCount < 120) {
    bad.push({
      severity: 'high',
      title: '본문이 질문에 답하기에 짧습니다',
      evidence: `추출 단어 약 ${s.wordCount}개.`,
      aiImpact: '후속 질문·조건·예외를 다룰 정보가 부족합니다.',
      quote: clip(s.mainText, 80) || null,
      points: 6,
      rec: {
        workType: 'content',
        task: '대상, 작동 방식, 한계, 비교를 각각 한 절씩 추가하세요.',
        expectedEffect: '한 페이지로 핵심 질문을 완결할 수 있습니다.',
        difficulty: '중간',
        before: null,
        after: null,
      },
    })
  } else if (!s.faqLike && s.h2s.length < 2) {
    bad.push({
      severity: 'medium',
      title: '하위 질문·비교·예외가 구조화되어 있지 않습니다',
      evidence: `H2 ${s.h2s.length}개, FAQ 형태 ${s.faqLike ? '있음' : '없음'}.`,
      aiImpact: '관련 후속 질문을 이 페이지에서 메우기 어렵습니다.',
      quote: s.h2s[0] ?? null,
      points: 3,
      rec: {
        workType: 'content',
        task: '누가 쓰는지, 어떻게 작동하는지, 한계는 무엇인지 H2로 나누세요.',
        expectedEffect: '섹션 단위로 답이 추출됩니다.',
        difficulty: '중간',
        before: null,
        after: null,
      },
    })
  }

  const start = s.wordCount >= 80 ? 16 : 8
  return finish('answer_content', good, bad, start, recs)
}

function scoreStructure(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  if (s.title) {
    good.push({ title: 'title 태그가 있습니다', evidence: `「${clip(s.title, 80)}」`, quote: s.title })
  }
  if (s.jsonLdTypes.length) {
    good.push({
      title: '구조화 데이터가 있습니다',
      evidence: s.jsonLdTypes.join(', '),
      quote: s.jsonLdTypes[0] ?? null,
    })
  }
  if (s.listCount >= 2 || s.tableCount >= 1) {
    good.push({
      title: '목록 또는 표가 있습니다',
      evidence: `목록 ${s.listCount}, 표 ${s.tableCount}.`,
      quote: null,
    })
  }

  if (!s.title || s.title.length < 8) {
    bad.push({
      severity: 'high',
      title: '페이지 제목이 주제를 말하지 않습니다',
      evidence: s.title ? `title 길이 ${s.title.length}자.` : 'title이 비어 있습니다.',
      aiImpact: '스니펫과 엔터티 라벨이 빈약해집니다.',
      quote: s.title || null,
      points: 3,
      rec: {
        workType: 'content',
        task: 'title에 브랜드와 제공 가치를 함께 넣으세요. 음차 단독 제목은 피하세요.',
        expectedEffect: '수집기가 페이지 목적을 첫 필드에서 읽습니다.',
        difficulty: '낮음',
        before: s.title || '(없음)',
        after: null,
      },
    })
  }
  if (!s.metaDescription) {
    bad.push({
      severity: 'medium',
      title: 'meta description이 없습니다',
      evidence: 'description 메타가 비어 있습니다.',
      aiImpact: '요약 후보가 title·서두에만 의존합니다.',
      quote: null,
      points: 1,
      rec: {
        workType: 'content',
        task: '120~160자의 정의형 description을 추가하세요. 확인된 사실만 쓰세요.',
        expectedEffect: '요약·스니펫 품질이 올라갑니다.',
        difficulty: '낮음',
        before: '없음',
        after: null,
      },
    })
  }
  const h1 = s.h1s[0] ?? ''
  const h1TopicOk = Boolean(h1) && !looksLikeLogoH1(h1) && (topicsAlign(s.title, h1) || topicsAlign(s.ogTitle, h1))
  if (s.h1s.length !== 1 || looksLikeLogoH1(h1)) {
    if (h1TopicOk && s.h1s.length > 1) {
      bad.push({
        severity: 'medium',
        title: '마케팅 섹션에 H1이 반복됩니다',
        evidence: `문서 주제는 「${clip(h1, 40)}」로 읽히지만 H1이 ${s.h1s.length}개입니다.`,
        aiImpact: '섹션 카드 제목이 문서 제목과 같은 무게로 읽힙니다.',
        quote: h1,
        points: 1,
        rec: {
          workType: 'dev',
          task: '페이지 주제는 H1 하나, 나머지 섹션은 H2로 두세요.',
          expectedEffect: '기계가 문서 제목과 하위 섹션을 구분합니다.',
          difficulty: '낮음',
          before: h1,
          after: null,
        },
      })
    } else {
      bad.push({
        severity: 'high',
        title: 'H1이 페이지 주제를 담지 않습니다',
        evidence: s.h1s.length === 0 ? 'H1이 없습니다.' : `H1 ${s.h1s.length}개, 첫 값 「${clip(h1, 60) || '(빈 값)'}」.`,
        aiImpact: '헤딩 트리가 회사 로고에서 시작해 섹션 의미가 흐려집니다.',
        quote: h1 || null,
        points: 3,
        rec: {
          workType: 'dev',
          task: '로고는 링크로 두고, H1에는 텍스트 주제를 넣으세요. 첫 H2가 CMS 잔여물(팝업 알림 등)이면 삭제하세요.',
          expectedEffect: '기계가 문서 제목과 섹션을 구분합니다.',
          difficulty: '낮음',
          before: h1 || s.h2s[0] || '(없음)',
          after: null,
        },
      })
    }
  }
  if (/팝업|알림이 없습니다/i.test(s.h2s.join(' '))) {
    bad.push({
      severity: 'medium',
      title: 'CMS 잔여 헤딩이 계층을 오염시킵니다',
      evidence: 'H2에 팝업/알림 같은 인터페이스 문구가 있습니다.',
      aiImpact: '첫 섹션 제목이 콘텐츠가 아닌 UI 잔여물로 읽힙니다.',
      quote: s.h2s.find((h) => /팝업|알림/i.test(h)) ?? null,
      points: 2,
      rec: {
        workType: 'dev',
        task: '빈 팝업 레이어 제목을 DOM에서 제거하세요.',
        expectedEffect: 'H2가 실제 섹션만 가리킵니다.',
        difficulty: '낮음',
        before: s.h2s[0] ?? null,
        after: null,
      },
    })
  }
  if (
    !s.jsonLdTypes.length &&
    !(isReferenceHost(s.finalUrl || s.requestedUrl) && (s.ogSiteName || s.ogTitle))
  ) {
    bad.push({
      severity: 'medium',
      title: 'Schema.org 구조화 데이터가 없습니다',
      evidence: 'JSON-LD/microdata 유형이 확인되지 않았습니다. 이 항목만으로 과감점하지 않습니다.',
      aiImpact: '조직·기사 엔터티를 기계가 필드 단위로 붙이기 어렵습니다.',
      quote: null,
      points: 2,
      rec: {
        workType: 'dev',
        task: '푸터에 이미 있는 이름·주소·전화·URL만으로 Organization JSON-LD를 추가하세요. 없는 FAQ/평점은 마크업하지 마세요.',
        expectedEffect: '발행 주체가 엔터티로 식별됩니다.',
        difficulty: '낮음',
        before: 'JSON-LD 없음',
        after: null,
      },
    })
  }
  if (s.h2s.length + s.h3s.length < 2 && s.wordCount > 200) {
    bad.push({
      severity: 'medium',
      title: '긴 본문 대비 헤딩이 부족합니다',
      evidence: `단어 ${s.wordCount}, H2 ${s.h2s.length}, H3 ${s.h3s.length}.`,
      aiImpact: '정보 관계를 섹션 단위로 쪼개기 어렵습니다.',
      quote: null,
      points: 2,
      rec: {
        workType: 'content',
        task: '의미 단위마다 H2/H3를 넣고 한 문단은 3~5문장으로 나누세요.',
        expectedEffect: '부분 인용이 쉬워집니다.',
        difficulty: '중간',
        before: null,
        after: null,
      },
    })
  }

  const start = 12
  return finish('structure', good, bad, start, recs)
}

function scoreTrust(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  if (s.phoneOrEmail || s.addressLike) {
    good.push({
      title: '연락·위치 정보가 본문에 있습니다',
      evidence: `전화/이메일 ${s.phoneOrEmail ? '있음' : '없음'}, 주소형 텍스트 ${s.addressLike ? '있음' : '없음'}.`,
      quote: null,
    })
  }
  if (s.dates.length) {
    good.push({
      title: '날짜 신호가 있습니다',
      evidence: s.dates.slice(0, 3).join(', '),
      quote: s.dates[0] ?? null,
    })
  }
  if (s.authorCandidates.length || s.orgCandidates.length) {
    good.push({
      title: '작성자 또는 조직 후보가 있습니다',
      evidence: [...s.authorCandidates, ...s.orgCandidates].slice(0, 4).join(', '),
      quote: s.orgCandidates[0] ?? s.authorCandidates[0] ?? null,
    })
  }

  const reference = isReferenceHost(s.finalUrl || s.requestedUrl)
  const productLike = s.pageType === 'product' || s.pageType === 'saas_home'
  const hasPublisher = Boolean(s.authorCandidates.length || s.orgCandidates.length || s.ogSiteName)

  if (!hasPublisher) {
    bad.push({
      severity: 'high',
      title: '작성자·발행 주체가 본문 상단에 없습니다',
      evidence: 'author/Person 마크업과 바이라인 후보가 비어 있습니다.',
      aiImpact: '누가 말했는지 몰라 근거로 쓰기 꺼려집니다.',
      quote: null,
      points: 4,
      rec: {
        workType: 'content',
        task: '페이지에 조직명과 (있다면) 작성자·역할을 텍스트로 명시하세요.',
        expectedEffect: '인용 시 출처 주체가 분명해집니다.',
        difficulty: '낮음',
        before: null,
        after: null,
      },
    })
  }
  if (!s.dates.length && !productLike) {
    bad.push({
      severity: 'medium',
      title: '게시일·수정일이 없습니다',
      evidence: 'time 요소, article:published_time, 본문 날짜 패턴이 없습니다.',
      aiImpact: '최신성을 판단할 수 없어 시의성 있는 답에서 밀릴 수 있습니다.',
      quote: null,
      points: 3,
      rec: {
        workType: 'content',
        task: 'visible한 게시일/수정일을 넣고 datetime 속성을 주세요.',
        expectedEffect: '최신성 신호가 생깁니다.',
        difficulty: '낮음',
        before: '날짜 없음',
        after: '<time datetime="2026-08-26">2026년 8월 26일</time>',
      },
    })
  }
  if (s.externalLinkCount === 0 && NUMBER_RE.test(s.mainText)) {
    bad.push({
      severity: 'medium',
      title: '수치·주장이 있어도 외부 출처 링크가 없습니다',
      evidence: `본문에 숫자 패턴이 있으나 외부 링크 ${s.externalLinkCount}개.`,
      aiImpact: '검증 가능한 근거로 보기 어렵습니다.',
      quote: null,
      points: 3,
      rec: {
        workType: 'content',
        task: '수상, 통계, 파트너십은 1차 자료 또는 보도 원문에만 링크하세요. 없는 수치는 삭제하세요.',
        expectedEffect: '주장을 답변 근거로 쓰기 쉬워집니다.',
        difficulty: '중간',
        before: null,
        after: null,
      },
    })
  }
  if (!s.phoneOrEmail && !s.addressLike && !reference && !productLike) {
    bad.push({
      severity: 'medium',
      title: '연락처·회사 정보 투명성이 약합니다',
      evidence: '이메일/전화/주소형 텍스트가 추출되지 않았습니다.',
      aiImpact: '실제 조직인지 확인하는 신호가 부족합니다.',
      quote: null,
      points: 3,
      rec: {
        workType: 'content',
        task: '푸터에 법인명, 주소, 이메일, 전화를 텍스트로 두세요. 이미지 로고만으로 대체하지 마세요.',
        expectedEffect: '발행 주체 신뢰가 올라갑니다.',
        difficulty: '낮음',
        before: null,
        after: null,
      },
    })
  }
  if (s.ymyl) {
    const expert = s.reviewOrDisclaimer || /검토|전문의|자격|면책|reviewed|licensed|disclaimer/i.test(s.mainText)
    if (!expert) {
      bad.push({
        severity: 'high',
        title: '민감 주제인데 전문가 검토·책임 범위가 없습니다',
        evidence: '의료·법률·금융 관련 신호가 있으나 검토자·면책이 확인되지 않았습니다.',
        aiImpact: 'YMYL 답변에서 출처로 채택될 가능성이 크게 떨어집니다.',
        quote: null,
        points: 5,
        rec: {
          workType: 'content',
          task: '자격 있는 검토자, 적용 범위, 면책, 근거 문헌을 본문에 명시하세요.',
          expectedEffect: '고위험 주제에 대한 인용 장벽이 낮아집니다.',
          difficulty: '중간',
          before: null,
          after: null,
        },
      })
    }
  }

  const start = 16
  return finish('trust', good, bad, start, recs)
}

function scoreCitability(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  const defs = definitionSentences(s)
  const hasNumbers = NUMBER_RE.test(s.mainText)
  if (defs.length) {
    good.push({
      title: '독립적으로 읽히는 정의형 문장이 있습니다',
      evidence: `후보 ${defs.length}개.`,
      quote: clip(defs[0], 110),
    })
  }
  if (hasNumbers) {
    good.push({
      title: '구체적인 수치가 본문에 있습니다',
      evidence: '숫자·단위 패턴이 확인되었습니다. 출처 여부는 신뢰 영역에서 별도 평가합니다.',
      quote: quoteFrom(s, NUMBER_RE),
    })
  }
  if (s.tableCount || s.faqLike) {
    good.push({
      title: '재사용 가능한 정보 단위가 있습니다',
      evidence: `표 ${s.tableCount}, FAQ형 ${s.faqLike ? '있음' : '없음'}.`,
      quote: null,
    })
  }

  if (!defs.length) {
    const home = isHomePage(s)
    bad.push({
      severity: home ? 'medium' : 'high',
      title: '한두 문장으로 자를 명확한 답이 약합니다',
      evidence: home
        ? '홈·허브 페이지라 기사형 정의 단문이 적습니다.'
        : '정의형·완결형 단문이 본문에서 거의 잡히지 않았습니다.',
      aiImpact: '모델을 일반론으로 요약하게 만들고 출처 필요성이 줄어듭니다.',
      quote: clip(s.firstText, 90) || null,
      points: home ? 2 : 5,
      rec: {
        workType: 'content',
        task: '각 핵심 질문에 대해 주어+서술어가 완전한 40~90자 문장을 섹션 첫머리에 두세요.',
        expectedEffect: '문장 단위 인용이 가능해집니다.',
        difficulty: '낮음',
        before: clip(s.firstText, 70),
        after: null,
      },
    })
  }
  if (!hasNumbers && s.wordCount > 80) {
    bad.push({
      severity: 'medium',
      title: '검증 가능한 고유 수치가 없습니다',
      evidence: '본문에 단위를 가진 숫자가 거의 없습니다.',
      aiImpact: '어디서나 볼 수 있는 일반론으로 분류되기 쉽습니다.',
      quote: null,
      points: 4,
      rec: {
        workType: 'content',
        task: '이미 확인된 운영 수치·사례만 출처와 함께 넣으세요. 없는 통계는 만들지 마세요.',
        expectedEffect: '페이지가 다른 요약과 구별됩니다.',
        difficulty: '중간',
        before: null,
        after: null,
      },
    })
  }
  if (!s.tableCount && !s.faqLike && s.listCount < 2) {
    bad.push({
      severity: 'low',
      title: '비교표·체크리스트·절차 블록이 부족합니다',
      evidence: '표·FAQ·목록이 적어 재사용 단위가 약합니다.',
      aiImpact: '답변에 표나 단계로 붙일 조각이 없습니다.',
      quote: null,
      points: 2,
      rec: {
        workType: 'content',
        task: '제품 비교 또는 도입 절차를 3~5단계 목록으로 정리하세요. 있는 사실만 쓰세요.',
        expectedEffect: '답변이 구조화된 조각을 가져갈 수 있습니다.',
        difficulty: '낮음',
        before: null,
        after: null,
      },
    })
  }

  const start = 15
  return finish('citability', good, bad, start, recs)
}

function scoreEntity(
  s: PageSignals,
  recs: RecBag,
): CategoryResult {
  const good: Finding[] = []
  const bad: Deduction[] = []
  if (s.orgCandidates.length || s.ogSiteName) {
    good.push({
      title: '발행 주체 명칭 후보가 있습니다',
      evidence: [...s.orgCandidates, s.ogSiteName].filter(Boolean).slice(0, 3).join(', '),
      quote: s.ogSiteName || s.orgCandidates[0] || null,
    })
  }
  if (s.aboutOrContactLinks.length) {
    good.push({
      title: '소개·문의 내부 링크가 있습니다',
      evidence: s.aboutOrContactLinks.slice(0, 5).join(', '),
      quote: s.aboutOrContactLinks[0] ?? null,
    })
  }

  const names = uniqueNames(s)
  if (names.length >= 3) {
    bad.push({
      severity: 'high',
      title: '브랜드·조직 명칭이 한 페이지에서 갈립니다',
      evidence: `서로 다른 명칭 후보: ${names.slice(0, 6).join(', ')}`,
      aiImpact: '동일 조직을 여러 엔터티로 쪼개거나 다른 기업과 혼동할 수 있습니다.',
      quote: names[0] ?? null,
      points: 3,
      rec: {
        workType: 'content',
        task: '공식 한글명·영문명·법인명을 각각 하나씩 정해 title·H1·푸터·본문에 동일하게 쓰세요.',
        expectedEffect: '엔터티 연결이 안정됩니다.',
        difficulty: '낮음',
        before: names.slice(0, 4).join(' / '),
        after: null,
      },
    })
  }
  if (!s.aboutOrContactLinks.length) {
    bad.push({
      severity: 'medium',
      title: '소개·작성자·연락 경로가 약합니다',
      evidence: 'About/Contact/회사소개형 링크 텍스트가 없습니다.',
      aiImpact: '주제와 발행 주체를 다른 페이지로 확인해 잇기 어렵습니다.',
      quote: null,
      points: 2,
      rec: {
        workType: 'dev',
        task: '회사 소개, 연락처로 가는 텍스트 링크를 본문 또는 푸터에 두세요.',
        expectedEffect: '엔터티 확인 경로가 생깁니다.',
        difficulty: '낮음',
        before: null,
        after: null,
      },
    })
  }
  if (
    !s.jsonLdTypes.some((t) => /organization|person|article|webpage|website|techarticle/i.test(t)) &&
    !s.ogSiteName &&
    !s.orgCandidates.length
  ) {
    bad.push({
      severity: 'low',
      title: 'Organization/Person 구조화 정보가 없습니다',
      evidence: s.jsonLdTypes.length ? s.jsonLdTypes.join(', ') : 'JSON-LD 없음.',
      aiImpact: '브랜드 필드를 스키마로 고정하지 못합니다.',
      quote: null,
      points: 1,
      rec: {
        workType: 'dev',
        task: '페이지에 이미 보이는 조직 정보만 Organization으로 마크업하세요.',
        expectedEffect: '이름·주소·URL이 기계 필드로 연결됩니다.',
        difficulty: '낮음',
        before: null,
        after: null,
      },
    })
  }

  const start = 8
  return finish('entity', good, bad, start, recs)
}

function uniqueNames(s: PageSignals): string[] {
  const raw = [s.ogSiteName, ...s.orgCandidates]
    .map((v) => v.replace(/\s+/g, ' ').trim())
    .filter((v) => v.length >= 2 && v.length <= 40)
  const set = new Set<string>()
  for (const n of raw) {
    if (![...set].some((x) => x.includes(n) || n.includes(x))) set.add(n)
  }
  return [...set]
}

function severityRank(s: Severity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s]
}

function allDeductions(categories: CategoryResult[]): IssueFinding[] {
  return categories.flatMap((c) => c.issues)
}

function buildSuggestions(s: PageSignals, topic: string): ContentSuggestions {
  const brand = s.ogSiteName || s.orgCandidates[0] || s.title.split(/[|\-–·]/)[0]?.trim() || '이 조직'
  const what = topic || s.h1s[0] || s.title || '제공하는 서비스'
  const title = `${brand} | ${clip(what, 40)}`
  const h1 = `${brand} — ${clip(what, 48)}`
  const base = s.firstText || s.mainText
  const summarySource = clip(base.replace(HYPE_RE, '').trim(), 280)
  const outline = [
    'H2 한 줄로 보는 정의',
    'H2 제공하는 것',
    'H3 핵심 제품 또는 서비스 1',
    'H3 핵심 제품 또는 서비스 2',
    'H2 근거·사례 (확인된 사실만)',
    'H2 회사·연락처',
    'H2 자주 묻는 질문 (추가한 뒤에만 FAQ 마크업)',
  ]
  const faqs = [
    {
      question: `${brand}는 무엇을 하나요?`,
      answer: clip(summarySource || `${brand}의 역할은 이 페이지 본문에 확인된 범위에서만 서술하세요.`, 160),
    },
    {
      question: '어디에 문의하나요?',
      answer: s.phoneOrEmail
        ? '페이지에 있는 전화·이메일 정보를 그대로 안내하세요.'
        : '확인된 공식 연락 채널을 본문에 추가한 뒤 답하세요.',
    },
    {
      question: '누가 운영하나요?',
      answer: s.orgCandidates[0]
        ? `${s.orgCandidates[0]}이(가) 이 페이지의 발행 주체 후보입니다.`
        : '법인명과 역할을 본문에 명시한 뒤 답하세요.',
    },
  ]
  const schema: string[] = []
  if (s.phoneOrEmail || s.addressLike || s.orgCandidates.length) schema.push('Organization (이름·URL·이미 보이는 주소/전화/이메일만)')
  schema.push('WebPage / WebSite (title, url, inLanguage)')
  if (s.faqLike) schema.push('FAQPage (화면에 실제로 있는 질문만)')
  if (s.jsonLdTypes.some((t) => /article|news/i.test(t)) || /뉴스|보도/i.test(s.h2s.join(' '))) {
    schema.push('NewsArticle (headline, datePublished — 본문에 날짜가 있을 때만)')
  }
  return {
    title,
    h1,
    summary: summarySource || `${brand}에 대해 확인된 사실만 40~70단어로 적으세요. 없는 수치는 넣지 마세요.`,
    outline,
    faqs,
    sourcesToAdd: [
      s.dates.length ? '페이지 수정일을 visible하게 유지' : '게시일·수정일 표시',
      s.authorCandidates.length ? '작성자 역할·전문성 한 줄' : '작성자 또는 대변 조직 명시',
      '수상·통계를 쓸 경우 1차 출처 URL',
    ],
    schemaTypes: schema,
  }
}

function citableFrom(s: PageSignals): string[] {
  const defs = definitionSentences(s).filter((line) => !isBoilerplateText(line))
  const extras: string[] = []
  if (s.addressLike) {
    const m = s.mainText.match(/.{0,12}(시|구|로 \d).{0,40}/)
    if (m && !/wikipedia/i.test(m[0])) extras.push(clip(m[0], 140))
  }
  const merged = uniqueKeep([...defs, ...extras]).slice(0, 3)
  const opener = s.firstText.replace(/this (article|page) (needs|may).{0,80}/i, '').trim()
  while (merged.length < 3 && opener && !isBoilerplateText(opener) && !/part of a series/i.test(opener)) {
    merged.push(clip(opener, 120))
    break
  }
  return merged.slice(0, 3)
}

function uniqueKeep(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const i of items) {
    const k = i.trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

const TOPIC_STOP = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'of',
  'and',
  'or',
  'in',
  'on',
  'with',
  'welcome',
  'home',
  'official',
  '사이트',
  '홈',
])

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/www\./g, '')
    .replace(/[^a-z0-9가-힣.]+/gi, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/\.(org|com|io|ai|net)$/i, ''))
    .filter((token) => token.length >= 3 && !TOPIC_STOP.has(token))
}

function topicsAlign(a: string, b: string): boolean {
  const left = new Set(significantTokens(a))
  const right = significantTokens(b)
  if (!left.size || !right.length) return false
  return right.some((token) => left.has(token) || [...left].some((item) => item.includes(token) || token.includes(item)))
}

function titleTopic(s: PageSignals): string {
  let raw = s.title.trim()
  raw = raw.replace(/\s*[-–|]\s*(Wikipedia|위키백과).*$/i, '')
  raw = raw.replace(/^Welcome to\s+/i, '')
  raw = raw.replace(/\s*[-–|·].*$/, '').trim()
  return raw || s.ogTitle || s.ogSiteName || ''
}

export function inferTopic(s: PageSignals, provided: string): { topic: string; inferred: boolean } {
  if (provided.trim()) return { topic: provided.trim(), inferred: false }
  const fromTitle = titleTopic(s)
  const h1 = s.h1s[0] ?? ''
  if (fromTitle && h1 && !topicsAlign(fromTitle, h1)) return { topic: fromTitle, inferred: true }
  if (h1 && h1.length >= 4) return { topic: h1, inferred: true }
  if (fromTitle) return { topic: fromTitle, inferred: true }
  return { topic: '확인 불가', inferred: true }
}

function inferAudience(s: PageSignals, provided: string): { audience: string; inferred: boolean } {
  if (provided.trim()) return { audience: provided.trim(), inferred: false }
  if (/기업|B2B|엔터프라이즈|솔루션/i.test(s.mainText)) return { audience: '기업 의사결정자·실무 담당자 (본문에서 추론)', inferred: true }
  if (/소상공인|자영업|로컬/i.test(s.mainText)) return { audience: '소상공인·로컬 비즈니스 (본문에서 추론)', inferred: true }
  return { audience: '확인 불가 — 페이지에서 독자가 명시되지 않음', inferred: true }
}

function applyTypeWeights(categories: CategoryResult[], pageType: PageSignals['pageType']): CategoryResult[] {
  const weights = PAGE_TYPE_WEIGHTS[pageType]
  return categories.map((c) => {
    const defMax = CATEGORY_DEFS.find((d) => d.id === c.id)!.max
    const typeMax = weights[c.id]
    if (c.score === 'unknown') return { ...c, maxScore: typeMax }
    return {
      ...c,
      score: clamp((c.score / defMax) * typeMax, 0, typeMax),
      maxScore: typeMax,
    }
  })
}

export function rankRecommendations(bag: RecBag): Recommendation[] {
  const difficultyRank = { 낮음: 0, 중간: 1, 높음: 2 } as const
  const sorted = [...bag].sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity)
    if (s) return s
    if (b.points !== a.points) return b.points - a.points
    return difficultyRank[a.rec.difficulty] - difficultyRank[b.rec.difficulty]
  })
  const seen = new Set<string>()
  const out: Recommendation[] = []
  for (const item of sorted) {
    const key = item.rec.task.slice(0, 96)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ priority: out.length + 1, ...item.rec })
    if (out.length >= 10) break
  }
  return out
}

export function unevaluableReport(
  url: string,
  failure: AeoReport['accessFailure'],
  limitations: string[] = [],
): AeoReport {
  return {
    url,
    analyzedAt: new Date().toISOString(),
    pageTitle: '확인 불가',
    coreTopic: '확인 불가',
    topicInferred: false,
    audience: '확인 불가',
    audienceInferred: false,
    collectionMode: 'static',
    accessStatus: 'failed',
    accessFailure: failure,
    overallScore: null,
    grade: null,
    oneLiner: '본문을 확인하지 못해 점수를 부여하지 않습니다.',
    categories: CATEGORY_DEFS.map((c) => unknownCategory(c.id, '본문 미확인 — 점수 없음')),
    strengths: [],
    problems: [],
    recommendations: [],
    contentSuggestions: null,
    citableSentences: [],
    verdict: null,
    limitations,
    disclaimer: DISCLAIMER,
    source: 'heuristic',
    pageType: 'other',
    bodyWordCount: null,
  }
}

export function evaluateAeo(s: PageSignals, context: AuditContext = DEFAULT_AUDIT_CONTEXT): AeoReport {
  const httpFail = s.status < 200 || s.status >= 400 || Boolean(s.fetchError)
  const noBody = s.wordCount < 20 && (s.spaShell || s.iframeOnly || httpFail)

  if (s.fetchError && !s.status) {
    return unevaluableReport(
      s.requestedUrl,
      {
        status: '수집 실패',
        cause: s.fetchError,
        technical: '프록시가 HTML을 반환하지 못했습니다.',
        neededFromUser: '본문 HTML, 또는 접근 가능한 공개 URL, 필요 시 스크린샷.',
        howToRetry: 'URL이 공개 HTTPS인지 확인한 뒤 다시 진단하세요. 로그인 페이지면 공개 요약 URL을 주세요.',
      },
      ['페이지 HTML을 가져오지 못해 콘텐츠 점수를 만들지 않았습니다.'],
    )
  }

  const recs: RecBag = []
  const accessibility = scoreAccessibility(s, recs)
  if (httpFail || noBody) {
    const others = CATEGORY_DEFS.filter((c) => c.id !== 'accessibility').map((c) =>
      unknownCategory(c.id, '본문을 신뢰할 수 없어 채점하지 않음'),
    )
    return {
      url: s.requestedUrl,
      analyzedAt: new Date().toISOString(),
      pageTitle: s.title || '확인 불가',
      coreTopic: '확인 불가',
      topicInferred: false,
      audience: '확인 불가',
      audienceInferred: false,
      collectionMode: s.collectionMode,
      accessStatus: 'failed',
      accessFailure: {
        status: `HTTP ${s.status || '없음'}`,
        cause: s.fetchError || (noBody ? '본문 텍스트가 거의 없습니다' : `HTTP ${s.status}`),
        technical: `finalUrl=${s.finalUrl}, contentType=${s.contentType}, words=${s.wordCount}`,
        neededFromUser: '렌더된 본문 HTML 또는 스크린샷, 공개 접근 가능한 URL',
        howToRetry: '200 응답의 공개 페이지 URL로 다시 제출하세요.',
      },
      overallScore: null,
      grade: null,
      oneLiner: '접근 실패 또는 본문 부재로 콘텐츠 점수를 만들지 않았습니다.',
      categories: [accessibility, ...others],
      strengths: accessibility.positives.slice(0, 3),
      problems: accessibility.issues.slice(0, 5).map((issue, i) => ({
        rank: i + 1,
        severity: issue.severity,
        categoryId: 'accessibility',
        title: issue.title,
        evidence: issue.evidence,
        aiImpact: issue.aiImpact,
        quote: issue.quote,
      })),
      recommendations: rankRecommendations(recs),
      contentSuggestions: null,
      citableSentences: [],
      verdict: null,
      limitations: [
        '접근 실패를 콘텐츠 품질 감점으로 처리하지 않았습니다.',
        '확인 불가 영역 점수는 unknown이며 overall_score는 null입니다.',
      ],
      disclaimer: DISCLAIMER,
      source: 'heuristic',
      pageType: s.pageType,
      bodyWordCount: s.wordCount,
    }
  }

  /** example.com 같은 스텁·IANA 예제 도메인은 제품 페이지처럼 채점하지 않는다. */
  const thinBody = s.wordCount < 50
  if (thinBody) {
    const placeholder = isPlaceholderHost(s.requestedUrl) || isPlaceholderHost(s.finalUrl)
    if (placeholder) {
      recs.length = 0
      recs.push({
        severity: 'high',
        points: 10,
        rec: {
          workType: 'content',
          task: 'IANA가 문서용으로 예약한 example.com이 아니라, 실제 공개 서비스 URL로 다시 진단하세요.',
          expectedEffect: '인용 준비도 총점과 영역 점수를 만들 수 있습니다.',
          difficulty: '낮음',
          before: clip(s.mainText, 80) || '(예제 본문)',
          after: null,
        },
      })
    } else {
      recs.push({
        severity: 'high',
        points: 10,
        rec: {
          workType: 'content',
          task: '본문을 최소 80단어 이상으로 늘리세요. 플레이스홀더 한 단락만으로는 인용 준비도를 채점하지 않습니다.',
          expectedEffect: '질문 대응·신뢰·인용 영역을 채점할 수 있게 됩니다.',
          difficulty: '중간',
          before: clip(s.mainText, 80) || '(본문 거의 없음)',
          after: null,
        },
      })
    }
    const { topic, inferred } = inferTopic(s, context.topicOrQuery)
    const aud = inferAudience(s, context.audience)
    const rankedRecs = rankRecommendations(recs)
    const access = placeholder
      ? {
          ...accessibility,
          issues: [],
          positives: [],
          score: 'unknown' as const,
          judgment: 'IANA 예제 도메인. 페이지는 응답하지만 콘텐츠 준비도는 채점하지 않습니다.',
        }
      : accessibility
    const categories = applyTypeWeights(
      [
        access,
        ...CATEGORY_DEFS.filter((c) => c.id !== 'accessibility').map((c) =>
          unknownCategory(c.id, placeholder ? '예제 도메인이라 채점하지 않음' : '본문이 짧아 채점하지 않음'),
        ),
      ],
      s.pageType,
    )
    const grade = placeholder ? '예제 도메인 · 채점 대상 아님' : '본문 부족 · 채점 제한'
    const blocker = placeholder
      ? 'IANA 예제 도메인이라 서비스 페이지로 채점하지 않습니다'
      : '본문이 채점 기준에 미달합니다'
    return {
      url: s.requestedUrl,
      analyzedAt: new Date().toISOString(),
      pageTitle: s.title || '(제목 없음)',
      coreTopic: topic,
      topicInferred: inferred,
      audience: aud.audience,
      audienceInferred: aud.inferred,
      collectionMode: s.collectionMode,
      accessStatus: 'ok',
      accessFailure: null,
      overallScore: null,
      grade,
      oneLiner: placeholder
        ? 'example.com은 RFC 문서용으로 예약된 도메인입니다. 접근은 되지만 AEO 총점은 부여하지 않습니다.'
        : '페이지는 열리지만 본문이 너무 짧아 AEO 준비도 총점을 부여하지 않습니다.',
      categories,
      strengths: placeholder ? [] : access.positives.slice(0, 3),
      problems: [
        {
          rank: 1,
          severity: 'high',
          categoryId: 'answer_content',
          title: blocker,
          evidence: placeholder
            ? `추출 단어 약 ${s.wordCount}개. IANA example.com 계열은 문서 예시용이라 제품 개선 대상으로 보지 않습니다.`
            : `추출 단어 약 ${s.wordCount}개. 80단어 미만이면 질문 대응·신뢰·인용 점수를 만들지 않습니다.`,
          aiImpact: placeholder
            ? '예제 도메인 점수를 실제 사이트 벤치마크로 쓰면 진단이 왜곡됩니다.'
            : '스텁 페이지를 실제 서비스처럼 개선 대상으로 오해하게 됩니다.',
          quote: clip(s.mainText, 90) || null,
        },
      ],
      recommendations: rankedRecs,
      contentSuggestions: null,
      citableSentences: [],
      verdict: {
        readiness: grade,
        biggestStrength: access.positives[0]?.title ?? '페이지가 응답합니다',
        biggestBlocker: blocker,
        firstAction: rankedRecs[0]?.task ?? '실제 공개 URL로 다시 진단하세요.',
        scoreRangeIfFixed: placeholder
          ? '예제 도메인에는 점수를 추정하지 않습니다. 실제 페이지 URL로 다시 제출하세요.'
          : '본문이 충분해진 뒤에 다시 채점하세요. 지금은 점수를 추정하지 않습니다.',
      },
      limitations: [
        placeholder
          ? 'IANA 예제 도메인(example.com 등)은 총점과 콘텐츠 영역 점수를 부여하지 않습니다.'
          : '본문이 50단어 미만이라 총점과 콘텐츠 영역 점수를 부여하지 않았습니다.',
        '제품 목차·FAQ 초안은 본문이 충분한 실제 페이지에만 제안합니다.',
        s.collectionMode === 'browser'
          ? 'JavaScript 실행 후 사용자에게 표시되는 본문을 기준으로 분석했습니다.'
          : '정적 HTML을 기준으로 분석했습니다. 지연 로딩 영역은 포함되지 않을 수 있습니다.',
      ],
      disclaimer: DISCLAIMER,
      source: 'heuristic',
      pageType: s.pageType,
      bodyWordCount: s.wordCount,
    }
  }

  const categories = applyTypeWeights(
    [
      accessibility,
      scoreAnswer(s, recs),
      scoreStructure(s, recs),
      scoreTrust(s, recs),
      scoreCitability(s, recs),
      scoreEntity(s, recs),
    ],
    s.pageType,
  )
  const numeric = categories.map((c) => c.score).filter((n): n is number => typeof n === 'number')
  const overall = numeric.length === 6 ? numeric.reduce((a, b) => a + b, 0) : null
  const { topic, inferred } = inferTopic(s, context.topicOrQuery)
  const aud = inferAudience(s, context.audience)

  const issues = allDeductions(categories).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  )
  const problems: TopIssue[] = issues.slice(0, 5).map((issue, i) => ({
    rank: i + 1,
    severity: issue.severity,
    categoryId: categories.find((c) => c.issues.includes(issue))?.id ?? 'structure',
    title: issue.title,
    evidence: issue.evidence,
    aiImpact: issue.aiImpact,
    quote: issue.quote,
  }))

  const strengths = categories.flatMap((c) => c.positives).slice(0, 5)
  const rankedRecs = rankRecommendations(recs)
  const suggestions = buildSuggestions(s, topic)
  const citables = citableFrom(s)
  const grade = scoreBand(overall)
  const oneLiner =
    problems[0] && strengths[0]
      ? `${strengths[0].title} 그러나 ${problems[0].title.toLowerCase()}.`
      : strengths[0]?.title || problems[0]?.title || '수집은 되었으나 인용 단위가 분명하지 않습니다.'

  return {
    url: s.requestedUrl,
    analyzedAt: new Date().toISOString(),
    pageTitle: s.title || '(제목 없음)',
    coreTopic: topic,
    topicInferred: inferred,
    audience: aud.audience,
    audienceInferred: aud.inferred,
    collectionMode: s.collectionMode,
    accessStatus: 'ok',
    accessFailure: null,
    overallScore: overall,
    grade,
    oneLiner,
    categories,
    strengths,
    problems,
    recommendations: rankedRecs,
    contentSuggestions: suggestions,
    citableSentences: citables,
    verdict: {
      readiness: grade ? `${grade}${overall !== null ? ` (${overall}/100)` : ''}` : '확인 불가',
      biggestStrength: strengths[0]?.title ?? '확인된 강점 부족',
      biggestBlocker: problems[0]?.title ?? '치명 장애 없음',
      firstAction: rankedRecs[0]?.task ?? 'title·H1·정의 문단을 한 세트로 고정하세요.',
      scoreRangeIfFixed:
        overall === null
          ? '확인 불가'
          : `개선안을 충실히 반영하면 약 ${Math.min(100, overall + 18)}~${Math.min(100, overall + 28)}점 구간까지는 합리적입니다. 실제 인용·순위를 보장하지 않습니다.`,
    },
    limitations: [
      '이 결과는 휴리스틱 채점입니다. LLM 키가 있으면 같은 프롬프트로 재평가할 수 있습니다.',
      s.collectionMode === 'browser'
        ? 'JavaScript 실행 후 사용자에게 표시되는 본문을 기준으로 분석했습니다.'
        : '정적 HTML을 기준으로 분석했습니다. 지연 로딩 영역은 포함되지 않을 수 있습니다.',
      '검색엔진 색인 건수와 실제 AI 답변 인용 이력은 확인하지 않습니다.',
      s.renderWarning ?? '',
      s.robotsTxtStatus === 404 ? 'robots.txt는 404라 기본 허용으로 해석했습니다.' : '',
      context.competitorUrls.length === 0 ? '경쟁 URL이 없어 비교 채점은 하지 않았습니다.' : '',
    ].filter(Boolean),
    disclaimer: DISCLAIMER,
    source: 'heuristic',
    pageType: s.pageType,
    bodyWordCount: s.wordCount,
  }
}
