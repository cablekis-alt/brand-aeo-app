import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 테넌트별 쓰기 줄 — 집행 상태(action-states.json)와 집행 원장(published-posts.json)이 함께 쓴다.
 *
 * 「올렸어요」는 원장에 한 줄을 넣고 그 항목을 「집행함」으로 바꾼다. 두 파일을 다른 줄에서 쓰면, 상태 변경이 끼어들어 옛
 * 스냅샷으로 덮을 수 있다. 줄은 Express 프로세스 하나 안에서만 순서를 지킨다(drafts.json의 updateDrafts와 같은 방식).
 */
const queues = new Map<string, Promise<unknown>>();

export function queueTenantWrite<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(tenantId) ?? Promise.resolve();
  const run = prev.then(task);
  // 앞 작업이 실패해도 다음 작업은 돈다 — 실패는 그 호출자에게만 간다.
  queues.set(
    tenantId,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * 임시 파일에 쓰고 rename으로 갈아끼운다. 임시 파일 이름에 UUID를 붙인다 — 같은 pid 이름을 쓰면 두 쓰기가 한 임시 파일을
 * 함께 써서 깨진 JSON이 남을 수 있다.
 */
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, target);
}
