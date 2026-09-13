import type { ActionStateMap, ActionStatus } from './api'
import { blogPlatformOf } from './blogPlatforms'
import { objectParticle, subjectParticle } from './korean'
import { siteGroupKey } from './siteGroup'
import { computeQuestionWinLoss, type WinLossRow } from './questionWinLoss'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

/**
 * 격차 → 실행 항목.
 *
 * 격차 분석은 "어디가 비어 있나"까지 말한다. 그 다음 질문은 늘 같다 — **그래서 뭘 하지?**
 * 여기서 그 답을 목록으로 만든다. 새 수집·판정 호출 없이, 이미 저장된 분석(B5)과
 * 인용 출처(B7)를 조인해서 계산한다.
 *
 * 두 종류만 낸다. 데이터가 그 둘만 뒷받침하기 때문이다.
 *
 *   listing  AI가 답을 찾으러 가는 **외부 도메인인데 우리가 없는** 곳 → 등재·기고.
 *            출처: B7 인용 URL. 실측(k-wonjin 2026-W37): 인용 49건 / 도메인 33개 중
 *            우리 것은 k-wonjin.co.kr 하나뿐이고 나머지는 커뮤니티·블로그였다.
 *   content  **밀린 질문 유형** → 그 주제를 다루는 우리 콘텐츠가 없다는 뜻이다.
 *            출처: B5 질문별 승패의 '패' 판정.
 *
 * ── 완료를 저장하지 않는 이유 ────────────────────────────────────────────────
 * 완료는 사람이 체크하는 값이 아니라 **데이터에서 읽는 값**이다. 등재가 실제로 되면
 * 그 도메인의 인용이 우리 언급을 뒷받침하기 시작한다(supportingBrandMentionCount > 0).
 * 그래서 satisfied는 매번 계산한다. 사람이 적어 넣은 '완료'와 실제 노출이 어긋나는
 * 상태를 아예 만들지 않는다.
 *
 * 굳이 이렇게 하는 건 언급률로는 개별 조치를 평가할 수 없기 때문이다. 측정 하나의
 * 표준오차가 9.66%p(36문항×1회)라 두 주차 차이의 표준오차는 약 13.7%p다. 조치 하나가
 * 그만큼 움직일 리 없으니 "이 조치가 효과 있었나"를 언급률로 물으면 영원히 답이 안 나온다.
 * 인용 획득은 이진값이라 그 문제가 없다 — URL이 뜨면 된 것이다.
 */

export type ActionKind = 'listing' | 'content'
export type { ActionStatus }

