import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import BrandManageList from '../components/BrandManageList'
import MeasureProgress, { type ActiveMeasure } from '../components/MeasureProgress'
import { useTenant } from '../context/useTenant'
import { extractPage } from '../lib/aeo/extractPage'
import { fetchPage } from '../lib/aeo/fetchPage'
import { parsePublicHttpUrl } from '../lib/aeo/netGuard'
import { fetchFactCandidatesFor, inferBrandAliases, measureTenantAll, type FactCandidate } from '../lib/api'

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
  /**
   * 질문 배분(문항 수 · 반복 수 · 은행 버전)은 **보내지 않는다** — 서버의
   * normalizeTenantDraft가 정한다. 여기서 값을 정하면 기본값이 두 곳에 생겨 갈린다.
   *
   * 실제로 갈렸다. 서버 기본을 36문항 × 1회 · v3으로 올렸는데 이 화면이 12문항 × 3회를
   * 하드코딩한 채 버전만 v3으로 바꿔서, **v3 딱지가 붙은 12문항 은행**이 만들어졌다 —
   * 버전 표시가 거짓이 되는, 버전을 안 올린 것보다 나쁜 상태였다.
   */
  questionBankSize?: number
  questionBankVersion?: string
  repeatsPerQuestion?: number
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

// 도메인이 없는 브랜드(상호 기반, 홈페이지 없음)의 tenantId. ASCII 상호는 그대로 슬러그화하고,
// 한글 등 비ASCII 상호는 결정적 짧은 해시로 고유 id를 만든다(여러 무도메인 브랜드가 'brand'로 충돌 방지).
function slugFromName(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii && ascii !== '-') return ascii
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `brand-${h.toString(36)}`
}

function makeTenantId(domain: string, brandName: string): string {
  return domain ? slugFromDomain(domain) : brandName.trim() ? slugFromName(brandName) : 'brand'
}

// 한국 상호는 업종을 포함하는 경우가 많다("바노바기성형외과의원"→"성형외과"). AI 추론이 업종을
// 누락할 때의 결정적 폴백. 더 구체적인 키워드를 앞에 둔다(치과의원이 치과보다 먼저 매치되도록).
const INDUSTRY_KEYWORDS = [
  '성형외과', '피부과', '치과의원', '치과병원', '치과', '안과', '이비인후과', '정형외과', '재활의학과',
  '산부인과', '비뇨기과', '신경외과', '마취통증의학과', '가정의학과', '한의원', '한방병원', '내과', '외과',
  '의원', '병원', '약국', '동물병원', '카페', '펜션', '게스트하우스', '호텔', '모텔', '리조트',
  '미용실', '헤어', '네일', '피부관리', '필라테스', '요가', '헬스', '피트니스', '학원', '어학원',
  '유치원', '어린이집', '베이커리', '제과', '안경원', '안경', '레스토랑', '식당', '부동산',
]
function industryFromName(name: string): string {
  return INDUSTRY_KEYWORDS.find((k) => name.includes(k)) ?? ''
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
  lockedHint,
}: {
  id: string
  code: string
  title: string
  status: StageStatus
  children: ReactNode
  /** 잠겼을 때 보여 줄 안내. 단계마다 먼저 해야 할 일이 다르다. */
  lockedHint?: string
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
      {locked ? (
        <p className="onboard-lock">{lockedHint ?? '상호 또는 URL로 자동 채우기를 먼저 실행하세요.'}</p>
      ) : (
        children
      )}
    </section>
  )
}

// BrandManageList·ApiKeySettings와 같은 순서·이름. 세 화면이 달라지면 같은 엔진으로 안 보인다.
// 키 상태는 /api/health가 **엔진 id**로 색인해 준다(engineKeys). 환경변수 이름은 서버 안에만
// 있으므로 여기 두지 않는다 — 두면 그걸로 조회하게 되고, 실제로 그래서 네 엔진이 전부
// "키 없음"으로 잠겼다(v0.1.98 회귀).
const ENGINE_CHOICES: { id: string; label: string }[] = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'perplexity', label: 'Perplexity' },
]

/**
 * active인 동안 경과 초를 센다. 시작할 때 0으로 되돌린다.
 *
 * 진짜 진행률의 대체물이다 — 어디까지 갔는지는 못 말해도 "멈추지 않았다"는 말은 한다.
 * 서버가 단계를 내보내게 되면 이 자리를 그것으로 바꾼다.
 */
function useElapsed(active: boolean): number {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    if (!active) return
    // 시작 시각을 기준으로 계산한다 — 이펙트 본문에서 setState로 0을 찍으면 렌더가 한 번 더
    // 돌고(react-hooks/set-state-in-effect), 탭이 멈춰 있던 동안의 틱도 놓친다.
    const start = Date.now()
    const t = window.setInterval(() => setSec(Math.floor((Date.now() - start) / 1000)), 500)
    return () => {
      window.clearInterval(t)
      setSec(0)
    }
  }, [active])
  return active ? sec : 0
}

