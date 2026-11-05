/**
 * 자사 화면 캡처 — 브랜드 자사 사이트에서 찍을 화면(프로필 표) · 화면 · 변형 id · 이름표 · 글에 넣는 규칙.
 *
 * 데스크톱 앱의 메인 프로세스가 숨긴 창으로 찍고(electron/capture.cjs), 서버가 운영자 PC에 저장한다(server/screens.ts —
 * PIPELINE_DATA_DIR/<tenant>/screens/<id>.png + screens.json). 글의 사진 기록(PhotoPick)에는 앱 주소 /api/screens/<tenant>/<id>.png만 적고,
 * 그림은 내보낼 때 넣는다(2026-11-04 결정 1).
 *
 * 찍을 주소는 이 표에서만 나온다 — 화면(클라이언트)은 주소를 보내지 않고 화면 id · 변형 id만 보낸다. 코스 화면은 주소의 쿼리로 조건을
 * 미리 채우기만 하고 보내지 않는다(POST /api/plan/ 없음 — 캡처 창은 GET 말고는 모두 막는다).
 *
 * 서버(server/screens.ts · server/index.ts · server/contentDraft.ts)와 화면이 함께 쓰므로 DOM에 기대지 않는다.
 */
import type { PhotoPick } from './articlePhotos.js'
import type { MapRegion } from './mapImage.js'

/**
 * 화면 종류 — course(코스 만들기 화면) · map(지도 화면) · place(장소 페이지의 안내 칸 — 장소마다 변형) · guide(목적별 가이드 페이지의 머리).
 * place · guide는 페이지의 자사 부분만 잘라 찍는다(clip — 같은 페이지의 공공누리 사진은 그림에 넣지 않는다).
 */
export type ScreenKind = 'course' | 'map' | 'place' | 'guide'

/**
 * 잘라 찍기(electron/capture.cjs clip) — 선택자들의 요소를 합친 사각형에 여백(padding)을 둘러 그 부분만 찍는다. selectors는 다 있어야
 * 하고(없으면 찍지 않는다 — clip-missing), optional은 있으면 함께 넣는다. 사각형 안에 걸친 그림만 검사한다(공공누리 · 바깥 그림).
 */
export interface ScreenClip {
  selectors: readonly string[]
  optional?: readonly string[]
  padding?: number
  /**
   * 잘라 찍는 화면의 가로(CSS px, 360~1920의 정수) — 사이트를 이 폭의 화면으로 열어 반응형 배치가 그 폭에 맞춘다. 없으면 SCREEN_VIEW_WIDTH
   * (1280). 창은 그대로 1280×800이고 화면 흉내(CDP)만 이 폭이다.
   */
  viewWidth?: number
}

/** 한 화면의 변형 하나 — 같은 페이지를 다른 조건 · 권역으로 연 것. 「화면 + 변형」이 한 장의 단위다. */
export interface ScreenVariant {
  /** 변형 id — 그 화면 안에서 고유. */
  id: string
  /** 미리보기 · 칩에 쓰는 이름(「아이와」 · 「원도심」). */
  label: string
  /** 찍을 주소의 경로 · 쿼리 · #조각(호스트 뒤). 미리 채우기는 주소로만 한다 — 제출하지 않는다. */
  path: string
  /** 이 선택자의 요소가 화면 맨 위(고정 머리 아래)에 오게 스크롤한다(electron/capture.cjs scrollTo). */
  scrollTo?: string
  /**
   * 주소의 #조각을 가리키는 페이지 안 링크를 지도 준비 뒤 한 번 누른다 — 군산각 /map/#r-권역을 바로 열면 목록만 그 권역으로 걸러지고
   * 지도는 군산 전체로 남는다(site.js가 map.js보다 먼저 gs:region을 보낸다). 사이트가 고치면 뺀다.
   */
  activateFragmentLink?: true
  /**
   * 이 변형이 보여 주는 권역의 이름 · 장소(지도 권역 변형) — 자리 글자에 이 가운데 하나가 나오면 이 변형만 쓴다(원도심 장소를 말하는 지도
   * 자리에는 #r-원도심만 — screenVariantChoice). 띄어쓰기 · 문장부호는 무시하고 맞춘다.
   */
  places?: readonly string[]
  /** 자리 글자가 이 조건을 말하면(「아이」 · 「부모님」 · 「혼자」 · 「연인」) 이 변형을 먼저 쓴다(코스 조건 변형 — screenVariantChoice). */
  prefer?: RegExp
  /**
   * 같은 조건의 둘째 변형 — 그 조건의 첫 변형(extra가 없는 것)을 이 글 · 작성자에게 이미 썼을 때만 쓴다(두 번째 묶음이라 「확인 필요」).
   * 조건을 말하지 않는 자리에는 쓰지 않는다(2026-11-05 결정 D5(b) — 「아이와」 코스 자리가 같은 작성자에게 둘째로 나와 비던 자리).
   */
  extra?: true
}

/** 찍을 화면 하나. */
export interface ScreenDef {
  /** 화면 id — 그 프로필 안에서 고유. */
  id: string
  kind: ScreenKind
  /** 사이트의 메뉴 이름 그대로(「AI 코스 만들기」) — 대체 텍스트 · 미리보기에 쓴다. */
  label: string
  /** 지도 화면 — 준비 신호(gs:mapready)와 카카오 타일까지 기다린다. */
  map?: true
  /** 이 화면에서 더 숨길 것(챗봇 단추 · 캐러셀 · 동의 배너는 캡처 모듈이 늘 숨긴다). */
  hide?: readonly string[]
  /** 페이지의 이 부분만 잘라 찍는다 — 찍은 부분의 글자도 함께 저장해 설명 줄의 사실과 견준다(screenFactGaps). */
  clip?: ScreenClip
  /** 자사 호스트 밖의 요청을 모두 막는다(관광공사 사진 · 지도 SDK · 동영상 썸네일을 받지 않는다 — 잘라 찍는 부분은 자사 글자 · 그림뿐). */
  ownHostOnly?: true
  /**
   * 변형이 사이트의 장소 페이지(/places/<이름>/)다 — variants는 비고, 자리 글자에 나온 장소를 사이트의 장소 사전(sitemap)에서 찾아
   * 변형을 만든다(placeScreenVariant). 변형 id는 주소의 장소 이름(slug)이다.
   */
  placePages?: true
  /**
   * 화면 이름이 자리 글자에 없을 때 이 화면으로 볼 낱말 — 장소 안내 칸이 보여 주는 것(이용시간 · 휴관 · 입장료 …). 화면 이름 · 다른 회사 ·
   * 누르기 낱말이 먼저다(screenKindOf).
   */
  slotWords?: RegExp
  /**
   * 이름 · 안내 낱말이 흔하다(「장소 안내」 · 「아이와 함께 안내」 — 실물 안내판 · 다른 기관 사이트의 안내 화면과 겹친다). 이름만으로는 화면
   * 자리로 보지 않고(isScreenSlotText), 자리 글자가 브랜드 이름이나 프로필 호스트를 말할 때만 이 화면 자리다(screenKindOf).
   */
  commonLabel?: true
  /**
   * 찍지 않는 화면 — 지도 자리를 앱이 그린 OSM 지도로만 채운다(사이트에 찍을 지도 화면이 없다 — 스테이,머뭄). 화면 고르기 · 찍기 목록에 없다.
   */
  drawOnly?: true
  variants: readonly ScreenVariant[]
}

/** 자사 사이트 하나의 화면 목록 — 호스트로 찾는다(브랜드 ownedDomains에 그 호스트가 있어야 한다). */
export interface ScreenProfile {
  host: string
  /**
   * 한 호스트를 여러 업체가 경로로 나눠 쓰면(co.webforai.kr — WebforAI 고객 여럿) 이 브랜드의 경로 — 브랜드 페이지(brandPageUrl)가 이 호스트의
   * 이 경로 아래일 때만 이 프로필이다(screenProfileFor). 같은 호스트의 다른 업체에 붙지 않게.
   */
  pathPrefix?: string
  screens: readonly ScreenDef[]
  /**
   * 지도 자리에 앱이 그린 OSM 지도를 넣을 장소 목록의 출처(server/mapPoints.ts · src/lib/mapImage.ts). 동봉한 지도 데이터가 군산뿐이라 군산
   * 브랜드에만 있다. 없으면 지도 자리는 지금처럼 카카오 지도 미리보기만 한다.
   * - source site-map(기본): 자사 사이트의 이 경로(div.map[data-points])에서 점만 읽는다(군산각 /map/).
   * - source own-geo: 자사 사이트 이 경로의 구조화 데이터 위치(geo) 한 곳(anchorId — 숙소)과 그 둘레 관광지의 관광공사 좌표(공공데이터)를
   *   쓴다(2026-11-05 결정 D5(c) — 스테이,머뭄. 다른 고객 사이트의 장소 목록은 쓰지 않는다). 지도 자리에는 늘 그 한 곳을 맨 앞에 둔다.
   */
  mapPoints?: { path: string; source?: 'site-map' | 'own-geo'; anchorId?: string }
}