export interface GapAction {
  /**
   * 주차가 바뀌어도 **같은 조치는 같은 id**를 갖는다. 진행 상태를 여러 주에 걸쳐
   * 붙들려면 안정적인 키가 있어야 한다. 질문 집합은 주마다 달라지므로 키에 넣지 않는다.
   */
  id: string
  kind: ActionKind
  title: string
  /**
   * 화면 배지에 쓸 짧은 말. listing이라고 다 같은 일이 아니다 — 언론사에 "등재"할 수는 없다.
   * 출처 종류마다 실제로 하는 일이 달라서 그 말을 여기서 정한다.
   */
  badge: string
  /** 왜 이게 목록에 올라왔는지 — 화면이 근거를 그대로 보여줄 수 있게 문장으로. */
  evidence: string
  /** 등재형일 때 목표 도메인. 완료 판정의 대상이다. */
  targetDomain?: string
  /** 이 조치가 겨냥하는 밀린 질문들(최대 5개까지 텍스트를 함께 싣는다). */
  questionIds: string[]
  questionTexts: string[]
  /** 우선순위 근거 — 등재형은 그 도메인 인용 수, 콘텐츠형은 밀린 질문 수. */
  reach: number
  /** 데이터가 이미 충족했다고 말하는가. true면 사람이 할 일이 남지 않았다. */
  satisfied: boolean
  /**
   * 사람이 적은 **집행 상태**. satisfied와 다른 질문에 답한다 —
   * status는 "내가 그 일을 했나", satisfied는 "AI가 우리를 거기서 보나".
   * 둘을 갈라 두면 **집행했는데 몇 주째 충족이 안 되는 항목**이 저절로 드러난다.
   */
  status: ActionStatus
  /** 집행하고 올린 글 주소(사람이 적는다). */
  publishedUrls: string[]
  /**
   * 그중 이번 주 인용에 실제로 등장한 주소.
   *
   * 충족 판정은 도메인 단위라 "그 사이트에서 우리가 보인다"까지만 말한다. 우리가 올린 글이
   * 인용된 건지 그 사이트의 다른 글이 인용된 건지는 구분하지 못한다. 주소를 맞추면 그제서야
   * 집행한 일과 결과가 이어진다.
   */
  citedPublishedUrls: string[]
  /** status를 정한 시점의 주차 — 집행 후 얼마나 지났는지 세는 데 쓴다. */
  markedWeek?: string
  /** 무엇이 관측되면 완료인지 — 화면과 사람이 같은 기준을 보게 한다. */
  doneSignal: string
  /**
   * 지분으로 보는 항목(블로그 플랫폼)의 현재 위치. 디렉터리·위키처럼 "실렸다/안 실렸다"가
   * 아니라 "인용 M회 중 N회가 우리를 뒷받침"인 자리라 satisfied가 켜지지 않는다 — 대신 이 값이
   * 움직인다. 화면이 비율을 그대로 보여 준다.
   */
  progress?: { supporting: number; total: number }
}

export interface GapActionPlan {
  actions: GapAction[]
  /** 아직 남은 것 / 데이터가 충족을 확인한 것. 화면 요약용. */
  openCount: number
  satisfiedCount: number
  /** 집행했다고 적었는데 데이터가 아직 확인하지 못한 항목 수. */
  awaitingCount: number
  /** 보류로 내려둔 항목 수 — 목록에서 사라진 게 아니라 아래로 내려갔음을 밝히려고 센다. */
  skippedCount: number
  /**
   * 경쟁사 소유라 등재 대상이 될 수 없는 도메인 수. 실행 항목에서 빠지지만
   * "왜 저 도메인은 목록에 없나"에 답해야 해서 센다.
   */
  competitorDomainCount: number
  /**
   * 등재 제안을 하지 않은 도메인 수(other·blog·gov). 알려진 호스트 목록에 없거나,
   * 있어도 우리가 글을 올릴 수 없는 곳이다 — LISTING_PLAY 주석 참고.
   */
  excludedLowConfidence: number
}

const CATEGORY_LABEL: Record<string, string> = {
  'category-agnostic': '카테고리 무관',
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격·사양',
  'troubleshooting-review': '문제해결·후기',
  'local-regional': '지역',
}

