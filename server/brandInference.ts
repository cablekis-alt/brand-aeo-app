import { lookup } from 'node:dns/promises';
import { GeminiEngineClient } from './engines/geminiEngineClient.js';
import { GeminiJudgeClient } from './engines/geminiJudgeClient.js';
import { OpenAiJudgeClient } from './engines/openaiJudgeClient.js';
import { parseJsonLoose } from './jsonParse.js';

// 한국 도로명/지번 주소 패턴 (온보딩 폼의 것과 동일) — 그라운딩 응답에서 주소만 검증·추출.
const KR_ADDRESS =
  /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청?[남북]?|충[남북]|전라?[남북]?|전[남북]|경상?[남북]?|경[남북]|제주)[가-힣]*(?:특별자치[시도]|특별[시도]|광역시|도)?\s?[가-힣]+(?:시|군|구)\s?[가-힣0-9]+(?:로|길)\s?\d+[-\d]*)/;

export interface InferredBrandFields {
  industry: string;
  region: string;
  address: string;
}

const EMPTY: InferredBrandFields = { industry: '', region: '', address: '' };

/**
 * 온보딩 보조 — 수집된 페이지 텍스트에서 업종·지역·주소를 Gemini로 추론한다.
 * GEMINI_API_KEY가 없거나 실패하면 빈 값으로 강등한다(사용자가 직접 입력).
 */
export async function inferBrandFields(pageText: string, brandName = ''): Promise<InferredBrandFields> {
  const text = pageText.trim();
  if (!text || !process.env.GEMINI_API_KEY) return EMPTY;

  const system =
    '당신은 한국 비즈니스 웹페이지에서 업종·지역·주소를 뽑아내는 도우미입니다. 반드시 JSON 객체만 반환하세요.';
  const user = `아래는 ${brandName ? `"${brandName}"의 ` : ''}웹페이지에서 추출한 본문과 위치 단서입니다.
다음 세 가지를 추론해 JSON으로만 답하세요.
- industry: 업종을 짧은 한국어 명사로 (예: "숙박", "성형외과", "카페", "치과"). 알 수 없으면 "".
- region: 시/도 + 시군구 수준 (예: "전북 군산", "서울 강남", "서울 서초"). 푸터·주소·강남역 표기가 있으면 비우지 마세요.
- address: 본문·푸터에 도로명/지번 주소가 있으면 건물명까지 그대로. 없으면 "". 지어내지 마세요.
스키마: {"industry": string, "region": string, "address": string}
설명·마크다운·코드블록 없이 JSON만 반환하세요.

--- 페이지 텍스트 ---
${text.slice(0, 4000)}`;

  // Gemini(gemini-3.7-flash)가 동일 입력에도 간헐적으로 "부분"·빈 응답을 주므로, 각 필드의 첫
  // non-empty 값을 여러 시도에서 누적(merge)한다. 업종이 채워지면 조기 종료(자동채우기 일관성).
  const judge = new GeminiJudgeClient();
  const merged: InferredBrandFields = { industry: '', region: '', address: '' };
  for (let attempt = 1; attempt <= 3 && !merged.industry; attempt += 1) {
    try {
      const result = await judge.call({ system, user });
      const parsed = parseJsonLoose<Partial<InferredBrandFields>>(result.text);
      merged.industry ||= typeof parsed?.industry === 'string' ? parsed.industry.trim() : '';
      merged.region ||= typeof parsed?.region === 'string' ? parsed.region.trim() : '';
      merged.address ||= typeof parsed?.address === 'string' ? parsed.address.trim() : '';
    } catch (err) {
      console.error('[inferBrandFields] Gemini 호출 실패:', err instanceof Error ? err.message : err);
    }
  }
  return merged;
}

/**
 * 온보딩 보조(B) — 페이지에서 주소를 못 찾았을 때 브랜드명+지역으로 도로명 주소를 조회한다.
 * 로컬·CI에선 Gemini 웹검색 그라운딩(정확), Vercel 서버리스에선 그라운딩이 동작하지 않으므로
 * 순수 추론 recall로 폴백한다(모델 지식 기반 — 사용자 확인 전제). 응답은 한국 주소 정규식으로 검증(환각 방지).
 */