/** 찍은 화면 한 장 — server/screens.ts가 screens.json에 적는다. */
export interface ScreenShot {
  /** PNG sha256의 앞 16자(소문자 16진수) — 파일 이름 <sha16>.png이자 찍은 화면 id. */
  sha16: string
  screenId: string
  variantId: string
  /** 찍은 주소(프로필에서 만든 것). */
  url: string
  /** 찍은 때(서버 시각, ISO). 같은 그림을 다른 날 다시 찍으면 이 값만 새로 적는다. */
  capturedAt: string
  /** PNG 화소 크기(가로 · 세로) — 잘라 찍은 화면의 CSS 크기는 이것 ÷ scale. */
  width: number
  height: number
  bytes: number
  /** 잘라 찍은 화면이면 찍은 부분의 글자(요소들의 innerText, SCREEN_TEXT_MAX자까지) — 설명 줄의 사실과 견준다(screenFactGaps). */
  text?: string
  /**
   * 화소 배율(CSS 1px이 그림 몇 화소인가) — 잘라 찍은 화면은 2(2026-11-05부터 — SCREEN_CLIP_SCALE). 없으면 1: 첫 화면 통째(코스 · 지도)와
   * 그 전에 1배로 찍은 잘라 찍기(옛 기록 — 목록 · 내보내기는 그대로 쓴다).
   */
  scale?: number
  /**
   * 찍은 화면의 가로(CSS px) — 장소 안내는 600(2026-11-05부터 — ScreenClip.viewWidth). 없으면 1280(SCREEN_VIEW_WIDTH): 첫 화면 통째 · 가이드와
   * 그 전에 1280 화면으로 찍은 장소 안내(옛 기록 — 목록 · 내보내기는 그대로 쓴다).
   */
  viewWidth?: number
}

/** 찍은 부분 글자의 최대 길이. */
export const SCREEN_TEXT_MAX = 2000

/**
 * 잘라 찍는 화면(장소 안내 · 가이드)의 화소 배율 — 2배로 찍는다(2026-11-05 결정: 장소 안내 칸은 폭이 425px로 좁아 블로그에서 더 크고
 * 선명하게 보이게). electron/capture.cjs CLIP_SCALE과 같은 값이다. 첫 화면 통째(코스 · 지도)는 1배 그대로.
 */
export const SCREEN_CLIP_SCALE = 2

/** 이 화면을 찍는 화소 배율 — 잘라 찍는 화면은 SCREEN_CLIP_SCALE, 첫 화면 통째는 1. */
export function screenShotScale(screen: Pick<ScreenDef, 'clip'>): number {
  return screen.clip ? SCREEN_CLIP_SCALE : 1
}

/** 찍는 화면의 기본 가로(CSS px) — electron/capture.cjs VIEW_WIDTH와 같다. 첫 화면 통째(코스 · 지도)는 늘 이 폭이다. */
export const SCREEN_VIEW_WIDTH = 1280

/** 이 화면을 찍는 화면 가로 — 잘라 찍기의 viewWidth(장소 안내 600), 없으면 SCREEN_VIEW_WIDTH. */
export function screenShotViewWidth(screen: Pick<ScreenDef, 'clip'>): number {
  return screen.clip?.viewWidth ?? SCREEN_VIEW_WIDTH
}

/**
 * 찍어 둔 화면이 지금 이 화면을 찍는 방식(화소 배율 · 화면 가로)과 같은가 — 서버는 같은 날이라도 같은 방식으로 찍은 것만 다시 쓴다
 * (server/screens.ts sameDayShot). 다르면(600 전에 1280 화면으로 찍은 장소 안내 · 2배 전에 1배로 찍은 잘라 찍기) 오늘 찍었어도 다시 찍을 수 있다.
 */
export function screenShotCurrent(shot: Pick<ScreenShot, 'scale' | 'viewWidth'>, screen: Pick<ScreenDef, 'clip'>): boolean {
  return (shot.scale ?? 1) === screenShotScale(screen) && (shot.viewWidth ?? SCREEN_VIEW_WIDTH) === screenShotViewWidth(screen)
}

/** 목록 · 찍기 응답에 나가는 한 장 — id(= sha16)와 앱 주소(src)를 붙인다. */
export interface ScreenShotView extends ScreenShot {
  id: string
  src: string
}

/** 군산각 코스 화면의 조건 고르기 단계(동행) — 아이와 · 부모님 · 혼자 · 연인·친구 변형은 여기가 맨 위에 오게 찍는다. */
const GUNSAN_COURSE_STEP = 'fieldset:has(input[name="with"])'
/**
 * 「누구와 가세요?」의 혼자 칸을 말하는 낱말. 「혼자서도 · 혼자서는 · 혼자 짜기 · 혼자 고민」은 「스스로」라 동행이 아니고(「AI 코스 만들기는
 * 혼자서도 쉽게」), 「홀로그램」 · 「1인 1메뉴」 · 「1인당」도 아니다. 「혼자 하는 · 하기 좋은 · 해도 좋은」은 뒤에 여행 · 코스 · 일정이 오면
 * 혼자다(「혼자 하는 군산 여행」 — 「혼자 하기 어려운 일정 짜기」는 아니다).
 */
const GUNSAN_SOLO =
  /혼자(?!서[도는]|\s?(?:하[기는지고면]|해[도서야요]|고민|정하|찾|짜[기는지]|알아보))|혼자\s?(?:하는|하기\s?(?:딱\s?)?좋은|해도\s?(?:좋은|괜찮은))[^.,!?\n]{0,12}?(?:여행|코스|일정|나들이|투어|여정|1박|당일)|홀로(?!그램)|혼행|1인\s?(?:여행|코스|일정)|솔로\s?(?:여행|트립)/
/**
 * 연인·친구 칸을 말하는 낱말 — 사이트의 칸 이름과 글에 흔한 말(커플 · 데이트 · 둘이서 · 부부). 「친구 같은 · 친구처럼 · 친구 추가 ·
 * 플러스친구」, 「업데이트」, 「여부부터 · 공부부터」(…부 + 부터), 「연인원」은 아니다. 아이 낱말 바로 뒤의 「친구」(어린이 친구들 · 아이 친구 ·
 * 아이의 친구)도 아니다 — 아이와 칸이다.
 */
const GUNSAN_COUPLE =
  /연인(?!원)|커플|(?<!업)데이트|신혼|부부(?!터)|(?<!플러스\s?|(?:아이|어린이|자녀|아들|딸|꼬마|유아|초등학생)(?:의)?\s?)친구(?!\s?(?:같|처럼|추가|맺|신청|등록))|둘이서|둘만|둘이\s?(?:걷|걸|가|간|갈|떠나|여행|나란히|함께)|두\s?사람이?\s?(?:함께|나란히|걷|걸)|우정\s?여행/
/** 자사 위치 한 곳(own-geo 장소 목록의 숙소 · 매장)의 장소 id — 지도 자리에 늘 맨 앞에 둔다(src/lib/mapImage.ts mapChoiceOf anchorId). */
export const OWN_GEO_POINT_ID = 'own'
/** 「아이와」 칸을 말하는 낱말 — 「아이」로 시작하지만 사람이 아닌 낱말(아이보리 · 아이콘 …)은 뺀다. */
const GUNSAN_KIDS = /아이(?!보리|콘|디어|스|폰|템)|어린이|자녀/
/** 군산각 날씨 카드 — 실시간 날씨 · 점수 · 밤에는 달이 그려져 오래 남는 블로그 그림에 맞지 않는다. */
const GUNSAN_WEATHER = '[data-wx]'
/**
 * 장소 안내 칸(장소 페이지 첫머리의 이용시간 · 쉬는 날 · 요금 · 주차 · 전화 카드)이 보여 주는 것 — 화면 이름(코스 · 지도)이 없는 화면 자리에
 * 이 낱말이 있으면 장소 안내 화면 자리다(「근대역사박물관의 이용시간과 휴관일, 입장료가 표시된 화면」). 다른 회사 · 누르기 · 결과 낱말이
 * 먼저다(「지도에서 찾기 화면에서 근대역사박물관을 눌러 요금이 보이는 장면」은 누르기 화면).
 */
