import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import BrandManageList from '../components/BrandManageList'
import { useTenant } from '../context/useTenant'
import { extractPage } from '../lib/aeo/extractPage'
import { fetchPage } from '../lib/aeo/fetchPage'
import { parsePublicHttpUrl } from '../lib/aeo/netGuard'

// 한국 주소 best-effort 추출 (시/도 + 시/군/구 + 로/길 + 번지 + 선택 건물). 실패해도 사용자가 직접 수정 가능.
const KR_ADDRESS =
  /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청?[남북]?|충[남북]|전라?[남북]?|전[남북]|경상?[남북]?|경[남북]|제주)[가-힣]*(?:특별자치[시도]|특별[시도]|광역시|도)?\s?[가-힣]+(?:시|군|구)\s?[가-힣0-9]+(?:로|길)\s?\d+[-\d]*(?:\s+[가-힣A-Za-z0-9]+(?:타워|빌딩|건물|센터|프라자)(?:\s*\d+\s*[-~]?\s*\d*\s*층)?)?)/

function htmlToPlain(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstKrAddress(text: string): string {
  return text.match(KR_ADDRESS)?.[0]?.trim() ?? ''
}

/** 도로명 주소 → 코호트용 지역 ("서울시 서초구 …" → "서울 서초"). */
function regionFromAddress(addr: string): string {
  const m = addr.match(
    /((?:서울|부산|대구|인천|광주|대전|울산|세종)(?:특별시|광역시|시)?|(?:경기|강원|충남|충북|전남|전북|경남|경북|제주|충청[남북]|전라[남북]|경상[남북])(?:도)?)\s*([가-힣]+(?:시|군|구))/,
  )
  if (!m) return ''
  const sido = m[1]
    .replace('충청남도', '충남')
    .replace('충청북도', '충북')
    .replace('전라남도', '전남')
    .replace('전라북도', '전북')
    .replace('경상남도', '경남')
    .replace('경상북도', '경북')
    .replace(/특별시|광역시|특별자치시|특별자치도|도$/g, '')
    .replace(/시$/, '')
  const district = m[2].replace(/(?:시|군|구)$/, '')
  return `${sido} ${district}`.trim()
}

function locationClues(plain: string): string {
  const hits: string[] = []
  const addr = firstKrAddress(plain)
  if (addr) hits.push(addr)
  const around = plain.match(/.{0,24}(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|제주)[가-힣0-9\s,.]{0,60}/g) ?? []
  for (const s of around) {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t && !hits.includes(t)) hits.push(t)
    if (hits.length >= 6) break
  }
  return hits.join('\n')
}

interface CompetitorDraft {
  name: string
  aliases: string[]
  domains: string[]
}

interface TenantDraft {
  tenantId: string
  brandName: string
  aliases: string[]
  ownedDomains: string[]
  industry: string
  region: string
  engines: string[]
  questionBankSize: number
  questionBankVersion: string
  repeatsPerQuestion: number
  competitors: CompetitorDraft[]
  factGraph: { id: string; type: string; claim: string; value: string; updatedAt: string }[]
  cohortOnly?: boolean
  autoCohort?: boolean
}

