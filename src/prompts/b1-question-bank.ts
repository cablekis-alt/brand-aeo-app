import type { MarketScope, PromptMessage, QuestionLanguage, QuestionSpec } from './types.js';

/**
 * 질문 문체 규칙 — 언어에 따라 이것만 바뀐다(나머지 규칙·스키마는 같다).
 *
 * 영어는 한국에서 시술을 알아보는 외국인 환자의 입력처럼 쓰게 한다. 지역 표기 뒤 괄호 꼬리표
 * (예: "서울 강남 (영어 질문)")는 한국어 측정과 코호트를 나누려고 붙인 것이라 질문에 넣지 않는다.
 * topic은 화면에서 한국어 측정과 같이 보이므로 한국어로 둔다.
 */
/** 시장 범위별 질문 설계 — 누가 묻는가 · 무엇을 묻는가 · 지역을 넣는가 · 추천형 예시. */
interface ScopeGuide {
  /** 이 질문을 입력하는 사람 — 프롬프트 첫 줄과 사용자 메시지에 들어간다. */
  persona: string;
  /** 다룰 주제의 범위. 지역형은 빈 문자열(기존 규칙 그대로). */
  topicRule: string;
  /** 지역을 질문에 넣지 말라는 규칙. 지역형은 빈 문자열. */
  regionRule: string;
  /** 추천형(consider) 질문의 예시. */
  recommend: string;
  label: string;
}

/**
 * 시장 범위가 생기기 전에는 모든 브랜드를 「지역 소비자」로 보고 질문을 만들었다. B2B 납품사(셋톱박스)는
 * 「수도권 원룸 OTT 셋톱박스 추천」 같은 소비자 질문을 받아 코호트 5곳이 모두 언급률 0%였고(2026-W40),
 * 업종 이름에 「통신사 납품」을 넣어 우회하자 같은 브랜드가 25%로 1위가 됐다. 지역형은 예전 문구를 그대로 쓴다.
 */
export function scopeGuide(scope: MarketScope | undefined, industry: string, region: string, buyer?: string): ScopeGuide {
  if (scope === 'b2b') {
    const who = buyer?.trim() || `${industry} 공급사를 찾는 기업 고객의 구매 · 조달 담당자`;
    return {
      persona: who,
      topicRule:
        '질문은 이 담당자가 공급사 · 제조사를 찾고 비교 · 선정할 때 묻는 업무 질문이다. 일반 소비자의 구매 질문' +
        '(가성비 · 집에서 쓰기 · 중고 구매 · 자가 설치 등)은 만들지 마라. 요구 스펙 · 인증 · 규격, 납품 실적 · 레퍼런스, ' +
        '양산 · 품질 관리, 단가 · 계약 조건, 기술 지원 · 유지보수 같은 주제를 고르게 다룬다.',
      regionRule: '특정 시 · 구 같은 지역을 질문에 넣지 마라 — 이 시장은 지역이 아니라 고객사로 나뉜다.',
      recommend: `"${industry} 공급사 · 제조사 추천해줘"`,
      label: 'B2B형(기업 고객에게 납품)',
    };
  }
  if (scope === 'national') {
    return {
      persona: '전국의 소비자 · 제품 구매자',
      topicRule: '제품 · 서비스를 알아보고 비교해 고르는 질문을 고르게 다룬다(기능 · 성능, 가격 · 요금, 브랜드 비교, 이용 후기 등).',
      regionRule: '특정 시 · 구 같은 지역을 질문에 넣지 마라 — 전국 어디서나 같은 질문을 한다.',
      recommend: `"${industry} 브랜드 추천해줘"`,
      label: '전국형(전국 소비자)',
    };
  }
  return { persona: '실제 소비자', topicRule: '', regionRule: '', recommend: `"${region} ${industry} 추천해줘"`, label: '지역형(동네 손님)' };
}

/** 사용자 메시지의 시장 범위 줄 — 지역형은 넣지 않는다(시장 범위 이전과 같은 프롬프트를 그대로 쓴다). */
function scopeLines(scope: MarketScope | undefined, guide: ScopeGuide): string {
  if (!scope || scope === 'local') return '';
  return `
시장 범위: ${guide.label}
질문하는 사람: ${guide.persona}`;
}

