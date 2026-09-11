# Brand AEO Visibility 파이프라인 — 프롬프트 설계

원본: `Visibility 측정 파이프라인 B1~B8` (질문 생성 → 엔진 연동 → 다각도 분석 → 스코어·리포트)

코드: [`src/prompts/`](../src/prompts)

## 1. 어떤 단계가 "프롬프트"이고 어떤 단계가 "코드"인가

| 단계 | LLM 프롬프트 필요 | 비고 |
|---|---|---|
| B1 질문 프롬프트 빌더 | ✅ | 질문 은행 자체를 LLM으로 생성 |
| B2 스케줄러 | ❌ | 순수 인프라 (주 1회 cron, 큐잉) |
| B3 모델별 어댑터 | ✅ | 4개 엔진에 동일 질문을 보낼 때의 시스템 프롬프트 차이 |
| B4 응답 정규화 | 부분 ✅ | URL/마크다운 등은 코드(정규식)로, "URL 없는 출처 언급"만 LLM 보조 |
| B5-A 브랜드 언급 탐지 | ✅ | 판정용 LLM(심판 모델) 사용 |
| B5-B 인용 URL 탐지 | ✅ | 출처 소유권 분류 |
| B5-C 추천 순서·SoM | 부분 ✅ | 암묵적 순위 판정만 LLM, SoM 수치 자체는 결정적 계산 |
| B5-D Fact Graph 사실성 | ✅ | 브랜드 관련 주장만 검증 |
| B8 스코어 & 리포트 | 부분 ✅ | 스코어 산식은 결정적 계산, 내러티브 리포트만 LLM |

## 2. 설계 원칙과 프롬프트 설계의 관계

슬라이드의 설계 원칙 — *"LLM 응답은 비결정적이므로 동일 질문을 엔진당 3회 반복 호출하고, 지표는 반복 평균과 95% 신뢰구간으로 산출"* — 은 두 군데에 영향을 준다.

1. **B3 (수집)**: 같은 `questionText`로 엔진당 반복 호출. 어댑터 시스템 프롬프트는 매 호출 동일해야 함 — 여기서 프롬프트를 바꾸면 반복 호출의 의미(같은 조건에서의 분산 측정)가 깨진다.
2. **B5 (분석)**: 판정용 LLM은 수집용 4개 엔진과 **분리된 고정 모델 1개**를 쓸 것을 권장. 분석 모델까지 매번 바뀌거나 여러 개면, "주간 지표 변동"에 수집 대상의 변화와 분석기 자체의 변동이 뒤섞여 원인 분리가 불가능해진다.

### 2-1. 반복 3회 → 1회, 문항 12 → 36 (질문 은행 v3)

반복 횟수를 실측으로 다시 정했다. 저장된 측정 **1,376개 셀**(브랜드 × 주차 × 엔진 × 질문)에서
언급 판정의 분산을 분해한 결과:

| | 값 |
|---|---|
| 질문 간 분산 σ²_b | 0.1671 |
| 반복 내 분산 σ²_w | 0.0383 |
| ICC = σ²_b / (σ²_b + σ²_w) | **0.814** |

**분산의 81%가 질문 간이고, 반복으로는 그 부분이 줄지 않는다.** 고정 예산에서 추정치의
분산은 `σ²_b/k + σ²_w/(k·m)`(k=문항, m=반복)이므로 k를 늘리는 쪽만 첫 항을 줄인다.

같은 36호출 안에서의 언급률 표준오차:

| 배분 | SE |
|---|---|
| 12문항 × 3회 (옛 기본) | 14.99%p |
| 18문항 × 2회 | 13.01%p |
| **36문항 × 1회 (현재)** | **9.66%p** |
| 9문항 × 4회 | 17.16%p |

한계 효율로는 호출 1개를 반복에 쓰면 SE가 0.017%p 줄고 문항에 쓰면 0.245%p 줄어, **문항이
14배 효율적이다.**

**비결정성 측정은 잃지 않는다.** 반복은 정밀도 장치이기만 한 게 아니라 이 원칙이 말하는
비결정성 자체를 재는 장치였다(실측 합성 표준편차 19.6%p — 다섯 번에 한 번 판정이 뒤집힌다).
그런데 그건 **매 측정마다 낼 비용이 아니라 주기적으로 재는 상수**다. 모델이나 프롬프트가
바뀔 때 다시 재면 된다. 그 역할은 `scripts/nondeterminism-probe.ts`가 맡는다.

그리고 그 도구는 반복보다 **나은 계측기**다. 반복은 수집과 판정을 한 덩어리로 다시 돌려
두 노이즈가 섞였지만, 이 도구는 나눠 잰다.

