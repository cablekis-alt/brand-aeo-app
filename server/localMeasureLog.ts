import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateFilePath } from './appPaths.js';

// 앱(데스크톱/로컬)에서 실행한 측정의 완료 기록. userData(패키징) 또는 server/(dev)에 저장한다.
// GitHub Actions 실행 목록·CLI가 커밋한 src/data/measure-log.json과 별개로, 이 앱이 직접 돌린 측정을
// "측정 상태" 화면에 보여주기 위한 로컬 로그.
export interface LocalMeasureRun {
  tenantId: string;
  brandName: string;
  weekOf: string;
  aeoScore: number;
  durationSec: number;
  at: string; // ISO 완료 시각
}

const FILE = stateFilePath('measure-runs.json');
const MAX = 50;

export function readLocalMeasures(): LocalMeasureRun[] {
  try {
    const data: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? (data as LocalMeasureRun[]) : [];
  } catch {
    return [];
  }
}

export function appendLocalMeasure(entry: LocalMeasureRun): void {
  const list = [entry, ...readLocalMeasures()].slice(0, MAX);
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  } catch {
    /* 저장 실패는 측정 자체를 막지 않는다 */
  }
}