function styleRule(language: QuestionLanguage | undefined): string {
  if (language === 'en') {
    return `질문 text는 반드시 영어로 쓴다. 한국에서 시술·수술을 알아보는 외국인 환자가 ChatGPT 같은 AI에 실제로 입력할 법한
   자연스러운 구어체 영어로 작성한다(설문 문항 같은 딱딱한 문체 금지). 위 예시는 의도만 참고하고 영어로 바꿔 쓴다.
   지역은 영어 지명으로 쓴다(예: 서울 강남 → Gangnam, Seoul). 지역 표기 뒤 괄호 꼬리표는 측정 구분용이니 질문에 넣지 마라.
   topic만은 한국어 명사구로 둔다.`;
  }
  return '질문 문체는 실제 사용자 입력처럼 구어체, 오탈자 없는 자연스러운 한국어로 작성한다. 설문 문항 같은 딱딱한 문체 금지.';
}

export interface QuestionBankRequest {
  industry: string;
  region: string;
  brandName: string;
  competitorNames: string[];
  count: number; // 예: 100
  version: string; // 예: '2026-09-01' — 버저닝 기준
  previousVersionDiffNote?: string; // 이전 버전 대비 변경 사유(있으면 회귀분석에 사용)
  language?: QuestionLanguage; // 없으면 한국어
}

/**
 * B1 — 질문 프롬프트 빌더.
 * 카테고리 무관(브랜드명 미언급) 질문 비중을 강제해 "프롬프트하지 않아도 언급되는가"를 측정한다.
 */
/** 전체 count 중 category-agnostic이 최소 60%가 되도록 한 개수. */
export function agnosticQuota(count: number): number {
  return Math.max(1, Math.ceil(count * 0.6));
}

/**
 * 구매 여정 단계별 최소 개수 — learn(탐색)의 하한.
 *
 * 왜 하한이 필요한가: 전에는 "세 단계가 모두 나오게 한다"고만 적었더니 LLM이 추천형(consider)으로
 * 쏠렸다. 스테이,머뭄 v3 실측은 탐색 3 · 비교 26 · 결정 7이었고, 그 3개로 낸 탐색 언급률 0.0%는
 * "세 번 다 안 나왔다"는 뜻일 뿐 통계로 쓸 수 없는 값이었다.
 *
 * 탐색은 **신규 고객이 들어오는 입구**다(아직 후보를 모르는 사람이 기준·시세를 묻는 자리).
 * 여기서 안 보이면 비교 단계 후보 목록에 아예 못 드는데, 표본이 3개면 그 사실을 측정하지 못한다.
 * 20%를 하한으로 둔다 — 36문항이면 8개, 그 정도면 비율이 흔들려도 방향은 읽힌다.
 * decide는 브랜드명이 들어간 질문이 자연히 채우므로 따로 하한을 두지 않는다.
 */
export function learnQuota(count: number): number {
  return Math.max(1, Math.ceil(count * 0.2));
}

export function countAgnostic(questions: Pick<QuestionSpec, 'category'>[]): number {
  return questions.filter((q) => q.category === 'category-agnostic').length;
}

/** 상호·별칭이 본문에 들어 있는지. 카테고리 무관 승격 가능 여부를 코드로 판정할 때 쓴다. */
export function questionMentionsName(text: string, names: string[]): boolean {
  return names.some((name) => name.length > 0 && text.includes(name));
}

/**
 * LLM이 카테고리 태그를 잘못 달아도, 브랜드·경쟁사명이 없는 질문은 category-agnostic으로 승격한다.
 * 프롬프트 재시도만으로는 60% 하한을 자주 못 맞추기 때문에 저장 직전에 한 번 더 강제한다.
 */
export function enforceAgnosticQuota(
  questions: QuestionSpec[],
  quota: number,
  names: string[],
): QuestionSpec[] {
  const next = questions.map((question) => ({ ...question }));
  for (const question of next) {
    if (question.category === 'category-agnostic') question.containsBrandName = false;
  }

  let agnostic = countAgnostic(next);
  for (const question of next) {
    if (agnostic >= quota) break;
    if (question.category === 'category-agnostic') continue;
    if (questionMentionsName(question.text, names)) continue;
    question.category = 'category-agnostic';
    question.containsBrandName = false;
    agnostic += 1;
  }
  return next;
}

