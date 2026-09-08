/**
 * 엔진 진단 — "어떤 엔진이 실제로 수집 가능한가"를 엔진당 1회 호출로 확인한다.
 * 키가 설정만 되고 크레딧이 소진된 엔진(예: OpenAI 429)을 측정 전에 미리 구분하는 용도.
 *
 *   npx tsx scripts/smoke-engines.ts            # 4개 수집 엔진 + 판단 엔진
 *   npx tsx scripts/smoke-engines.ts claude      # 특정 엔진만
 *
 * 주의: 실제 API를 호출하므로 소량의 비용이 발생한다(엔진당 1회).
 */
import 'dotenv/config';
import { ClaudeEngineClient } from '../server/engines/claudeEngineClient.js';
import { GeminiEngineClient } from '../server/engines/geminiEngineClient.js';
import { OpenAiEngineClient } from '../server/engines/openaiEngineClient.js';
import { PerplexityEngineClient } from '../server/engines/perplexityEngineClient.js';
import { getJudgeClient } from '../server/engines/index.js';
import type { EngineClient } from '../server/engines/types.js';

const ENGINES: { key: string; label: string; env: string; make: () => EngineClient }[] = [
  { key: 'openai', label: 'ChatGPT', env: 'OPENAI_API_KEY', make: () => new OpenAiEngineClient() },
  { key: 'gemini', label: 'Gemini', env: 'GEMINI_API_KEY', make: () => new GeminiEngineClient() },
  { key: 'claude', label: 'Claude', env: 'ANTHROPIC_API_KEY', make: () => new ClaudeEngineClient() },
  { key: 'perplexity', label: 'Perplexity', env: 'PERPLEXITY_API_KEY', make: () => new PerplexityEngineClient() },
];

const prompt = {
  system: '당신은 한국 소비자에게 업체를 추천하는 도우미입니다. 근거와 함께 간결히 답하세요.',
  user: '서울 강남에서 유명한 성형외과 3곳을 추천해줘.',
};

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const targets = only.length > 0 ? ENGINES.filter((e) => only.includes(e.key)) : ENGINES;

let ok = 0;
let failed = 0;

for (const e of targets) {
  const keySet = Boolean(process.env[e.env]);
  process.stdout.write(`\n[${e.label}] ${e.env}=${keySet ? '설정됨' : '없음/빈값'}\n`);
  if (!keySet) {
    console.log('  → 건너뜀 (측정 시에도 자동 제외됩니다)');
    continue;
  }
  try {
    const r = await e.make().call(prompt);
    ok += 1;
    console.log(
      `  ✓ 수집 성공 — webSearch=${r.usedWebSearch} 인용=${r.citations.length}건 토큰=${r.tokenUsage ?? '?'} ${r.latencyMs ?? '?'}ms`,
    );
    console.log(`    본문: ${r.text.slice(0, 140).replace(/\s+/g, ' ')}…`);
    if (r.citations.length > 0) console.log(`    출처: ${r.citations.slice(0, 3).join(' | ')}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ 수집 실패 — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 판단(심판) 엔진 — 수집과 별개로 분석 단계에서 쓰인다. 여기서 죽으면 측정 전체가 실패한다.
process.stdout.write('\n[판단(judge)] ');
try {
  const judge = getJudgeClient();
  console.log(`해석된 클래스=${judge.constructor.name} (JUDGE_ENGINE=${process.env.JUDGE_ENGINE ?? '미설정'})`);
  const r = await judge.call({ system: 'JSON만 반환하세요.', user: '{"ok":true} 를 그대로 반환하세요.' });
  console.log(`  ✓ 판단 성공 — ${r.text.slice(0, 80).replace(/\s+/g, ' ')}`);
} catch (err) {
  failed += 1;
  console.log(`  ✗ 판단 실패 — ${err instanceof Error ? err.message : String(err)}`);
  console.log('    판단 엔진이 죽으면 측정 전체가 실패합니다. .env에 JUDGE_ENGINE=gemini 등으로 고정하세요.');
}

console.log(`\n요약: 성공 ${ok} · 실패 ${failed}`);