const PLACE_INFO_WORDS = /이용\s?시간|여는\s?시간|운영\s?시간|영업\s?시간|관람\s?시간|휴관|쉬는\s?날|휴무|입장료|관람료|입장\s?마감|요금/

function gunsanRegion(name: string, places: readonly string[], label = name): ScreenVariant {
  return { id: `r-${name}`, label, path: `/map/#r-${name}`, scrollTo: '.map-grid', activateFragmentLink: true, places }
}

/**
 * 군산각 지도 권역의 이름 · 장소 — 사이트 /map/의 권역별 장소 목록(2026-11-04)에서 글에 나올 만한 관광지만 골랐다(식당 · 숙소 · 짧은 이름은
 * 뺐다 — 「달」 · 「하늘」 같은 이름은 아무 글에나 걸린다). 여기 없는 장소가 자리에 나오면 그 지도 자리는 전체 지도만 쓴다(screenVariantChoice).
 */
const GUNSAN_REGION_PLACES = {
  원도심: [
    '원도심', '구도심', '시간여행', '근대역사박물관', '근대미술관', '근대건축관', '군산세관', '장미갤러리', '호남관세박물관', '진포해양공원',
    '테디베어박물관', '초원사진관', '동국사', '신흥동', '일본식 가옥', '히로쓰', '경암동', '철길마을', '월명공원', '월명호수', '해망굴', '이성당',
    '말랭이마을', '우체통거리', '영화의 거리', '평화박물관', '이영춘 가옥', '군산역사관', '동백대교', '월명동', '영화동', '장미동',
  ],
  은파: ['은파', '물빛다리', '청암산', '군산호수', '은적사', '옥구향교'],
  고군산: ['고군산', '선유도', '장자도', '대장도', '대장봉', '무녀도', '신시도', '관리도', '방축도', '야미도', '선유대교', '장자교'],
  금강: ['금강', '하구둑', '철새', '나포', '채만식', '임피', '발산리', '오성산', '진포대첩', '진포시비'],
  '새만금-비응': ['새만금', '비응', '어린이랜드', '생말공원', '어린이교통공원'],
} as const satisfies Record<string, readonly string[]>

/**
 * 자사 화면 프로필 표. 군산각의 코스 화면 5장(기본 · 「누구와 가세요?」의 네 칸 아이와 · 부모님 · 혼자 · 연인·친구)과 지도 화면 6장(전체 +
 * 권역 5)이다. 주소의 쿼리 이름(with=solo|couple|kids|parents · adults · seniors · kids 나이) · 권역 조각은 사이트(plan.js fromAddress ·
 * /map/의 권역 탭)에서 확인한 것이다(2026-11-04). 프로필이 없는 브랜드는 찍을 화면이 없다.
 *
 * 장소 안내(장소마다 한 장)와 「아이와 함께」 가이드는 잘라 찍는다(4단계, 2026-11-04) — 두 페이지 모두 같은 화면에 관광공사 사진(공공누리
 * 제3유형)이 있어 첫 화면을 통째로 찍을 수 없다. 장소 페이지는 왼쪽 칸의 분류 · 이름 · 소개 · 안내 카드(dl.kf-hero — 자사 아이콘뿐)까지,
 * 가이드는 분류 · 제목 · 자사 일러스트(/assets/art/camp-kids) · 첫 줄까지다. 장소 페이지의 공공누리 사진(figure.pv)은 오른쪽 칸이라 잘라 낸
 * 사각형 밖이고, 가이드의 장소 카드 줄(공공누리 사진)은 캡처 모듈이 늘 숨기는 캐러셀([data-gallery])이며 첫 줄 아래다(숨긴 창 실측).
 *
 * 장소 안내는 600 화면으로 찍는다(2026-11-05 결정 「600px (권장)」) — 1280에서는 안내 카드가 왼쪽 칸(425 폭)에 세로로 길게(994까지) 들어가
 * 블로그 그림 줄(720)에서 720×1684까지 길었다. 600에서는 사이트의 반응형 배치가 카드를 한 줄 가득(한 줄에 칸 셋) 펴 23곳 모두 578(CSS px) ·
 * 2배 1156 화소가 되고, 그림 줄에서 글자가 사이트의 1.25배 · 세로 338~793이다(숨긴 창 실측). 공공누리 사진(figure.pv)은 600에서도 잘라 낸
 * 사각형 밖이다(23곳 그림 검사 모두 공공누리 0). 767 이하 화면에 생기는 아래 고정 줄(.pl-bar)은 숨긴다. 가이드는 1280 그대로.
 */
export const SCREEN_PROFILES: readonly ScreenProfile[] = [
  {
    host: 'gunsan.webforai.kr',
    mapPoints: { path: '/map/' },
    screens: [
      {
        id: 'course',
        kind: 'course',
        label: 'AI 코스 만들기',
        hide: ['.trp-handed-w', GUNSAN_WEATHER],
        variants: [
          { id: 'default', label: '기본', path: '/plan/', scrollTo: '#trp-form' },
          { id: 'kids', label: '아이와', path: '/plan/?with=kids&kids=7', scrollTo: GUNSAN_COURSE_STEP, prefer: GUNSAN_KIDS },
          // 사이트의 kids는 아이 나이 목록이다(plan.js — 쉼표로, 6명 · 17세까지, 2026-11-05 확인). 어른 2 · 아이 둘(4 · 9세).
          { id: 'kids2', label: '아이 둘과', path: '/plan/?with=kids&adults=2&kids=4,9', scrollTo: GUNSAN_COURSE_STEP, prefer: GUNSAN_KIDS, extra: true },
          { id: 'parents', label: '부모님', path: '/plan/?with=parents&adults=3&seniors=2', scrollTo: GUNSAN_COURSE_STEP, prefer: /부모님|어르신|효도/ },
          { id: 'solo', label: '혼자', path: '/plan/?with=solo&adults=1', scrollTo: GUNSAN_COURSE_STEP, prefer: GUNSAN_SOLO },
          { id: 'couple', label: '연인·친구', path: '/plan/?with=couple&adults=2', scrollTo: GUNSAN_COURSE_STEP, prefer: GUNSAN_COUPLE },
        ],
      },
      {
        id: 'map',
        kind: 'map',
        label: '지도에서 찾기',
        map: true,
        hide: [GUNSAN_WEATHER],
        variants: [
          { id: 'default', label: '전체', path: '/map/', scrollTo: '.map-grid' },
          gunsanRegion('원도심', GUNSAN_REGION_PLACES.원도심),
          gunsanRegion('은파', GUNSAN_REGION_PLACES.은파),
          gunsanRegion('고군산', GUNSAN_REGION_PLACES.고군산),
          gunsanRegion('금강', GUNSAN_REGION_PLACES.금강),
          gunsanRegion('새만금-비응', GUNSAN_REGION_PLACES['새만금-비응'], '새만금·비응'),
        ],
      },
      {
        id: 'place-info',
        kind: 'place',
        label: '장소 안내',
        placePages: true,
        ownHostOnly: true,
        slotWords: PLACE_INFO_WORDS,
        commonLabel: true,
        hide: [GUNSAN_WEATHER, '.pl-bar'],
        clip: {
          selectors: ['article.place .pl-head h1', 'article.place dl.kf.kf-hero'],
          optional: ['article.place .pl-head .kicker', 'article.place .pl-head .pl-alt', 'article.place .pl-head .summary'],
          padding: 16,
          viewWidth: 600,
        },
        variants: [],
      },
      {
        id: 'kids-guide',
        kind: 'guide',
        label: '아이와 함께 안내',
        ownHostOnly: true,
        commonLabel: true,
        hide: [GUNSAN_WEATHER],
        clip: {
          selectors: ['header.gd-head h1', 'header.gd-head figure.art-camp'],
          optional: ['header.gd-head .kicker', 'header.gd-head .gd-ans-l'],
          padding: 16,
        },
        variants: [{ id: 'default', label: '아이와 함께 군산', path: '/guides/아이와-함께-군산/' }],
      },
    ],
  },
  // 스테이,머뭄(2026-11-05 결정 D5(c)) — co.webforai.kr은 WebforAI 고객 여럿이 경로로 나눠 쓰는 호스트라 브랜드 페이지가 /s/stay 아래일 때만.
  // 사이트에 찍을 지도 화면은 없고(「오시는 길」의 지도는 찍지 않는다), 지도 자리(휴대폰 지도 앱의 도보 경로 자리 포함 — screenKindOf)는 앱이
  // 그린 OSM 지도로만 채운다 — 표지는 자사 페이지 구조화 데이터의 숙소 위치와 그 둘레 관광지의 관광공사 좌표. 「이용안내 및 예약」 · 「객실
  // 안내」 화면은 두지 않는다 — 두 칸이 세로 4,500~6,400px라 잘라 찍기 상한(세로 2,000px)을 넘는다(2026-11-05 측정).
  {
    host: 'co.webforai.kr',
    pathPrefix: '/s/stay',
    mapPoints: { path: '/s/stay', source: 'own-geo', anchorId: OWN_GEO_POINT_ID },
    screens: [
      {
        id: 'map',
        kind: 'map',
        label: '숙소 둘레 지도',
        map: true,
        drawOnly: true,
        variants: [{ id: 'default', label: '숙소 둘레', path: '/s/stay' }],
      },
    ],
  },
]