export function buildQuestionBankPrompt(req: QuestionBankRequest): PromptMessage {
  const { industry, region, brandName, competitorNames, count, version } = req;
  const agnosticCount = agnosticQuota(count);
  const brandedCount = count - agnosticCount;
  const learnCount = learnQuota(count);

  const system = `당신은 AEO(Answer Engine Optimization) 리서치 설계자입니다.
목표는 실제 소비자가 ChatGPT/Perplexity 같은 AI 검색·비서 서비스에 입력할 법한 "자연스러운" 질문 은행을 만드는 것입니다.
이 질문들은 이후 4개 LLM 엔진에 그대로 입력되어, 특정 브랜드가 "요청받지 않아도" 얼마나 자연스럽게 언급되는지를 측정하는 데 쓰입니다.

★ 가장 중요한 제약 — 반드시 지켜라:
전체 ${count}개 중 **정확히 ${agnosticCount}개**는 category-agnostic 이어야 한다.
category-agnostic = 브랜드명(${brandName})도, 어떤 경쟁사명도, 특정 업체명도 전혀 포함하지 않는 일반 질문.
   예: "${industry} 추천해줘", "${region}에서 ${industry} 고를 때 뭘 봐야 해?", "${industry} 후기 좋은 곳 알려줘"
이것이 이 측정의 핵심이다("이름을 대지 않아도 브랜드가 등장하는가"). 이 개수를 못 맞추면 측정 자체가 무의미하다.
나머지 **${brandedCount}개**만 아래 브랜드/특정 지목 카테고리로 배분한다.

그 밖의 규칙:
1. 나머지 ${brandedCount}개는 brand-direct(브랜드 직접), comparison(비교), price-spec(가격/스펙),
   troubleshooting-review(후기/문제해결), local-regional(지역 특화)로 고르게 분배한다.
   — brand-direct/comparison에는 브랜드명이나 경쟁사명이 들어가도 된다.
2. category-agnostic 질문에는 어떤 상호·브랜드명도 절대 넣지 마라(containsBrandName=false).
3. ${styleRule(req.language)}
4. 특정 브랜드에 유리하거나 불리하게 유도하는 질문(답을 암시하는 질문)은 금지한다.
5. 같은 의도의 질문을 표현만 바꿔 중복 생성하지 않는다 (의도 다양성 확보).
6. 출력 전에 category가 "category-agnostic"인 원소가 정확히 ${agnosticCount}개인지 직접 세어 확인하라.
7. 각 질문에 구매 여정 단계 stage를 하나 매긴다 — learn(탐색: 기준·개념을 묻는다),
   consider(비교: 후보를 고르거나 비교한다, 추천·순위·A vs B), decide(결정: 가격·예약·후기 등 선택 직전 확인).
   브랜드명 포함 여부와 무관하게 문장의 의도로 판단한다.
   **learn은 최소 ${learnCount}개**를 만든다(전체의 20%). 추천형(consider)으로 쏠리기 쉬운데, 탐색은
   아직 후보를 모르는 신규 고객이 들어오는 입구라 표본이 적으면 그 구간을 측정할 수 없다.
   learn 예: "${region} ${industry} 고를 때 뭘 먼저 봐야 해?", "${industry} 보통 얼마쯤 해?",
   "${industry} 예약 전에 확인할 게 뭐야?" — 특정 업체를 묻지 않고 **기준·시세·절차**를 묻는 질문이다.
8. 각 질문에 콘텐츠 주제 topic을 하나 매긴다 — 질문의 **내용**으로 묶는 이름이다(형태가 아니다).
   전체가 4~7개 주제로 묶이게 하고, 한국어 명사구로 12자 이내로 쓴다. 예: "눈 성형", "가격·비용", "회복·부작용".
   "기타"·"일반"처럼 뭉뚱그린 이름과 질문 하나짜리 주제는 만들지 마라.
9. 출력은 아래 JSON 스키마를 따르는 배열만 반환한다. 설명, 마크다운, 코드블록 금지.

JSON 스키마 (배열의 각 원소):
{
  "questionId": string,        // "${version}-{순번3자리}"
  "text": string,
  "category": "category-agnostic" | "brand-direct" | "comparison" | "price-spec" | "troubleshooting-review" | "local-regional",
  "stage": "learn" | "consider" | "decide",
  "topic": string,             // 콘텐츠 주제(4~7개 안에서 재사용)
  "containsBrandName": boolean
}`;

  const user = `업종: ${industry}
지역: ${region}
측정 대상 브랜드: ${brandName}
주요 경쟁사: ${competitorNames.join(', ')}
버저닝 태그: ${version}
${req.previousVersionDiffNote ? `이전 버전 대비 참고사항: ${req.previousVersionDiffNote}` : ''}

위 조건에 맞는 질문 ${count}개를 생성하라.`;

  return { system, user };
}


