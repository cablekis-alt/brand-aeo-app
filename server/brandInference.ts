import { lookup } from 'node:dns/promises';
import { GeminiEngineClient } from './engines/geminiEngineClient.js';
import { GeminiJudgeClient } from './engines/geminiJudgeClient.js';
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
  const user = `아래는 ${brandName ? `"${brandName}"의 ` : ''}웹페이지에서 추출한 본문 텍스트입니다.
다음 세 가지를 추론해 JSON으로만 답하세요.
- industry: 업종을 짧은 한국어 명사로 (예: "숙박", "성형외과", "카페", "치과"). 알 수 없으면 "".
- region: 시/도 + 시군구 수준 (예: "전북 군산", "서울 강남"). 알 수 없으면 "".
- address: 본문에 도로명/지번 전체 주소가 있으면 그대로, 없으면 "". 지어내지 마세요.
스키마: {"industry": string, "region": string, "address": string}
설명·마크다운·코드블록 없이 JSON만 반환하세요.

--- 페이지 텍스트 ---
${text.slice(0, 4000)}`;

  try {
    const result = await new GeminiJudgeClient().call({ system, user });
    const parsed = parseJsonLoose<Partial<InferredBrandFields>>(result.text);
    if (!parsed) return EMPTY;
    return {
      industry: typeof parsed.industry === 'string' ? parsed.industry.trim() : '',
      region: typeof parsed.region === 'string' ? parsed.region.trim() : '',
      address: typeof parsed.address === 'string' ? parsed.address.trim() : '',
    };
  } catch {
    return EMPTY;
  }
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
  if (!process.env.GEMINI_API_KEY || !brandName.trim() || !industry.trim()) return [];

  const system =
    '당신은 한국 시장 리서처입니다. 반드시 JSON 배열만 반환하세요. 도메인은 확실할 때만 적고, 모르면 빈 문자열("")로 두세요. 도메인을 지어내지 마세요.';
  const user = `"${brandName}"(업종: ${industry}${region ? `, 지역: ${region}` : ''})와 실제로 경쟁하는 같은 업종·지역 브랜드 3~5곳을 추천하세요.
"${brandName}" 자신은 제외합니다.
각 항목: {"name": 브랜드명(한국어), "domain": 공식 웹사이트 도메인(예: "example.com"), 확실하지 않으면 ""}
스키마: [{"name": string, "domain": string}]
설명·마크다운·코드블록 없이 JSON 배열만 반환하세요.`;

  const result = await new GeminiJudgeClient().call({ system, user });
  const parsed = parseJsonLoose<Array<{ name?: unknown; domain?: unknown }>>(result.text);
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const candidates: { name: string; rawDomain: string }[] = [];
  for (const item of parsed.slice(0, 5)) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || name === brandName.trim() || seen.has(name)) continue;
    seen.add(name);
    candidates.push({ name, rawDomain: typeof item?.domain === 'string' ? item.domain : '' });
  }
  // 도메인 DNS 검증은 병렬로 (순차로 하면 서버리스 시간 제한을 넘기 쉽다).
  return Promise.all(
    candidates.map(async (c) => ({ name: c.name, domain: c.rawDomain ? await verifiedDomain(c.rawDomain) : '' })),
  );
}
