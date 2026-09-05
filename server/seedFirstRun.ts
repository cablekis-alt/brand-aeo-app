import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PIPELINE_DATA_DIR, packagedDataMode } from './appPaths.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';

// 첫 실행 시 커밋된 데이터(src/data, asar에 동봉)를 userData/data(FileResultStore 레이아웃)로
// 변환·시드한다. 설치 직후에도 기존 코호트·대시보드가 비어 보이지 않게 한다.
// 이미 측정했거나 시드된 적이 있으면(=data/에 테넌트 폴더 존재) 아무것도 하지 않는다.
// dev/웹(packagedDataMode=false)에서는 저장소가 곧 데이터이므로 시드하지 않는다.
export function seedFirstRunIfEmpty(): void {
  if (!packagedDataMode()) return;
  const seedDir = process.env.SEED_DATA_DIR;
  if (!seedDir || !existsSync(seedDir)) return;

  try {
    if (existsSync(PIPELINE_DATA_DIR) && readdirSync(PIPELINE_DATA_DIR).length > 0) return;
  } catch {
    /* 폴더 없으면 계속 진행 */
  }

  const readJson = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(path.join(seedDir, file), 'utf8')) as T;
    } catch {
      return null;
    }
  };
  const write = (rel: string, data: unknown): void => {
    const full = path.join(PIPELINE_DATA_DIR, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
  };

  // 1) 스코어카드: 테넌트별 history + 주차별 scorecard.json (랭킹 코호트·스코어카드 뷰의 소스).
  const cards = readJson<WeeklyScorecard[]>('demo-scorecards.json') ?? [];
  const byTenant = new Map<string, WeeklyScorecard[]>();
  for (const c of cards) {
    const list = byTenant.get(c.tenantId) ?? [];
    list.push(c);
    byTenant.set(c.tenantId, list);
  }
  for (const [tenantId, list] of byTenant) {
    list.sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    write(path.join(tenantId, 'scorecard-history.json'), list);
    for (const c of list) write(path.join(tenantId, c.weekOf, 'scorecard.json'), c);
  }

  // 2) live-<id>-question-analyses.json → data/<id>/<weekOf>/question-analyses.json (진단/인용/EEAT 소스)
  // 3) live-<id>-question-bank.json    → data/<id>/question-bank/<version>.json (질문 빌더 소스)
  // 코호트에 실제로 있는 테넌트(스코어카드 보유)만 시드해 고아 데이터를 만들지 않는다.
  let files: string[] = [];
  try {
    files = readdirSync(seedDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    const an = f.match(/^live-(.+)-question-analyses\.json$/);
    if (an) {
      const rec = readJson<{ tenantId?: string; weekOf?: string; analyses?: unknown }>(f);
      if (rec?.tenantId && rec.weekOf && Array.isArray(rec.analyses) && byTenant.has(rec.tenantId)) {
        write(path.join(rec.tenantId, rec.weekOf, 'question-analyses.json'), rec.analyses);
      }
      continue;
    }
    const bank = f.match(/^live-(.+)-question-bank\.json$/);
    if (bank) {
      const id = bank[1];
      if (!byTenant.has(id)) continue;
      const content = readJson<{ version?: string }>(f);
      if (content?.version) write(path.join(id, 'question-bank', `${content.version}.json`), content);
    }
  }

  console.log(`[seed] 첫 실행 시드 완료 — 테넌트 ${byTenant.size}곳 → ${PIPELINE_DATA_DIR}`);
}
