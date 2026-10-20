/**
 * 브랜드별 발행 설정 — 글 끝 상담 안내 · 문의 링크 · 기본 태그 · 카테고리 · 블로그 주소.
 *
 * 글쓰기 모델은 이 값을 모른다(본문에 상담 안내를 쓰게 하면 브랜드마다 문구가 흔들리고 사실 가드에 걸린다).
 * 사람이 한 번 적어 두면 코드가 발행본 끝에 붙인다(src/lib/publishArticle.ts). 서버(server/publishSettingsStore.ts)와
 * 화면이 같은 규칙으로 고르도록 여기 둔다 — 화면에서 통과한 값이 저장에서 거절되는 일이 없게.
 */
export interface PublishSettings {
  /** 글 끝 상담 안내 한 문단 — 예: 「사이트 주소와 자주 받는 질문 2~3개를 준비해 문의해 주세요.」 */
  ctaText?: string
  /** 문의 링크(http · https). */
  inquiryUrl?: string
  /** 기본 태그 — # 없이. */
  tags?: string[]
  /** 블로그 카테고리. */
  category?: string
  /** 브랜드 블로그 주소 — 티스토리면 글쓰기 화면을 연다. */
  blogUrl?: string
  /**
   * 공식 사이트 주소 — 글 끝 「○○ 공식 사이트」 링크와 .html 구조화 데이터의 웹사이트 주소. 비우면 첫 소유 도메인의 루트를 쓴다.
   * 한 도메인을 여러 브랜드가 경로로 나눠 쓰면(https://web4ai.o2osolution.ai/s/stay) 루트는 그 브랜드가 아니라서 따로 적는다.
   * 「브랜드 페이지」(사실을 읽어 오는 페이지 — 오시는 길 · 진료 안내 등)와는 다른 값이다.
   */
  siteUrl?: string
  /**
   * 홈페이지 사진을 글에 써도 된다는 확인(브랜드별 한 번, src/lib/articlePhotos.ts). 서버만 찍는다(PUT photo-rights) — 설정 패널
   * 저장(PUT publish-settings)은 이 값을 받지 않고 저장된 값을 이어받는다.
   */
  photoRights?: PhotoRights
  updatedAt?: string
}

/** 홈페이지 사진 사용 확인. medical: 의료 업종에서 의료광고(환자 · 시술 전후 사진) 확인까지 받았다. */
export interface PhotoRights {
  confirmedAt: string
  medical?: true
}

export const PUBLISH_LIMITS = { cta: 200, tags: 10, tag: 30, category: 30 } as const

/** http · https 주소만 받는다. javascript: · data: 같은 주소는 거절한다(발행본에 링크로 들어간다). */
export function httpUrl(raw: unknown, label: string): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return undefined
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`)
  } catch {
    throw new Error(`${label} 주소를 읽지 못했어요: ${s}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}는 http · https 주소만 쓸 수 있어요.`)
  return url.href
}

/**
 * 상담 안내 한 문단. 줄바꿈은 한 칸으로 붙이고, 맨 앞의 제목 · 인용 · 목록 표시(#·>·-·「1.」)는 떼어 낸다 — 마크다운
 * 제목 · 인용 · 목록이 되어 글 끝 모양이 바뀌지 않게. 인용(>) 말고는 **뒤에 공백이 있을 때만** 표시다 — 「1.5배」 「+82」
 * 「**무료 상담**」의 앞 글자를 떼면 숫자 · 서식이 바뀐다(글 끝은 사실 대조를 거치지 않는다).
 */
const CTA_MARK = /^(#{1,6}\s+|>+\s*|[-*+]\s+|\d+[.)]\s+)/
function ctaOf(raw: unknown): string | undefined {
  let s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  while (CTA_MARK.test(s)) s = s.replace(CTA_MARK, '')
  if (!s) return undefined
  if (s.length > PUBLISH_LIMITS.cta) throw new Error(`상담 안내는 ${PUBLISH_LIMITS.cta}자까지 쓸 수 있어요(지금 ${s.length}자).`)
  return s
}

/** 태그 — 배열이나 쉼표로 나눈 글자. 앞의 #는 떼고, 같은 태그는 한 번만. */
function tagsOf(raw: unknown): string[] | undefined {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : []
  const out: string[] = []
  for (const item of items) {
    const t = String(item).trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (t.length > PUBLISH_LIMITS.tag) throw new Error(`태그는 ${PUBLISH_LIMITS.tag}자까지예요: ${t}`)
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  if (out.length > PUBLISH_LIMITS.tags) throw new Error(`태그는 ${PUBLISH_LIMITS.tags}개까지 넣을 수 있어요(지금 ${out.length}개).`)
  return out.length ? out : undefined
}

function categoryOf(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!s) return undefined
  if (s.length > PUBLISH_LIMITS.category) throw new Error(`카테고리는 ${PUBLISH_LIMITS.category}자까지예요.`)
  return s
}

/** 저장된 사진 사용 확인 — 날짜로 읽히는 확인 시각만. 깨진 값은 조용히 뺀다(설정 전체를 못 읽게 하지 않는다). */
function photoRightsOf(raw: unknown): PhotoRights | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.confirmedAt !== 'string' || Number.isNaN(Date.parse(r.confirmedAt))) return undefined
  return { confirmedAt: r.confirmedAt, ...(r.medical === true ? { medical: true as const } : {}) }
}

/** 받은 값을 고른다. 빈 칸은 뺀다. 틀린 값은 이유를 담아 throw. */
export function normalizePublishSettings(input: unknown): PublishSettings {
  const raw = (input ?? {}) as Record<string, unknown>
  const out: PublishSettings = {}
  const ctaText = ctaOf(raw.ctaText)
  const inquiryUrl = httpUrl(raw.inquiryUrl, '문의 링크')
  const tags = tagsOf(raw.tags)
  const category = categoryOf(raw.category)
  const blogUrl = httpUrl(raw.blogUrl, '블로그')
  const siteUrl = httpUrl(raw.siteUrl, '공식 사이트')
  if (ctaText) out.ctaText = ctaText
  if (inquiryUrl) out.inquiryUrl = inquiryUrl
  if (tags) out.tags = tags
  if (category) out.category = category
  if (blogUrl) out.blogUrl = blogUrl
  if (siteUrl) out.siteUrl = siteUrl
  const photoRights = photoRightsOf(raw.photoRights)
  if (photoRights) out.photoRights = photoRights
  return out
}

/**
 * 블로그 글쓰기 화면. 티스토리는 블로그마다 관리 화면이 따로 있고(https://<블로그>.tistory.com/manage/newpost),
 * 네이버 블로그는 공용 글쓰기 주소가 있다. 그 밖은 적어 둔 주소 그대로 연다.
 */
export function blogWriteUrl(blogUrl: string): string {
  let url: URL
  try {
    url = new URL(blogUrl)
  } catch {
    return blogUrl
  }
  const host = url.hostname.toLowerCase()
  if (host.endsWith('.tistory.com') && host !== 'www.tistory.com') return `https://${host}/manage/newpost`
  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') return 'https://blog.naver.com/GoBlogWrite.naver'
  return url.href
}
