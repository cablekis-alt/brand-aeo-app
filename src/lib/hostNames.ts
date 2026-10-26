/**
 * 인용 출처 주소 → 고객이 아는 이름(「yeogi.com」 → 「여기어때」). 정기진단 보고서의 「AI가 근거로 쓴 출처」 표가 주소 옆에 함께 적는다
 * (2026-10-26 스테이,머뭄 W44 점수 분석 — 주소만 적으면 고객은 어디인지 모른다). 모르는 주소는 이름 없이 주소만 둔다(지어내지 않는다).
 *
 * 하위 주소도 같은 이름으로 본다(m.blog.naver.com → 네이버 블로그, kr.trip.com → 트립닷컴). 더 긴 주소를 먼저 맞춘다.
 */
const HOST_NAMES: [string, string][] = [
  ['blog.naver.com', '네이버 블로그'],
  ['post.naver.com', '네이버 포스트'],
  ['cafe.naver.com', '네이버 카페'],
  ['map.naver.com', '네이버 지도'],
  ['place.naver.com', '네이버 플레이스'],
  ['booking.naver.com', '네이버 예약'],
  ['smartstore.naver.com', '네이버 스마트스토어'],
  ['kin.naver.com', '네이버 지식iN'],
  ['news.naver.com', '네이버 뉴스'],
  ['v.daum.net', '다음 뉴스'],
  ['cafe.daum.net', '다음 카페'],
  ['blog.daum.net', '다음 블로그'],
  ['map.kakao.com', '카카오맵'],
  ['place.map.kakao.com', '카카오맵'],
  ['pf.kakao.com', '카카오톡 채널'],
  ['tistory.com', '티스토리'],
  ['brunch.co.kr', '브런치'],
  ['yeogi.com', '여기어때'],
  ['goodchoice.kr', '여기어때'],
  ['yanolja.com', '야놀자'],
  ['nol.yanolja.com', '놀(야놀자)'],
  ['airbnb.co.kr', '에어비앤비'],
  ['airbnb.com', '에어비앤비'],
  ['trip.com', '트립닷컴'],
  ['agoda.com', '아고다'],
  ['booking.com', '부킹닷컴'],
  ['expedia.co.kr', '익스피디아'],
  ['hotels.com', '호텔스닷컴'],
  ['tripadvisor.co.kr', '트립어드바이저'],
  ['tripadvisor.com', '트립어드바이저'],
  ['mom-mom.net', '맘맘'],
  ['visitkorea.or.kr', '한국관광공사'],
  ['namu.wiki', '나무위키'],
  ['ko.wikipedia.org', '위키백과'],
  ['youtube.com', '유튜브'],
  ['instagram.com', '인스타그램'],
  ['facebook.com', '페이스북'],
  ['threads.net', '스레드'],
  ['google.com', '구글'],
  ['coupang.com', '쿠팡'],
  ['gmarket.co.kr', 'G마켓'],
  ['11st.co.kr', '11번가'],
  ['danawa.com', '다나와'],
]
  .slice()
  .sort((a, b) => b[0].length - a[0].length) as [string, string][]

/** 알려진 플랫폼이면 이름, 아니면 null. */
export function hostName(domain: string): string | null {
  const h = domain.toLowerCase().replace(/^www\./, '')
  for (const [host, name] of HOST_NAMES) if (h === host || h.endsWith(`.${host}`)) return name
  return null
}