export async function inferAddressViaSearch(brandName: string, region = ''): Promise<string> {
  if (!process.env.GEMINI_API_KEY || !brandName.trim()) return '';
  const system =
    '당신은 한국 비즈니스의 실제 도로명 주소를 아는 도우미입니다. 확실하지 않으면 "모름"만 답하고, 주소를 지어내지 마세요.';
  const user = `"${brandName}"${region ? ` (${region})` : ''}의 공식 도로명 주소를 한 줄만 답하세요.
예: "서울 강남구 봉은사로 107". 확실하지 않으면 "모름"이라고만 답하세요.`;

  // 1) 웹검색 그라운딩 — Vercel 서버리스에선 결과를 못 주므로 로컬·CI에서만 시도한다.
  if (!process.env.VERCEL) {
    try {
      const grounded = await new GeminiEngineClient().call({ system, user });
      const m = (grounded.text ?? '').match(KR_ADDRESS);
      if (m) return m[0].trim();
    } catch {
      // 폴백으로 넘어간다.
    }
  }
  // 2) 순수 추론 recall — 모든 환경에서 동작하는 폴백/기본.
  try {
    const reasoned = await new GeminiJudgeClient().call({ system, user });
    const m = (reasoned.text ?? '').match(KR_ADDRESS);
    if (m) return m[0].trim();
  } catch {
    // 무시
  }
  return '';
}

/**
 * 봇 차단 등으로 페이지 텍스트를 못 가져왔을 때 도메인만으로 브랜드명·업종·지역을 추론한다.
 * Gemini 웹검색 그라운딩을 사용하므로 로컬·Vercel 모두 동작한다.
 */
export async function inferBrandFromDomain(
  domain: string,
): Promise<{ brandName: string; industry: string; region: string; address: string }> {
  const EMPTY_DOMAIN = { brandName: '', industry: '', region: '', address: '' };
  if (!process.env.GEMINI_API_KEY || !domain.trim()) return EMPTY_DOMAIN;

  const system =
    '당신은 웹사이트 도메인에서 한국 브랜드 정보를 찾아주는 도우미입니다. 반드시 JSON만 반환하세요.';
  const user = `도메인: "${domain}"
이 웹사이트의 한국어 브랜드명·업종·지역·주소를 아는 경우 JSON으로 답하세요. 모르면 ""로 두세요.
스키마: {"brandName": string, "industry": string, "region": string, "address": string}
brandName은 공식 한국어 브랜드명(예: "뷰클리닉"), industry는 짧은 명사(예: "성형외과"), region은 시+구(예: "서울 강남"), address는 도로명 주소(예: "서울 서초구 강남대로 419")
설명 없이 JSON만 반환하세요.`;

  const attempt = async (client: GeminiEngineClient | GeminiJudgeClient) => {
    const result = await client.call({ system, user });
    const parsed = parseJsonLoose<Partial<{ brandName: string; industry: string; region: string; address: string }>>(result.text);
    return {
      brandName: typeof parsed?.brandName === 'string' ? parsed.brandName.trim() : '',
      industry: typeof parsed?.industry === 'string' ? parsed.industry.trim() : '',
      region: typeof parsed?.region === 'string' ? parsed.region.trim() : '',
      address: typeof parsed?.address === 'string' ? parsed.address.trim() : '',
    };
  };
  // Gemini가 간헐적으로 "부분" 응답(예: 지역·주소만 주고 업종은 빈값)을 주므로, 각 필드의 첫 non-empty
  // 값을 여러 시도에서 누적(merge)한다. 특히 업종이 빠지기 쉬워 industry가 채워질 때까지 재시도한다.
  const merged = { ...EMPTY_DOMAIN };
  const absorb = (o: typeof EMPTY_DOMAIN) => {
    merged.brandName ||= o.brandName;
    merged.industry ||= o.industry;
    merged.region ||= o.region;
    merged.address ||= o.address;
  };
  // 업종을 핵심으로 본다(자동채우기에서 업종이 비면 경쟁사 추론까지 막힘).
  const enough = () => Boolean(merged.industry && merged.region);
  for (let round = 0; round < 3 && !enough(); round += 1) {
    try {
      absorb(await attempt(new GeminiEngineClient())); // 웹검색 그라운딩(정확)
    } catch (err) {
      console.error('[inferBrandFromDomain] 그라운딩 실패:', err instanceof Error ? err.message : err);
    }
    if (enough()) break;
    try {
      absorb(await attempt(new GeminiJudgeClient())); // 순수 추론 폴백
    } catch (err) {
      console.error('[inferBrandFromDomain] 추론 실패:', err instanceof Error ? err.message : err);
    }
  }
  return merged;
}

