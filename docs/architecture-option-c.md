# 아키텍처 C안 — 단일 아시아 리전 서버 + 실 DB + 잡 큐

> 목표: 서버리스(Vercel) + GitHub Actions + "git 커밋을 DB로" 하이브리드를,
> **서울 리전에 상시 떠 있는 단일 서버 + Postgres + 인프로세스 잡 큐**로 통합한다.
> 이번 프로젝트 복잡성의 절반가량(리전 게이트·CI 우회·Blob 큐·비동기 폴링)을 제거하는 것이 핵심 성과다.

---

## 1. 왜 이 구조인가 — 근본 병목 2가지

| 병목 | 지금 증상 | C안이 없애는 방식 |
|---|---|---|
| **미국 리전** | Vercel(iad1)·GitHub 러너가 US → 한국어 브랜드 회상·그라운딩이 헛소리/빈 결과 | **서울 리전**에서 실행 |
| **함수 실행 시간 ~60초** | 측정(테넌트당 ~2분, 코호트 6개 ~15분)이 서버리스에 안 맞음 → GitHub Actions로 떠넘김 | 상시 서버는 **시간 제한 없음** |

### 리전이 품질을 좌우하는 이유 (중요)
그라운딩(Google Search / OpenAI web_search)은 **요청자 geo-IP로 검색 결과를 지역화**한다.
- US IP → 미국·영어 위주 결과 → 한국 로컬 브랜드(성형외과 등)에 헛소리.
- **서울 IP → 한국 로컬 결과 → 정확.**

따라서 백엔드를 서울에 두면 **그라운딩·web_search가 정상화**되어, 지금의 `!VERCEL` 게이트·CI 우회·비동기 dispatch+폴링이 **불필요**해지고, 경쟁사 추론이 **동기적으로 정확**해진다. (제이준류 업종 혼동도 web_search 정상화로 줄어든다.)

> ⚠️ **선검증 권장:** 전체 이전 전에 서울 Fly 인스턴스 하나에서 `inferCompetitors('제이준성형외과','성형외과','서울 강남')`를 돌려 병원이 나오는지 확인. 나오면 C안의 최대 성과가 실측으로 확정된다(저비용 디리스크).

---

## 2. 타깃 토폴로지

```mermaid
flowchart LR
  Browser["브라우저 (React SPA)"] -->|HTTPS| Server
  subgraph SEOUL["Fly.io · icn(서울) 리전"]
    Server["Express API + 정적 SPA 서빙"]
    Worker["잡 워커 (pg-boss)\n측정·추론·삭제 파이프라인"]
    Server <-->|enqueue / status| DB[("Postgres")]
    Worker <-->|read/write| DB
  end
  Worker -->|LLM 호출 (서울발)| LLM["OpenAI / Gemini\n(그라운딩 = 한국 결과)"]
```

- **단일 앱**: 기존 `server/index.ts`(Express)를 그대로 배포. 정적 SPA도 같은 서버가 서빙(단일 오리진 → CORS 불필요) — 또는 프론트만 Vercel 유지(B안과의 혼합도 가능).
- **잡 워커**: 같은 프로세스의 pg-boss 워커, 또는 별도 워커 프로세스(수평 확장 시).
- **DB**: Postgres — Fly Postgres / Neon / Supabase(도쿄·싱가포르 리전).

---

## 3. 데이터 모델 (git·Blob·파일 → DB)

지금 상태 저장소를 전부 DB 테이블로 대체한다.

| 지금 | → C안 |
|---|---|
| `server/tenants.config.json` (베이크) + `tenants.overlay.json` (Blob) | `tenants` 테이블 |
| `src/data/demo-scorecards.json` + `data/<id>/scorecard-history.json` | `scorecards` 테이블 |
| `data/<id>/<week>/question-*.json`, `src/data/live-*.json` | `question_banks`, `question_analyses` 테이블(JSONB) |
| `measure-requests.json` / `delete-requests.json` (Blob 큐) | pg-boss 잡 테이블 |
| `infer-competitors-<slug>.json` (Blob) | `infer_results` 테이블(또는 잡 결과) |

### 스키마(초안)