/**
 * 글에 저장해도 되는 화면 종류 — 사람이 고르기(op pick)와 자동 채우기(op auto) 모두, 그리고 사진 받기(photo-file)도 이 값을 본다.
 * 카카오 지도 화면은 운영자가 이용 조건(로고 · 출처를 그대로 두고 블로그에 다시 싣는 것)을 확인하기 전까지 찍기 · 미리보기만 한다
 * (2026-11-04 결정 4). 확인되면 여기에 'map'을 더한다 — 서버와 화면이 이 값 하나만 본다. 장소 안내 · 가이드는 고객 사이트의 자사 글자 ·
 * 아이콘 · 일러스트만 잘라 찍으므로 넣는다(설명 줄의 사실이 찍은 글자에 없으면 「확인 필요」 — screenFactGaps).
 */
export const SCREEN_AUTO_SAVE_KINDS: readonly ScreenKind[] = ['course', 'place', 'guide']

/** 찍는 화면 종류 — 화면 자리의 종류(ScreenSlotKind) 가운데 자사 화면 단계가 채우는 것. */
export const SCREEN_KINDS: readonly ScreenKind[] = ['course', 'map', 'place', 'guide']

export function isScreenKind(kind: unknown): kind is ScreenKind {
  return SCREEN_KINDS.includes(kind as ScreenKind)
}

export function screenSaveAllowed(kind: ScreenKind): boolean {
  return SCREEN_AUTO_SAVE_KINDS.includes(kind)
}

/** 글에 넣지 않는 지도 화면의 안내 — 자동 채우기 미리보기 · 「화면 고르기」(결정 4). */
export const MAP_PREVIEW_ONLY_TEXT = '지도 화면 — 카카오 지도 이용 조건 확인 전이라 미리보기만(저장 안 함)'

/** 찍은 화면 id(= PNG sha256 앞 16자)의 모양. */
export const SCREEN_SHOT_ID = /^[0-9a-f]{16}$/

export function isScreenShotId(v: unknown): v is string {
  return typeof v === 'string' && SCREEN_SHOT_ID.test(v)
}

/** 글의 사진 기록에 적는 앱 주소 — 앱 안(같은 출처)에서만 열린다. 내보낼 때 그림으로 바꾼다. */
export function screenAppSrc(tenantId: string, shotId: string): string {
  return `/api/screens/${encodeURIComponent(tenantId)}/${shotId}.png`
}

