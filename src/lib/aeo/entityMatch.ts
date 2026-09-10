import type { PageSignals } from './types'

/**
 * 엔티티 일치 — "이 페이지가 어느 브랜드에 대한 것인지 기계가 알 수 있는가".
 *
 * Site AEO 총점(scoreAeo.ts)에는 **넣지 않는다.** 배점은 aeocheck 총점에 맞춰 정렬을 끝냈고
 * (MAD 5.00, 하니스는 회귀 감지기), 브랜드명을 점수에 반영하면 같은 URL이 브랜드명을 아는지
 * 여부에 따라 다른 점수가 된다. 그래서 이 모듈은 scoreAeo를 건드리지 않는 별도 진단이다.
 *
 * 입력은 선택된 브랜드의 brandName·aliases뿐 — 화면에 새 입력창을 만들지 않는다.
 */

export type EntityMatchStatus =
  | 'match' // 신호가 있고 브랜드와 일치
  | 'mismatch' // 신호는 있는데 브랜드가 안 보임
  | 'absent' // 신호 자체가 없음
  | 'weak' // 있긴 하나 형태가 약함(예: H1이 브랜드명만)

export interface EntityMatchRow {
  key: string
  label: string
  status: EntityMatchStatus
  /** 페이지에서 읽은 값(없으면 null). 화면에 그대로 보여준다. */
  found: string | null
  /** 이 신호가 왜 중요한지 + 무엇을 하면 되는지. */
  note: string
}

export interface EntityMatchReport {
  brandName: string
  rows: EntityMatchRow[]
  matched: number
  checked: number
}

/** 공백·대소문자·괄호류를 지운 비교용 형태. 한국어 상호는 공백 유무가 흔들려서 공백을 없앤다. */
function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[()[\]{}<>|·・,./\\-]/g, ' ')
    .replace(/\s+/g, '')
    .trim()
}

/** 브랜드명·별칭 중 하나라도 대상 문자열 안에 있으면 일치로 본다. */
function containsBrand(target: string, candidates: string[]): string | null {
  const t = norm(target)
  if (!t) return null
  for (const c of candidates) {
    const n = norm(c)
    if (n.length >= 2 && t.includes(n)) return c
  }
  return null
}

/** 대상이 사실상 브랜드명 하나로만 이루어졌는지 — H1이 로고 대체 텍스트인 경우를 잡는다. */
function isBrandOnly(target: string, candidates: string[]): boolean {
  const t = norm(target)
  if (!t) return false
  for (const c of candidates) {
    const n = norm(c)
    if (n.length >= 2 && t === n) return true
    // 브랜드명이 대상의 80% 이상을 차지하면 나머지는 장식으로 본다("원진성형외과 | 강남").
    if (n.length >= 2 && t.includes(n) && n.length / t.length >= 0.8) return true
  }
  return false
}

const ORG_TYPES = /^(organization|localbusiness|corporation|medicalorganization|medicalclinic|hospital|dentist|store|restaurant|lodgingbusiness|hotel)$/i

