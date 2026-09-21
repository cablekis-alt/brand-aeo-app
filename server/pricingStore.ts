import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateFilePath } from './appPaths.js';

/**
 * 엔진 단가 — **코드가 아니라 파일에 둔다**.
 *
 * 단가를 코드에 박으면 벤더가 가격을 바꾼 뒤에도 화면이 그대로 거짓을 말한다. 오늘 정기진단
 * 보고서의 가중치 표에서 겪은 것과 같은 종류의 사고다. 기본값도 두지 않는다 — 비어 있으면
 * "비용 미설정"으로 보이는 편이, 틀린 기본값으로 그럴듯한 금액을 보여 주는 것보다 낫다.
 *
 * 왜 요청당 요금(perRequest)이 따로 있나. 엔진마다 과금 구조가 다르다. Perplexity는 검색
 * 코퍼스를 입력 토큰으로 받지 않고 요청 수수료로 받는다(실측 W38: 입력이 호출당 114토큰뿐).
 * 토큰만으로 계산하면 그 비용이 통째로 빠진다.
 *
 * 통화는 문자열 꼬리표일 뿐이다. 환율 환산은 하지 않는다 — 환율을 어디서 가져올지, 언제
 * 기준인지가 또 다른 거짓말의 씨앗이 된다. 사용자가 쓰는 통화로 단가를 넣으면 그 통화로 나온다.
 */
export interface EngineRate {
  /** 이 단가가 어느 모델 기준인지. 화면이 그대로 보여 준다 — 모델이 바뀌면 사람이 알아채야 한다. */
  model?: string;
  /** 100만 입력 토큰당 가격. */
  inputPerM?: number;
  /** 100만 출력 토큰당 가격. */
  outputPerM?: number;
  /** 호출 1회당 고정 요금(웹검색 수수료 등). 없으면 0. */
  perRequest?: number;
}

export interface EnginePricing {
  /** 표시용 꼬리표. 'USD' · '원' 무엇이든 사용자가 넣은 그대로 쓴다. */
  currency: string;
  /** 사용자가 마지막으로 손댄 날. 낡은 단가를 화면이 드러내기 위한 값이다. */
  updatedAt: string;
  /** 엔진 id → 단가. 없는 엔진은 "미설정"으로 남는다. */
  engines: Record<string, EngineRate>;
}

const FILE = stateFilePath('engine-pricing.json');

const EMPTY: EnginePricing = { currency: 'USD', updatedAt: '', engines: {} };

export async function readPricing(): Promise<EnginePricing> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const p = parsed as Partial<EnginePricing>;
    return {
      currency: typeof p.currency === 'string' && p.currency.trim() ? p.currency.trim() : 'USD',
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
      engines: p.engines && typeof p.engines === 'object' ? (p.engines as Record<string, EngineRate>) : {},
    };
  } catch {
    // 파일이 없으면 미설정이다. 기본 단가를 만들어 주지 않는다.
    return EMPTY;
  }
}

/** 숫자가 아닌 값·음수는 버린다. 0은 유효하다(요청당 요금 없음을 뜻한다). */
function cleanRate(raw: unknown): EngineRate {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const out: EngineRate = {};
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  const i = num(r.inputPerM);
  const o = num(r.outputPerM);
  const q = num(r.perRequest);
  if (i !== undefined) out.inputPerM = i;
  if (o !== undefined) out.outputPerM = o;
  if (q !== undefined) out.perRequest = q;
  return out;
}

export async function writePricing(input: unknown): Promise<EnginePricing> {
  const p = (input ?? {}) as Partial<EnginePricing>;
  const engines: Record<string, EngineRate> = {};
  for (const [id, raw] of Object.entries(p.engines ?? {})) {
    const rate = cleanRate(raw);
    // 아무 값도 안 남으면 그 엔진은 지운다 — 빈 껍데기를 "설정됨"으로 두지 않는다.
    if (Object.keys(rate).length > 0) engines[id] = rate;
  }
  const next: EnginePricing = {
    currency: typeof p.currency === 'string' && p.currency.trim() ? p.currency.trim() : 'USD',
    updatedAt: new Date().toISOString().slice(0, 10),
    engines,
  };
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  await rename(tmp, FILE);
  return next;
}
