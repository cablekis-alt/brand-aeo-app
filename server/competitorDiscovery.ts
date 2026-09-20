import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { RawCallRecord } from './types.js';

/**
 * 답변에 함께 나온 브랜드 찾기 — 코호트에 없는 곳을 사람이 발견하게 한다.
 *
 * 지금 화면은 **등록된 경쟁사만** 비교한다. 판정 프롬프트에 경쟁사 목록을 넣어 주기 때문에,
 * 등록하지 않은 업체는 답변에 아무리 자주 나와도 화면에 존재하지 않는다. 코호트를 사람이
 * 처음부터 정확히 짜야 하는 구조이고, 그건 온보딩에서 가장 어려운 일이다.
 *
 * 왜 엔진에 묻지 않는가 — 원문은 이미 저장돼 있고, 거기서 업체명을 뽑는 일은 회상이 아니라
 * 문자열 추출이다. 엔진을 한 번 더 부르면 주당 70여 콜이 늘고(크레딧이 이미 빠듯하다),
 * 지난 주차에 소급할 수 없으며, 같은 입력에 다른 답이 나올 수 있다. 여기 방식은 값이 없고
 * 결정적이며 옛 주차에도 그대로 돌아간다.
 *
 * 다만 **판정이 아니라 후보**다. 업종 접미사로 뽑는 방식이라 "대형성형외과" 같은 일반어가
 * 섞일 수 있다. 그래서 화면은 이것을 경쟁사라고 부르지 않고 "함께 나온 브랜드"로 두고,
 * 등록은 사람이 확인한 뒤에 한다.
 */
export interface DiscoveredBrand {
  name: string;
  /** 총 등장 횟수(같은 답변 안의 반복 포함). */
  mentions: number;
  /** 몇 개의 답변에 나왔는지 — 한 답변에서 열 번 나온 것과 열 답변에 한 번씩 나온 것은 다르다. */
  answers: number;
  engines: string[];
  /** 어느 질문에서 나왔는지(최대 5개). 사람이 원문으로 확인하러 갈 실마리다. */
  questionIds: string[];
  /** 이 코호트에 이미 등록된 브랜드인지. */
  registered: boolean;
}

export interface DiscoveryResult {
  brands: DiscoveredBrand[];
  /** 업종에서 쓸 접미사를 찾지 못하면 빈 결과가 나온다 — 화면이 이유를 말해야 한다. */
  suffixes: string[];
  /**
   * 접미사를 어디서 얻었는지. 'fallback'은 업종 이름을 그대로 접미사로 삼아 본 것이라
   * 결과가 0개여도 "경쟁사가 없다"가 아니라 "이 방식으로는 못 찾는다"는 뜻이다.
   * 둘을 구분하지 않으면 테이블오더처럼 업종명이 상호에 안 붙는 업종에서 화면이
   * "다른 브랜드가 발견되지 않았습니다"라고 거짓을 말한다(실측으로 걸렸다).
   */
  suffixSource: 'catalog' | 'fallback' | 'none';
  /** 읽은 답변 수. 0이면 원문이 없는 주차다. */
  answersScanned: number;
}

/**
 * 업종 → 이름 접미사. 업종 문자열 자체가 접미사인 경우가 많아(성형외과·치과·펜션) 그대로 쓰되,
 * 실제 상호에 더 자주 붙는 변형을 함께 둔다.
 */
const SUFFIXES_BY_INDUSTRY: Record<string, string[]> = {
  성형외과: ['성형외과의원', '성형외과'],
  치과: ['치과의원', '치과'],
  병원: ['병원', '의원'],
  한의원: ['한의원'],
  펜션: ['펜션', '풀빌라', '게스트하우스', '리조트'],
  호텔: ['호텔', '리조트'],
};

/** 접미사 앞에 붙어도 상호가 아닌 말들. "대형성형외과"를 업체로 세면 목록이 쓰레기가 된다. */
const GENERIC_PREFIX = new Set([
  '대형', '유명', '전문', '해당', '각', '이', '그', '저', '다른', '여러', '주요', '대표', '대표적',
  '모든', '일부', '기타', '해당', '추천', '인근', '근처', '지역', '국내', '서울', '강남', '부산',
  '수도권', '전문의', '비전문의', '일반', '특정', '개인', '동네', '큰', '작은', '최고', '최상',
  '유명한', '추천하는', '선호', '인기', '신규', '기존',
]);

function suffixesFor(industry: string): { suffixes: string[]; source: DiscoveryResult['suffixSource'] } {
  const key = (industry ?? '').trim();
  if (SUFFIXES_BY_INDUSTRY[key]) return { suffixes: SUFFIXES_BY_INDUSTRY[key]!, source: 'catalog' };
  // 한글 업종이면 그 자체를 접미사로 시험해 본다(등록 업종이 늘어도 코드를 고치지 않게).
  if (/^[가-힣]{2,8}$/.test(key)) return { suffixes: [key], source: 'fallback' };
  return { suffixes: [], source: 'none' };
}