export function checkEntityMatch(
  s: PageSignals,
  brandName: string,
  aliases: string[] = [],
): EntityMatchReport | null {
  const name = brandName.trim()
  if (!name) return null
  const candidates = [name, ...aliases.map((a) => a.trim()).filter(Boolean)]

  const rows: EntityMatchRow[] = []

  // 1) <title> — 답변 엔진이 페이지를 목록에 올릴 때 가장 먼저 읽는 이름표.
  rows.push(
    !s.title
      ? {
          key: 'title',
          label: '<title>',
          status: 'absent',
          found: null,
          note: 'title이 비어 있습니다. "브랜드명 + 무엇을 하는 곳"으로 채우세요.',
        }
      : containsBrand(s.title, candidates)
        ? { key: 'title', label: '<title>', status: 'match', found: s.title, note: '브랜드명이 들어 있습니다.' }
        : {
            key: 'title',
            label: '<title>',
            status: 'mismatch',
            found: s.title,
            note: `title에 "${name}"이(가) 없습니다. 엔진이 이 페이지를 어느 브랜드로 묶을지 판단하기 어렵습니다.`,
          },
  )

  // 2) H1 — 브랜드명만 있으면 로고 대체 텍스트다(무엇을 하는 곳인지 설명이 없다).
  const h1 = s.h1s[0] ?? ''
  rows.push(
    !h1
      ? { key: 'h1', label: 'H1', status: 'absent', found: null, note: 'H1이 없습니다. 페이지 주제를 한 문장으로 두세요.' }
      : isBrandOnly(h1, candidates)
        ? {
            key: 'h1',
            label: 'H1',
            status: 'weak',
            found: h1,
            note: 'H1이 브랜드명뿐입니다(로고 대체 텍스트). "브랜드명은 …하는 곳입니다" 형태로 서술을 더하세요.',
          }
        : containsBrand(h1, candidates)
          ? { key: 'h1', label: 'H1', status: 'match', found: h1, note: '브랜드명과 설명이 함께 있습니다.' }
          : {
              key: 'h1',
              label: 'H1',
              status: 'mismatch',
              found: h1,
              note: `H1에 "${name}"이(가) 없습니다. 주제만 있고 주체가 없으면 엔티티로 묶이지 않습니다.`,
            },
  )

  // 3) og:site_name — 사이트 단위 이름. 공유·수집기가 브랜드를 식별하는 데 쓴다.
  rows.push(
    !s.ogSiteName
      ? {
          key: 'ogSiteName',
          label: 'og:site_name',
          status: 'absent',
          found: null,
          note: `<meta property="og:site_name" content="${name}">를 추가하세요.`,
        }
      : containsBrand(s.ogSiteName, candidates)
        ? { key: 'ogSiteName', label: 'og:site_name', status: 'match', found: s.ogSiteName, note: '브랜드명과 일치합니다.' }
        : {
            key: 'ogSiteName',
            label: 'og:site_name',
            status: 'mismatch',
            found: s.ogSiteName,
            note: `사이트 이름이 "${name}"과(와) 다릅니다. 브랜드명으로 통일하세요.`,
          },
  )

  // 4) JSON-LD 조직 엔티티의 name — 구조화 데이터가 브랜드를 명시적으로 선언하는 자리.
  const orgEntity = s.jsonLdEntities.find((e) => e.types.some((t) => ORG_TYPES.test(t)) && e.name)
  rows.push(
    !orgEntity
      ? {
          key: 'jsonLdOrg',
          label: 'JSON-LD 조직 name',
          status: 'absent',
          found: null,
          note: 'Organization / LocalBusiness 구조화 데이터에 name이 없습니다. 엔티티를 기계가 읽을 수 있게 선언하세요.',
        }
      : containsBrand(orgEntity.name ?? '', candidates)
        ? {
            key: 'jsonLdOrg',
            label: 'JSON-LD 조직 name',
            status: 'match',
            found: orgEntity.name,
            note: `${orgEntity.types.join(' · ')} 로 브랜드가 선언돼 있습니다.`,
          }
        : {
            key: 'jsonLdOrg',
            label: 'JSON-LD 조직 name',
            status: 'mismatch',
            found: orgEntity.name,
            note: `구조화 데이터의 name이 "${name}"과(와) 다릅니다. 같은 표기로 맞추세요.`,
          },
  )

  // 5) NAP — 이름·주소·전화. 여기서는 "주소·연락처 형태가 페이지에 있는지"만 본다
  //    (실제 값이 사업자 등록 정보와 같은지는 이 도구가 확인할 수 없다).
  const napBoth = s.addressLike && s.phoneOrEmail
  rows.push({
    key: 'nap',
    label: '주소 · 연락처',
    status: napBoth ? 'match' : s.addressLike || s.phoneOrEmail ? 'weak' : 'absent',
    found: napBoth ? '주소·연락처 모두 있음' : s.addressLike ? '주소만 있음' : s.phoneOrEmail ? '연락처만 있음' : null,
    note: napBoth
      ? '지역 엔티티로 묶일 근거가 있습니다. 표기는 다른 채널(지도·디렉터리)과 동일해야 합니다.'
      : '주소와 전화(또는 이메일)를 본문 텍스트로 함께 두세요. 이미지로만 있으면 수집되지 않습니다.',
  })

  return {
    brandName: name,
    rows,
    matched: rows.filter((r) => r.status === 'match').length,
    checked: rows.length,
  }
}