| 모드 | 무엇을 재나 | 실측 (torder, 카테고리 무관 20개 × 3회) |
|---|---|---|
| `--judge` | 같은 응답 원문을 다시 판정 → 판정 노이즈만 | σ = **12.9%p** (20셀 중 1셀 뒤집힘, 언급률 62%) |
| `--collect` | 같은 질문을 다시 수집·판정 → 합성 노이즈 | 기준선 σ = 19.6%p |

차이로 수집 자체의 기여를 어림하면 σ²_collect ≈ 0.0383 − 0.0167 = 0.0216 (σ ≈ 14.7%p).
수집 호출에는 `googleSearch` 그라운딩이 붙으므로 이 부분은 모델 샘플링만이 아니라
**검색이 가져오는 문서가 매번 달라지는 것**까지 포함한다. 판정 노이즈가 12.9%p로 작지 않다는
것도 함께 드러났다 — 온도가 코드에 고정돼 있지 않다.

주의: 0/1 판정의 반복 내 분산은 상한이 p(1-p)다. 언급률이 0%나 100%에 붙은 브랜드·주차로
재면 σ가 구조적으로 0에 가까워지므로 "노이즈가 없다"로 읽으면 안 된다. 도구가 이 경우를
경고한다.

**주의 — 이 변경은 척도를 갈아치운다.** 질문이 달라지면 언급률·SoM의 모집단이 바뀌어 같은
브랜드라도 값이 움직인다. 그래서 질문 은행 버전을 올려 옛 집합을 보존하고(`v1` 12문항 ·
`v2` 18문항 · `v3` 36문항), 스코어카드에 `questionBankVersion`을 기록한다. 버전이 다른 주차
사이의 점수 비교는 "같은 척도로 잰 값"이 아니다.

## 3. 카테고리 무관 질문 비중 (B1)

AEO의 핵심은 "브랜드명을 프롬프트하지 않아도 언급되는가"이다. 그래서 [`buildQuestionBankPrompt`](../src/prompts/b1-question-bank.ts)는 `category-agnostic` 질문(브랜드명 미포함)을 전체의 60% 이상으로 강제한다. 이 비율이 낮으면 "물어보니까 답했다"만 측정하게 되어 AEO score가 실제 가시성과 괴리된다.

버저닝(B1 요구사항)은 `version` 필드로 질문 은행 배치를 태깅하고, 이전 버전과의 diff 노트를 다음 생성 프롬프트에 넣어 회귀 원인 분석에 사용한다.

## 4. 판정 스키마가 분리된 이유 (B5-A/B/C/D)

하나의 거대 프롬프트로 "언급+인용+순위+사실성"을 한 번에 시키지 않고 4개로 쪼갠 이유:

- 각 판정은 서로 다른 근거 자료가 필요하다 (B5-B는 도메인 목록, B5-D는 Fact Graph) — 프롬프트가 커질수록 무관한 컨텍스트가 판정 정확도를 떨어뜨린다.
- 실패 격리: Fact Graph가 비어 있는 신규 테넌트는 B5-D만 건너뛰고 나머지는 정상 산출 가능해야 한다.
- 재시도 비용: 한 항목만 파싱 실패해도 전체를 재호출하지 않도록 단위를 작게 유지한다.

SoM(Share of Mention)과 언급 카운트 자체는 프롬프트 출력이 아니라 [`b5c-recommendation-order.ts`](../src/prompts/b5c-recommendation-order.ts) 상단 주석처럼 B5-A 결과로부터 **결정적으로 계산**한다. LLM에게 "몇 % 점유율인지" 계산을 맡기면 반복 호출 간 산술 오차까지 노이즈에 더해진다.

## 5. B8: 무엇을 LLM에 맡기지 않았는가

AEO Score(가중합), MA4, 95% CI, 코호트 랭킹은 전부 애플리케이션 코드에서 계산해 [`WeeklyScorecard`](../src/prompts/b8-report.ts)로 확정한 뒤 리포트 프롬프트에 **입력으로만** 전달한다. `buildWeeklyReportPrompt`의 시스템 프롬프트가 "주어진 수치 외에는 새로 만들어내지 말라"고 명시하는 이유는, 리포트 생성 단계에서 숫자가 재계산·왜곡되면 스코어의 신뢰구간 설계 자체가 무의미해지기 때문이다.

## 6. 구현 시 주의 (보안)

이 프롬프트들은 OpenAI/Gemini/Claude/Perplexity API 키를 사용하므로 **브라우저(React 앱)에서 직접 호출하면 안 된다**. 현재 저장소는 프론트엔드 전용 Vite 스캐폴드이므로, 실제 호출은 별도 백엔드/서버리스 함수에서 이 프롬프트 빌더들을 import해 실행하고, React 앱은 그 백엔드가 계산한 `WeeklyScorecard` 등 결과만 받아 시각화하는 구조를 권장한다.