```sql
create table tenants (
  tenant_id        text primary key,
  brand_name       text not null,
  aliases          text[] not null default '{}',
  owned_domains    text[] not null default '{}',
  industry         text not null,
  region           text not null,
  engines          text[] not null default '{openai,gemini}',
  question_bank_size int not null default 12,
  repeats_per_question int not null default 3,
  question_bank_version text not null default 'v1',
  competitors      jsonb not null default '[]',   -- [{name, aliases[], domains[]}]
  fact_graph       jsonb not null default '[]',
  cohort_only      boolean not null default false,
  auto_cohort      boolean not null default true,
  created_at       timestamptz not null default now()
);
create index on tenants (industry, region);         -- 코호트 조회
create index on tenants (cohort_only);

create table scorecards (
  tenant_id   text references tenants(tenant_id) on delete cascade,
  week_of     text not null,                         -- ISO 주차 키
  aeo_score   jsonb not null,                        -- {current, ma4, ...}
  cohort_rank jsonb,                                 -- {position, totalTenants}
  som         jsonb,                                 -- competitorShareOfMention
  dimensions  jsonb,                                 -- mention/citation/rank/factuality
  eeat        jsonb,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, week_of)
);
create index on scorecards (week_of);

create table question_banks (
  tenant_id text references tenants(tenant_id) on delete cascade,
  version   text not null,
  questions jsonb not null,
  primary key (tenant_id, version)
);

create table question_analyses (
  tenant_id text references tenants(tenant_id) on delete cascade,
  week_of   text not null,
  analyses  jsonb not null,
  primary key (tenant_id, week_of)
);

create table infer_results (
  slug        text primary key,                      -- slugFromDomain
  pending     boolean not null default true,
  competitors jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);
-- 잡 큐는 pg-boss가 자체 스키마로 관리(pgboss.job 등).
```

---

## 4. 잡 큐·워커 설계 (pg-boss)

**pg-boss** = Postgres 기반 잡 큐(Redis 불필요, 의존성 1개). 내구성·재시도·동시성·크론을 기본 제공 → GitHub Actions concurrency 우회가 통째로 사라진다.

### 잡 종류
| 잡 | 트리거 | 내용 |
|---|---|---|
| `measure` | 랭킹 분석 "이 브랜드 측정", 주간 크론 | 경쟁사 비면 추론→코호트(≤5) 측정→본 브랜드 측정→scorecards 저장 |
| `infer` | 자동 채우기 | `inferCompetitors` 실행 → `infer_results` 저장 (서울발이라 **동기 호출도 가능**, 잡은 선택) |
| `delete` | 브랜드 삭제 | 테넌트 + 고아 경쟁사 삭제(현 cascade 로직 재사용) |

### 동시성·진행
- `boss.work('measure', { teamSize: 1 })` → **직렬화**(git push 경쟁·러너 취소 문제 원천 소멸).
- 주간 자동 측정: `boss.schedule('measure-all', '0 3 * * 1', …)` (크론 내장).
- 진행 상황: 잡 상태가 DB에 있으니 `/api/jobs?tenantId=` 폴링 또는 SSE 스트림 → "측정 상태" 화면이 실시간.

---

## 5. API·프론트 변화 (얇아짐)

| 엔드포인트 | 지금 | C안 |
|---|---|---|
| `POST /api/tenants` | Blob 오버레이/파일 | `insert into tenants` |
| `DELETE /api/tenants` | 큐+GitHub delete.yml dispatch | `delete` 잡 enqueue(즉시 처리 가능) |
| 측정 | measure-requests + GitHub measure.yml | `measure` 잡 enqueue |
| 경쟁사 자동 채우기 | infer.yml dispatch + 폴링 | **동기 `/api/infer?kind=competitors`** (서울 → 정확, ~10-30초) |
| 측정 상태 | GitHub Actions runs 조회 | `pgboss.job` 조회 |

프론트에서 **제거**되는 것: dispatch+폴링 루프, `~1-2분 뒤 표시` 안내, measureVia 분기 상당 부분.

---

## 6. 코드 정리 (제거 / 재사용)