/**
 * 온보딩 진입(상호 기반) — 브랜드명(상호)만으로 공식 도메인·업종·지역·주소를 추론한다.
 * 한국 소상공인·병원은 자사 홈페이지가 없거나 약한 경우가 많아, URL보다 상호가 더 자연스러운 씨앗이다.
 * inferBrandFromDomain과 같은 방식(웹검색 그라운딩 + 순수 추론 폴백을 필드별로 누적)이며,
 * 도메인은 DNS로 실재 확인해 환각을 거른다. 주소가 비면 기존 주소 그라운딩으로 한 번 더 보강한다.
 */
export async function inferBrandFromName(
  brandName: string,
  region = '',
): Promise<{ brandName: string; domain: string; industry: string; region: string; address: string }> {
  const seed = { brandName: brandName.trim(), domain: '', industry: '', region: region.trim(), address: '' };
  if (!process.env.GEMINI_API_KEY || !brandName.trim()) return seed;

  const system =
    '당신은 한국 상호(브랜드명)로 그 사업체의 공식 정보를 찾아주는 도우미입니다. 반드시 JSON만 반환하고, 확실하지 않은 값은 ""로 두세요. 도메인·주소를 지어내지 마세요.';
  const user = `상호(브랜드명): "${brandName}"${region ? ` (${region})` : ''}
이 한국 사업체의 공식 정보를 아는 경우 JSON으로 답하세요. 모르면 각 값을 ""로 두세요.
스키마: {"brandName": string, "domain": string, "industry": string, "region": string, "address": string}
- brandName: 공식 한국어 상호로 정규화 (예: "원진성형외과의원")
- domain: 공식 웹사이트 도메인만 (예: "wonjin.co.kr"). 네이버 블로그·플레이스·인스타 등 자사 도메인이 아니면 "".
- industry: 짧은 한국어 명사 (예: "성형외과", "치과", "카페")
- region: 시/도 + 시군구 (예: "서울 강남")
- address: 도로명 주소 (예: "서울 강남구 강남대로 419"). 없으면 "".
설명·마크다운·코드블록 없이 JSON만 반환하세요.`;

  const attempt = async (client: GeminiEngineClient | GeminiJudgeClient) => {
    const result = await client.call({ system, user });
    const parsed = parseJsonLoose<Partial<typeof seed>>(result.text);
    return {
      brandName: typeof parsed?.brandName === 'string' ? parsed.brandName.trim() : '',
      domain: typeof parsed?.domain === 'string' ? parsed.domain.trim() : '',
      industry: typeof parsed?.industry === 'string' ? parsed.industry.trim() : '',
      region: typeof parsed?.region === 'string' ? parsed.region.trim() : '',
      address: typeof parsed?.address === 'string' ? parsed.address.trim() : '',
    };
  };
  const merged = { ...seed };
  const absorb = (o: typeof seed) => {
    merged.brandName ||= o.brandName;
    merged.domain ||= o.domain;
    merged.industry ||= o.industry;
    merged.region ||= o.region;
    merged.address ||= o.address;
  };
  // 업종·지역이 채워지면 충분(경쟁사 추론까지 이어짐). 도메인·주소는 있으면 좋지만 필수는 아니다.
  const enough = () => Boolean(merged.industry && merged.region);
  for (let round = 0; round < 3 && !enough(); round += 1) {
    try {
      absorb(await attempt(new GeminiEngineClient())); // 웹검색 그라운딩(정확)
    } catch (err) {
      console.error('[inferBrandFromName] 그라운딩 실패:', err instanceof Error ? err.message : err);
    }
    if (enough()) break;
    try {
      absorb(await attempt(new GeminiJudgeClient())); // 순수 추론 폴백
    } catch (err) {
      console.error('[inferBrandFromName] 추론 실패:', err instanceof Error ? err.message : err);
    }
  }
  // 도메인 환각 방지 — DNS로 실재 확인. 안 뜨면 비운다(사용자가 직접 보완).
  if (merged.domain) merged.domain = await verifiedDomain(merged.domain);
  // 주소가 끝까지 비면 기존 주소 그라운딩으로 한 번 더 시도한다.
  if (!merged.address) {
    const addr = await inferAddressViaSearch(merged.brandName || brandName, merged.region || region);
    if (addr) merged.address = addr;
  }
  return merged;
}