## 7. 예상 호출량과의 정합성

설계 최대치는 100문항 × 4엔진 × 3회 = 1,200콜(B3, 수집)이지만, **실제 기본값은 비용 캡을
적용한 36문항 × 1회**다(`docs/architecture-option-c.md` 참고). Gemini 단독이면 브랜드당 수집
36콜 + 판정 약 95콜이다.

반복을 쓰는 설정에서는 분석 단계가 반복분의 평균 텍스트가 아니라 **각 반복을 독립적으로
판정**한 뒤 그 판정 결과들을 평균·CI 처리해야 한다. (하나로 합쳐 요약한 뒤 분석하면 반복
측정의 통계적 의미가 사라진다.) 기본값은 반복 1회라 이 주의는 반복을 다시 올릴 때 적용된다.

## 8. B2 스케줄러 + 백엔드 골격

코드: [`server/`](../server)

```
server/
  index.ts        Express 진입점 — /health, POST /pipeline/run/:tenantId(수동 트리거), GET /scorecards/:tenantId
  scheduler.ts     B2 — node-cron 주 1회(기본 매주 월 03:00, PIPELINE_CRON로 변경 가능)
  pipeline.ts      B1~B8 오케스트레이션 (ensureQuestionBank → collectRawCalls → analyzeRawCall → aggregateScorecard)
  scoring.ts       AEO Score 가중합, 95% CI(표본 수에 따라 t-분포 임계값 또는 z=1.96), MA4, 코호트 랭킹 — 전부 결정적 계산
  (도구) scripts/nondeterminism-probe.ts  비결정성을 주기적으로 재는 계측기(--judge / --collect)
  store.ts         ResultStore 인터페이스 + FileResultStore(로컬 JSON). 실배포 시 DB 어댑터로 교체 가능
  engines/         EngineClient 인터페이스. 지금은 Mock만 존재, 실제 SDK는 index.ts의 TODO 지점에 연결
  config.ts        server/tenants.config.json에서 테넌트(업종/지역/브랜드/경쟁사/Fact Graph) 로드
  analysisTypes.ts B5 프롬프트의 JSON 스키마와 1:1 대응하는 타입 (프롬프트 스키마를 바꾸면 여기도 같이 바꿀 것)
```

**현재 상태**: 4개 엔진(`openaiEngineClient.ts`, `geminiEngineClient.ts`, `claudeEngineClient.ts`, `perplexityEngineClient.ts`) 모두 실제 SDK로 연동되어 있다. `.env`에 `OPENAI_API_KEY`/`GEMINI_API_KEY`/`ANTHROPIC_API_KEY`/`PERPLEXITY_API_KEY`를 채우면 바로 동작한다. `USE_MOCK_ENGINES=true`로 두면 목(mock) 엔진으로 되돌아가 API 키 없이 배선만 검증할 수 있다.

- OpenAI: Responses API(`responses.create`) + `web_search` 도구, `output`의 `web_search_call`/`message.annotations`에서 사용 여부·인용 URL 추출
- Gemini: `@google/genai`의 `generateContent` + `tools:[{googleSearch:{}}]`, `groundingMetadata.groundingChunks`에서 인용 URL 추출
- Claude: `@anthropic-ai/sdk`의 `messages.create` + `web_search_20250305` 도구(4개 엔진을 동일 조건으로 비교하기 위해 최신 모델 전용 확장 버전 대신 최소 공통 버전 사용), `web_search_tool_result`/`citations`에서 추출
- Perplexity: OpenAI 호환 REST(`baseURL: https://api.perplexity.ai`)라 `openai` SDK를 재사용, 항상 검색이 켜져 있으므로 `search_results`를 그대로 인용으로 사용

각 엔진의 모델명(`OPENAI_MODEL`/`GEMINI_MODEL`/`CLAUDE_MODEL`)은 `.env.example`에 2026-09 기준 추정값으로 넣어뒀다 — 제공사 문서에서 실제 배포 전 반드시 재확인할 것.

**심판 모델 분리**: `getJudgeClient()`는 `getEngineClient()`와 별도 함수로 분리되어 있고, `claudeJudgeClient.ts`가 `JUDGE_MODEL`(기본 `claude-opus-5`)로 고정 구현되어 있다. 4개 수집 엔진과 다른 모델이어야 한다는 2절 원칙을 지킨다. 분석은 이미 주어진 텍스트에 대한 순수 추론이라 웹 검색 도구는 붙이지 않았다.

**설계상 의도적으로 생략한 것**: 인증/멀티테넌트 격리, 재시도·백오프, 레이트리밋 대응(현재는 `mapWithConcurrency`로 동시성만 제한), 실패한 개별 호출의 부분 재실행. 테넌트 수와 실제 트래픽이 정해지면 그때 추가하는 것이 맞다 — 지금 단계에서는 과설계다.

