import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * 테넌트별 쓰기 줄 — 집행 상태(action-states.json)와 집행 원장(published-posts.json)이 함께 쓰고, 두 파일을 읽는 라우트도 여기 선다.
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
 *
 * 윈도우에서는 다른 요청이 그 파일을 읽고 있는 순간 rename이 EPERM · EACCES · EBUSY로 실패한다(읽기는 줄 밖이다 — 화면 여러 곳이
 * 같은 파일을 불러온다). 잠깐 쉬었다 다시 시도하고, 끝내 실패하면 임시 파일을 지우고 오류를 올린다.
 */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (RETRYABLE.has(code) && attempt < 8) {
        await sleep(10 * 2 ** attempt);
        continue;
      }
      await unlink(tmp).catch((cleanupErr: unknown) => console.warn(`[writeJsonAtomic] 임시 파일을 지우지 못했습니다: ${tmp}`, cleanupErr));
      throw err;
    }
  }
}