const APP_SRC = /^\/api\/screens\/([^/?#]+)\/([0-9a-f]{16})\.png$/

/** 앱 주소에서 브랜드 · 찍은 화면 id를 읽는다. 모양이 다르거나 브랜드 id에 경로 글자가 있으면 null. */
export function parseScreenAppSrc(src: unknown): { tenantId: string; shotId: string } | null {
  const m = typeof src === 'string' ? APP_SRC.exec(src) : null
  if (!m) return null
  let tenantId: string
  try {
    tenantId = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') return null
  return { tenantId, shotId: m[2]! }
}

/**
 * 같은 사진 반복 상한의 열쇠(src/lib/photoAutoPick.ts AUTO_PICK_RULES · server/contentDraft.ts saveAutoPhotoPicks). 사진은 주소, 자사 화면은
 * 「화면 + 변형」 — 다른 날 다시 찍어 파일이 달라져도 같은 화면으로 센다(2026-11-04 결정 3). 앱이 그린 지도(origin osm-map)는 「장소 묶음」
 * (src/lib/mapImage.ts mapVariantKey) — 판이 바뀌어 다시 그려도 같은 지도로 센다. 사람이 뺀 자리의 기록(removed)도 이 열쇠를 적는다.
 */
export function photoRepeatKey(p: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId' | 'mapVariant'>): string {
  if (p.origin === 'osm-map' && p.mapVariant) return `osm-map:${p.mapVariant}`
  return p.origin === 'screen' && p.screenId && p.variantId ? `screen:${p.screenId}:${p.variantId}` : p.src
}

/**
 * 브랜드 전체 반복 상한(AUTO_PICK_RULES.brandRepeat)을 받지 않는 사진인가 — 자사 화면 · 앱이 그린 지도는 받지 않는다(결정 3). 글 하나에
 * 한 번 · 작성자 한 사람에게 한 번은 그대로 지킨다(photoRepeatKey 단위).
 */
export function brandRepeatExempt(p: Pick<PhotoPick, 'origin'>): boolean {
  return p.origin === 'screen' || p.origin === 'osm-map'
}

/**
 * 지도 그림의 권역(src/lib/mapImage.ts mapChoiceOf) — 프로필 지도 화면의 권역 변형(이름 · 장소 낱말). 권역 이름은 자사 사이트 장소 목록의
 * 권역 이름과 같다(「원도심」 · 「새만금·비응」).
 */
export function mapRegionsOf(profile: ScreenProfile): MapRegion[] {
  return profile.screens
    .filter((s) => s.kind === 'map')
    .flatMap((s) => s.variants.filter((v) => v.places?.length).map((v) => ({ name: v.label, words: v.places! })))
}

/** ownedDomains 한 줄(「site.example」 · 「https://www.site.example/」)의 호스트 — articlePhotos.ts isOwnedPhotoHost와 같은 정리. */
function ownedHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]!.replace(/^www\./, '').replace(/\.$/, '')
}

/**
 * 브랜드의 화면 프로필 — 자사 사이트(ownedDomains)에 프로필 호스트가 그대로 있을 때만(하위 도메인으로 넓히지 않는다). 경로로 나눠 쓰는
 * 호스트의 프로필(pathPrefix)은 브랜드 페이지(brandPageUrl)가 그 경로 아래일 때만. 없으면 null.
 */
export function screenProfileFor(ownedDomains: readonly string[] | undefined, brandPageUrl?: string): ScreenProfile | null {
  const owned = new Set((ownedDomains ?? []).map(ownedHost).filter(Boolean))
  return SCREEN_PROFILES.find((p) => owned.has(p.host) && (!p.pathPrefix || pageUnder(brandPageUrl, p.host, p.pathPrefix))) ?? null
}

/** 브랜드 페이지가 그 호스트의 그 경로(또는 그 아래)인가. */
function pageUnder(pageUrl: string | undefined, host: string, prefix: string): boolean {
  if (!pageUrl) return false
  try {
    const u = new URL(pageUrl)
    const path = u.pathname.replace(/\/+$/, '')
    return ownedHost(u.host) === host && (path === prefix || path.startsWith(`${prefix}/`))
  } catch {
    return false
  }
}

/**
 * 프로필에서 화면 · 변형을 찾는다. 장소 안내(placePages)는 변형 id(장소 이름 slug)의 모양만 보고 변형을 만든다 — 사이트의 장소인지는
 * 찍기 전에 서버가 sitemap으로 본다(server/screens.ts). 없으면 null.
 */
export function findScreenVariant(profile: ScreenProfile, screenId: unknown, variantId: unknown): { screen: ScreenDef; variant: ScreenVariant } | null {
  // 찍지 않는 화면(drawOnly — 앱이 그린 지도로만 채운다)은 찍기 · 넣기 대상이 아니다.
  const screen = profile.screens.find((s) => s.id === screenId && !s.drawOnly)
  if (!screen) return null
  const variant = screen.placePages ? placeVariantOfSlug(variantId) : screen.variants.find((v) => v.id === variantId)
  return variant ? { screen, variant } : null
}

/** 사이트 장소 페이지 주소의 장소 이름(slug) 모양 — 글자 · 숫자를 하이픈으로 이은 것(군산각 sitemap의 380곳 모두 이 모양, 2026-11-04). */
const PLACE_SLUG = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u
const PLACE_SLUG_MAX = 60

/**
 * 장소 이름(slug — 주소 /places/<slug>/의 이름, 「일제강점기-군산역사관」)으로 만든 장소 안내 변형. 이름표는 하이픈을 띄어쓰기로 바꾼
 * 것(사이트 장소 사전 src/lib/sitePhotos.ts와 같다). 모양이 아니면(경로 글자 · 띄어쓰기 · % 표기 · 너무 긺) null.
 */
export function placeVariantOfSlug(slug: unknown): ScreenVariant | null {
  if (typeof slug !== 'string' || slug.length > PLACE_SLUG_MAX || slug !== slug.normalize('NFC') || !PLACE_SLUG.test(slug)) return null
  return { id: slug, label: slug.replace(/-/g, ' '), path: `/places/${encodeURIComponent(slug)}/` }
}

/**
 * 사이트 장소 사전 한 곳의 주소(sitemap의 https://<호스트>/places/<이름>/)로 만든 장소 안내 변형 — https · 프로필 호스트 · 기본 포트 ·
 * 계정 · 쿼리 · #조각 없음 · 경로가 /places/<이름>/ 하나일 때만(다른 언어 경로 /en/places/… 는 아니다). 자리 글자로 주소를 만들지 않는다 —
 * 자리에 나온 장소 이름을 사전에서 찾아 그 주소만 쓴다. 아니면 null.
 */
export function placeScreenVariant(profile: ScreenProfile, pageUrl: string): ScreenVariant | null {
  let u: URL
  try {
    u = new URL(pageUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== profile.host || u.port || u.username || u.password || u.search || u.hash) return null
  const seg = /^\/places\/([^/]+)\/$/.exec(u.pathname)?.[1]
  if (!seg) return null
  let slug: string
  try {
    slug = decodeURIComponent(seg)
  } catch {
    return null
  }
  return placeVariantOfSlug(slug)
}

/** sitemap.xml에 있는 프로필 호스트의 장소 이름(slug) — 서버가 장소 안내를 찍기 전에 그 장소가 사이트에 있는지 본다(server/screens.ts). */
export function placeSlugsOfSitemap(xml: string, profile: ScreenProfile): Set<string> {
  const out = new Set<string>()
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const v = placeScreenVariant(profile, m[1]!.replace(/&amp;/g, '&'))
    if (v) out.add(v.id)
  }
  return out
}

/** 자사 화면 사진(origin screen)의 화면 · 변형 — 브랜드 프로필에 없으면 null. */
export function screenOfPick(
  pick: Pick<PhotoPick, 'origin' | 'screenId' | 'variantId'>,
  ownedDomains: readonly string[] | undefined,
): { screen: ScreenDef; variant: ScreenVariant } | null {
  if (pick.origin !== 'screen') return null
  const profile = screenProfileFor(ownedDomains)
  return profile ? findScreenVariant(profile, pick.screenId, pick.variantId) : null
}

/** 찍을 주소 — https · 프로필 호스트. */
export function screenUrl(profile: ScreenProfile, variant: ScreenVariant): string {
  return new URL(variant.path, `https://${profile.host}/`).href
}

/**
 * 자사 화면의 대체 텍스트 — 화면 이름만(「군산각 웹사이트 'AI 코스 만들기' 화면」). 사진 자리의 장면 글자(「박물관 위치가 표시된」)를
 * 쓰면 화면에 실제로 없는 사실이 나갈 수 있다. 장소 안내는 장소 이름을 앞에 둔다(「군산각 웹사이트 '근대역사박물관 장소 안내' 화면」 —
 * 찍은 부분에 장소 이름이 있다).
 */
export function screenAlt(brandName: string, screen: Pick<ScreenDef, 'label' | 'placePages'>, variant?: Pick<ScreenVariant, 'label'>): string {
  const name = screen.placePages && variant ? `${variant.label} ${screen.label}` : screen.label
  return `${brandName} 웹사이트 '${name}' 화면`
}

/**
 * 찍은 화면의 가로 · 세로 비율(CSS aspect-ratio 「416 / 677」) — 잘라 찍은 화면은 16:10이 아니다. 2배로 찍은 화면도 비율은 같다(썸네일
 * 칸 크기는 그대로). 크기를 모르면 undefined.
 */
export function screenAspectRatio(shot: { width?: number; height?: number } | undefined): string | undefined {
  const w = shot?.width
  const h = shot?.height
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? `${w} / ${h}` : undefined
}

/** 찍은 때의 한국 날짜 「11-04」 — 읽지 못하면 null. */
export function screenShotDay(capturedAt: string | undefined): string | null {
  const t = capturedAt ? Date.parse(capturedAt) : Number.NaN
  return Number.isNaN(t) ? null : new Date(t + 9 * 3600_000).toISOString().slice(5, 10)
}

/** 주소의 경로 · #조각을 사람이 읽는 글자로(「/places/%EA%B7%BC…/」 → 「/places/근대역사박물관/」 · 「#r-%EC%9B%90…」 → 「#r-원도심」). 풀 수 없으면 그대로. */
function readableUrlPart(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * 찍은 화면의 설명 줄 — 「군산각 웹사이트 화면 · gunsan.webforai.kr/map/ · 11-04 캡처」(미리보기 · 사진 칸). 주소는 호스트 · 경로 ·
 * #조각만 보인다(코스 조건 쿼리는 변형 이름이 말한다). 찍은 때를 모르면(아직 찍지 않음) 날짜를 뺀다.
 */
export function screenShotMeta(brandName: string, url: string, capturedAt?: string): string {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(#.*)?$/i.exec(url.trim())
  const page = m ? `${m[1]}${readableUrlPart(m[2] || '/')}${m[3] ? readableUrlPart(m[3]) : ''}` : url.trim()
  const day = screenShotDay(capturedAt)
  return [`${brandName ? `${brandName} ` : ''}웹사이트 화면`, page, ...(day ? [`${day} 캡처`] : [])].join(' · ')
}

/**
 * 한 번에 찍을 화면 순서 — 글에 넣는 종류(SCREEN_AUTO_SAVE_KINDS — 코스)를 먼저, 미리보기만 하는 화면(지도)을 뒤에. 이번 화면에서 찍다가
 * 실패한 화면(failed — 「화면id:변형id」)은 맨 뒤로 보낸다(같은 화면이 계속 실패해 남은 화면을 막지 않게). 같은 무리 안은 받은 순서.
 */
export function screenCaptureOrder<T extends { screenId: string; variantId: string }>(
  wanted: readonly T[],
  saveAllowedOf: (screenId: string) => boolean,
  failed: ReadonlySet<string> = new Set(),
): T[] {
  const rank = (w: T) => (failed.has(`${w.screenId}:${w.variantId}`) ? 2 : saveAllowedOf(w.screenId) ? 0 : 1)
  return wanted.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map(({ w }) => w)
}

/** 화면 · 변형마다 가장 늦게 찍은 화면(「화면id:변형id」 → 그 화면). */
export function latestScreenShots<T extends Pick<ScreenShot, 'screenId' | 'variantId' | 'capturedAt'>>(shots: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const s of shots) {
    const k = `${s.screenId}:${s.variantId}`
    const had = out.get(k)
    if (!had || Date.parse(s.capturedAt) > Date.parse(had.capturedAt)) out.set(k, s)
  }
  return out
}

/**
 * 내보내도 되는 자사 화면 사진인가 — 앱 주소 모양이 맞고, 어느 프로필에 그 화면 · 변형이 글에 넣는 종류(SCREEN_AUTO_SAVE_KINDS)로 있을 때만.
 * 서버가 지도 화면을 저장하지 않지만(결정 4), 내보내기(src/lib/articlePhotos.ts placePhotos)도 한 번 더 막는다.
 */
export function screenExportable(p: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId'>): boolean {
  if (p.origin !== 'screen' || !parseScreenAppSrc(p.src)) return false
  return SCREEN_PROFILES.some((profile) => {
    const found = findScreenVariant(profile, p.screenId, p.variantId)
    return found !== null && screenSaveAllowed(found.screen.kind)
  })
}

// ── 화면 자리 판정(src/lib/photoAutoPick.ts 자사 화면 단계) ──────────────────────────────────────────

/** 비교용 글자 — 띄어쓰기 · 따옴표 · 문장부호를 걷고 소문자로(「'AI 코스 만들기'」 → 「ai코스만들기」). */
function textKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 「화면」이 없어도 화면 자리인 낱말 — 검색 결과 · 캡처 · 스크린샷은 사진일 수 없다. */
const SCREEN_ALWAYS = /검색\s?결과|스크린\s?샷|캡처|캡쳐/
/** 「화면」과 함께 있으면 화면 자리 — 웹사이트 · 홈페이지 · 사이트 · 앱(2026-11-04 계획 5절). */
const SITE_WORD = /웹\s?사이트|홈\s?페이지|사이트|앱|어플/
/** 다른 회사 · 기기의 화면 — 화면 자리로 보되 찍지 않는다(네이버 지도 · 휴대폰 지도 앱 · 네이버 플레이스 예약 화면). */
const OTHER_SCREEN = /네이버|카카오|구글|티맵|인스타그램|유튜브|플레이스|휴대폰|핸드폰|스마트폰|모바일|태블릿/
/**
 * 누르거나 결과를 받아야 보이는 화면 — 사이트에 없는 동작이거나 운영 사이트의 AI 호출이 필요해 사람이 찍는다. 조건을 고르는 것(「조건을
 * 선택한」 · 「조건 선택 화면」)은 주소로 미리 채우는 코스 화면이라 아니다.
 */
const ACTION_SCREEN = /눌러|누른|누르|클릭|터치|(?<!조건을?\s?)선택(해|한|하면)|결과\s?화면|결과가|결과를/
/** 지도 앱의 길 안내 자리 — 「지도 앱」과 경로 · 길 찾기 낱말, 이름이 있는 지도 앱(그 회사 화면)은 아니다(screenKindOf). */
const MAP_APP = /지도\s?앱|지도\s?어플/
const MAP_ROUTE = /경로|길\s?찾기|가는\s?길|동선/
const NAMED_MAP_APP = /네이버|카카오|구글|티맵|T\s?맵|애플/i
/**
 * 다른 기관 · 장소 자신의 사이트 — 흔한 이름의 화면(장소 안내 · 가이드, commonLabel) 자리가 브랜드를 말하지 않고 이것을 말하면 그 기관의
 * 화면이다(「근대역사박물관 공식 홈페이지의 관람시간 안내 화면」 · 「한국관광공사 구석구석 사이트」 · 「군산시 문화관광 홈페이지」).
 */
const OTHER_SITE = /관광공사|구석구석|visitkorea|(?:시|군|구|도)청|문화\s?관광|공식\s?(?:홈\s?페이지|웹\s?사이트|사이트|누리집)|누리집/i

/** 프로필 표의 화면 이름(「AI 코스 만들기」 · 「지도에서 찾기」) 가운데 글자에 나온 것. common이 false면 흔한 이름(commonLabel)은 세지 않는다. */
function labelsIn(text: string, profiles: readonly ScreenProfile[], common = true): ScreenDef[] {
  const t = textKey(text)
  return profiles.flatMap((p) => p.screens.filter((s) => (common || !s.commonLabel) && t.includes(textKey(s.label))))
}

/**
 * 웹사이트 화면 자리인가 — 사진이 아니라 화면 캡처가 맞는 자리. 「화면」만으로는 보지 않는다(「한 화면에 담긴 장면」 · 「대형 화면이 걸린
 * 카페」는 사진 자리다). 「화면」과 함께 웹사이트 · 홈페이지 · 사이트 · 앱, 프로필 표의 화면 이름(「군산각 '지도에서 찾기' 화면」), 다른
 * 회사 · 기기 낱말(「네이버 플레이스 예약 화면」), 누르기 · 결과 낱말(「코스 결과 화면에서 한 장소를 눌러」)이 있을 때 — 뒤의 둘은 찍지 않고
 * 비워 둔다 — 그리고 검색 결과 · 캡처 · 스크린샷이면 화면 자리다. 「사이트」 · 「앱」 · 「스크린」만 있는 자리(「캠핑 사이트」 · 「스크린
 * 골프장」)는 사진 자리다. 흔한 화면 이름(「장소 안내」 · 「아이와 함께 안내」 — commonLabel)만 있는 자리(「박물관 로비의 장소 안내 화면」)는
 * 실물 안내판 사진 자리다.
 */
export function isScreenSlotText(text: string): boolean {
  const t = text.normalize('NFC')
  if (SCREEN_ALWAYS.test(t)) return true
  if (!t.includes('화면')) return false
  return SITE_WORD.test(t) || OTHER_SCREEN.test(t) || ACTION_SCREEN.test(t) || labelsIn(t, SCREEN_PROFILES, false).length > 0
}

/**
 * 화면 자리의 종류 — course 코스 화면 · map 지도 화면 · guide 가이드 화면(프로필 표의 화면 이름이 장면 글자에 정확히 하나 있을 때),
 * place 장소 안내 화면(화면 이름은 없고 이용시간 · 휴관 · 입장료 같은 안내 낱말이 있을 때 — slotWords), 그 밖에는 찍지 않는다:
 * other 다른 회사 · 기관 · 기기 화면, action 누르거나 결과를 받아야 보이는 화면, none 브랜드에 찍을 화면 목록(프로필)이 없음, ambiguous 화면
 * 이름이 둘 이상, unrelated 목록에 없는 화면(첫 화면 · 행사 안내 · 브랜드와 무관한 사이트), unowned 흔한 이름의 화면(장소 안내 · 가이드)인데
 * 자리 글자가 브랜드를 말하지 않아 자사 사이트인지 모름.
 */
export type ScreenSlotKind = ScreenKind | 'other' | 'action' | 'none' | 'ambiguous' | 'unrelated' | 'unowned'

export const SCREEN_SLOT_KIND_TEXT: Record<ScreenSlotKind, string> = {
  course: '코스 화면',
  map: '지도 화면',
  place: '장소 안내 화면',
  guide: '가이드 화면',
  other: '다른 회사 · 기관 · 휴대폰 화면',
  action: '누르거나 결과를 받아야 보이는 화면',
  none: '이 브랜드는 찍을 화면이 없음',
  ambiguous: '화면 이름이 둘 이상',
  unrelated: '찍을 화면 목록에 없는 화면',
  unowned: '브랜드 이름이 없어 자사 사이트 화면인지 모름',
}

/**
 * 화면 자리 하나(장면 글자)의 종류와 그 화면 — 설명 줄은 보지 않는다(「AI 코스 만들기」 자리의 설명이 「지도에서 찾기로 …」를 말하기도 한다).
 * profile은 브랜드의 화면 프로필(screenProfileFor) — 없으면 none. 흔한 이름의 화면(commonLabel — 장소 안내 · 가이드)은 장면 글자가 브랜드
 * 이름(brandName)이나 프로필 호스트를 말할 때만 그 화면이고, 아니면 다른 기관 사이트 낱말(OTHER_SITE)이 있으면 other, 없으면 unowned다.
 */
export function screenKindOf(
  text: string,
  profile: ScreenProfile | null,
  brandName?: string,
): { kind: ScreenSlotKind; screen?: ScreenDef; viaAction?: true } {
  const t = text.normalize('NFC')
  // 이름 없는 지도 앱의 길 안내 자리(「지도 앱에 숙소에서 근처 명소까지 도보 경로가 표시된 휴대폰 화면」) — 장소 목록 출처가 있는 브랜드는
  // 앱이 그린 OSM 지도로 대신한다(2026-11-05 결정 D5(c) — 경로선 없이 표지만, 늘 「확인 필요」). 네이버 · 카카오 같은 이름이 있는 앱은 그
  // 회사 화면이라 그대로 다른 회사 화면이다.
  if (profile?.mapPoints && MAP_APP.test(t) && MAP_ROUTE.test(t) && !NAMED_MAP_APP.test(t)) {
    const map = profile.screens.find((s) => s.kind === 'map')
    if (map) return { kind: 'map', screen: map }
  }
  if (OTHER_SCREEN.test(t)) return { kind: 'other' }
  if (ACTION_SCREEN.test(t)) {
    // 2026-11-05 결정 D5(b) — 브랜드 사이트에서 장소를 눌러 이용시간 · 요금을 보는 자리(「군산각 지도에서 찾기 화면에서 근대역사박물관을
    // 눌러 여는 시간과 요금」)는 그 장소의 장소 안내 화면으로 대신한다(늘 「확인 필요」 — 누른 화면 그대로는 아니다). 장소는
    // src/lib/photoAutoPick.ts가 사이트 장소 사전에서 찾고, 없으면 비워 둔다. 브랜드를 말하지 않는 자리(「코스 결과 화면에서 한 장소를
    // 눌러」)는 그대로 누르기 화면이다.
    const place = profile?.screens.find((s) => s.placePages && s.slotWords?.test(t))
    const brandKey = brandName ? textKey(brandName) : ''
    const own = Boolean(profile) && ((brandKey !== '' && textKey(t).includes(brandKey)) || t.toLowerCase().includes(profile!.host))
    return place && own ? { kind: place.kind, screen: place, viaAction: true } : { kind: 'action' }
  }
  if (!profile) return { kind: 'none' }
  const found = labelsIn(t, [profile])
  if (found.length > 1) return { kind: 'ambiguous' }
  // 화면 이름이 없으면 안내 낱말 — 「근대역사박물관의 이용시간과 휴관일, 입장료가 표시된 화면」은 장소 안내 화면이다.
  const worded = found.length ? found : profile.screens.filter((s) => s.slotWords?.test(t))
  if (worded.length > 1) return { kind: 'ambiguous' }
  const screen = worded[0]
  if (!screen) return { kind: 'unrelated' }
  if (screen.commonLabel) {
    const brandKey = brandName ? textKey(brandName) : ''
    const own = (brandKey !== '' && textKey(t).includes(brandKey)) || t.toLowerCase().includes(profile.host)
    if (!own) return { kind: OTHER_SITE.test(t) ? 'other' : 'unowned' }
  }
  return { kind: screen.kind, screen }
}

/**
 * 화면 자리에 쓸 변형 — 묶음(tiers) 앞부터, 묶음 안에서는 브랜드에서 덜 쓴 변형을 고른다(같으면 표 순서 — photoAutoPick.ts가 고른다).
 * - 권역 변형이 있는 화면(지도): 장면 글자에 한 권역의 이름 · 장소만 나오면 그 권역만(by region — 원도심 장소를 말하는 지도 자리에는
 *   #r-원도심만). 권역이 둘 이상이거나, 장소 사전의 장소(namedPlaces — 장면 글자에 나온 장소)가 어느 권역 목록에도 없으면 전체 지도만
 *   (by named — 그 장소가 안 보이는 권역 지도를 넣지 않게).
 * - 조건 변형이 있는 화면(코스): 조건은 장면 글자와 함께 소제목 · 설명 줄(context)도 본다 — 장면 글자는 대개 「조건을 고르는 모습」뿐이고
 *   조건은 소제목이 말한다.
 *   - 동행(「아이」 · 「부모님」 · 「혼자」 · 「연인」)을 말하면 그 변형(둘 이상 말하면 그것들) 다음 기본 변형(by prefer — 말하지 않은
 *     동행의 변형은 쓰지 않는다. 「연인·혼자」 소제목 아래 부모님 조건 화면이 나가지 않게).
 *   - 조건을 말하지 않으면 기본 변형 다음 조건 변형(by general) — 기본을 이 글 · 작성자에게 이미 썼을 때만 조건 변형을 쓰고, 그때는 두 번째
 *     묶음이라 「확인 필요」가 붙는다(photoAutoPick.ts).
 * - 그 밖에는 모든 변형.
 * 장소 안내(placePages)는 여기서 고르지 않는다 — 자리 글자의 장소를 사이트 장소 사전에서 찾아 그 한 곳(by place — 장면 글자 · 설명 줄,
 * by heading — 소제목에만 나온 장소라 「확인 필요」)을 쓴다(src/lib/photoAutoPick.ts).
 */
export interface ScreenVariantChoice {
  tiers: ScreenVariant[][]
  by?: 'region' | 'named' | 'prefer' | 'general' | 'place' | 'heading'
}

export function screenVariantChoice(screen: ScreenDef, text: string, namedPlaces: readonly string[] = [], context = ''): ScreenVariantChoice {
  const general = screen.variants.filter((v) => !v.places?.length && !v.prefer)
  const base = general.length ? general : [...screen.variants]
  const regional = screen.variants.filter((v) => v.places?.length)
  if (regional.length) {
    const t = textKey(text)
    const hits = regional.filter((v) => v.places!.some((p) => t.includes(textKey(p))))
    const unknown = namedPlaces.filter((name) => !regional.some((v) => v.places!.some((p) => textKey(name).includes(textKey(p)))))
    if (hits.length === 1 && !unknown.length) return { tiers: [hits], by: 'region' }
    if (hits.length > 1 || unknown.length) return { tiers: [base], by: 'named' }
  }
  const conditional = screen.variants.filter((v) => v.prefer)
  if (!conditional.length) return { tiers: [[...screen.variants]] }
  const said = `${text}\n${context}`.normalize('NFC')
  const preferred = conditional.filter((v) => !v.extra && v.prefer!.test(said))
  if (preferred.length) {
    // 같은 조건의 둘째 변형(extra)은 그 조건의 첫 변형 다음, 기본 변형 앞.
    const extras = conditional.filter((v) => v.extra && v.prefer!.test(said))
    return { tiers: [preferred, extras, base.filter((v) => !preferred.includes(v))].filter((tier) => tier.length > 0), by: 'prefer' }
  }
  return { tiers: [base, conditional.filter((v) => !base.includes(v) && !v.extra)].filter((tier) => tier.length > 0), by: 'general' }
}

// ── 잘라 찍은 화면의 사실 확인 ─────────────────────────────────────────────

/** 휴관을 말하는 낱말 — 자리 쪽(「휴관일」 · 「쉬는 날」 · 「휴무」 · 「문을 닫는」)과 찍은 쪽(같은 낱말 · 「연중무휴」도 쉬는 날 안내다). */
const SAID_CLOSED = /휴관|쉬는\s?날|휴무|정기\s?휴일|문\s?(?:을\s?)?닫/
const SHOWN_CLOSED = /휴관|쉬는\s?날|휴무|정기\s?휴일|연중\s?무휴/
/** 쉬는 날이 있다고 말함(「휴관일이 있으니」 · 「휴관합니다」 · 「월요일 휴관」 · 「월요일에 쉽니다」) — 「휴관일이 보이는 화면」은 아니다. */
const SAID_CLOSING_DAYS =
  /(?:휴관일?|쉬는\s?날|휴무일?|정기\s?휴일)(?:이|은|도)?\s?있|휴관(?:합|해요|한다|하며|하고|하는|이고|이며|입니다)|[월화수목금토일]요일(?:과|이나|은|에는|에|마다|도)?\s?(?:\S+\s)?(?:휴관|휴무|쉽|쉬어|쉬는|쉰다|문을?\s?닫|닫)/
/** 쉬는 날이 없다(「연중무휴」 · 「휴관일 없이」 · 「매일 엽니다」). */
const NO_CLOSING = /연중\s?무휴|(?:휴관일?|쉬는\s?날|휴무일?)(?:이|은)?\s?없|매일\s?(?:엽|열|문을\s?열|운영)/
/** 쉬는 날 안내의 구체 — 요일 · 명절 · 날짜(「연중무휴(설 · 추석 당일 휴관)」은 쉬는 날이 있다는 말과 어긋나지 않는다). */
const CLOSING_DETAIL = /[월화수목금토일]요일|설날|설\s?당일|추석|명절|공휴일|\d{1,2}월\s?\d{1,2}일/
const SAID_HOURS = /이용\s?시간|여는\s?시간|운영\s?시간|영업\s?시간|관람\s?시간/
const SAID_FEE = /입장료|관람료|이용료|요금/

/** 사실 확인의 항목 — 요금 · 주차 · 쉬는 날 · 이용시간. */
type FactTopic = 'fee' | 'parking' | 'closed' | 'hours'
/** 글 조각의 항목 — 「주차 요금」은 주차다(요금이 아니다). */
function factTopicsOf(s: string): Set<FactTopic> {
  const out = new Set<FactTopic>()
  if (/주차/.test(s)) out.add('parking')
  if (/입장료|관람료|이용료|요금|입장권|관람권|통합권|개별권/.test(s.replace(/주차\s?(?:요금|비|료)/g, ''))) out.add('fee')
  if (/휴관|쉬는\s?날|휴무|정기\s?휴일|연중\s?무휴|쉽니다|쉬어요|문\s?(?:을\s?)?닫/.test(s)) out.add('closed')
  if (/이용\s?시간|여는\s?시간|운영\s?시간|영업\s?시간|관람\s?시간|입장\s?마감|개방/.test(s)) out.add('hours')
  return out
}
/** 찍은 글자의 항목 머리(안내 카드의 dt — 「이용시간」 · 「쉬는 날」 · 「요금」 · 「주차 요금」 · 「전화」) — 다음 머리까지의 줄이 그 항목이다. */
const FACT_HEADER =
  /^(?:이용\s?시간|운영\s?시간|관람\s?시간|여는\s?시간|영업\s?시간|쉬는\s?날|휴관일?|휴무일?|정기\s?휴일|요금|입장료|관람료|이용료|주차(?:\s?요금|\s?안내)?|전화|주소|문의|가는\s?길|교통|위치|홈\s?페이지)$/
/** 글 조각으로 나누는 곳 — 줄 · 문장 끝 · 쉼표 · 가운뎃점 · 「…이고 · 이며 · 하고 · 으며」. */
const CLAUSE_BREAK = /(?<=[.!?。])\s+|,\s+|;\s*|\s[·•]\s|(?<=이고|이며|하고|으며)\s+/

interface FactSegment {
  text: string
  topics: Set<FactTopic>
}

/**
 * 글을 조각으로 나누고 항목을 단다. headers면 찍은 글자처럼 항목 머리 줄이 다음 줄들의 항목을 정한다(머리 줄은 조각이 아니다) — 조각
 * 자신의 항목 낱말이 먼저다.
 */
function factSegments(text: string, headers: boolean): FactSegment[] {
  const out: FactSegment[] = []
  let block = new Set<FactTopic>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (headers && FACT_HEADER.test(line)) {
      block = factTopicsOf(line)
      continue
    }
    for (const part of line.split(CLAUSE_BREAK)) {
      const t = part.trim()
      if (!t) continue
      const own = factTopicsOf(t)
      out.push({ text: t, topics: own.size ? own : block })
    }
  }
  return out
}

type FactToken = { keys: string[]; text: string }
/** 시각 — 「09:00」 · 「9:00」, 「오전 10시」 · 「오후 6시 30분」 · 「10시 반」(오전 · 오후가 없으면 12시간 뒤도 같은 시각으로 본다). */
function factTimes(s: string): FactToken[] {
  const out: FactToken[] = []
  for (const m of s.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)) out.push({ keys: [`${Number(m[1])}:${m[2]}`], text: m[0] })
  for (const m of s.matchAll(/(?:(오전|오후|낮|밤|저녁|새벽|아침)\s?)?(?<![\d:.])(\d{1,2})\s?시(?![간대즌장청내민티각])(?:\s?(\d{1,2})\s?분|\s?(반))?/g)) {
    const h = Number(m[2])
    if (h > 24) continue
    const mm = m[3] ? String(Number(m[3])).padStart(2, '0') : m[4] ? '30' : '00'
    const pm = m[1] === '오후' || m[1] === '밤' || m[1] === '저녁'
    const hours = m[1] ? [pm && h < 12 ? h + 12 : h] : h < 12 ? [h, h + 12] : [h]
    out.push({ keys: hours.map((x) => `${x}:${mm}`), text: m[0].trim() })
  }
  return out
}
const factWons = (s: string): FactToken[] =>
  [...s.matchAll(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s?원/g)].map((m) => ({ keys: [`${m[1]!.replace(/,/g, '')}원`], text: m[0] }))
