/**
 * 수집 동시성 상한을 실측한다 — "동시에 몇 개까지 던져도 429가 안 나고, 실제로 빨라지는가".
 *
 * 파이프라인의 COLLECTION_CONCURRENCY(8)·ANALYSIS_CONCURRENCY(8)와 전역 LLM_CONCURRENCY(24)는
 * 추측으로 정한 값이다. 코호트를 병렬로 측정하기 시작하면 같은 모델 쿼터에 몇 배로 몰리므로,
 * 올려도 되는 값인지 여기서 실제 API로 확인한다.
 *
 * 전역 슬롯(concurrency.ts)을 우회하려고 클라이언트를 직접 만든다 — 상한을 재는 도구가
 * 그 상한에 걸리면 안 된다.
 *
 *   npx tsx scripts/quota-probe.ts                 # 8 · 16 · 24 · 32, 단계별 24회 호출
 *   npx tsx scripts/quota-probe.ts 8,16            # 단계 지정
 *   npx tsx scripts/quota-probe.ts 8,16 12         # 단계 지정 + 단계별 호출 수
 *   npx tsx scripts/quota-probe.ts 24,48 48 --judge  # 판정 호출(그라운딩 없음)의 천장
 *
 * --judge를 붙이면 수집 대신 **판정 호출**을 잰다. 두 호출은 성질이 달라 천장도 다르다 —
 * 수집은 googleSearch 그라운딩이 붙어 한 번에 7~8초가 걸리고 서버가 큐에 세우지만,
 * 판정은 검색이 없다. 같은 슬롯을 다투게 두면 수집이 막혀 있는 동안 판정도 함께 대기한다.
 * 예산을 나눌지 판단하려면 판정 쪽 천장을 따로 알아야 한다.
 *
 * 주의: 실제 Gemini 호출이다(기본 4단계 × 24회 = 96회).
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { GeminiEngineClient } from '../server/engines/geminiEngineClient.js';
import { GeminiJudgeClient } from '../server/engines/geminiJudgeClient.js';
import { mapWithConcurrency } from '../server/concurrency.js';
import { buildBrandMentionPrompt, buildEngineCallPrompt } from '../src/prompts/index.js';
import type { PromptMessage } from '../src/prompts/types.js';

const judgeMode = process.argv.includes('--judge');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const levels = (positional[0] ?? '8,16,24,32')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const callsPerLevel = Number(positional[1] ?? 24);

if (levels.length === 0) {
  console.error('단계를 파싱할 수 없습니다. 예: npx tsx scripts/quota-probe.ts 8,16,24')
  process.exit(1)
}

/** 실제 질문 은행의 문항을 쓴다 — 짧은 더미 프롬프트는 지연·토큰이 달라 측정이 왜곡된다. */
function loadQuestions(): string[] {
  const candidates = [
    'src/data/live-question-bank.json',
    'src/data/live-stay-question-bank.json',
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { questions?: { text?: string }[] };
      const texts = (parsed.questions ?? []).map((q) => q.text).filter((t): t is string => Boolean(t));
      if (texts.length > 0) return texts;
    } catch {
      // 다음 후보로
    }
  }
  return ['서울에서 평이 좋은 성형외과를 추천해줘', '국내 태블릿 주문 시스템으로 많이 쓰는 서비스는?'];
}

/** 429(쿼터)인지 — 메시지·상태코드 어디에 들어오든 잡는다. */
function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string };
  if (e?.status === 429 || e?.code === 429) return true;
  const msg = String(e?.message ?? err);
  return /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 판정 프롬프트 — 저장된 실제 응답으로 만든다. 짧은 더미 텍스트로는 입력 토큰이 달라
 * 지연·처리량이 실제 측정과 어긋난다(판정 입력은 응답 전문 1~2KB다).
 */
function loadJudgePrompts(): PromptMessage[] {
  const brand = {
    brandName: "t'order",
    aliases: ['티오더', 'torder'],
    ownedDomains: ['torder.co.kr'],
    competitors: [{ name: '페이히어', aliases: ['페이히어'], domains: ['payhere.in'] }],
    industry: '테이블오더',
    region: '서울 영등포',
  };
  const file = 'data/torder/2026-W37/raw-calls.json';
  if (!existsSync(file)) return [];
  const calls = JSON.parse(readFileSync(file, 'utf8')) as { rawText?: string }[];
  return calls
    .map((c) => c.rawText)
    .filter((t): t is string => Boolean(t))
    .map((rawText) => buildBrandMentionPrompt(brand, rawText));
}

const prompts: PromptMessage[] = judgeMode
  ? loadJudgePrompts()
  : loadQuestions().map((text) => buildEngineCallPrompt('gemini', text));

if (prompts.length === 0) {
  console.error('프롬프트를 만들 재료가 없습니다(--judge는 data/torder/2026-W37/raw-calls.json이 필요).');
  process.exit(1);
}

// 전역 슬롯을 우회하려고 클라이언트를 직접 만든다(위 주석 참고).
const client = judgeMode ? new GeminiJudgeClient() : new GeminiEngineClient();
console.log(
  `${judgeMode ? '판정' : '수집'} 호출 · 모델 ${process.env.GEMINI_MODEL ?? 'gemini-3.7-flash'} · ` +
    `단계 ${levels.join(', ')} · 단계별 ${callsPerLevel}회 · 프롬프트 ${prompts.length}종\n`,
);

interface LevelResult {
  level: number;
  wallSec: number;
  ok: number;
  quota: number;
  other: number;
  p50: number;
  p95: number;
  perSec: number;
}
const rows: LevelResult[] = [];

for (const level of levels) {
  const jobs = Array.from({ length: callsPerLevel }, (_, i) => prompts[i % prompts.length]);
  const started = Date.now();
  let quota = 0;
  let other = 0;
  const latencies: number[] = [];
  const otherMessages: string[] = [];

  await mapWithConcurrency(jobs, level, async (prompt) => {
    try {
      const result = await client.call(prompt);
      latencies.push(result.latencyMs ?? 0);
    } catch (err) {
      if (isQuotaError(err)) quota += 1;
      else {
        other += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (otherMessages.length < 3) otherMessages.push(msg.slice(0, 160));
      }
    }
  });

  const wallSec = (Date.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  rows.push({
    level,
    wallSec: Math.round(wallSec * 10) / 10,
    ok: latencies.length,
    quota,
    other,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    perSec: Math.round((latencies.length / wallSec) * 100) / 100,
  });

  const last = rows[rows.length - 1];
  console.log(
    `동시성 ${String(level).padStart(2)} → ${String(last.wallSec).padStart(6)}초 · ` +
      `성공 ${last.ok}/${callsPerLevel} · 429 ${last.quota} · 기타실패 ${last.other} · ` +
      `호출지연 p50 ${last.p50}ms p95 ${last.p95}ms · 처리량 ${last.perSec}/초`,
  );
  for (const msg of otherMessages) console.log(`     기타실패: ${msg}`);
}

console.log('\n요약 (처리량이 더 안 오르는 지점이 실효 상한이다)');
const base = rows[0];
for (const row of rows) {
  const speedup = base.wallSec > 0 ? Math.round((base.wallSec / row.wallSec) * 100) / 100 : 0;
  console.log(
    `  ${String(row.level).padStart(2)}: ${String(row.wallSec).padStart(6)}초 ` +
      `(${String(speedup).padStart(4)}× vs ${base.level}) · 429 ${row.quota} · 실패 ${row.other}`,
  );
}