/** 이름 정규화 — 굵게 표시(**), 공백, 괄호를 털어 같은 업체가 갈라지지 않게 한다. */
function tidy(name: string): string {
  return name.replace(/[*_`]/g, '').replace(/\s+/g, '').trim();
}

/**
 * 한 답변에서 상호 후보를 뽑는다.
 *
 * 접미사 **바로 앞에 붙은** 한글/영문 덩어리만 이름으로 본다. 공백을 건너뛰며 앞으로 더
 * 가져오면 "유명한 성형외과"의 '유명한'까지 상호가 되어 버린다.
 *
 * 긴 접미사를 먼저 훑고 그 구간을 소비한다. 안 그러면 「기린성형외과의원」 하나가
 * 「기린성형외과의원」과 「기린성형외과」 둘로 세어진다 — 실측에서 그렇게 갈렸고,
 * 한쪽은 등록됨·다른 쪽은 미등록으로 표시돼 목록을 못 믿게 만들었다.
 */
function extractNames(text: string, suffixes: string[]): string[] {
  const found: string[] = [];
  const taken: { start: number; end: number }[] = [];
  for (const suffix of [...suffixes].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`([가-힣A-Za-z][가-힣A-Za-z0-9]{0,11})${suffix}`, 'g');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some((t) => start < t.end && t.start < end)) continue;
      const prefix = tidy(m[1] ?? '');
      if (prefix.length < 2) continue;
      if (GENERIC_PREFIX.has(prefix)) continue;
      taken.push({ start, end });
      found.push(`${prefix}${suffix}`);
    }
  }
  return found;
}

/**
 * 비교용 키 — 표기 흔들림을 하나로 모은다.
 *
 * 「기린성형외과」와 「기린성형외과의원」은 같은 곳이다. 표시에는 실제로 더 자주 나온 표기를
 * 쓰되, 세는 것과 등록 대조는 이 키로 한다. 그래야 같은 업체가 목록에 두 번 나오지 않고,
 * 등록된 경쟁사가 표기 차이 때문에 "미등록"으로 뜨지 않는다.
 */
function matchKey(name: string): string {
  return tidy(name).replace(/(성형외과|치과|병원|한의원)의원$/, '$1');
}

export async function discoverBrands(
  tenantId: string,
  weekOf: string,
  self: { brandName: string; aliases: string[]; industry: string },
  known: { name: string; aliases: string[] }[],
): Promise<DiscoveryResult> {
  const { suffixes, source: suffixSource } = suffixesFor(self.industry);
  const file = path.join(PIPELINE_DATA_DIR, tenantId, weekOf, 'raw-calls.json');
  let records: RawCallRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    if (Array.isArray(parsed)) records = parsed as RawCallRecord[];
  } catch {
    return { brands: [], suffixes, suffixSource, answersScanned: 0 };
  }
  if (suffixes.length === 0) return { brands: [], suffixes, suffixSource, answersScanned: records.length };

  // 자기 자신은 후보가 아니다. 별칭도 함께 턴다(WJ원진성형외과 · 원진성형외과).
  const selfKeys = new Set([self.brandName, ...self.aliases].map(matchKey).filter(Boolean));
  // 등록된 브랜드는 목록에 남기되 "등록됨"으로 표시한다 — 몇 번 나왔는지는 여전히 궁금하다.
  const knownKeys = new Map<string, string>();
  for (const k of known) {
    for (const n of [k.name, ...k.aliases]) {
      const t = matchKey(n);
      if (t) knownKeys.set(t, k.name);
    }
  }

  const acc = new Map<
    string,
    { surfaces: Map<string, number>; mentions: number; answers: Set<number>; engines: Set<string>; questions: Set<string> }
  >();
  records.forEach((r, i) => {
    for (const raw of extractNames(r.rawText ?? '', suffixes)) {
      const key = matchKey(raw);
      if (!key || selfKeys.has(key)) continue;
      let row = acc.get(key);
      if (!row) {
        row = { surfaces: new Map(), mentions: 0, answers: new Set(), engines: new Set(), questions: new Set() };
        acc.set(key, row);
      }
      const surface = tidy(raw);
      row.surfaces.set(surface, (row.surfaces.get(surface) ?? 0) + 1);
      row.mentions += 1;
      row.answers.add(i);
      row.engines.add(r.engine);
      row.questions.add(r.questionId);
    }
  });

  const brands = [...acc.entries()]
    .map(([key, v]) => ({
      // 표시는 실제로 가장 자주 나온 표기로 한다 — 우리가 만든 정규화형이 아니라 AI가 쓴 말.
      name: [...v.surfaces.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      mentions: v.mentions,
      answers: v.answers.size,
      engines: [...v.engines].sort(),
      questionIds: [...v.questions].sort().slice(0, 5),
      registered: knownKeys.has(key),
    }))
    .sort((a, b) => b.answers - a.answers || b.mentions - a.mentions || a.name.localeCompare(b.name));

  return { brands, suffixes, suffixSource, answersScanned: records.length };
}