/**
 * 출처 종류별로 **실제로 하는 일**과 그 말 — 그리고 이게 곧 등재 제안 **허용 목록**이다.
 * 금지 목록이 아니다. 할 말이 정해진 종류만 목록에 올린다(LISTABLE_KINDS = 이 표의 키).
 *
 * ── 왜 종류마다 말이 다른가 ──────────────────────────────────────────────────
 * 전부 "등재"로 적었더니 health.chosun.com에 등재하라는 카드가 나왔다. 언론사에 등재하는
 * 방법은 없다 — 보도자료를 내거나 기고를 한다. 나무위키는 등재가 아니라 문서를 고치는
 * 일이고, 디시·더쿠는 그 판에서 언급되게 만드는 일이다. 같은 단어를 쓰면 목록을 받은
 * 사람이 무엇을 해야 할지 다시 생각해야 한다.
 *
 * ── 왜 이 다섯 종류만인가 ────────────────────────────────────────────────────
 * 전부 호스트 카탈로그로만 붙는 라벨이다(NEWS_HOSTS·WIKI_HOSTS·REVIEW_HOSTS·
 * FORUM_HOSTS·SOCIAL_HOSTS). 라벨이 붙었다면 그 종류가 맞다.
 *
 * news는 한동안 뺐었다. classifyCitationSourceKind에 폴백이 있어 판정이 "권위 있어
 * 보인다"고만 해도 news가 붙었고, 그대로 쓰면 다른 성형외과 홈페이지에 "등재하세요"가 떴다
 * (처음 돌렸을 때 291건짜리 목록이 그렇게 나왔다). 그 폴백을 없앴으므로 이제 news는 믿는다.
 *
 * blog는 카탈로그로 걸러 되살렸다(blogPlatforms.ts). host.startsWith('blog.') 규칙 때문에
 * blog.21ps.co.kr 같은 **업체 자체 블로그**가 같은 라벨을 다는데, 거기엔 글을 올릴 수 없다.
 * 그래서 "누구나 계정을 만들어 발행할 수 있는 플랫폼"만 통과시키고 나머지 blog는 제외한다.
 * 플랫폼은 도메인이 아니라 **플랫폼 단위로 묶는다** — 티스토리는 글쓴이마다 서브도메인이 달라
 * 도메인마다 카드를 만들면 인용 1~4회짜리 목록 16줄이 된다(실측).
 *
 * gov는 라벨이 정확한데도 뺀다. 정확한 것과 실행 가능한 것은 다르다 — 실측에서 mohw.go.kr,
 * pubmed.ncbi.nlm.nih.gov에 "등재"가 떴는데 보건복지부나 PubMed에 병원이 등재할 방법은 없다.
 * AI가 공공 지침을 참고한다는 사실은 정보지만 그건 "그 지침에 콘텐츠를 맞춰라"는 **콘텐츠형**
 * 지시이지 등재형이 아니다. 할 수 없는 일이 섞이면 목록 전체를 안 믿게 된다.
 *   대가: medicaltour.gangnam.go.kr(강남구 의료관광, 이미 등재됨)도 함께 빠진다.
 *   실행 가능한 .go.kr 디렉터리를 되살리려면 그런 호스트만 모은 카탈로그가 필요하다.
 */
const LISTING_PLAY: Record<string, { verb: string; badge: string }> = {
  news: { verb: '보도·기고', badge: '언론' },
  wiki: { verb: '문서 보완', badge: '위키' },
  review: { verb: '등재', badge: '후기 플랫폼' },
  forum: { verb: '커뮤니티 노출', badge: '커뮤니티' },
  social: { verb: '채널 콘텐츠', badge: '소셜' },
  blog: { verb: '블로그 발행', badge: '블로그 플랫폼' },
}
const LISTABLE_KINDS = new Set(Object.keys(LISTING_PLAY))

/**
 * 도메인 표기를 맞춘다.
 *
 * 인용 출처 집계(server/citationSources.ts의 hostOf)와 **같은 규칙**이어야 한다. 한쪽이
 * `www.`를 떼고 다른 쪽이 안 떼면 도메인↔질문 조인이 조용히 빈 배열을 낸다 — 오류가 아니라
 * "이 도메인을 인용한 질문이 없다"는 거짓말로 나온다. 그래서 규칙을 여기 그대로 적어 둔다
 * (src는 server를 import하지 않는다).
 */
function normalizeHost(raw: string, fallbackDomain: string | null): string {
  if (fallbackDomain) return fallbackDomain.replace(/^www\./, '').toLowerCase()
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return (raw.split('/')[0] ?? raw).replace(/^www\./, '').toLowerCase()
  }
}

/**
 * 도메인 → 그 도메인을 인용한 질문들.
 *
 * 등재 항목이 "reddit.com 커뮤니티 노출"까지만 말하면 받은 사람이 **무슨 내용을** 올려야
 * 할지 모른다. AI가 그 도메인을 꺼내 든 질문이 곧 그 답이다 — 저장된 분석에 질문별 인용이
 * 그대로 있으니 역인덱스만 만들면 새 호출 없이 나온다.
 */