export interface StageTopUpRequest {
  industry: string;
  region: string;
  /** 이미 은행에 있는 질문 원문 — 같은 의도를 다시 만들지 않게 그대로 보여 준다. */
  existingTexts: string[];
  /** 만들 개수. */
  count: number;
  /** 새 질문에 붙일 questionId 접두(= 은행 버전). */
  version: string;
  /** 다음 순번 — 기존 최대 순번 + 1. */
  startIndex: number;
}

/**
 * B1-보강 — 기존 은행에 **탐색(learn) 질문만** 덧붙인다.
 *
 * 은행을 통째로 다시 만들면 기존 문항이 바뀌어 주차 간 비교가 끊긴다. 탐색 표본이 모자랄 때는
 * 있는 질문을 그대로 두고 부족한 단계만 채우는 편이 낫다 — 기존 questionId가 그대로 남으므로
 * 지난 주차 판정 레코드도 계속 유효하다.
 *
 * 새 질문은 전부 category-agnostic이다. 탐색은 정의상 특정 업체를 아직 모르는 자리라
 * 상호가 들어가면 그 단계가 아니게 된다.
 */
export function buildStageTopUpPrompt(req: StageTopUpRequest): PromptMessage {
  const { industry, region, existingTexts, count, version, startIndex } = req;
  const system = `당신은 AEO 리서치 설계자입니다. 기존 질문 은행에 **탐색(learn) 단계 질문만** ${count}개 덧붙입니다.

탐색(learn)의 정의 — 아직 어떤 업체를 고를지 모르는 사람이 묻는 것:
- 고를 때의 **기준**: "${region} ${industry} 고를 때 뭘 먼저 봐야 해?"
- **시세·비용 구조**: "${industry} 보통 얼마쯤 해?", "성수기랑 비수기 차이 커?"
- **절차·주의점**: "예약 전에 뭘 확인해야 해?", "환불 규정 보통 어떻게 돼?"
- **개념·차이**: "A형이랑 B형이 뭐가 달라?"

탐색이 **아닌** 것(만들지 마라):
- "추천해줘", "어디가 좋아", "어디 있어" → 후보를 고르는 비교(consider)다.
- 특정 상호를 묻는 질문 → 결정(decide)이다.

규칙:
1. ${count}개 전부 stage="learn", category="category-agnostic", containsBrandName=false.
2. 어떤 상호·브랜드명도 넣지 마라.
3. 아래 "이미 있는 질문"과 **같은 의도를 다시 만들지 마라**. 표현만 바꾼 중복 금지.
4. 실제 사용자가 AI에게 입력할 법한 구어체 한국어. 설문 문항 같은 딱딱한 문체 금지.
5. questionId는 "${version}-{순번3자리}"이며 순번은 ${startIndex}부터 1씩 증가한다.
6. topic은 질문의 내용으로 묶는 한국어 명사구 12자 이내(예: "가격·비용", "예약·절차", "숙소 고르는 기준").
7. 출력은 JSON 배열만. 설명·마크다운·코드블록 금지.

JSON 스키마 (배열의 각 원소):
{
  "questionId": string,
  "text": string,
  "category": "category-agnostic",
  "stage": "learn",
  "topic": string,
  "containsBrandName": false
}`;

  const user = `업종: ${industry}
지역: ${region}
만들 개수: ${count}

이미 있는 질문(중복 금지):
${existingTexts.map((t) => `- ${t}`).join('\n')}`;

  return { system, user };
}

export interface CohortQuestionBankRequest {
  industry: string;
  region: string;
  /** 코호트 브랜드의 이름·별칭 — 질문에 들어가면 안 되는 이름 목록. */
  excludedNames: string[];
  /** 만들 일반 질문 수(= 코호트 브랜드의 category-agnostic 몫). */
  count: number;
  /** 탐색(learn) 질문 하한. 브랜드 은행과 같은 기준(전체 문항의 20%)을 그대로 쓴다. */
  learnMin: number;
  /** questionId 접두 — 코호트 은행 버전(예: c1). */
  version: string;
  previousVersionDiffNote?: string;
  language?: QuestionLanguage;
  /** 없으면 지역형. */
  marketScope?: MarketScope;
  /** B2B형의 구매자 — 질문하는 사람이 된다. */
  buyer?: string;
}