/** "페이지를 읽는 중…" + 경과. 1초 미만이면 초를 숨긴다(깜빡임 방지). */
const withElapsed = (label: string, sec: number) => (sec > 0 ? `${label} ${sec}초` : label)

export default function BrandOnboarding() {
  const { reloadTenants, setTenantId } = useTenant()
  const [url, setUrl] = useState('')
  const [industry, setIndustry] = useState('')
  const [region, setRegion] = useState('')
  // STAGE 1 상호 검색의 '지역 힌트'는 결과 지역(region)과 분리한다. 힌트는 사용자가 명시적으로 넣은 값만 담아,
  // 브랜드를 바꿔 재검색할 때 이전 브랜드의 결과 지역이 힌트로 새어들어가 오답을 유발하지 않게 한다.
  const [regionHint, setRegionHint] = useState('')
  const [brandName, setBrandName] = useState('')
  const [domain, setDomain] = useState('')
  const [address, setAddress] = useState('')
  const [findingAddr, setFindingAddr] = useState(false)
  // 별칭 — 언급 판정이 이 목록을 그대로 쓴다. 비어 있으면 브랜드명 하나로만 센다.
  const [aliases, setAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [findingAliases, setFindingAliases] = useState(false)
  const [addrMsg, setAddrMsg] = useState<string | null>(null)
  const [competitorsRaw, setCompetitorsRaw] = useState('')
  // 수집 엔진 — 기본값은 "키가 있는 엔진 전부"다. 키 없는 엔진을 기본으로 켜 두면
  // 측정에서 조용히 빠져(부분 저하) 고른 것과 실제로 잰 것이 달라진다.
  // 키 상태는 서버가 /api/health로 알려 준다(존재 여부만) — 웹·데스크톱 모두 같은 경로.
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean> | null>(null)
  const [engines, setEngines] = useState<string[]>(['openai', 'gemini', 'claude', 'perplexity'])
  // 3단계 사실 — 주소가 있을 때만 뽑는다. 고른 것만 테넌트 초안의 factGraph에 담긴다.
  const [findingFacts, setFindingFacts] = useState(false)
  const [factCands, setFactCands] = useState<FactCandidate[] | null>(null)
  const [factsMsg, setFactsMsg] = useState<string | null>(null)
  const [picked, setPicked] = useState<FactCandidate[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extracted, setExtracted] = useState(false)
  const [canRegister, setCanRegister] = useState(false)
  // 측정 경로: local(=/run 로컬 측정) | github(=GitHub Actions dispatch) | none(=대기열만).
  const [measureVia, setMeasureVia] = useState<'local' | 'github' | 'none'>('none')
  // 로컬 백엔드에서만 주소 조회(Gemini)가 동작한다 — Vercel(미국 리전)에선 "모름"이라 버튼을 숨긴다.
  const [addrLookupOn, setAddrLookupOn] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerMsg, setRegisterMsg] = useState<string | null>(null)
  // 등록 완료 시 true — 등록 완료 단계에서 "이 브랜드 전체 측정"을 바로 실행할 수 있게 한다.
  const [registered, setRegistered] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  // 측정을 건너뛰었나 — 6단계를 '완료'로 보고 다음 할 일을 안내한다.
  const [skippedMeasure, setSkippedMeasure] = useState(false)
  const [measureMsg, setMeasureMsg] = useState<string | null>(null)
  // 경쟁사도 cohortOnly로 함께 측정 → 코호트 랭킹이 1/N으로 채워진다(기본 켬).
  const [withCohort, setWithCohort] = useState(true)
  const [suggestingComp, setSuggestingComp] = useState(false)
  // 오래 걸리는 작업마다 경과 초. 1단계는 실측 90초가 넘어 침묵이 가장 길다.
  const busySec = useElapsed(busy)
  const factsSec = useElapsed(findingFacts)
  const compSec = useElapsed(suggestingComp)
  const measureSec = useElapsed(measuring)
  /**
   * 서버가 보고하는 측정 진행. 경과 초는 "멈추지 않았다"까지만 말하고, 어디쯤인지는 못 말한다.
   * 코호트를 함께 재면 브랜드가 여럿이므로 목록으로 받는다.
   */
  const [progress, setProgress] = useState<ActiveMeasure[]>([])
  useEffect(() => {
    if (!measuring || measureVia !== 'local') return
    let alive = true
    const poll = () => {
      fetch('/api/measure-status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d?.active) setProgress(d.active)
        })
        .catch(() => {})
    }
    poll()
    const t = window.setInterval(poll, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
      setProgress([])
    }
  }, [measuring, measureVia])
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
        if (d.engineKeys) {
          const keys = d.engineKeys as Record<string, boolean>
          setKeyStatus(keys)
          const withKey = ENGINE_CHOICES.filter((e) => keys[e.id]).map((e) => e.id)
          if (withKey.length > 0) setEngines(withKey)
        }
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
      // 사람이 친 상호가 페이지 <title>·og:site_name보다 나은 근거다 — 그 브랜드를 찾는
      // 사람이 실제로 부르는 이름이기 때문이다. 실측: 「이디야커피」가 「Ediya」로 바뀌었고,
      // 한국어 답변은 "이디야"라고 하므로 그대로 두면 언급 판정이 대부분을 놓친다.
      // 뽑은 이름은 버리지 않고 별칭 후보로 넘긴다(그 표기도 답변에 나올 수 있다).
      setBrandName((prev) => prev.trim() || guessedName)
      if (guessedName && brandName.trim() && guessedName !== brandName.trim()) {
        setAliases((prev) => (prev.includes(guessedName) ? prev : [...prev, guessedName]))
      }
      // 진단용 extractPage는 footer를 버리므로, 주소는 원본 HTML 전체에서 다시 찾는다.
      const pagePlain = htmlToPlain(payload.html || '')
      let resolvedAddr = firstKrAddress(s.mainText || '') || firstKrAddress(pagePlain)
      let resolvedRegion = regionFromAddress(resolvedAddr) || region
      let resolvedIndustry = industry
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
            if (inferred.industry) {
              resolvedIndustry = resolvedIndustry || inferred.industry
              setIndustry((prev) => prev || inferred.industry!)
            }
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
            if (inferred.industry) {
              resolvedIndustry = resolvedIndustry || inferred.industry
              setIndustry((prev) => prev || inferred.industry!)
            }
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

      // C) 업종·지역·주소가 아직 비어 있으면 도메인 그라운딩으로 최종 보강한다.
      //    JS 렌더링 사이트(예: banobagi.com)는 정적 수집 텍스트가 비거나 빈약해, 위 텍스트 추론이
      //    업종을 못 채우는 경우가 있다. 그러면 환경(Vercel/로컬)마다 페이지 수집 결과가 달라 결과가
      //    엇갈리고, 업종이 비면 아래 경쟁사 자동추론까지 건너뛴다. 도메인 추론으로 빈 칸만 메워
      //    두 환경이 같은 결과로 수렴하게 한다. (사용자가 등록 전 확인하므로 안전한 폴백)
      if ((!resolvedIndustry || !resolvedRegion || !resolvedAddr) && finalDomain) {
        try {
          const rd = await fetch('/api/infer?kind=domain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: finalDomain }),
          })
          if (rd.ok) {
            const jd = (await rd.json()) as { industry?: string; region?: string; address?: string }
            if (jd.industry) {
              resolvedIndustry = resolvedIndustry || jd.industry
              setIndustry((prev) => prev || jd.industry!)
            }
            if (jd.region) {
              resolvedRegion = resolvedRegion || jd.region
              setRegion((prev) => prev || jd.region!)
            }
            if (jd.address && !resolvedAddr) {
              resolvedAddr = jd.address
              setAddress((prev) => prev || jd.address!)
            }
          }
        } catch {
          // 무시 — 사용자가 직접 채우면 된다.
        }
      }

      // D) 업종이 끝까지 비면 브랜드명에서 직접 추출한다(결정적·환경 무관 폴백).
      //    한국 상호는 업종을 포함하는 경우가 많다("바노바기성형외과의원"→"성형외과"). AI 그라운딩이
      //    간헐적으로 업종을 누락해도 이름으로 확실히 채워, 경쟁사 자동추론까지 이어지게 한다.
      if (!resolvedIndustry && guessedName) {
        const fromName = industryFromName(guessedName)
        if (fromName) {
          resolvedIndustry = fromName
          setIndustry((prev) => prev || fromName)
        }
      }

      // 경쟁사 자동 채우기 — URL·상호 두 진입 경로가 공유한다. URL 경로는 사용자가 이미 넣은 경쟁사는 보존.
      await autoFillCompetitors(guessedName, resolvedIndustry, resolvedRegion, finalDomain, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '수집 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  // 경쟁사 자동 채우기 — 경쟁사 칸이 비어 있고 브랜드·업종이 있으면 추론한다(URL·상호 공용).
  // 로컬은 즉시 추론, 배포는 도메인이 있으면 CI에 맡기고 폴링, 도메인이 없으면 직접 입력을 안내한다.
  async function autoFillCompetitors(
    name: string,
    industryVal: string,
    regionVal: string,
    domainVal: string,
    skipIfFilled: boolean,
  ) {
    if (!name || !industryVal) return
    if (skipIfFilled && competitorsRaw.trim()) return
    const fill = (list: { name: string; domain?: string }[]) =>
      setCompetitorsRaw(list.map((c) => (c.domain ? `${c.name}, ${c.domain}` : c.name)).join('\n'))
    if (addrLookupOn) {
      // 로컬 — 그라운딩 추론이 동기로 동작한다.
      try {
        setCompMsg('경쟁사 추론 중…')
        const r = await fetch('/api/infer?kind=competitors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brandName: name, industry: industryVal, region: regionVal }),
        })
        const list = r.ok ? ((await r.json()) as { name: string; domain?: string }[]) : []
        if (Array.isArray(list) && list.length) {
          fill(list)
          setCompMsg(`✓ 경쟁사 ${list.length}곳 자동 추론됨 — 검토 후 수정하세요.`)
        } else setCompMsg('경쟁사 자동 추론 결과가 없습니다 — 직접 입력하세요.')
      } catch {
        setCompMsg(null)
      }
      return
    }
    // 배포 — Vercel은 추론이 안 되므로 CI 러너에 맡기고 결과를 폴링한다(~1-2분). 폴링 키가 도메인이라 도메인이 필요.
    if (!domainVal) {
      setCompMsg('도메인이 없어 경쟁사 자동 추론을 건너뜁니다 — 직접 입력하거나 측정 시 다시 추론합니다.')
      return
    }
    try {
      const dsp = await fetch('/api/infer?kind=competitors-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandName: name, industry: industryVal, region: regionVal, domain: domainVal }),
      })
      const dj = (await dsp.json().catch(() => ({}))) as { dispatched?: boolean }
      if (dj.dispatched) {
        setCompMsg('경쟁사 추론 중… (CI, ~1-2분) 완료되면 3.경쟁사에 자동 표시됩니다.')
        void (async () => {
          for (let i = 0; i < 26; i++) {
            await new Promise((r) => setTimeout(r, 7000))
            try {
              const pr = await fetch('/api/infer?kind=competitors-result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: domainVal }),
              })
              if (!pr.ok) continue
              const pj = (await pr.json()) as { pending: boolean; competitors: { name: string; domain?: string }[] }
              if (!pj.pending) {
                if (pj.competitors.length) {
                  fill(pj.competitors)
                  setCompMsg(`✓ 경쟁사 ${pj.competitors.length}곳 자동 추론됨 — 검토 후 수정하세요.`)
                } else setCompMsg('경쟁사 자동 추론 결과가 없습니다 — 직접 입력하세요.')
                return
              }
            } catch {
              // 다음 주기에 재시도
            }
          }
          setCompMsg('경쟁사 추론이 지연됩니다 — 직접 입력하거나 잠시 후 다시 시도하세요.')
        })()
      }
    } catch {
      // 무시 — 직접 입력하면 된다.
    }
  }

  // 상호(브랜드명) 기반 진입 — 이름만으로 도메인·업종·지역·주소를 역추론해 폼을 채운다.
  /**
   * 1단계 시작 — 주소가 있으면 페이지를 읽고(정확), 없으면 상호로 추론한다(빠름).
   *
   * 두 경로를 버튼 하나로 합친 이유: 접어 둔 대안은 아무도 안 쓴다. 주소를 넣으면 더 정확해지는데
   * 그 사실이 <details> 안에 숨어 있었다.
   */
  async function handleStart(e: FormEvent) {
    if (url.trim()) {
      // URL 경로는 상호를 페이지에서 뽑지만, 사용자가 적어 넣은 상호가 더 믿을 만하다 —
      // handleExtract가 덮어쓰지 않도록 여기서 지키지는 않는다(2단계에서 확인·수정한다).
      await handleExtract(e)
      return
    }
    await handleIdentify(e)
  }

  async function handleIdentify(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setExtracted(false)
    const name = brandName.trim()
    if (!name) {
      setError('상호(브랜드명)를 입력하세요.')
      return
    }
    // 재검색(다른 브랜드 조회 후 재실행) 시 이전 결과가 남지 않도록 파생 필드를 먼저 비운다.
    // 상호(입력)와 지역 힌트(regionHint)만 유지하고, 아래에서 새 결과로 덮어쓴다.
    const hint = regionHint.trim()
    setDomain('')
    setIndustry('')
    setRegion('')
    setAddress('')
    setCompetitorsRaw('')
    setCompMsg(null)
    setRegistered(false)
    setRegisterMsg(null)
    setMeasureMsg(null)
    setBusy(true)
    try {
      const res = await fetch('/api/infer?kind=identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandName: name, region: hint }),
      })
      const info = (res.ok ? await res.json() : {}) as {
        brandName?: string
        domain?: string
        industry?: string
        region?: string
        address?: string
      }
      const resolvedName = info.brandName || name
      // 업종이 비면 상호에서 결정적으로 보강(경쟁사 추론까지 이어지게).
      const resolvedIndustry = info.industry || industryFromName(resolvedName)
      const resolvedRegion = info.region || hint

      // 새 결과로 덮어쓴다(값이 없으면 비운다 — 이전 브랜드 값 잔존 방지).
      // 상호만 예외다: 여기 오는 입력은 사람이 친 상호 그 자체이므로 추론이 다듬은 표기로
      // 바꾸지 않는다. 다른 표기는 별칭으로 들어간다.
      if (info.brandName && name.trim() && info.brandName !== name.trim()) {
        setAliases((prev) => (prev.includes(info.brandName!) ? prev : [...prev, info.brandName!]))
      }
      setBrandName(name.trim() || resolvedName)
      setDomain(info.domain || '')
      setIndustry(resolvedIndustry)
      setRegion(resolvedRegion)
      setAddress(info.address || '')
      setExtracted(true)

      await autoFillCompetitors(resolvedName, resolvedIndustry, resolvedRegion, info.domain || '', false)

      if (!info.domain) {
        setError(
          '공식 도메인을 찾지 못했습니다. 홈페이지가 있으면 아래 “대표 도메인”에 직접 넣으면 측정 정확도(브랜드 소유 인용)가 올라갑니다. 없어도 등록·측정은 가능합니다.',
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '상호 조회 중 오류가 발생했습니다.')
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
    tenantId: makeTenantId(domain, brandName),
    brandName: brandName.trim(),
    // 브랜드명은 항상 첫 별칭. 추론·직접 입력분을 뒤에 붙인다(중복 제거는 sanitize가 한다).
    aliases: brandName.trim()
      ? [brandName.trim(), ...aliases.filter((a) => a.trim() && a.trim() !== brandName.trim())]
      : [],
    ownedDomains: domain ? [domain] : [],
    industry: industry.trim(),
    region: region.trim(),
    // 5단계에서 고른 엔진. 데스크톱이 아니면 키를 알 수 없어 4개 그대로 두고, 측정 때
    // 키 없는 엔진이 걸러진다(부분 저하).
    engines,
    // 질문 배분은 서버가 정한다(위 TenantDraft 주석 참고).
    competitors: parseCompetitors(competitorsRaw),
    // 주소 한 줄 + 3단계에서 고른 사실. 주소와 값이 겹치면 고른 쪽이 보통 더 자세하다.
    factGraph: [
      ...(address.trim()
        ? [
            {
              id: 'brand-address',
              type: 'location',
              claim: '주소',
              value: address.trim(),
              updatedAt: new Date().toISOString().slice(0, 10),
            },
          ]
        : []),
      ...picked
        .filter((f) => f.value.replace(/\s/g, '') !== address.trim().replace(/\s/g, ''))
        .map((f, i) => ({
          id: `fact-${i + 1}`,
          type: f.type,
          claim: f.claim,
          value: f.value,
          updatedAt: new Date().toISOString().slice(0, 10),
        })),
    ],
    // 경쟁사 비움+측정 시 자동 추론된 경쟁사를 코호트로 함께 측정할지. 체크 해제 시에만 false로 전달.
    ...(withCohort ? {} : { autoCohort: false }),
  }

  // 도메인은 선택 — 홈페이지 없는 브랜드(상호 기반)도 등록·측정할 수 있게 한다(브랜드 소유 인용률만 0이 됨).
  const ready = Boolean(tenant.brandName && tenant.industry && tenant.region)
  const canSuggestComp = Boolean(brandName.trim() && industry.trim())
  const json = JSON.stringify(tenant, null, 2)

  /** 브랜드 페이지에서 사실 후보를 뽑는다. 저장하지 않는다 — 고른 것만 등록 때 함께 간다. */
  async function findFacts() {
    const target = url.trim() || domain.trim()
    if (!target || !brandName.trim()) return
    setFindingFacts(true)
    setFactsMsg(null)
    try {
      const r = await fetchFactCandidatesFor(target, brandName.trim(), industry.trim())
      setFactCands(r.candidates)
      setPicked(r.candidates)
      setFactsMsg(
        r.candidates.length
          ? `${r.sourceUrl}에서 ${r.candidates.length}건을 찾았습니다. 값이 페이지에 글자 그대로 있는 것만 남겼습니다.`
          : `${r.sourceUrl}에는 확인 가능한 값이 없었습니다. 사실이 적힌 다른 주소(이용 안내·요금 등)를 2단계 도메인 칸에 넣어 보세요.`,
      )
    } catch (err) {
      setFactsMsg(err instanceof Error ? err.message : String(err))
      setFactCands([])
    } finally {
      setFindingFacts(false)
    }
  }

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

  // 등록만 한다 — 등록 후 드롭다운에 바로 보인다. 측정은 STAGE 1 "브랜드·경쟁사 측정"에서 별도로.
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
      setRegistered(true)
      // 등록 완료 — 아래 "이 브랜드 전체 측정 시작" 버튼으로 바로 측정할 수 있다(경쟁사·코호트 포함).
      setRegisterMsg(`✓ 등록 완료 — ${tenant.brandName} (${tenant.tenantId}). 상단 브랜드 메뉴에서 선택할 수 있습니다.`)
    } catch (err) {
      setRegisterMsg(`✗ ${err instanceof Error ? err.message : '실패했습니다.'}`)
    } finally {
      setRegistering(false)
    }
  }

  // 등록한 본 브랜드를 바로 전체 측정한다(경쟁사·코호트 포함) — STAGE 1로 이동하지 않고 여기서 실행.
  // 로컬은 이 탭에서 즉시 측정(서버가 진행 상태를 추적), 배포는 GitHub Actions를 트리거한다.
  async function measureRegisteredBrand() {
    const id = tenant.tenantId
    if (!id || measuring) return
    setMeasuring(true)
    setMeasureMsg(
      measureVia === 'github'
        ? `${tenant.brandName} GitHub Actions 측정 요청 중…`
        : `${tenant.brandName} 측정 중… (수 분). 완료되면 결과가 반영됩니다.`,
    )
    try {
      if (measureVia === 'github') {
        const res = await fetch('/api/measure-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', tenantId: id }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string }
        if (!res.ok) throw new Error(body.error || `측정 요청 실패 (HTTP ${res.status})`)
        setMeasureMsg(
          `✓ GitHub Actions가 시작됐습니다. 수 분~수십 분 뒤 결과가 반영됩니다.` +
            (body.htmlUrl ? ` 진행: ${body.htmlUrl}` : ''),
        )
        return
      }
      const d = await measureTenantAll(id)
      setMeasureMsg(`✓ ${d.brandName ?? tenant.brandName} 측정 완료 (AEO Score ${d.aeoScore ?? '?'}). 대시보드·랭킹에서 확인하세요.`)
    } catch (err) {
      setMeasureMsg(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuring(false)
    }
  }

  const currentStage = !extracted ? 1 : !ready ? 2 : 5
  const s1 = stageStatus(1, extracted, ready)
  const s2 = stageStatus(2, extracted, ready)
  const s3 = stageStatus(3, extracted, ready)
  const s4 = stageStatus(4, extracted, ready)
  const s5 = stageStatus(4, extracted, ready)
  // 6단계는 등록해야 열린다. 측정했거나 건너뛰면 완료.
  const s6: StageStatus = !registered ? 'locked' : measuring || !skippedMeasure ? 'current' : 'done'
  /** 사실을 뽑을 주소가 있나 — 없으면 3단계는 건너뛴다. */
  const factSource = url.trim() || domain.trim()

  function goStage(n: 1 | 2 | 3 | 4 | 5 | 6) {
    document.getElementById(`stage-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <header className="onboard-masthead">
        <div>
          <p className="brand">시작</p>
          <h1>브랜드 추가</h1>
          <p className="lead">
            상호만 넣으면 도메인·업종·지역·경쟁사까지 자동으로 채웁니다. 홈페이지 주소를 함께 넣으면 그 페이지를
            읽어 더 정확해집니다. 확인 후 등록하면 테넌트가 만들어집니다.
          </p>
        </div>
      </header>

      <nav className="onboard-steps" aria-label="브랜드 추가 단계">
        {(
          [
            [1, '1', '브랜드', s1],
            [2, '2', '정보', s2],
            [3, '3', '사실', s3],
            [4, '4', '경쟁사', s4],
            [5, '5', '등록', s5],
            [6, '6', '측정', s6],
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

      <StageShell id="stage-1" code="1" title="브랜드" status={s1}>
        <form className="site-form" onSubmit={handleStart}>
          <div className="onboard-grid">
            <label className="field">
              <span>상호 (브랜드명) *</span>
              <input
                type="text"
                placeholder="예: 원진성형외과"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>지역 (선택 · 같은 이름이 여럿일 때)</span>
              <input
                type="text"
                list="cohort-regions"
                placeholder="예: 서울 강남"
                value={regionHint}
                onChange={(e) => setRegionHint(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>홈페이지 주소 (선택 · 넣으면 훨씬 정확합니다)</span>
            <input
              type="text"
              inputMode="url"
              placeholder="예: k-wonjin.co.kr"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          {/* 두 길의 정확도가 다르다는 것을 화면이 말한다 — 접어 두면 아무도 모른다. */}
          <div className="onboard-paths">
            <p className={url.trim() ? 'onboard-path is-on' : 'onboard-path'}>
              <b>주소를 넣으면</b> 그 페이지를 읽어 업종·지역·별칭을 채웁니다. 브랜드가 스스로 공개한 값이라
              정확합니다. 사실(요금·시간·규정)도 여기서 가져올 수 있습니다.
            </p>
            <p className={url.trim() ? 'onboard-path' : 'onboard-path is-on'}>
              <b>상호만 넣으면</b> AI가 기억으로 추론합니다. 빠르지만 한국 지역 업체에서는 틀릴 때가 있으니
              다음 단계에서 값을 꼭 확인해 주세요.
            </p>
          </div>
          <span className="hint">
            홈페이지가 없어도 등록·측정할 수 있습니다 — 언급 판정은 도메인이 아니라 상호와 별칭으로 합니다.
          </span>
          <button type="submit" className="primary" disabled={busy || !brandName.trim()}>
            {busy ? withElapsed(url.trim() ? '페이지를 읽는 중…' : '조회 중…', busySec) : '자동으로 채우기'}
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
            <span>대표 도메인 (선택)</span>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="예: viewclinic.com" />
            <span className="hint">홈페이지가 있으면 넣으세요 — 브랜드 소유 인용률 측정에 쓰입니다. 없어도 등록됩니다.</span>
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
            <span>별칭 (AI 답변에서 이 브랜드를 부르는 다른 표기)</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                type="text"
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const t = aliasInput.trim()
                  if (t && !aliases.includes(t) && t !== brandName.trim()) setAliases((prev) => [...prev, t])
                  setAliasInput('')
                }}
                placeholder="예: 원진, Wonjin — 입력 후 Enter"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="ghost"
                disabled={findingAliases || !brandName.trim()}
                title="브랜드명·업종·지역으로 표기 변형을 찾습니다"
                onClick={async () => {
                  setFindingAliases(true)
                  try {
                    const found = await inferBrandAliases(brandName.trim(), industry.trim(), region.trim(), domain)
                    if (found) {
                      // 브랜드명은 등록 시 어차피 맨 앞에 붙으므로 여기서는 뺀다.
                      const rest = found.filter((a) => a.trim() && a.trim() !== brandName.trim())
                      setAliases((prev) => [...new Set([...prev, ...rest])])
                    }
                  } finally {
                    setFindingAliases(false)
                  }
                }}
              >
                {findingAliases ? '찾는 중…' : '별칭 찾기'}
              </button>
            </div>
            {aliases.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {aliases.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="ghost"
                    onClick={() => setAliases((prev) => prev.filter((x) => x !== a))}
                    title="빼기"
                  >
                    {a} ×
                  </button>
                ))}
              </div>
            )}
            <span className="hint">
              언급 판정이 이 목록을 그대로 씁니다. 비어 있으면 브랜드명 한 가지 표기로만 세기 때문에,
              AI가 다른 이름으로 부르면 언급을 놓칩니다. 업종·지역처럼 우리만 가리키지 않는 말은
              자동으로 걸러집니다.
            </span>
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

      <StageShell id="stage-3" code="3" title="사실" status={s3}>
        {!factSource ? (
          <p className="muted">
            홈페이지 주소가 없어 건너뜁니다. 사실은 나중에 <b>브랜드 사실</b> 화면에서 넣거나, 초안의 빈칸에
            바로 적어 넣을 수 있습니다.
          </p>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              브랜드 페이지에서 <b>확인 가능한 값</b>만 뽑습니다 — 요금·시간·규정처럼 손님과 맺는 약속. 값이
              페이지에 글자 그대로 있는 것만 남기고, 홍보 문구와 설명 문장은 뺍니다. 여기서 채워 두면 첫 초안의
              빈칸이 그만큼 줄어듭니다.
            </p>
            <div className="brief-bar" style={{ marginBottom: 8 }}>
              <button type="button" className="ghost" onClick={() => void findFacts()} disabled={findingFacts}>
                {findingFacts ? withElapsed('페이지 읽는 중…', factsSec) : '브랜드 페이지에서 찾기'}
              </button>
              {factCands && factCands.length > 0 && (
                <span className="st st-info">
                  {picked.length}/{factCands.length}건 선택
                </span>
              )}
            </div>
            {factsMsg && <p className="doc-meta">{factsMsg}</p>}
            {factCands && factCands.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>넣기</th>
                    <th>주장</th>
                    <th>값</th>
                  </tr>
                </thead>
                <tbody>
                  {factCands.map((f) => {
                    const on = picked.some((p) => p.claim === f.claim && p.value === f.value)
                    return (
                      <tr key={`${f.claim}|${f.value}`}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${f.claim} 넣기`}
                            checked={on}
                            onChange={(e) =>
                              setPicked((prev) =>
                                e.target.checked
                                  ? [...prev, f]
                                  : prev.filter((p) => !(p.claim === f.claim && p.value === f.value)),
                              )
                            }
                          />
                        </td>
                        <td>{f.claim}</td>
                        <td>
                          <b>{f.value}</b>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </StageShell>

      <StageShell id="stage-4" code="4" title="경쟁사" status={s4}>
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
                {suggestingComp ? withElapsed('추천 중…', compSec) : '경쟁사 자동 추천 (ChatGPT+Gemini)'}
              </button>
            )}
          </div>
          <textarea
            rows={4}
            value={competitorsRaw}
            onChange={(e) => setCompetitorsRaw(e.target.value)}
            placeholder={'예) 경쟁사A, competitor-a.com\n경쟁사B, competitor-b.co.kr'}
          />
          <span className="hint">
            경쟁사를 넣으면 Share of Mention·순위 비교가 가능합니다.{' '}
            <b>URL에서 자동 채우기</b>를 하면 경쟁사도 자동 추론되어 이 칸에 채워집니다
            {addrLookupOn ? ' (로컬: 즉시).' : ' (배포: CI에서 ~1-2분 뒤 자동 표시).'} 결과는 <b>best-effort</b>이니 직접
            검토·수정하세요. 비워 두면 측정 시 다시 추론합니다.
          </span>
          {compMsg && (
            <span className={compMsg.startsWith('✗') ? 'error' : 'hint'} role="status">
              {compMsg}
            </span>
          )}
        </div>
      </StageShell>

      <StageShell id="stage-5" code="5" title="등록" status={s5}>
        <div className="onboard-register">
          <p className="onboard-tenant">테넌트 초안 (tenantId: {tenant.tenantId || '—'})</p>
          {keyStatus && (
            <div className="onboard-engines">
              <p className="onboard-engines-title">수집 엔진</p>
              <span className="engine-cell">
                {ENGINE_CHOICES.map((e) => {
                  const keyMissing = !keyStatus[e.id]
                  return (
                    <label
                      key={e.id}
                      className={keyMissing ? 'disabled' : undefined}
                      title={keyMissing ? `${e.label} 키가 이 PC에 없습니다.` : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={engines.includes(e.id)}
                        disabled={keyMissing || registered}
                        onChange={() =>
                          setEngines((prev) => (prev.includes(e.id) ? prev.filter((x) => x !== e.id) : [...prev, e.id]))
                        }
                      />{' '}
                      {e.label}
                      {keyMissing && <span className="muted"> — 키 없음</span>}
                    </label>
                  )
                })}
              </span>
              <p className="hint" style={{ margin: '4px 0 0' }}>
                {engines.length === 0 ? (
                  <b style={{ color: 'var(--bad)' }}>엔진을 하나 이상 고르세요.</b>
                ) : (
                  <>
                    <b>{engines.length}개</b> 선택 — 엔진 1개 기준 대비 수집·판정 호출이 약 <b>{engines.length}배</b>가 되고
                    측정 시간도 그만큼 늘어납니다. 등록 후에는 아래 브랜드 목록에서 바꿀 수 있습니다.
                  </>
                )}
              </p>
            </div>
          )}
          {canRegister && measureVia !== 'none' && (
            <label className="onboard-cohort">
              <input type="checkbox" checked={withCohort} onChange={(e) => setWithCohort(e.target.checked)} />
              <span>
                측정 시 경쟁사도 코호트로 함께 측정 — 코호트 랭킹(1/N)을 채웁니다. 해제하면 본 브랜드만 측정합니다.
              </span>
            </label>
          )}
          <div className="onboard-register-actions">
            {canRegister && !registered && (
              <button
                type="button"
                className="primary"
                onClick={registerBrand}
                disabled={!ready || registering || engines.length === 0}
              >
                {registering ? '등록 중…' : '브랜드 등록'}
              </button>
            )}

          </div>
        </div>
        {!ready && <p className="hint">* 브랜드명·업종·지역을 채우면 등록할 수 있습니다 (도메인은 선택).</p>}
        {registered ? (
          <p className="hint">
            등록됐습니다. 아래 <b>6 측정</b>에서 이어서 재거나, 나중으로 미룰 수 있습니다.
          </p>
        ) : canRegister ? (
          <p className="hint">
            등록하면 <b>6 측정</b>이 열립니다 — 경쟁사·코호트까지 함께 잽니다
            {measureVia === 'local' ? ' (로컬 즉시).' : ' (GitHub Actions).'} 지금 재지 않고 나중으로 미룰 수도 있습니다.
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
          로컬 측정 CLI: <code>npm run measure:local -- {tenant.tenantId || '<tenantId>'}</code> (경쟁사·코호트 포함, baking·배포까지)
        </p>
      </StageShell>

      <StageShell id="stage-6" code="6" title="측정" status={s6} lockedHint="먼저 5단계에서 브랜드를 등록하세요.">
        {measureVia === 'none' ? (
          <p className="muted">
            이 환경에서는 측정을 실행할 수 없습니다. 로컬 앱에서 <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>을
            쓰거나 CLI로 돌리세요.
          </p>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              {/* 문항 수는 서버가 정한다. 화면이 숫자를 박으면 서버 기본값과 어긋난다 — 이 파일 위쪽
                  주석에 그 사고 기록이 있다(화면 12문항 × 3회 / 서버 36문항 × 1회). */}
              질문 은행 전체를 엔진에 던져 <b>어느 질문에서 밀리는지</b>를 잽니다. 경쟁사까지 함께 재면
              코호트 순위(1/N)도 나옵니다. 실측으로 본 브랜드만 약 2.7분, 경쟁사 포함 6곳이 약 3분입니다(병렬).
            </p>
            <div className="onboard-register-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void measureRegisteredBrand()}
                disabled={measuring}
              >
                {measuring ? withElapsed('측정 중… (보통 3분)', measureSec) : '측정 시작'}
              </button>
              {!measuring && !skippedMeasure && (
                <button type="button" className="ghost" onClick={() => setSkippedMeasure(true)}>
                  나중에 하기
                </button>
              )}
            </div>
            {measuring && <MeasureProgress active={progress} />}
            {skippedMeasure && !measuring && (
              // 건너뛰어도 반쪽이 아니다 — 측정은 우선순위를 매기는 일이지 글쓰기의 전제가 아니다(v0.1.91).
              <p className="hint">
                측정을 미뤘습니다. <b>지금도 글은 쓸 수 있습니다</b> —{' '}
                <Link to="/questions">질문 프롬프트 빌더</Link>에서 질문을 골라 바로 초안까지 갑니다. 측정은 그 질문
                중 <b>어느 것에서 밀리는지</b>를 알려 주므로, 나중에 <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>
                에서 돌리면 실행 항목이 아픈 순서대로 채워집니다.
              </p>
            )}
            {measureMsg && (
              <p className={measureMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
                {measureMsg} {measuring && <Link to="/measure-status">측정 상태에서 진행 보기</Link>}
              </p>
            )}
          </>
        )}
      </StageShell>

      <BrandManageList />
    </>
  )
}