function questionsByDomain(analyses: QuestionRepeatAnalysis[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const a of analyses) {
    for (const c of a.citations ?? []) {
      const host = normalizeHost(c.raw, c.domain)
      if (!host) continue
      const set = map.get(host) ?? new Set<string>()
      set.add(a.questionId)
      map.set(host, set)
    }
  }
  return map
}

/** 등재를 제안할 수 없는 출처. 경쟁사 사이트에는 우리가 실릴 수 없다. */
function isCompetitorOwned(kind: string, ownerType: string): boolean {
  return kind === 'competitor' || ownerType === 'competitor-owned'
}

/** 우리가 이미 가진 자산. 갭이 아니라 유지 대상이다. */
function isBrandOwned(kind: string, ownerType: string): boolean {
  return kind === 'brand-official' || ownerType === 'brand-owned'
}

/**
 * 등재형 항목. B7 인용 URL을 **도메인 단위로 접어서** 판단한다.
 *
 * URL 단위로 보면 안 된다. 한 도메인에 우리를 인용하는 URL과 아닌 URL이 섞여 있을 때
 * URL만 보면 "우리가 없는 곳"으로 잘못 잡힌다. 이미 실려 있는 도메인에 "등재하세요"를
 * 띄우는 건 목록의 신뢰를 깎는다. 그래서 도메인의 **모든** URL을 모아 지원 여부를 센다.
 */
