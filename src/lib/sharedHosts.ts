/**
 * 여럿이 함께 쓰는 주소 — 한 업체의 홈페이지가 아니다. 서버(tenantCompetitorsStore.ts isSharedHost)와 같은 홈페이지 판정
 * (brandVariant.ts sharesSite)이 함께 쓴다.
 *
 * 경쟁사 id는 도메인 첫 마디라(cohortPlan.ts slugFromDomain) 네이버 블로그를 홈페이지로 넣은 펜션은 모두 id 'blog'가 되어
 * 한 브랜드로 섞이고, 그 플랫폼의 모든 인용이 그 경쟁사의 자사 인용으로 잡힌다. 같은 홈페이지로 보면 서로 다른 업체가
 * 「다른 범위 변형」으로 묶여 별칭 · GA4 · 사실을 나눠 받는다(2026-10-21 검토).
 */
const SHARED_HOSTS = new Set([
  'blog.naver.com', 'm.blog.naver.com', 'post.naver.com', 'm.post.naver.com', 'cafe.naver.com',
  'smartstore.naver.com', 'place.naver.com', 'm.place.naver.com', 'map.naver.com', 'booking.naver.com',
  'instagram.com', 'facebook.com', 'm.facebook.com', 'youtube.com', 'm.youtube.com', 'threads.net', 'tiktok.com',
  'twitter.com', 'x.com', 'band.us', 'pf.kakao.com', 'place.map.kakao.com', 'map.kakao.com', 'linktr.ee',
  'modoo.at', 'blog.daum.net', 'cafe.daum.net', 'brunch.co.kr', 'tistory.com', 'velog.io', 'medium.com',
  'blogspot.com', 'wordpress.com', 'sites.google.com', 'maps.google.com',
  'yanolja.com', 'goodchoice.kr', 'yeogi.com', 'airbnb.co.kr', 'airbnb.com', 'booking.com', 'agoda.com',
])

/** 플랫폼 주소인가(소문자 · www 없는 호스트). */
export function isSharedPlatformHost(host: string): boolean {
  return SHARED_HOSTS.has(host) || host.endsWith('.naver.com') || host.endsWith('.kakao.com') || host.endsWith('.daum.net')
}
