import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';

/**
 * 실행 항목의 **사람이 정하는 상태**를 테넌트 단위로 저장한다.
 *
 * ── 왜 '완료'가 두 종류인가 ──────────────────────────────────────────────────
 * 이 파일은 `satisfied`를 저장하지 않는다. satisfied는 데이터가 말하는 값이다 —
 * 그 도메인의 인용이 우리 언급을 뒷받침하면 자동으로 켜진다(gapActions.ts 참고).
 *
 * 여기 저장하는 건 **집행 상태**다. 둘은 다른 질문에 답한다:
 *   done(집행함)  "나는 그 일을 했다"          — 사람만 안다
 *   satisfied(충족) "AI가 우리를 그 출처에서 본다" — 데이터만 안다
 *
 * 둘을 한 칸에 합치면 둘 다 잃는다. 사람이 '완료'로 덮으면 실제로 노출이 안 된 것을
 * 못 보게 되고, 데이터만 쓰면 "올렸는데 아직 안 잡힌다"는 상태를 표현할 방법이 없다.
 * 갈라 두면 **집행했는데 몇 주째 충족이 안 되는 항목**이 저절로 드러난다 — 그게 등재
 * 방식이 틀렸다는 가장 이른 신호다.
 *
 * ── 주차가 아니라 테넌트 단위인 이유 ─────────────────────────────────────────
 * 조치는 주차를 가로지른다. 이번 주에 "진행 중"으로 둔 일이 다음 주에 리셋되면 상태가
 * 아무 뜻도 없어진다. 항목 id(`listing:<domain>` · `content:<category>`)가 주차에
 * 의존하지 않게 설계된 이유가 이것이다.
 *
 * 웹(Vercel)에는 이 라우트를 만들지 않는다 — Hobby 함수 한도를 쓰지 않으려고
 * 데스크톱·로컬 전용으로 둔다. 클라이언트는 404를 "저장 기능 없음"으로 읽고 컨트롤을 숨긴다.
 */
export const ACTION_STATUSES = ['todo', 'doing', 'done', 'skip'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionState {
  status: ActionStatus;
  /** 이 상태로 바꾼 시각. */
  updatedAt: string;
  /**
   * 어느 주차를 보다가 정했는지. "집행했다는데 그 뒤로 몇 주가 지났나"를 세려면 필요하다
   * — 없으면 '충족 안 됨'이 오래된 일인지 방금 한 일인지 구분할 수 없다.
   */
  markedWeek?: string;
  note?: string;
}

export type ActionStateMap = Record<string, ActionState>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'action-states.json');
}

export async function readActionStates(tenantId: string): Promise<ActionStateMap> {
  try {
    const raw = await readFile(filePathFor(tenantId), 'utf-8');
    const parsed = JSON.parse(raw) as ActionStateMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 한 항목의 상태를 쓴다. `todo`는 **지운다** — 기본값이라 저장할 이유가 없고, 남겨 두면
 * 손댄 적 없는 항목과 되돌린 항목이 파일에서 구분되지 않은 채 쌓이기만 한다.
 *
 * 임시 파일에 쓰고 rename으로 갈아끼운다(store.ts와 같은 이유 — 부분적으로 쓰인 파일이
 * 읽히면 readActionStates가 조용히 {}를 돌려주고 상태가 통째로 사라진 것처럼 보인다).
 */
export async function writeActionState(
  tenantId: string,
  actionId: string,
  patch: { status: ActionStatus; markedWeek?: string; note?: string },
): Promise<ActionStateMap> {
  const current = await readActionStates(tenantId);
  if (patch.status === 'todo') {
    delete current[actionId];
  } else {
    current[actionId] = {
      status: patch.status,
      updatedAt: new Date().toISOString(),
      ...(patch.markedWeek ? { markedWeek: patch.markedWeek } : {}),
      ...(patch.note ? { note: patch.note } : {}),
    };
  }
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(current, null, 2), 'utf-8');
  await rename(tmp, target);
  return current;
}

export function isActionStatus(value: unknown): value is ActionStatus {
  return typeof value === 'string' && (ACTION_STATUSES as readonly string[]).includes(value);
}