**제거 가능**
- `server/githubMeasure.ts`, `scripts/ci-measure.ts`, `scripts/infer-competitors.ts`
- `.github/workflows/{measure,delete,infer,probe-openai}.yml`
- Blob 계층: `tenantOverlay.ts`, `measureRequests.ts`, `deleteRequests.ts`, `inferResults.ts`
- `brandInference.ts`의 `!VERCEL` 게이트, 주소/경쟁사 로컬 전용 분기
- `BrandOnboarding`의 dispatch+폴링, "측정 시점 추론" 개념
- "측정 = git 커밋 + 재배포", `demo-scorecards.json` 베이킹

**그대로 재사용**
- `server/pipeline.ts`, `server/scoring.ts`, `server/engines/*`
- `brandInference.ts` 핵심 추론 로직(서울 리전이라 **정확해짐**)
- React 프론트(엔드포인트만 새 서버로, 폴링 제거)

---

## 7. 배포 (Fly.io 서울)

- `Dockerfile`(node 22) + `fly.toml`:
  ```toml
  primary_region = "icn"          # 서울
  [http_service]
    internal_port = 3000
    min_machines_running = 1       # 콜드스타트 방지(그라운딩 지연 최소화)
  ```
- `fly postgres create --region icn` (또는 Neon/Supabase 도쿄·싱가포르).
- `fly secrets set GEMINI_API_KEY=… OPENAI_API_KEY=… JUDGE_ENGINE=gemini`.
- CI: GitHub Action은 **배포만**(`flyctl deploy`) — 측정은 더 이상 CI가 안 함.

---

## 8. 이전 계획 (단계별, 무중단 지향)

| 단계 | 작업 | 리스크 |
|---|---|---|
| **0. 선검증** | 서울 Fly 인스턴스에서 `inferCompetitors` 품질 확인 | 낮음 · C안 최대 성과 확정 |
| **1. DB 계층** | 스키마 + 데이터 접근 모듈(`db/*.ts`). 기존 파일/Blob 읽기를 DB로 치환(전환기엔 dual-read) | 중 |
| **2. 잡 워커** | pg-boss 도입, `measure/infer/delete`를 잡으로. 파이프라인은 그대로 호출 | 중 |
| **3. 프론트 전환** | API 베이스를 새 서버로, 폴링·게이트 제거, 동기 추론 | 낮음 |
| **4. 데이터 이관·정리** | 커밋된 scorecards → DB import, GitHub Actions·Blob 폐기 | 중 |

각 단계는 독립 배포 가능하며, 3단계까지 가면 사용자 체감(동기 추론·실시간 진행)이 크게 개선된다.

---

## 9. 비용

| 항목 | 대략 |
|---|---|
| Fly shared-cpu-1x (256–512MB, min 1) | ~$3–7/월 |
| Postgres (Fly dev / Neon·Supabase 무료 티어) | $0–15/월 |
| LLM API | 지금과 동일(리전만 교정, 호출 수 불변) |

> 측정 비용 캡은 그대로 유효: 코호트 측정 `MAX_AUTO_COHORT=5`, 테넌트당 질문 12×반복 3×엔진 2. C안은 이 계수들을 **DB 컬럼/환경변수로** 노출해 브랜드별·전역 튜닝을 쉽게 만든다.

---

## 10. 트레이드오프 / 리스크

- **운영 포인트 +1** (상시 서버·DB) — Hobby "무료·무운영" 대비.
- **단일 리전 가용성** — Fly 머신 2대(또는 리전 2개)로 완화.
- **콜드스타트** — `min_machines_running=1`로 방지(그라운딩 지연 최소화).
- **DB 마이그레이션 작업량** — 4단계가 가장 큼(기존 커밋 데이터 import).
- **리전 가설 의존** — 8단계 0(선검증)으로 먼저 확정할 것.

---

## 11. 한 줄 요약

> 서울 리전 단일 서버 + Postgres + pg-boss로 통합하면, **리전 문제·시간 제한·git-as-DB·CI 우회가 동시에 사라지고**, 경쟁사 추론이 동기적으로 정확해진다. 다만 상시 서버·DB 운영과 데이터 이관이 대가다. **먼저 서울 인스턴스에서 추론 품질을 선검증(0단계)** 한 뒤 1→4단계로 점진 이전을 권장한다.