/**
 * B1-코호트 — 같은 코호트(업종·지역)의 브랜드가 **함께 쓰는** 일반 질문만 만든다.
 *
 * 왜 따로 만드나. 브랜드마다 은행을 만들면 일반 질문도 브랜드마다 달라져(실측: 통신 5사 22문항,
 * 10개 조합 모두 겹침 0개) 언급률·SoM 차이가 가시성 차이인지 질문 차이인지 가릴 수 없다.
 * 브랜드 이름을 주고 만들면 질문이 그 브랜드의 주력 분야로 기운다(KT는 가정용 인터넷 속도,
 * 세종텔레콤은 기업용 전용회선) — 그래서 여기에는 **업종·지역만** 준다.
 */
export function buildCohortQuestionBankPrompt(req: CohortQuestionBankRequest): PromptMessage {
  const { industry, region, excludedNames, count, learnMin, version } = req;
  const guide = scopeGuide(req.marketScope, industry, region, req.buyer);

  const system = `당신은 AEO(Answer Engine Optimization) 리서치 설계자입니다.
목표는 ${guide.persona}가 ChatGPT/Perplexity 같은 AI 검색·비서 서비스에 입력할 법한 "자연스러운" 일반 질문을 만드는 것입니다.
이 질문들은 같은 업종·지역의 여러 브랜드가 **똑같이** 받는 공통 시험지입니다. 어떤 브랜드가 "이름을 대지 않아도" AI 답변에 나오는지 비교하는 데 쓰입니다.

★ 가장 중요한 제약:
1. 정확히 ${count}개를 만든다. 전부 category-agnostic이다.
2. 어떤 상호·브랜드명·업체명도 넣지 마라(containsBrandName=false). 특히 아래 이름은 절대 넣지 마라:
   ${excludedNames.join(', ') || '(없음)'}
3. 특정 브랜드의 주력 상품·강점 쪽으로 치우치지 마라. ${guide.topicRule || '이 업종의 소비자가 흔히 묻는 주제를 고르게 다룬다.'}${guide.regionRule ? `\n   ${guide.regionRule}` : ''}

그 밖의 규칙:
4. ${styleRule(req.language)}
5. 특정 브랜드에 유리하거나 불리하게 유도하는 질문(답을 암시하는 질문)은 금지한다.
6. 같은 의도의 질문을 표현만 바꿔 중복 생성하지 않는다 (의도 다양성 확보).
7. 각 질문에 구매 여정 단계 stage를 하나 매긴다 — learn(탐색: 기준·개념을 묻는다),
   consider(비교: 후보를 고르거나 비교한다, 추천·순위·A vs B), decide(결정: 가격·예약·후기 등 선택 직전 확인).
   **learn은 최소 ${learnMin}개**를 만든다. 추천형(consider)도 포함한다 — ${guide.recommend}처럼
   후보를 고르는 질문에서 어떤 브랜드가 불리는지가 이 측정의 핵심이다.
8. 각 질문에 콘텐츠 주제 topic을 하나 매긴다 — 질문의 **내용**으로 묶는 이름이다(형태가 아니다).
   전체가 4~7개 주제로 묶이게 하고, 한국어 명사구로 12자 이내로 쓴다. "기타"·"일반" 같은 이름은 만들지 마라.
9. 출력은 아래 JSON 스키마를 따르는 배열만 반환한다. 설명, 마크다운, 코드블록 금지.

JSON 스키마 (배열의 각 원소):
{
  "questionId": string,        // "${version}-{순번3자리}"
  "text": string,
  "category": "category-agnostic",
  "stage": "learn" | "consider" | "decide",
  "topic": string,
  "containsBrandName": false
}`;

  const user = `업종: ${industry}
지역: ${region}${scopeLines(req.marketScope, guide)}
버저닝 태그: ${version}
${req.previousVersionDiffNote ? `이전 시도 참고사항: ${req.previousVersionDiffNote}` : ''}

위 조건에 맞는 일반 질문 ${count}개를 생성하라.`;

  return { system, user };
}