function hostToDomain(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

function slugFromDomain(domain: string): string {
  const label = domain.split('.')[0] || 'brand'
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand'
}

// 주소가 홈페이지 본문에 없을 때, 같은 도메인의 "오시는 길·연락처" 링크를 찾아 한 번 더 수집한다.
const CONTACT_KEYWORDS = [
  '오시는', '찾아오시', '오시는길', '연락처', '위치', '약도', '지도',
  'contact', 'location', 'directions', 'direction', 'map', 'access', 'find-us', 'findus', 'way',
]
function findContactUrl(html: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl)
    const scored: { url: string; score: number }[] = []
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1]
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      const hrefLow = href.toLowerCase()
      let score = 0
      for (const k of CONTACT_KEYWORDS) {
        if (text.includes(k)) score += 2
        if (hrefLow.includes(k)) score += 3
      }
      if (score === 0) continue
      let abs: URL
      try {
        abs = new URL(href, base)
      } catch {
        continue
      }
      if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue
      if (abs.hostname !== base.hostname) continue // 같은 도메인만
      if (abs.href.replace(/#.*$/, '') === base.href.replace(/#.*$/, '')) continue // 자기 자신 제외
      scored.push({ url: abs.href, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored[0]?.url ?? null
  } catch {
    return null
  }
}


/** "강남언니, gangnamunni.com" 형식 줄들을 경쟁사 배열로. */
function parseCompetitors(raw: string): CompetitorDraft[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, domain] = line.split(',').map((s) => s.trim())
      return {
        name: name || '',
        aliases: name ? [name] : [],
        domains: domain ? [hostToDomain(domain.includes('://') ? domain : `https://${domain}`)] : [],
      }
    })
    .filter((c) => c.name)
}

type StageStatus = 'current' | 'done' | 'locked' | 'open'

function stageStatus(id: 1 | 2 | 3 | 4, extracted: boolean, ready: boolean): StageStatus {
  if (id === 1) return extracted ? 'done' : 'current'
  if (!extracted) return 'locked'
  if (id === 2) return ready ? 'done' : 'current'
  if (id === 4) return ready ? 'current' : 'open'
  return 'open'
}

function StageShell({
  id,
  code,
  title,
  status,
  children,
}: {
  id: string
  code: string
  title: string
  status: StageStatus
  children: ReactNode
}) {
  const locked = status === 'locked'
  return (
    <section id={id} className={`onboard-stage panel${status === 'current' ? ' is-current' : ''}${locked ? ' is-locked' : ''}`}>
      <header className="onboard-stage-head">
        <span className="onboard-stage-code">{code}</span>
        <h2>{title}</h2>
        {status === 'done' && <span className="onboard-stage-mark">완료</span>}
        {status === 'current' && <span className="onboard-stage-mark on">진행</span>}
      </header>
      {locked ? <p className="onboard-lock">URL에서 자동 채우기를 먼저 실행하세요.</p> : children}
    </section>
  )
}