function listingActions(
  citations: CitationSourceAnalysis | null,
  domainQuestions: Map<string, Set<string>>,
  rows: WinLossRow[],
): {
  actions: GapAction[]
  competitorDomainCount: number
  excludedLowConfidence: number
} {
  if (!citations || citations.urls.length === 0) {
    return { actions: [], competitorDomainCount: 0, excludedLowConfidence: 0 }
  }

  interface DomainRoll {
    /** 그룹 키 — 보통은 도메인, 블로그 플랫폼이면 플랫폼 키. */
    domain: string
    /** 이 그룹에 들어온 실제 호스트들 — 질문 색인을 합칠 때 쓴다. */
    hosts: Set<string>
    kind: string
    ownerType: string
    /** 블로그 플랫폼이면 그 정의(표시 문구·채널 메모). */
    platform: ReturnType<typeof blogPlatformOf>
    citationCount: number
    supporting: number
    engines: Set<string>
    sampleUrl: string
  }
  const byDomain = new Map<string, DomainRoll>()
  for (const u of citations.urls) {
    // 블로그는 발행 가능한 플랫폼만, 그것도 플랫폼 단위로 묶는다. 업체 자체 블로그는 키가 없어 빠진다.
    // 나머지는 **사이트 단위**(등록가능 도메인)로 묶는다 — nol.yanolja.com·place-site.yanolja.com·
    // yanolja.com이 세 카드로 쪼개져 '충족'과 "등재하세요"가 같이 뜨던 문제(siteGroup 주석 참고).
    const platform = u.kind === 'blog' ? blogPlatformOf(u.domain) : null
    const key = u.kind === 'blog' ? platform?.key : siteGroupKey(u.domain)
    if (!key) continue
    const roll = byDomain.get(key) ?? {
      domain: key,
      hosts: new Set<string>(),
      kind: u.kind,
      ownerType: u.ownerType,
      platform,
      citationCount: 0,
      supporting: 0,
      engines: new Set<string>(),
      sampleUrl: u.raw,
    }
    roll.hosts.add(u.domain)
    roll.citationCount += u.citationCount
    roll.supporting += u.supportingBrandMentionCount
    for (const e of u.engines) roll.engines.add(e)
    // 한 사이트 안에서 종류가 갈리면 **등재 가능한 쪽**을 택한다. 일부 페이지만 카탈로그에 걸리는
    // 경우(yanolja.com은 other, nol.yanolja.com은 review)에 사이트 전체를 놓치지 않기 위해서다.
    // 단 경쟁사·자사 소유는 한 멤버만 그래도 전체를 그렇게 본다 — 거기엔 실릴 수 없거나 이미 우리 것이다.
    if (isCompetitorOwned(u.kind, u.ownerType) || isBrandOwned(u.kind, u.ownerType)) {
      roll.kind = u.kind
      roll.ownerType = u.ownerType
    } else if (!LISTABLE_KINDS.has(roll.kind) && LISTABLE_KINDS.has(u.kind)) {
      roll.kind = u.kind
      roll.ownerType = u.ownerType
    }
    byDomain.set(key, roll)
  }

  // 제외 개수는 URL이 아니라 **도메인** 기준으로 센다(그룹 키로 접기 전 원본 도메인 수).
  const allDomains = new Set(citations.urls.map((u) => u.domain))
  const rolls = [...byDomain.values()]
  const competitorDomainCount = rolls.filter((r) => isCompetitorOwned(r.kind, r.ownerType)).length
  const listable = rolls.filter(
    (r) => !isCompetitorOwned(r.kind, r.ownerType) && !isBrandOwned(r.kind, r.ownerType) && LISTABLE_KINDS.has(r.kind),
  )
  const keptHosts = new Set(listable.flatMap((r) => [...r.hosts]))
  const competitorHosts = new Set(rolls.filter((r) => isCompetitorOwned(r.kind, r.ownerType)).flatMap((r) => [...r.hosts]))
  const brandHosts = new Set(rolls.filter((r) => isBrandOwned(r.kind, r.ownerType)).flatMap((r) => [...r.hosts]))
  const excludedLowConfidence = [...allDomains].filter(
    (d) => !keptHosts.has(d) && !competitorHosts.has(d) && !brandHosts.has(d),
  ).length

  // 질문 쪽 색인 — 도메인에 붙일 질문을 고를 때 쓴다. 밀린 질문이 먼저다.
  const rowById = new Map(rows.map((r) => [r.questionId, r]))

  const actions = listable
    .sort((a, b) => b.citationCount - a.citationCount)
    .map<GapAction>((r) => {
      // 블로그 플랫폼은 "실렸다/안 실렸다"가 아니라 **지분**이다 — 네이버 블로그 62회 인용 중
      // 1회 뒷받침을 '충족'이라 부르면 과장이다. 임의의 기준선(예: 20%)을 만드는 대신 비율을
      // 그대로 보여 주고 자동 충족은 켜지 않는다(콘텐츠형과 같은 모양).
      const isPlatform = Boolean(r.platform)
      const satisfied = !isPlatform && r.supporting > 0
      const engines = [...r.engines].join('·')
      const play = r.platform
        ? { verb: r.platform.verb, badge: '블로그 플랫폼' }
        : (LISTING_PLAY[r.kind] ?? { verb: '등재', badge: '외부 출처' })
      const name = r.platform ? r.platform.label : r.domain

      // 이 출처를 꺼내 든 질문들 = 여기 올릴 글이 답해야 할 것. 플랫폼이면 소속 호스트 전체를 합친다.
      // 우리가 밀린 질문을 앞에 두고 언급률 낮은 순으로 정렬한다 — 가장 비어 있는 주제가 먼저 보이게.
      const qids = new Set<string>()
      for (const h of r.hosts) for (const id of domainQuestions.get(h) ?? []) qids.add(id)
      const cited = [...qids]
        .map((id) => rowById.get(id))
        .filter((row): row is WinLossRow => row !== undefined)
      const lost = cited
        .filter((row) => row.verdict === 'loss')
        .sort((a, b) => a.mentionedRate - b.mentionedRate)
      const picked = lost.length > 0 ? lost : cited
      // 밀린 질문이 없으면 "그중 N개는…" 절이 통째로 빠진다. 앞 절을 "꺼냈고,"로 두면
      // 문장이 잘린 채 끝난다 — 이어질 말이 있을 때만 연결형을 쓴다.
      const citedNote =
        cited.length === 0
          ? ''
          : lost.length > 0
            ? ` 질문 ${cited.length}개에서 이 출처를 꺼냈고, 그중 ${lost.length}개는 우리가 밀린 질문입니다.`
            : ` 질문 ${cited.length}개에서 이 출처를 꺼냈습니다.`

      const share = r.citationCount > 0 ? Math.round((r.supporting / r.citationCount) * 100) : 0
      const platformEvidence =
        `AI가 ${objectParticle(name)} ${r.citationCount}회 인용했고(${engines}) 그중 우리를 뒷받침하는 대목은 ` +
        `${r.supporting}회(${share}%)입니다. 글쓴이 ${r.hosts.size}곳이 인용됐습니다.` +
        (r.platform ? ` ${r.platform.note}` : '')

      return {
        id: r.platform ? `listing:platform:${r.domain}` : `listing:${r.domain}`,
        kind: 'listing',
        title: `${name} ${play.verb}`,
        badge: play.badge,
        evidence: isPlatform
          ? platformEvidence + citedNote
          : satisfied
            ? `${subjectParticle(name)} 우리 언급을 ${r.supporting}회 뒷받침합니다 — 이미 실려 있습니다.` +
              (r.hosts.size > 1 ? ` (${r.hosts.size}개 주소 합산)` : '')
            : `AI가 ${objectParticle(name)} ${r.citationCount}회 인용했지만(${engines}) 우리를 뒷받침하는 대목은 0건입니다.` +
              citedNote,
        targetDomain: r.domain,
        questionIds: picked.map((row) => row.questionId),
        questionTexts: picked.slice(0, 5).map((row) => row.text),
        reach: r.citationCount,
        satisfied,
        status: 'todo',
        publishedUrls: [],
        citedPublishedUrls: [],
        ...(isPlatform ? { progress: { supporting: r.supporting, total: r.citationCount } } : {}),
        doneSignal: isPlatform
          ? `${name} 인용 중 우리를 뒷받침하는 비율이 오르면 진척 (지금 ${r.supporting}/${r.citationCount})`
          : `${name} 인용이 우리 언급을 뒷받침하면 완료`,
      }
    })

  return { actions, competitorDomainCount, excludedLowConfidence }
}

