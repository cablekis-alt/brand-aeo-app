/**
 * 인용 출처 주소 → 고객이 아는 이름(「yeogi.com」 → 「여기어때」). 정기진단 보고서의 「AI가 근거로 쓴 출처」 표가 주소 옆에 함께 적는다
 * (2026-10-26 스테이,머뭄 W44 점수 분석 — 주소만 적으면 고객은 어디인지 모른다). 모르는 주소는 이름 없이 주소만 둔다(지어내지 않는다).
 *
 * 하위 주소도 같은 이름으로 본다(m.blog.naver.com → 네이버 블로그, kr.trip.com → 트립닷컴). 더 긴 주소를 먼저 맞춘다.
 *   - exact: 그 주소일 때만 — google.com의 하위 주소에는 남이 올린 문서 · 사이트(docs · sites)와 근거 리디렉트(vertexaisearch.cloud)가 있어
 *     모두 「구글」로 적으면 구글 검색이 근거인 것처럼 읽힌다.
 *   - group: 블로그마다 주소가 다른 플랫폼 — 출처 표에서 하위 주소를 플랫폼 하나로 묶는다(platformGroupHost).
 */
interface HostEntry {
  host: string
  name: string
  exact?: true
  group?: true
}

const HOST_NAMES: HostEntry[] = [
  { host: 'blog.naver.com', name: '네이버 블로그' },
  { host: 'post.naver.com', name: '네이버 포스트' },
  { host: 'cafe.naver.com', name: '네이버 카페' },
  { host: 'map.naver.com', name: '네이버 지도' },
  { host: 'place.naver.com', name: '네이버 플레이스' },
  { host: 'booking.naver.com', name: '네이버 예약' },
  { host: 'smartstore.naver.com', name: '네이버 스마트스토어' },
  { host: 'kin.naver.com', name: '네이버 지식iN' },
  { host: 'news.naver.com', name: '네이버 뉴스' },
  { host: 'v.daum.net', name: '다음 뉴스' },
  { host: 'cafe.daum.net', name: '다음 카페' },
  { host: 'blog.daum.net', name: '다음 블로그' },
  { host: 'map.kakao.com', name: '카카오맵' },
  { host: 'place.map.kakao.com', name: '카카오맵' },
  { host: 'pf.kakao.com', name: '카카오톡 채널' },
  { host: 'tistory.com', name: '티스토리', group: true },
  { host: 'brunch.co.kr', name: '브런치' },
  { host: 'yeogi.com', name: '여기어때' },
  { host: 'goodchoice.kr', name: '여기어때' },
  { host: 'yanolja.com', name: '야놀자' },
  { host: 'nol.yanolja.com', name: '놀(야놀자)' },
  { host: 'airbnb.co.kr', name: '에어비앤비' },
  { host: 'airbnb.com', name: '에어비앤비' },
  { host: 'trip.com', name: '트립닷컴' },
  { host: 'agoda.com', name: '아고다' },
  { host: 'booking.com', name: '부킹닷컴' },
  { host: 'expedia.co.kr', name: '익스피디아' },
  { host: 'hotels.com', name: '호텔스닷컴' },
  { host: 'tripadvisor.co.kr', name: '트립어드바이저' },
  { host: 'tripadvisor.com', name: '트립어드바이저' },
  { host: 'mom-mom.net', name: '맘맘' },
  { host: 'visitkorea.or.kr', name: '한국관광공사' },
  { host: 'namu.wiki', name: '나무위키' },
  { host: 'ko.wikipedia.org', name: '위키백과' },
  { host: 'youtube.com', name: '유튜브' },
  { host: 'instagram.com', name: '인스타그램' },
  { host: 'facebook.com', name: '페이스북' },
  { host: 'threads.net', name: '스레드' },
  { host: 'google.com', name: '구글', exact: true },
  { host: 'maps.google.com', name: '구글 지도' },
  { host: 'play.google.com', name: '구글 플레이' },
  { host: 'support.google.com', name: '구글 고객센터' },
  { host: 'business.google.com', name: '구글 비즈니스 프로필' },
  { host: 'apps.apple.com', name: '앱스토어' },
  { host: 'coupang.com', name: '쿠팡' },
  { host: 'gmarket.co.kr', name: 'G마켓' },
  { host: '11st.co.kr', name: '11번가' },
  { host: 'danawa.com', name: '다나와' },
].sort((a, b) => b.host.length - a.host.length) as HostEntry[]

const bare = (domain: string) => domain.toLowerCase().replace(/^www\./, '')

function entryOf(domain: string): HostEntry | null {
  const h = bare(domain)
  return HOST_NAMES.find((e) => h === e.host || (!e.exact && h.endsWith(`.${e.host}`))) ?? null
}

/** 알려진 플랫폼이면 이름, 아니면 null. */
export function hostName(domain: string): string | null {
  return entryOf(domain)?.name ?? null
}

/** 블로그마다 주소가 다른 플랫폼이면 그 플랫폼 주소(「cablekis.tistory.com」 → 「tistory.com」), 아니면 null. */
export function platformGroupHost(domain: string): string | null {
  const e = entryOf(domain)
  return e?.group ? e.host : null
}