const factMonths = (s: string): FactToken[] =>
  [...s.matchAll(/(?<!\d)(\d{1,2})\s?[~∼〜\-–—]\s?(\d{1,2})\s?월/g)].map((m) => ({ keys: [`${Number(m[1])}~${Number(m[2])}월`], text: m[0] }))
const factDays = (s: string): FactToken[] => [...s.matchAll(/([월화수목금토일])요일/g)].map((m) => ({ keys: [m[0]], text: m[0] }))

/**
 * 자리 글자(장면 글자 · 설명 줄)가 말한 사실 가운데 찍은 부분의 글자(screens.json text)에 없는 것 — 잘라 찍은 화면(장소 안내 · 가이드)을
 * 넣을 때 「확인 필요」를 붙이는 기준이다(막지는 않는다). 찍은 글자는 항목(이용시간 · 쉬는 날 · 요금 · 주차 — 안내 카드의 머리 줄과 글 조각의
 * 낱말)과 글 조각으로 나눠 견준다:
 * - 값: 시각(09:00 = 9:00 = 오전 9시), 금액(2,000원 = 2000원), 달 범위(3~10월), 요일(월요일), 「무료」, 「입장 마감」 — 찍은 글자에 같은 값이
 *   있어야 한다. 금액 · 무료는 자리 조각이 말한 항목(입장료 · 주차)의 조각에 있어야 하고(주차 무료 ≠ 입장료 무료), 달 범위와 함께 말한
 *   시각은 찍은 글자의 그 달 범위 조각에 있어야 한다(11~2월 18:00 ≠ 3~10월 18:00).
 * - 말만: 휴관(휴관일 · 쉬는 날 · 휴무 — 찍은 쪽의 「연중무휴」도 쉬는 날 안내로 본다), 이용시간(찍은 글자에 시각이 하나라도),
 *   요금 · 입장료(찍은 글자에 금액이나 「무료」가 하나라도).
 * - 어긋남: 쉬는 날이 있다는 말(「휴관일이 있으니」 · 「월요일에 쉽니다」)인데 찍은 글자가 「연중무휴」뿐이면, 「연중무휴」라는 말인데 찍은
 *   글자가 쉬는 날을 적으면.
 * 없는 것을 자리 글자에 적힌 모양 그대로(「09:00」 · 「성인 2,000원」의 「2,000원」 · 「휴관일」의 「휴관」 · 「오전 10시」) 돌려준다. 띄어쓰기
 * · 전각 글자는 무시한다.
 */