/**
 * 콘텐츠형 항목. 밀린 질문을 카테고리로 묶는다.
 *
 * 질문 하나에 항목 하나를 만들면 36줄짜리 할 일 목록이 나오는데, 그건 격차 분석 이전으로
 * 돌아가는 것이다. 카테고리는 "같은 글 한 편으로 덮을 수 있는 묶음"에 가깝다.
 */
function contentActions(rows: WinLossRow[]): GapAction[] {
  const byCategory = new Map<string, WinLossRow[]>()
  for (const r of rows) {
    if (r.verdict !== 'loss') continue
    const list = byCategory.get(r.category) ?? []
    list.push(r)
    byCategory.set(r.category, list)
  }

  return [...byCategory.entries()]
    .map<GapAction>(([category, list]) => {
      // 언급률이 낮은 질문이 먼저 — 아예 안 나오는 주제가 가장 급하다.
      const worst = [...list].sort((a, b) => a.mentionedRate - b.mentionedRate)
      const label = CATEGORY_LABEL[category] ?? category
      const zero = list.filter((r) => r.mentionedRate === 0).length
      return {
        id: `content:${category}`,
        kind: 'content',
        title: `${label} 질문 콘텐츠 보강`,
        badge: '콘텐츠',
        evidence:
          zero > 0
            ? `${label} 질문 ${list.length}개에서 밀리고, 그중 ${zero}개는 언급이 아예 0건입니다.`
            : `${label} 질문 ${list.length}개에서 경쟁사에 밀립니다.`,
        questionIds: worst.map((r) => r.questionId),
        questionTexts: worst.slice(0, 5).map((r) => r.text),
        reach: list.length,
        // 콘텐츠형은 '패가 사라짐'이 완료 신호다. 다음 측정에서 확인된다.
        satisfied: false,
        status: 'todo',
        publishedUrls: [],
        citedPublishedUrls: [],
        doneSignal: `다음 측정에서 이 질문들의 패 판정이 줄면 진척`,
      }
    })
    .sort((a, b) => b.reach - a.reach)
}

