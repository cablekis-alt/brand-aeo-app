/**
 * 글을 올릴 수 있는 블로그 플랫폼 카탈로그.
 *
 * 인용 분류(server/citationSources.ts)는 `host.startsWith('blog.')`도 blog로 본다. 그래서
 * blog.21ps.co.kr, blog.viewclinic.com 같은 **남의 회사 자체 블로그**가 같은 라벨을 단다.
 * 거기엔 우리가 글을 올릴 수 없으므로 실행 항목에서 blog를 통째로 뺐었다(v0.1.56). 이 카탈로그는
 * 그중 "누구나 계정을 만들어 발행할 수 있는 플랫폼"만 되살린다.
 *
 * ── 왜 도메인이 아니라 플랫폼 단위로 묶나 ───────────────────────────────────
 * 티스토리는 글쓴이마다 서브도메인이 다르다. 실측(k-wonjin 2026-W37): blog 도메인 21개 중
 * 16개가 인용 1~4회짜리 개별 티스토리다. 도메인마다 카드를 만들면 쓸모없는 목록 16줄이 된다.
 * 플랫폼으로 묶으면 "티스토리 24회 인용 중 우리 뒷받침 2회"라는 한 줄이 된다.
 *
 * 묶음은 성과 판정에도 맞다. 우리가 새 티스토리 블로그를 열면 그건 인용 집합에 없던 새 서브도메인
 * 이지만, 플랫폼 단위로 보면 *.tistory.com의 뒷받침이 늘어난 것으로 그대로 잡힌다.
 * 네이버 블로그는 반대로 모두가 blog.naver.com 한 도메인을 공유해 경로만 다르다 — 어느 쪽이든
 * 플랫폼이 올바른 단위다.
 */
export interface BlogPlatform {
  /** 그룹 키이자 실행 항목의 targetDomain. */
  key: string
  label: string
  test: (host: string) => boolean
  /** 제목에 붙는 동사. label이 플랫폼 이름을 말하므로 '발행' 하나면 된다 — '블로그 발행'을
   *  쓰면 "네이버 블로그 블로그 발행"이 된다. */
  verb: string
  /** 채널 특성 메모. 직접 발행인지, 필자에게 제안해야 하는지가 갈린다. */
  note: string
}

export const BLOG_PLATFORMS: BlogPlatform[] = [
  {
    key: 'blog.naver.com',
    label: '네이버 블로그',
    // m.blog / post.naver 는 같은 플랫폼의 다른 표기다. 하나로 묶지 않으면 지분이 쪼개져 보인다.
    test: (h) => h === 'blog.naver.com' || h === 'm.blog.naver.com' || h === 'post.naver.com' || h === 'm.post.naver.com',
    verb: '발행',
    note: '모든 글이 blog.naver.com 한 도메인을 공유합니다 — 우리 블로그를 운영하면 그 지분이 바로 올라갑니다.',
  },
  {
    key: 'tistory.com',
    label: '티스토리',
    test: (h) => h === 'tistory.com' || h.endsWith('.tistory.com'),
    verb: '발행',
    note: '글쓴이마다 주소가 다릅니다 — 우리 블로그를 열거나, 이미 인용되는 글쓴이에게 제안하는 두 길이 있습니다.',
  },
  {
    key: 'brunch.co.kr',
    label: '브런치',
    test: (h) => h === 'brunch.co.kr' || h.endsWith('.brunch.co.kr'),
    verb: '발행',
    note: '작가 승인이 필요합니다. 광고성 글은 노출이 제한됩니다.',
  },
  {
    key: 'velog.io',
    label: 'velog',
    test: (h) => h === 'velog.io' || h.endsWith('.velog.io'),
    verb: '발행',
    note: '개발·기술 주제 중심 플랫폼입니다.',
  },
  {
    key: 'medium.com',
    label: 'Medium',
    test: (h) => h === 'medium.com' || h.endsWith('.medium.com'),
    verb: '발행',
    note: '영문 콘텐츠 비중이 높습니다.',
  },
  {
    key: 'substack.com',
    label: 'Substack',
    test: (h) => h === 'substack.com' || h.endsWith('.substack.com'),
    verb: '발행',
    note: '뉴스레터 형식입니다.',
  },
  {
    key: 'wordpress.com',
    label: 'WordPress.com',
    test: (h) => h === 'wordpress.com' || h.endsWith('.wordpress.com'),
    verb: '발행',
    note: '자체 호스팅 워드프레스(우리 도메인)는 여기 해당하지 않습니다.',
  },
  {
    key: 'blogspot.com',
    label: 'Blogger',
    test: (h) => h === 'blogspot.com' || h.endsWith('.blogspot.com') || h === 'blogger.com',
    verb: '발행',
    note: '구글 계정으로 바로 개설됩니다.',
  },
]

/** 이 호스트가 발행 가능한 블로그 플랫폼이면 그 플랫폼, 아니면 null(= 남의 자체 블로그). */
export function blogPlatformOf(host: string): BlogPlatform | null {
  const h = host.replace(/^www\./, '').toLowerCase()
  return BLOG_PLATFORMS.find((p) => p.test(h)) ?? null
}