export function screenFactGaps(said: string, shown: string): string[] {
  const a = said.normalize('NFKC')
  const b = shown.normalize('NFKC')
  const saidSegs = factSegments(a, false)
  const shownSegs = factSegments(b, true)
  const gaps: string[] = []
  const add = (text: string) => {
    if (!gaps.includes(text)) gaps.push(text)
  }
  const keysIn = (segs: readonly FactSegment[], pick: (s: string) => FactToken[]) => new Set(segs.flatMap((s) => pick(s.text).flatMap((t) => t.keys)))
  const has = (segs: readonly FactSegment[], pick: (s: string) => FactToken[], t: FactToken) => {
    const keys = keysIn(segs, pick)
    return t.keys.some((k) => keys.has(k))
  }
  /** 자리 조각이 요금 · 주차를 말하면 찍은 글자에서 그 항목의 조각만(둘 다 말하면 둘 다에 있어야), 아니면 모든 조각. */
  const topicScopes = (seg: FactSegment): FactSegment[][] => {
    const wanted = (['fee', 'parking'] as const).filter((x) => seg.topics.has(x))
    return wanted.length ? wanted.map((x) => shownSegs.filter((s) => s.topics.has(x))) : [shownSegs]
  }
  // 시각 — 달 범위와 함께 말했으면 찍은 글자의 그 달 범위 조각에서.
  for (const seg of saidSegs) {
    const monthSegs = factMonths(seg.text).flatMap((m) => shownSegs.filter((s) => has([s], factMonths, m)))
    for (const t of factTimes(seg.text)) if (!has(monthSegs.length ? monthSegs : shownSegs, factTimes, t)) add(t.text)
  }
  for (const seg of saidSegs) for (const t of factWons(seg.text)) if (!topicScopes(seg).every((scope) => has(scope, factWons, t))) add(t.text)
  for (const seg of saidSegs) for (const t of factMonths(seg.text)) if (!has(shownSegs, factMonths, t)) add(t.text)
  for (const seg of saidSegs) for (const t of factDays(seg.text)) if (!has(shownSegs, factDays, t)) add(t.text)
  for (const seg of saidSegs) if (/무료/.test(seg.text) && !topicScopes(seg).every((scope) => scope.some((s) => /무료/.test(s.text)))) add('무료')
  if (/입장\s?마감/.test(a) && !/입장\s?마감/.test(b)) add('입장 마감')
  const saysClosing = SAID_CLOSED.test(a) || SAID_CLOSING_DAYS.test(a)
  const closedLabel = SAID_CLOSED.exec(a)?.[0] ?? '쉬는 날'
  if (saysClosing && !NO_CLOSING.test(a) && !SHOWN_CLOSED.test(b)) add(closedLabel)
  // 어긋남 — 쉬는 날이 있다는 말 ↔ 찍은 글자의 연중무휴(구체 없음), 연중무휴라는 말 ↔ 찍은 글자의 쉬는 날.
  const shownClosed = shownSegs.filter((s) => s.topics.has('closed'))
  if (SAID_CLOSING_DAYS.test(a) && !NO_CLOSING.test(a) && NO_CLOSING.test(b) && !shownClosed.some((s) => CLOSING_DETAIL.test(s.text))) add(closedLabel)
  if (NO_CLOSING.test(a) && !NO_CLOSING.test(b) && shownClosed.some((s) => CLOSING_DETAIL.test(s.text))) add(/연중\s?무휴/.test(a) ? '연중무휴' : NO_CLOSING.exec(a)![0])
  if (SAID_HOURS.test(a) && factTimes(b).length === 0) add(SAID_HOURS.exec(a)![0])
  if (SAID_FEE.test(a) && factWons(b).length === 0 && !/무료/.test(b)) add(SAID_FEE.exec(a)![0])
  return gaps
}