export interface BrandQuestionBankRequest {
  industry: string;
  region: string;
  brandName: string;
  competitorNames: string[];
  /** 만들 브랜드 전용 질문 수(= 전체 문항 − 코호트 공통 일반 질문). */
  count: number;
  version: string;
  previousVersionDiffNote?: string;
  language?: QuestionLanguage;
  /** 없으면 지역형. */
  marketScope?: MarketScope;
  buyer?: string;
}

/**
 * B1-브랜드 — 코호트 공통 일반 질문을 쓰는 브랜드의 **브랜드 전용 질문만** 만든다
 * (브랜드 직접·비교·가격·후기·지역). 일반 질문은 코호트 은행이 대신한다.
 */
export function buildBrandQuestionBankPrompt(req: BrandQuestionBankRequest): PromptMessage {
  const { industry, region, brandName, competitorNames, count, version } = req;
  const guide = scopeGuide(req.marketScope, industry, region, req.buyer);
  // 지역형만 지역 특화 질문을 만든다. 전국형 · B2B형은 그 몫을 다른 질문 종류에 나눠 담는다 — 새 질문 종류를
  // 만들지 않아 집계 · 보고서는 그대로다.
  const distribution =
    req.marketScope === 'b2b'
      ? `brand-direct(브랜드 직접), comparison(비교), price-spec(가격/스펙), troubleshooting-review(후기/문제해결)로 고르게 분배한다.
   local-regional(지역 특화)은 만들지 않는다 — 이 시장은 지역이 아니라 고객사로 나뉜다.
   price-spec에는 단가 · 계약 조건 · 인증 · 규격을, troubleshooting-review에는 납품 실적 · 레퍼런스 · 품질 · 기술 지원 평가를 담는다.`
      : req.marketScope === 'national'
        ? `brand-direct(브랜드 직접), comparison(비교), price-spec(가격/스펙), troubleshooting-review(후기/문제해결)로 고르게 분배한다.
   local-regional(지역 특화)은 만들지 않는다 — 전국 시장이다. price-spec에는 요금 · 가격 · 제품 라인업을 담는다.`
        : `brand-direct(브랜드 직접), comparison(비교), price-spec(가격/스펙), troubleshooting-review(후기/문제해결),
   local-regional(지역 특화)로 고르게 분배한다.`;

  const system = `당신은 AEO(Answer Engine Optimization) 리서치 설계자입니다.
목표는 ${guide.persona}가 ChatGPT/Perplexity 같은 AI 검색·비서 서비스에 입력할 법한 "자연스러운" 질문을 만드는 것입니다.
이번에는 **브랜드를 지목하는 질문만** 만든다. 브랜드 이름 없는 일반 질문은 따로 준비되어 있으니 만들지 마라.

★ 가장 중요한 제약:
1. 정확히 ${count}개를 만든다. category-agnostic은 하나도 만들지 않는다.
2. ${distribution}
3. 모든 질문에 측정 대상 브랜드명(${brandName})이 들어간다(containsBrandName=true). comparison에는 경쟁사명이 함께 들어가도 된다.

그 밖의 규칙:
4. ${styleRule(req.language)}
5. 특정 브랜드에 유리하거나 불리하게 유도하는 질문(답을 암시하는 질문)은 금지한다.
6. 같은 의도의 질문을 표현만 바꿔 중복 생성하지 않는다.
7. 각 질문에 구매 여정 단계 stage를 하나 매긴다 — learn / consider / decide(정의는 문장의 의도로 판단).
8. 각 질문에 콘텐츠 주제 topic을 하나 매긴다(한국어 명사구 12자 이내).
9. 출력은 아래 JSON 스키마를 따르는 배열만 반환한다. 설명, 마크다운, 코드블록 금지.

JSON 스키마 (배열의 각 원소):
{
  "questionId": string,        // "${version}-{순번3자리}"
  "text": string,
  "category": "brand-direct" | "comparison" | "price-spec" | "troubleshooting-review" | "local-regional",
  "stage": "learn" | "consider" | "decide",
  "topic": string,
  "containsBrandName": true
}`;

  const user = `업종: ${industry}
지역: ${region}${scopeLines(req.marketScope, guide)}
측정 대상 브랜드: ${brandName}
주요 경쟁사: ${competitorNames.join(', ')}
버저닝 태그: ${version}
${req.previousVersionDiffNote ? `이전 시도 참고사항: ${req.previousVersionDiffNote}` : ''}

위 조건에 맞는 브랜드 전용 질문 ${count}개를 생성하라.`;

  return { system, user };
}