export interface InferredCompetitor {
  name: string;
  domain: string;
}

/** 도메인을 정규화하고(스킴·www·경로 제거) 실제로 DNS 해석되는지 확인한다. 안 뜨면 환각으로 보고 비운다. */
async function verifiedDomain(raw: string): Promise<string> {
  const domain = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return '';
  try {
    // 매달린 DNS 조회가 서버리스 시간 예산을 다 먹지 않도록 3초로 제한한다.
    await Promise.race([
      lookup(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 3000)),
    ]);
    return domain;
  } catch {
    return '';
  }
}

/**
 * 온보딩 보조 — 같은 업종·지역의 경쟁 브랜드를 Gemini(웹 검색 그라운딩)로 추천한다.
 * 이름은 그대로 쓰되, 도메인은 실재 확인(DNS)에 통과한 것만 채우고 나머지는 빈 값(사용자 보완)으로 둔다.
 */
export async function inferCompetitors(
  brandName: string,
  industry: string,
  region = '',
): Promise<InferredCompetitor[]> {
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  // OpenAI는 Vercel 리전(iad1)에서 한국어 브랜드 회상에 헛소리(식당·놀이공원 등)를 내므로 로컬/CI에서만 병합한다.
  // Vercel에선 Gemini 단독 = 검증된 정상 경로. (주소 조회를 로컬 전용으로 게이트한 것과 동일한 이유.)
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY) && !process.env.VERCEL;
  if ((!hasGemini && !hasOpenAi) || !brandName.trim() || !industry.trim()) return [];

  const system =
    '당신은 한국 시장 리서처입니다. 반드시 JSON 배열만 반환하세요. 도메인은 확실할 때만 적고, 모르면 빈 문자열("")로 두세요. 도메인을 지어내지 마세요.';
  const user = `"${brandName}"와 직접 경쟁하는 ${region ? `${region} 지역의 ` : ''}같은 "${industry}" 업종 브랜드 3~5곳을 추천하세요.
매우 중요: 반드시 실제 "${industry}" 업종의 업체/브랜드만 포함하세요. "${brandName}"와 이름이 비슷하더라도 다른 업종(예: 화장품·카페·차·식당·쇼핑몰 등)은 절대 포함하지 마세요.
"${brandName}" 자신은 제외합니다.
각 항목: {"name": 브랜드명(한국어), "domain": 공식 웹사이트 도메인(예: "example.com"), 확실하지 않으면 ""}
스키마: [{"name": string, "domain": string}]
설명·마크다운·코드블록 없이 JSON 배열만 반환하세요.`;

  const parseCandidates = (text: string): { name: string; rawDomain: string }[] => {
    const parsed = parseJsonLoose<Array<{ name?: unknown; domain?: unknown }>>(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        name: typeof item?.name === 'string' ? item.name.trim() : '',
        rawDomain: typeof item?.domain === 'string' ? item.domain : '',
      }))
      .filter((c) => c.name);
  };

  // ChatGPT + Gemini 병렬 추천(하나 실패해도 다른 결과 사용) — 모델마다 아는 브랜드가 달라 커버리지가 넓어진다.
  const calls: Promise<{ name: string; rawDomain: string }[]>[] = [];
  if (hasGemini) {
    // 구글 검색 그라운딩 — 실제 웹검색 기반이라 정확(과거 정확했던 방식). 순수 추론은 리전 탓 자유연상 오답을 내므로 지양.
    calls.push(
      new GeminiEngineClient()
        .call({ system, user })
        .then((r) => parseCandidates(r.text))
        .catch(() => []),
    );
  }
  if (hasOpenAi) {
    // gpt-4o 순수 추론(chat.completions). web_search는 US 러너(Vercel·GitHub Actions)에서 한국어 질의에
    // 헛소리를 내므로 쓰지 않는다. 업종 혼동은 위 프롬프트의 업종 강제 앵커링으로 줄인다.
    calls.push(
      new OpenAiJudgeClient()
        .call({ system, user })
        .then((r) => parseCandidates(r.text))
        .catch(() => []),
    );
  }
  const lists = await Promise.all(calls);

  // 이름 기준 중복 제거(브랜드 자신 제외). 같은 이름을 여러 엔진이 주면 도메인 있는 값으로 채운다.
  const byName = new Map<string, string>();
  for (const list of lists) {
    for (const c of list) {
      if (c.name === brandName.trim()) continue;
      const existing = byName.get(c.name);
      if (existing === undefined || (!existing && c.rawDomain)) byName.set(c.name, c.rawDomain);
    }
  }
  const candidates = [...byName.entries()].map(([name, rawDomain]) => ({ name, rawDomain }));

  // 도메인 DNS 검증은 병렬로 (순차로 하면 서버리스 시간 제한을 넘기 쉽다).
  const validated = await Promise.all(
    candidates.map(async (c) => ({ name: c.name, domain: c.rawDomain ? await verifiedDomain(c.rawDomain) : '' })),
  );
  // 같은 도메인(같은 병원, 이름만 다른 경우)은 하나만 남기고, 최대 6곳.
  const seenDomain = new Set<string>();
  const out: InferredCompetitor[] = [];
  for (const c of validated) {
    if (c.domain) {
      if (seenDomain.has(c.domain)) continue;
      seenDomain.add(c.domain);
    }
    out.push(c);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 별칭 추론 — AI 답변이 이 브랜드를 부르는 다른 표기를 찾는다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * 브랜드 언급 판정(b5a)은 브랜드명과 별칭을 판정 프롬프트에 그대로 넣는다. 그래서 등록된 이름이
 * 실제 답변의 표기와 어긋나면 언급이 통째로 안 잡힌다. 실측(2026-09-13): 가온그룹이
 * "KAONGROUP.COM"으로 등록돼 있어 한국어 답변의 "가온그룹"을 한 번도 세지 못했고, 언급률이
 * 3/72로 바닥이었다. 가시성이 낮은 게 아니라 이름이 안 맞았던 것이다.
 *
 * 지금까지는 별칭이 브랜드명 하나뿐이었다(온보딩이 [brandName]으로 채운다). 사람이 나중에
 * 채워 넣기를 기대하는 설계였는데, 아무도 채우지 않았다 — 111개 브랜드 중 별칭이 둘 이상인
 * 곳이 손에 꼽는다.
 *
 * ── 무엇을 거르나 ──────────────────────────────────────────────────────────
 * 별칭은 넓을수록 좋은 게 아니다. 너무 일반적인 말이 별칭이 되면 경쟁사 문장까지 우리 언급으로
 * 센다. 그래서 코드로 막는다:
 *   2자 미만          한 글자는 아무 문장에나 걸린다.
 *   업종 이름과 같음   "성형외과"가 별칭이면 모든 경쟁사가 우리가 된다.
 *   지역 이름과 같음   "강남"도 마찬가지다.
 *   중복(대소문자 무시)
 * 브랜드명 자체는 항상 첫 별칭으로 남긴다(기존 데이터 규약).
 */
export async function inferAliases(
  brandName: string,
  industry = '',
  region = '',
  domain = '',
): Promise<string[]> {
  const base = brandName.trim();
  if (!base) return [];
  if (!process.env.GEMINI_API_KEY) return [base];

  const system =
    '당신은 한국 브랜드의 표기 변형을 찾아주는 도우미입니다. 반드시 JSON 배열만 반환하세요.';
  const user = `브랜드: "${base}"${industry ? `\n업종: ${industry}` : ''}${region ? `\n지역: ${region}` : ''}${domain ? `\n도메인: ${domain}` : ''}

AI 챗봇의 한국어 답변이 이 브랜드를 가리킬 때 실제로 쓸 법한 표기를 모두 나열하세요.
- 공식 한국어 상호, 줄임말, 법인 접두/접미를 뗀 형태, 영문 표기, 흔한 약칭
- 예: "WJ 원진성형외과" → ["원진성형외과", "원진", "Wonjin", "WJ원진"]
- 업종명("성형외과")이나 지역명("강남")처럼 **이 브랜드만 가리키지 않는 일반명사는 절대 넣지 마세요.**
- 확실하지 않으면 넣지 마세요. 적게 넣는 편이 낫습니다.
출력: 문자열 배열 JSON만. 설명 금지. 예: ["원진성형외과","원진","Wonjin"]`;

  const attempt = async (client: GeminiEngineClient | GeminiJudgeClient): Promise<string[]> => {
    const result = await client.call({ system, user });
    const parsed = parseJsonLoose<unknown>(result.text);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  };

  let raw: string[] = [];
  try {
    raw = await attempt(new GeminiEngineClient()); // 웹검색 그라운딩
  } catch (err) {
    console.error('[inferAliases] 그라운딩 실패:', err instanceof Error ? err.message : err);
  }
  if (raw.length === 0) {
    try {
      raw = await attempt(new GeminiJudgeClient()); // 순수 추론 폴백
    } catch (err) {
      console.error('[inferAliases] 추론 실패:', err instanceof Error ? err.message : err);
    }
  }
  return sanitizeAliases(base, raw, industry, region);
}

/** 별칭 거르기. inferAliases의 판정 없이도 쓸 수 있게 따로 둔다(시험·클라이언트 재사용). */
export function sanitizeAliases(brandName: string, candidates: string[], industry = '', region = ''): string[] {
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  // 지역은 "서울 강남"처럼 붙어 오므로 토막으로도 막는다.
  const banned = new Set(
    [industry, region, ...region.split(/\s+/)].map(squash).filter((s) => s.length > 0),
  );
  const brandSquashed = squash(brandName);
  const out = [brandName.trim()];
  for (const c of candidates) {
    const t = c.trim();
    if (t.length < 2) continue; // 한 글자는 아무 문장에나 걸린다
    const s = squash(t);
    if (!s || banned.has(s)) continue; // 업종·지역은 우리만 가리키지 않는다
    // 두 글자 한글은 상호명 안에 들어 있을 때만 받는다.
    //
    // 업종·지역을 막아도 다른 지역명이 샌다 — 실측: 서초 소재 병원에 "강남"이 별칭으로 들어왔고,
    // 그대로 두면 강남을 말하는 경쟁사 문장까지 우리 언급으로 센다. 반면 "가온"(가온그룹),
    // "원진"(WJ 원진성형외과)처럼 상호에서 잘라낸 약칭은 살려야 한다.
    // 석 자 이상은 이 규칙을 걸지 않는다 — "티오더", "한국전자기술연구원"처럼 상호와 글자가
    // 겹치지 않는 올바른 표기가 그쪽에 있다.
    if (/^[가-힣]{2}$/.test(t) && !brandSquashed.includes(s)) continue;
    if (out.some((x) => squash(x) === s)) continue;
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}