## 9. Brand AEO 메뉴용 API 라우트 (S-02/S-04/S-05/S-07)

[Brand AEO Console 메뉴 설계](https://claude.ai/code/artifact/6770cc65-de1b-42ce-8b46-0a6ccf55a63d)의 화면 4개가 쓰는 라우트. S-01/S-06는 기존 `/api/tenants`, `/api/scorecards/:tenantId`를 그대로 쓴다.

| 화면 | 라우트 | 구현 |
|---|---|---|
| S-02 브랜드 종합 진단 | `GET /api/question-analyses/:tenantId/:weekOf` | [store.ts](../server/store.ts)에 이미 저장된 문장 단위 판정을 그대로 반환 |
| S-04 질문 프롬프트 빌더 | `GET /api/question-bank/:tenantId?version=` | `version` 생략 시 테넌트의 현재 `questionBankVersion` 사용 |
| S-05 URL 상세 분석 | `GET /api/citations/:tenantId/:weekOf` | [queries.ts](../server/queries.ts)에서 도메인×소유권 기준으로 서버 집계 |
| S-07 랭킹 분석 | `GET /api/ranking/:tenantId/:weekOf` | 코호트 순위 + 테넌트 내부 경쟁사 언급 점유율을 한 응답으로 합쳐 반환 |

**QuestionRepeatAnalysis 확장**: S-02/S-05 화면이 문장 원문·어조·인용 도메인을 보여주려면 판정 단계에서 나온 상세가 그대로 남아 있어야 한다. 원래는 `mentioned`/`shareOfMention` 같은 집계값만 저장했는데, B5-A~D가 이미 파싱해둔 `mentionSentences`, `competitorMentions[].sentences`, `citations`, `factualityClaims`를 [types.ts](../server/types.ts)에 추가해 함께 저장하도록 [pipeline.ts](../server/pipeline.ts)의 `analyzeRawCall`을 바꿨다. 집계 로직(`aggregateScorecard`)이 쓰는 요약 필드(`mentioned`, `factualitySupported` 등)는 그대로 두고 상세를 곁들이는 식이라, B8 스코어 계산은 영향받지 않는다.

**S-04의 "새 버전 생성" 액션은 아직 없음**: 지금은 조회 라우트만 추가했다. 질문 은행을 재생성하는 쓰기 라우트(`POST`)는 실제 화면에서 필요해지면 추가하는 것이 맞다 — 지금 붙이면 쓰이지 않는 채로 남을 가능성이 크다.

## 10. S-03 사이트 종합 진단 (aeo-checker-app 통합)

`브랜드 진단 및 분석` 그룹에 추가한, 단일 URL의 AI 검색 대응 준비도를 6개 영역·100점으로 채점하는 화면. 별도 프로젝트 [`aeo-checker-app`](../../aeo-checker-app)의 휴리스틱 채점 엔진을 가져와 통합했다.

- **S-03만 성격이 다르다**: 다른 화면(S-01·S-02·S-04~S-07)은 테넌트(브랜드)의 주간 파이프라인 데이터를 읽는다. S-03은 그와 무관하게 임의의 공개 URL HTML을 즉시 수집해 그 자리에서 채점한다 — 테넌트·주차 개념이 없고, 저장도 하지 않는다.
- **프롬프트 없음**: S-03은 LLM을 쓰지 않는 결정적 휴리스틱 채점이다 (`source: 'heuristic'`). 그래서 `src/prompts/`가 아니라 [`src/lib/aeo/`](../src/lib/aeo)에 격리했다.
- **아키텍처**: 수집(`/api/fetch`)만 서버에서 하고, HTML 파싱(`extractPage`, 브라우저 DOMParser)과 채점(`evaluateAeo`)은 전부 클라이언트에서 돈다. 서버는 원본 HTML만 넘긴다.
- **SSRF 가드**: [`server/aeo/networkSafety.ts`](../server/aeo/networkSafety.ts)가 DNS 해석 결과가 사설 대역이면 수집을 거부한다 (localhost·169.254.169.254 등 차단 확인).
- **의도적 한계 — 정적 수집만**: 원본 앱은 SPA 셸을 puppeteer로 렌더하지만, 여기서는 무거운 브라우저 의존성을 추가하지 않았다. SPA로 의심되면 `renderWarning`으로 알리고 정적 HTML 기준으로만 채점한다. 렌더 수집이 실제로 필요해지면 그때 puppeteer 경로를 추가한다.
- **배포 이중화**: 로컬은 Express `GET /api/fetch`([server/index.ts](../server/index.ts)), 프로덕션은 Vercel 서버리스 [`api/fetch.ts`](../api/fetch.ts) — 기존 `api/*` 패턴과 동일하게 맞췄다.