/**
 * '아직 할 일'의 정의 — **한 곳에서만 정한다.**
 *
 * 실행 항목 화면과 측정 상태 화면이 각자 필터를 쓰면 한쪽만 고쳐져 같은 브랜드·같은 주차인데
 * 남은 건수가 다르게 뜬다. 그러면 둘 다 못 믿게 된다. openCount도 이 함수로 센다.
 */
export function isOpenAction(a: GapAction): boolean {
  return !a.satisfied && a.status !== 'skip'
}

/**
 * 정렬 순위. 작을수록 위.
 *
 * 보류(skip)는 데이터가 뭐라 하든 맨 아래다 — 안 하기로 한 일이 매주 맨 위에 뜨면
 * 목록을 닫아 버리게 된다. 충족된 항목도 아래로 내린다(할 일이 아니다). 나머지 중에서는
 * **집행했는데 아직 충족이 안 된 것**을 가장 위에 둔다. 그게 지금 확인이 필요한 유일한
 * 상태이기 때문이다 — 올렸는데 AI가 아직 우리를 못 보고 있다는 뜻이라, 방식이 틀렸는지
 * 시간이 더 필요한지 판단해야 한다.
 */
function rank(a: GapAction): number {
  if (a.status === 'skip') return 4
  if (a.satisfied) return 3
  if (a.status === 'done') return 0
  if (a.status === 'doing') return 1
  return 2
}

/**
 * 집행 주소와 인용 주소를 맞추기 위한 정규화. 서버(actionStates.normalizeUrl)와 같은 규칙이어야
 * 한다 — 한쪽만 바꾸면 맞던 주소가 조용히 안 맞게 된다.
 * 질의 문자열은 남긴다. 기사 id가 거기 있는 사이트가 많아 지우면 서로 다른 글이 같아진다.
 */
function normalizeActionUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export function computeGapActions(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
  citations: CitationSourceAnalysis | null,
  states: ActionStateMap = {},
): GapActionPlan {
  const rows = computeQuestionWinLoss(analyses, questions)
  const { actions: listing, competitorDomainCount, excludedLowConfidence } = listingActions(
    citations,
    questionsByDomain(analyses),
    rows,
  )
  const content = contentActions(rows)

  // 이번 주 인용 주소 전부(정규화). 집행 주소와 맞추는 데만 쓴다.
  const citedUrls = new Set<string>()
  for (const a of analyses) for (const c of a.citations ?? []) if (c.raw) citedUrls.add(normalizeActionUrl(c.raw))

  const actions = [...listing, ...content]
    .map((a) => {
      const saved = states[a.id]
      if (!saved) return a
      const publishedUrls = saved.publishedUrls ?? []
      const cited = publishedUrls.filter((u) => {
        const n = normalizeActionUrl(u)
        // 같거나, 인용 주소가 우리 주소로 시작하면(질의·앵커가 덧붙은 경우) 같은 글로 본다.
        return citedUrls.has(n) || [...citedUrls].some((c) => c.startsWith(n))
      })
      return { ...a, status: saved.status, markedWeek: saved.markedWeek, publishedUrls, citedPublishedUrls: cited }
    })
    .sort((a, b) => rank(a) - rank(b) || b.reach - a.reach)

  const open = actions.filter(isOpenAction)
  return {
    actions,
    openCount: open.length,
    satisfiedCount: actions.filter((a) => a.satisfied).length,
    /** 집행했다고 적었는데 데이터가 아직 확인하지 못한 항목. 가장 먼저 봐야 할 줄이다. */
    awaitingCount: actions.filter((a) => a.status === 'done' && !a.satisfied).length,
    skippedCount: actions.filter((a) => a.status === 'skip').length,
    competitorDomainCount,
    excludedLowConfidence,
  }
}
