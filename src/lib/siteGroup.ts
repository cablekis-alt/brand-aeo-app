/**
 * 실행 항목에서 한 사이트로 볼 단위를 정한다.
 *
 * 왜 필요한가. 야놀자가 세 카드로 쪼개져 있었다 — nol.yanolja.com(인용 66·뒷받침 20) ·
 * place-site.yanolja.com(25·0) · yanolja.com(3·0). 앞의 것은 '충족'이고 뒤의 것은 "등재하세요"라
 * 같은 화면이 서로 다른 말을 했다. 같은 회사의 섹션일 뿐이므로 하나로 봐야 한다.
 *
 * ── 합치면 안 되는 것 ───────────────────────────────────────────────────────
 * 서브도메인이 **서로 다른 주체**인 호스트가 있다. 두 종류다:
 *   포털     naver.com — blog / cafe / booking이 각각 다른 서비스다. 합치면
 *            "네이버 블로그 지분"과 "네이버 예약"이 한 줄로 섞인다(실측: web4ai에서
 *            blog.naver.com 160 + booking.naver.com 3).
 *   사이트빌더 cafe24.com · wixsite.com · github.io — 서브도메인마다 주인이 다르다.
 *            합치면 남의 회사 사이트가 우리 실행 항목에 묶인다.
 * 이런 호스트는 도메인 그대로 둔다. 블로그 플랫폼(tistory 등)은 blogPlatforms가 따로 묶으므로
 * 여기서 다시 건드리지 않는다.
 *
 * eTLD 판정은 공개 접미사 목록(PSL) 전체를 쓰지 않고 한국·주요국의 2단계 TLD만 담는다.
 * 인용 도메인의 대부분이 .com / .co.kr이고, 목록에 없는 2단계 TLD는 "합치지 않음"으로
 * 떨어져 지금과 같은 동작이 된다 — 틀리는 쪽이 아니라 안 합치는 쪽으로 실패한다.
 */

/** <이름>.<2단계 TLD> 형태로 쓰이는 접미사. 여기 걸리면 한 칸 더 올라가야 등록가능 도메인이다. */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'ne.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr', 'hs.kr', 'ms.kr', 'es.kr', 'sc.kr', 'kg.kr',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au',
  'com.cn', 'com.tw', 'com.hk', 'com.sg', 'com.br', 'com.mx', 'co.in', 'co.nz', 'co.id', 'co.th',
])

/**
 * 서브도메인이 서로 다른 주체라 합치면 안 되는 호스트.
 * 접미사로 비교한다 — `x.cafe24.com`도 `cafe24.com`에 걸린다.
 */
const MULTI_TENANT_SUFFIXES = [
  // 포털 — 서브도메인마다 다른 서비스
  'naver.com', 'daum.net', 'kakao.com', 'nate.com', 'google.com', 'yahoo.co.jp',
  // 사이트·블로그 빌더 — 서브도메인마다 다른 주인
  'cafe24.com', 'wixsite.com', 'weebly.com', 'squarespace.com', 'imweb.me', 'modoo.at',
  'creatorlink.net', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev', 'notion.site',
  'tistory.com', 'blogspot.com', 'wordpress.com', 'substack.com', 'medium.com', 'velog.io',
]

function endsWithSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/** 등록가능 도메인(eTLD+1). 판정할 수 없으면 입력을 그대로 돌려준다. */
export function registrableDomain(host: string): string {
  const h = host.replace(/^www\./, '').toLowerCase()
  const parts = h.split('.')
  if (parts.length < 3) return h
  const last2 = parts.slice(-2).join('.')
  return TWO_LEVEL_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2
}

export function isMultiTenantHost(host: string): boolean {
  const h = host.replace(/^www\./, '').toLowerCase()
  return MULTI_TENANT_SUFFIXES.some((s) => endsWithSuffix(h, s))
}

/**
 * 실행 항목에서 한 덩어리로 묶을 키. 서브도메인이 다른 주체인 호스트는 묶지 않는다.
 * 블로그 플랫폼은 호출부가 먼저 처리하므로 여기 오지 않는다.
 */
export function siteGroupKey(host: string): string {
  const h = host.replace(/^www\./, '').toLowerCase()
  return isMultiTenantHost(h) ? h : registrableDomain(h)
}