export default function BrandOnboarding() {
  const { reloadTenants, setTenantId } = useTenant()
  const [url, setUrl] = useState('')
  const [industry, setIndustry] = useState('')
  const [region, setRegion] = useState('')
  const [brandName, setBrandName] = useState('')
  const [domain, setDomain] = useState('')
  const [address, setAddress] = useState('')
  const [findingAddr, setFindingAddr] = useState(false)
  const [addrMsg, setAddrMsg] = useState<string | null>(null)
  const [competitorsRaw, setCompetitorsRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extracted, setExtracted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [canRegister, setCanRegister] = useState(false)
  // 측정 경로: local(=/run 로컬 측정) | github(=GitHub Actions dispatch) | none(=대기열만).
  const [measureVia, setMeasureVia] = useState<'local' | 'github' | 'none'>('none')
  // 로컬 백엔드에서만 주소 조회(Gemini)가 동작한다 — Vercel(미국 리전)에선 "모름"이라 버튼을 숨긴다.
  const [addrLookupOn, setAddrLookupOn] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerMsg, setRegisterMsg] = useState<string | null>(null)
  // 경쟁사도 cohortOnly로 함께 측정 → 코호트 랭킹이 1/N으로 채워진다(기본 켬).
  const [withCohort, setWithCohort] = useState(true)
  const [suggestingComp, setSuggestingComp] = useState(false)
  const [compMsg, setCompMsg] = useState<string | null>(null)
  // 코호트 표기 불일치 방지 — 기존 브랜드의 업종·지역을 자동완성으로 제공한다.
  const [cohortIndustries, setCohortIndustries] = useState<string[]>([])
  const [cohortRegions, setCohortRegions] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { industry?: string; region?: string }[]) => {
        if (!alive || !Array.isArray(list)) return
        const uniq = (vals: (string | undefined)[]) =>
          [...new Set(vals.filter((v): v is string => Boolean(v && v.trim())))].sort((a, b) => a.localeCompare(b, 'ko'))
        setCohortIndustries(uniq(list.map((t) => t.industry)))
        setCohortRegions(uniq(list.map((t) => t.region)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 배포(Vercel)에서도 /api/health가 canRegister를 알려 준다.
  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setCanRegister(Boolean(d.canRegister))
        setMeasureVia(d.measureVia === 'local' || d.measureVia === 'github' ? d.measureVia : 'none')
        setAddrLookupOn(typeof d.backend === 'string' && d.backend !== 'vercel')
      })
      .catch(() => {
        if (alive) setCanRegister(false)
      })
    return () => {
      alive = false
    }
  }, [])

  async function handleExtract(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setExtracted(false)
    const parsed = parsePublicHttpUrl(url)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setBusy(true)
    try {
      const payload = await fetchPage(parsed.href)
      if (payload.fetchError && !payload.html) {
        setError(`페이지를 가져오지 못했습니다: ${payload.fetchError}. 브랜드명·도메인은 직접 입력해 진행할 수 있습니다.`)
        setDomain(hostToDomain(parsed.href))
        setExtracted(true)
        return
      }
      const s = extractPage({
        requestedUrl: parsed.href,
        finalUrl: payload.finalUrl || parsed.href,
        status: payload.status,
        contentType: payload.contentType,
        redirected: payload.redirected,
        html: payload.html,
        robotsTxt: payload.robotsTxt,
        robotsTxtStatus: payload.robotsTxtStatus,
        sitemapFound: payload.sitemapFound,
        llmsTxtFound: payload.llmsTxtFound,
        xRobotsTag: payload.xRobotsTag,
        fetchError: payload.fetchError,
        fetchErrorCode: payload.fetchErrorCode,
        renderMode: payload.renderMode,
        rendered: payload.rendered,
        renderWarning: payload.renderWarning,
      })
      // 봇 차단(JS-only 리다이렉트) 감지 — body에 실제 텍스트가 없고 JS 리다이렉트 패턴만 있으면 경고.
      const htmlContent = payload.html || ''
      const isBotBlocked =
        !s.mainText?.trim() &&
        !s.title?.trim() &&
        (htmlContent.includes('ckattempt') || htmlContent.includes('slowAES') ||
          (htmlContent.length < 3000 && /location\.href/.test(htmlContent)))

      const guessedName =
        s.ogSiteName?.trim() ||
        s.orgCandidates?.[0]?.trim() ||
        (s.title || '').split(/[|\-–—:·]/)[0].trim()
      const finalDomain = hostToDomain(s.finalUrl || parsed.href)
      setDomain(finalDomain)
      setBrandName(guessedName)
      // 진단용 extractPage는 footer를 버리므로, 주소는 원본 HTML 전체에서 다시 찾는다.
      const pagePlain = htmlToPlain(payload.html || '')
      let resolvedAddr = firstKrAddress(s.mainText || '') || firstKrAddress(pagePlain)
      let resolvedRegion = regionFromAddress(resolvedAddr) || region
      // 서초구 강남대로/강남역 병원은 기존 코호트가 "서울 강남"인 경우가 많다.
      if (
        resolvedRegion === '서울 서초' &&
        cohortRegions.includes('서울 강남') &&
        /강남역|강남대로/.test(pagePlain)
      ) {
        resolvedRegion = '서울 강남'
      }
      if (resolvedAddr) setAddress(resolvedAddr)
      if (resolvedRegion) setRegion((prev) => prev || resolvedRegion)
      setExtracted(true)

      // 업종·지역·주소는 정규식만으로 부족하니, 읽어온 본문+푸터 위치 단서를 Gemini로 추론해 비어 있는 칸만 채운다.
      const pageText = (s.mainText || '').trim()
      const clues = locationClues(pagePlain)
      const inferText = [clues && `위치 단서:\n${clues}`, pageText].filter(Boolean).join('\n\n')
      if (isBotBlocked || !pageText) {
        // 봇 차단 또는 텍스트 없음 — 도메인으로 추론 시도
        try {
          const res = await fetch('/api/infer?kind=domain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: finalDomain }),
          })
          if (res.ok) {
            const inferred = (await res.json()) as { brandName?: string; industry?: string; region?: string; address?: string }
            if (inferred.brandName) setBrandName((prev) => prev || inferred.brandName!)
            if (inferred.industry) setIndustry((prev) => prev || inferred.industry!)
            if (inferred.region) {
              resolvedRegion = resolvedRegion || inferred.region
              setRegion((prev) => prev || inferred.region!)
            }
            if (!resolvedAddr && inferred.address) {
              resolvedAddr = inferred.address
              setAddress((prev) => prev || inferred.address!)
            }
          }
        } catch {
          // 추론 실패는 무시
        }
        if (isBotBlocked) {
          setError('이 사이트는 봇 차단이 적용되어 자동 추출이 제한됩니다. AI가 도메인 기반으로 일부 정보를 채웠으니 확인 후 수정해 주세요.')
        }
      }
      if (inferText) {
        try {
          const res = await fetch('/api/infer?kind=brand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: inferText, brandName: guessedName }),
          })
          if (res.ok) {
            const inferred = (await res.json()) as { industry?: string; region?: string; address?: string }
            if (inferred.industry) setIndustry((prev) => prev || inferred.industry!)
            if (inferred.region) {
              resolvedRegion = resolvedRegion || inferred.region
              setRegion((prev) => prev || inferred.region!)
            }
            if (!resolvedAddr && inferred.address) {
              resolvedAddr = inferred.address
              setAddress((prev) => prev || inferred.address!)
            }
          }
        } catch {
          // 추론 실패는 무시 — 사용자가 직접 입력하면 된다.
        }
      }

      // A) 주소가 아직 없으면 같은 도메인의 "오시는 길·연락처" 페이지를 찾아 한 번 더 수집·추출한다.
      if (!resolvedAddr) {
        const contactUrl = findContactUrl(payload.html || '', s.finalUrl || parsed.href)
        const guarded = contactUrl ? parsePublicHttpUrl(contactUrl) : null
        if (guarded?.ok) {
          try {
            const cp = await fetchPage(guarded.href)
            if (cp.html) {
              const cs = extractPage({
                requestedUrl: guarded.href,
                finalUrl: cp.finalUrl || guarded.href,
                status: cp.status,
                contentType: cp.contentType,
                redirected: cp.redirected,
                html: cp.html,
                robotsTxt: cp.robotsTxt,
                robotsTxtStatus: cp.robotsTxtStatus,
                sitemapFound: cp.sitemapFound,
                llmsTxtFound: cp.llmsTxtFound,
                xRobotsTag: cp.xRobotsTag,
                fetchError: cp.fetchError,
                fetchErrorCode: cp.fetchErrorCode,
                renderMode: cp.renderMode,
                rendered: cp.rendered,
                renderWarning: cp.renderWarning,
              })
              const cText = (cs.mainText || '').trim()
              const cPlain = htmlToPlain(cp.html || '')
              let contactAddr = firstKrAddress(cText) || firstKrAddress(cPlain)
              if (!contactAddr && cText) {
                try {
                  const r2 = await fetch('/api/infer?kind=brand', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: cText, brandName: guessedName }),
                  })
                  if (r2.ok) {
                    const inf2 = (await r2.json()) as { address?: string }
                    if (inf2.address) contactAddr = inf2.address
                  }
                } catch {
                  // 무시
                }
              }
              if (contactAddr) {
                resolvedAddr = contactAddr
                setAddress((prev) => prev || contactAddr)
                const fromAddr = regionFromAddress(contactAddr)
                if (fromAddr) {
                  resolvedRegion = resolvedRegion || fromAddr
                  setRegion((prev) => prev || fromAddr)
                }
              }
            }
          } catch {
            // 연락처 페이지 수집 실패는 무시 — 직접 입력하면 된다.
          }
        }
      }

      // B) 페이지에서 끝까지 못 찾으면 브랜드명+지역으로 주소 조회(Vercel 포함).
      if (!resolvedAddr && guessedName) {
        try {
          const rb = await fetch('/api/infer?kind=address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brandName: guessedName, region: resolvedRegion }),
          })
          if (rb.ok) {
            const jb = (await rb.json()) as { address?: string }
            if (jb.address) {
              setAddress((prev) => prev || jb.address!)
              const fromAddr = regionFromAddress(jb.address)
              if (fromAddr) setRegion((prev) => prev || fromAddr)
            }
          }
        } catch {
          // 무시 — 직접 입력하면 된다.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '수집 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  // B) 수동 — 브랜드명+지역으로 웹검색 그라운딩 주소 조회. 사용자가 이름을 채운 뒤 쓰기 좋다.
  async function handleFindAddress() {
    if (!brandName.trim()) {
      setAddrMsg('브랜드명을 먼저 입력하세요.')
      return
    }
    setFindingAddr(true)
    setAddrMsg(null)
    try {
      const r = await fetch('/api/infer?kind=address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandName: brandName.trim(), region: region.trim() }),
      })
      const j = (await r.json().catch(() => ({}))) as { address?: string; error?: string }
      if (!r.ok) throw new Error(j.error || `조회 실패 (HTTP ${r.status})`)
      if (j.address) {
        setAddress(j.address)
        setAddrMsg(null)
        const fromAddr = regionFromAddress(j.address)
        if (fromAddr) setRegion((prev) => prev || fromAddr)
      } else {
        setAddrMsg('웹에서 주소를 확실히 찾지 못했습니다. 직접 입력하세요.')
      }
    } catch (err) {
      setAddrMsg(err instanceof Error ? err.message : '주소 조회 실패')
    } finally {
      setFindingAddr(false)
    }
  }

  const tenant: TenantDraft = {
    tenantId: slugFromDomain(domain),
    brandName: brandName.trim(),
    aliases: brandName.trim() ? [brandName.trim()] : [],
    ownedDomains: domain ? [domain] : [],
    industry: industry.trim(),
    region: region.trim(),
    engines: ['openai', 'gemini'],
    questionBankSize: 12,
    questionBankVersion: 'v1',
    repeatsPerQuestion: 3,
    competitors: parseCompetitors(competitorsRaw),
    factGraph: address.trim()
      ? [
          {
            id: 'brand-address',
            type: 'location',
            claim: '주소',
            value: address.trim(),
            updatedAt: new Date().toISOString().slice(0, 10),
          },
        ]
      : [],
    // 경쟁사 비움+측정 시 자동 추론된 경쟁사를 코호트로 함께 측정할지. 체크 해제 시에만 false로 전달.
    ...(withCohort ? {} : { autoCohort: false }),
  }

  const ready = Boolean(tenant.brandName && tenant.ownedDomains.length && tenant.industry && tenant.region)
  const canSuggestComp = Boolean(brandName.trim() && industry.trim())
  const json = JSON.stringify(tenant, null, 2)

  // 같은 업종·지역 경쟁사를 Gemini로 추천해 경쟁사 칸에 병합한다. 도메인은 백엔드에서 DNS 검증된 것만 온다.
  async function suggestCompetitors() {
    setSuggestingComp(true)
    setCompMsg('경쟁사를 추론하는 중… (웹검색·도메인 확인, 십여 초)')
    try {
      const res = await fetch('/api/infer?kind=competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandName: brandName.trim(), industry: industry.trim(), region: region.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `추천 실패 (HTTP ${res.status})`)
      }
      const list = (await res.json()) as { name: string; domain: string }[]
      if (!Array.isArray(list) || list.length === 0) {
        setCompMsg('추천 결과가 없습니다 — 직접 입력해 주세요.')
        return
      }
      const existing = new Set(
        competitorsRaw
          .split('\n')
          .map((l) => l.split(',')[0]?.trim())
          .filter(Boolean),
      )
      const added = list.filter((c) => c.name && !existing.has(c.name))
      const lines = added.map((c) => (c.domain ? `${c.name}, ${c.domain}` : c.name))
      setCompetitorsRaw((prev) => [prev.trim(), ...lines].filter(Boolean).join('\n'))
      const noDomain = added.filter((c) => !c.domain).length
      setCompMsg(
        `✓ ${added.length}곳 추가${noDomain ? ` — 도메인 미확인 ${noDomain}곳은 이름만 넣었으니 확인·보완하세요` : ''}. 경쟁사는 직접 검토를 권합니다.`,
      )
    } catch (err) {
      setCompMsg(`✗ ${err instanceof Error ? err.message : '추천 실패'}`)
    } finally {
      setSuggestingComp(false)
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드 복사에 실패했습니다. JSON을 직접 선택해 복사하세요.')
    }
  }

  // 등록만 한다 — 등록 후 드롭다운에 바로 보인다. 측정은 STAGE 4 "랭킹 분석"의 "이 브랜드 측정"에서 별도로.
  async function registerBrand() {
    setRegistering(true)
    setRegisterMsg('브랜드를 등록하는 중…')
    try {
      const reg = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      })
      if (!reg.ok) {
        const body = (await reg.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `등록 실패 (HTTP ${reg.status})`)
      }
      await reloadTenants()
      setTenantId(tenant.tenantId)
      // 등록만 한다 — 측정은 STAGE 4 "랭킹 분석"의 "이 브랜드 측정" 버튼에서 별도로 실행한다.
      // 그 측정이 경쟁사 자동 추론·SoM·코호트(1/N)까지 채운다. 경쟁사를 직접 입력해 두면 그대로 쓰인다.
      const measureHint =
        measureVia === 'github'
          ? 'GitHub Actions가 경쟁사 SoM·코호트까지 채웁니다.'
          : measureVia === 'local'
            ? '로컬에서 즉시 측정됩니다.'
            : '측정은 로컬/CI에서 실행하세요.'
      setRegisterMsg(
        `✓ 등록 완료 — ${tenant.brandName} (${tenant.tenantId}). 상단 브랜드 메뉴에서 선택할 수 있습니다. ` +
          `측정하려면 STAGE 4 "랭킹 분석"에서 "이 브랜드 측정"을 누르세요 — ${measureHint}`,
      )
    } catch (err) {
      setRegisterMsg(`✗ ${err instanceof Error ? err.message : '실패했습니다.'}`)
    } finally {
      setRegistering(false)
    }
  }

  const currentStage = !extracted ? 1 : !ready ? 2 : 4
  const s1 = stageStatus(1, extracted, ready)
  const s2 = stageStatus(2, extracted, ready)
  const s3 = stageStatus(3, extracted, ready)
  const s4 = stageStatus(4, extracted, ready)

  function goStage(n: 1 | 2 | 3 | 4) {
    document.getElementById(`stage-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <header className="onboard-masthead">
        <div>
          <p className="brand">시작 · 진입점</p>
          <h1>브랜드 추가</h1>
          <p className="lead">URL을 넣으면 브랜드명·도메인·주소를 채웁니다. 업종·지역·경쟁사만 확인하면 테넌트가 만들어집니다.</p>
        </div>
      </header>

      <nav className="onboard-steps" aria-label="브랜드 추가 단계">
        {(
          [
            [1, '1', 'URL', s1],
            [2, '2', '정보', s2],
            [3, '3', '경쟁사', s3],
            [4, '4', '등록', s4],
          ] as const
        ).map(([n, code, label, status]) => (
          <button
            key={n}
            type="button"
            className={`onboard-step${n === currentStage ? ' is-current' : ''}${status === 'done' ? ' is-done' : ''}${status === 'locked' ? ' is-locked' : ''}`}
            onClick={() => goStage(n)}
          >
            <span className="onboard-step-code">
              {code}
              {status === 'done' ? ' · 완료' : n === currentStage ? ' · 진행' : ''}
            </span>
            <span className="onboard-step-title">{label}</span>
          </button>
        ))}
      </nav>

      <StageShell id="stage-1" code="1" title="URL 수집" status={s1}>
        <form className="site-form" onSubmit={handleExtract}>
          <label className="field">
            <span>브랜드 URL</span>
            <input
              type="text"
              inputMode="url"
              placeholder="https://www.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <span className="hint">
              공개 HTTPS 페이지만 읽습니다. 봇 차단·JS 렌더링 사이트는 자동 추출이 제한될 수 있으니 아래에서 직접 보완하세요.
            </span>
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '페이지를 읽는 중…' : 'URL에서 자동 채우기'}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </StageShell>

      <StageShell id="stage-2" code="2" title="브랜드 정보" status={s2}>
        <div className="onboard-grid">
          <label className="field">
            <span>브랜드명 *</span>
            <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="예: 뷰성형외과" />
          </label>
          <label className="field">
            <span>대표 도메인 *</span>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="예: viewclinic.com" />
          </label>
          <label className="field">
            <span>업종 *</span>
            <input
              type="text"
              list="cohort-industries"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="예: 성형외과"
            />
            <datalist id="cohort-industries">
              {cohortIndustries.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <span className="hint">
              코호트 랭킹은 <b>업종·지역이 정확히 일치</b>해야 같은 그룹입니다. 기존 값이 있으면 목록에서 고르세요.
            </span>
            {industry.trim() && cohortIndustries.length > 0 && !cohortIndustries.includes(industry.trim()) && (
              <span className="hint">⚠ 기존 코호트에 없는 업종입니다 — 새 코호트로 분리됩니다.</span>
            )}
          </label>
          <label className="field">
            <span>지역 *</span>
            <input
              type="text"
              list="cohort-regions"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="예: 서울 강남"
            />
            <datalist id="cohort-regions">
              {cohortRegions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {region.trim() && cohortRegions.length > 0 && !cohortRegions.includes(region.trim()) && (
              <span className="hint">
                ⚠ 기존 코호트에 없는 지역입니다 — 새 코호트로 분리됩니다. 의도한 것이 아니면 기존 값과 맞추세요.
              </span>
            )}
          </label>
          <label className="field span2">
            <span>주소 (Fact Graph · 선택)</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="예: 서울 강남구 봉은사로 107"
                style={{ flex: 1 }}
              />
              {addrLookupOn && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void handleFindAddress()}
                  disabled={findingAddr || !brandName.trim()}
                  title="브랜드명·지역으로 주소를 찾습니다"
                >
                  {findingAddr ? '찾는 중…' : '주소 찾기'}
                </button>
              )}
            </div>
            <span className="hint">
              사실성 검증에 쓰입니다. 자동 추출이 비면 직접 입력하세요
              {addrLookupOn ? ' (또는 브랜드명·지역을 채운 뒤 "주소 찾기").' : '.'}
            </span>
            {addrMsg && (
              <span className="hint" style={{ color: 'var(--accent)' }} role="status">
                {addrMsg}
              </span>
            )}
          </label>
        </div>
      </StageShell>

      <StageShell id="stage-3" code="3" title="경쟁사" status={s3}>
        <div className="field">
          <div className="onboard-comp-label">
            <span>경쟁사 (선택 · 한 줄에 하나: 이름, 도메인)</span>
            {addrLookupOn && (
              <button
                type="button"
                className="ghost"
                onClick={suggestCompetitors}
                disabled={!canSuggestComp || suggestingComp}
                title={canSuggestComp ? '' : '브랜드명·업종을 먼저 채우세요'}
              >
                {suggestingComp ? '추천 중…' : '경쟁사 자동 추천 (ChatGPT+Gemini)'}
              </button>
            )}
          </div>
          <textarea
            rows={4}
            value={competitorsRaw}
            onChange={(e) => setCompetitorsRaw(e.target.value)}
            placeholder={'예) 경쟁사A, competitor-a.com\n경쟁사B, competitor-b.co.kr\n(비워 두면 측정 시 자동 추론)'}
          />
          <span className="hint">
            경쟁사를 넣으면 Share of Mention·순위 비교가 가능합니다.{' '}
            {addrLookupOn ? (
              <>
                자동 추천은 <b>이름 위주 best-effort</b>이며 도메인은 실재 확인된 것만 채웁니다 — 직접 검토하세요.
              </>
            ) : (
              <>
                비워 두면 <b>측정 시점(GitHub Actions)에 경쟁사가 자동 추론</b>되어 채워집니다. 배포 환경에서는 직접
                추천이 부정확해 버튼을 숨겼습니다.
              </>
            )}
          </span>
          {compMsg && (
            <span className={compMsg.startsWith('✗') ? 'error' : 'hint'} role="status">
              {compMsg}
            </span>
          )}
        </div>
      </StageShell>

      <StageShell id="stage-4" code="4" title="등록" status={s4}>
        <div className="onboard-register">
          <p className="onboard-tenant">테넌트 초안 (tenantId: {tenant.tenantId || '—'})</p>
          {canRegister && measureVia !== 'none' && (
            <label className="onboard-cohort">
              <input type="checkbox" checked={withCohort} onChange={(e) => setWithCohort(e.target.checked)} />
              <span>
                측정 시 경쟁사도 코호트로 함께 측정 — 코호트 랭킹(1/N)을 채웁니다. 해제하면 본 브랜드만 측정합니다.
              </span>
            </label>
          )}
          <div className="onboard-register-actions">
            {canRegister && (
              <button type="button" className="primary" onClick={registerBrand} disabled={!ready || registering}>
                {registering ? '등록 중…' : '브랜드 등록'}
              </button>
            )}
            <button type="button" className="ghost" onClick={copyJson} disabled={!ready}>
              {copied ? '복사됨 ✓' : 'JSON 복사'}
            </button>
          </div>
        </div>
        {!ready && <p className="hint">* 브랜드명·도메인·업종·지역을 모두 채우면 등록할 수 있습니다.</p>}
        {canRegister ? (
          <p className="hint">
            등록만 합니다. 이후 STAGE 4 <b>"랭킹 분석"</b>에서 <b>"이 브랜드 측정"</b>을 누르면 경쟁사 자동 추론·SoM·코호트
            순위까지 채워집니다{measureVia === 'github' ? ' (GitHub Actions).' : measureVia === 'local' ? ' (로컬 즉시).' : '.'}
          </p>
        ) : (
          <p className="hint">
            자동 등록을 쓰려면 Vercel 프로젝트에 Blob 스토어를 연결하세요. 지금은 JSON을 복사해{' '}
            <code>tenants.config.json</code>에 추가할 수 있습니다.
          </p>
        )}
        {registerMsg && (
          <p className={registerMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
            {registerMsg}
          </p>
        )}
        <p className="hint onboard-cli">
          측정 CLI: <code>npx tsx scripts/run-pipeline.ts {tenant.tenantId || '<tenantId>'}</code>
          {' · '}
          점수 반영: <code>npx tsx scripts/publish-tenant.ts {tenant.tenantId || '<tenantId>'}</code>
        </p>
      </StageShell>

      <BrandManageList />
    </>
  )
}
