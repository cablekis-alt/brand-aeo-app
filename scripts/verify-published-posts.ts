/**
 * 집행 원장(server/publishedPosts.ts)의 쓰기 규칙을 확인한다. 임시 폴더에만 쓴다 — 저장소 data/와 앱 데이터는 건드리지 않는다.
 *
 * 왜: 원장은 지운 기록을 되찾을 길이 없는 유일한 집행 기록이다. 같은 주소가 두 글에 붙거나, 날짜를 고치다 기록 시각이 덮이거나,
 * 동시에 쓰다 줄이 사라지거나, 깨진 파일을 빈 목록으로 읽고 덮어쓰면 전후 비교의 기준이 통째로 사라진다.
 *
 *   npx tsx scripts/verify-published-posts.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'verify-published-posts-'));
// 모듈이 불러올 때 데이터 폴더를 정하므로, 환경 변수를 먼저 두고 동적으로 불러온다.
process.env.APP_DATA_DIR = root;
const { addPublishedPost, patchPublishedPost, readPublishedPosts, MAX_POSTS } = await import('../server/publishedPosts');
const { readActionStates, writeActionState } = await import('../server/actionStates');

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);
const fails = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
};

const T = 'fake-tenant';
const base = { articleId: 'content:category-agnostic', targetActionId: 'content:category-agnostic', via: 'own' };

try {
  // 1) 추가 + 집행함을 한 번에
  const r1 = await addPublishedPost(T, { ...base, url: 'https://www.example.com/posts/1?utm_source=openai', markDone: true, viewingWeek: '2026-W42', publishedOn: '2026-10-15', publishedOnChosen: true });
  const states = await readActionStates(T);
  ok('추가와 「집행함」이 한 번에 저장된다', r1.posts.length === 1 && states['content:category-agnostic']?.status === 'done' && r1.states?.['content:category-agnostic']?.markedWeek === '2026-W42');
  ok('키는 추적 파라미터 · www를 뗀다', r1.post.key === 'example.com/posts/1');
  ok('사람이 고른 날은 user로 남는다', r1.post.publishedOn === '2026-10-15' && r1.post.publishedOnSource === 'user');
  const r1b = await addPublishedPost(T, { ...base, url: 'https://example.com/posts/1/' });
  ok('같은 글 · 같은 곳의 같은 주소는 기존 줄을 돌려준다(멱등)', r1b.existing && r1b.post.id === r1.post.id && r1b.posts.length === 1);
  ok('다른 글에 적힌 주소는 409', (await fails(addPublishedPost(T, { articleId: 'topic:q1', targetActionId: 'topic:q1', via: 'direct', url: 'https://m.example.com/posts/1' }))) === 409);
  ok('첫 화면 주소는 400', (await fails(addPublishedPost(T, { ...base, url: 'https://example.com/' }))) === 400);
  ok('단축 주소는 400', (await fails(addPublishedPost(T, { ...base, url: 'https://naver.me/abc' }))) === 400);
  ok('미래 날짜는 400', (await fails(addPublishedPost(T, { ...base, url: 'https://example.com/posts/9', publishedOn: '2999-01-01' }))) === 400);
  ok('없는 날짜는 400', (await fails(addPublishedPost(T, { ...base, url: 'https://example.com/posts/9', publishedOn: '2026-02-30' }))) === 400);
  const r2 = await addPublishedPost(T, { ...base, url: 'https://example.com/posts/2' });
  ok('날짜를 안 주면 오늘(기본값)', r2.post.publishedOnSource === 'default-today' && /^\d{4}-\d{2}-\d{2}$/.test(r2.post.publishedOn ?? ''));

  // 2) 날짜 고치기 · 빼기 · 되살리기 — 지우지 않는다
  const recordedAt = r2.post.recordedAt;
  const d = await patchPublishedPost(T, r2.post.id, { publishedOn: '2026-10-01' });
  ok('날짜를 고쳐도 기록 시각은 그대로', d.post.publishedOn === '2026-10-01' && d.post.recordedAt === recordedAt && d.post.publishedOnSource === 'user');
  const rm1 = await patchPublishedPost(T, r2.post.id, { remove: 'taken-down' });
  ok('빼기는 표시만 한다(파일에 남는다)', rm1.post.removedReason === 'taken-down' && Boolean(rm1.post.removedAt) && rm1.posts.some((p) => p.id === r2.post.id));
  const again = await addPublishedPost(T, { articleId: 'topic:q1', targetActionId: 'topic:q1', via: 'direct', url: 'https://example.com/posts/2' });
  ok('뺀 주소는 다른 글에 다시 적을 수 있다', !again.existing && again.post.articleId === 'topic:q1');
  ok('같은 주소가 다시 적혀 있으면 되살리지 않는다(409)', (await fails(patchPublishedPost(T, r2.post.id, { restore: true }))) === 409);
  await patchPublishedPost(T, again.post.id, { remove: 'mistake' });
  const back = await patchPublishedPost(T, r2.post.id, { restore: true });
  ok('되살리면 뺀 표시가 사라진다', !back.post.removedAt && !back.post.removedReason);
  ok('뺀 이유가 틀리면 400', (await fails(patchPublishedPost(T, r2.post.id, { remove: 'whatever' }))) === 400);
  ok('없는 기록은 404', (await fails(patchPublishedPost(T, 'p-nope', { restore: true }))) === 404);

  // 3) 동시에 쓰기 — 원장 20줄과 상태 쓰기가 섞여도 사라지는 줄이 없다
  const writes = await Promise.allSettled([
    ...Array.from({ length: 20 }, (_, i) => addPublishedPost(T, { ...base, url: `https://example.com/burst/${i}` })),
    ...Array.from({ length: 10 }, (_, i) => writeActionState(T, `listing:site${i}.example`, { status: 'doing', markedWeek: '2026-W42' })),
  ]);
  const after = await readPublishedPosts(T);
  const stateAfter = await readActionStates(T);
  ok('동시 쓰기에서 실패 0건', writes.every((w) => w.status === 'fulfilled'));
  ok('동시 쓰기에서 원장 줄이 사라지지 않는다', Array.from({ length: 20 }, (_, i) => `example.com/burst/${i}`).every((k) => after.some((p) => p.key === k)));
  ok('동시 쓰기에서 상태가 사라지지 않는다', Array.from({ length: 10 }, (_, i) => `listing:site${i}.example`).every((id) => stateAfter[id]?.status === 'doing') && stateAfter['content:category-agnostic']?.status === 'done');

  // 4) 옛 주소(집행 상태에만 있던 것)는 읽을 때 합쳐 보이고, 고치면 원장으로 옮긴다
  await writeActionState(T, 'listing:old.example', { status: 'done', publishedUrls: ['https://old.example/a/1'] });
  const withLegacy = await readPublishedPosts(T);
  const legacy = withLegacy.find((p) => p.key === 'old.example/a/1');
  ok('옛 주소가 옛 기록으로 합쳐 보인다', legacy?.legacy === true && legacy.publishedOn === null && legacy.targetActionId === 'listing:old.example');
  const moved = await patchPublishedPost(T, legacy!.id, { publishedOn: '2026-09-01' });
  const afterMove = await readPublishedPosts(T);
  ok('옛 기록을 고치면 원장으로 옮기고 두 번 보이지 않는다', !moved.post.legacy && afterMove.filter((p) => p.key === 'old.example/a/1').length === 1);

  // 5) 깨진 파일은 읽지도 쓰지도 않는다
  const B = 'broken-tenant';
  const brokenFile = path.join(root, 'data', B, 'published-posts.json');
  await mkdir(path.dirname(brokenFile), { recursive: true });
  await writeFile(brokenFile, '{"posts": [ {', 'utf-8');
  ok('깨진 파일을 읽으면 오류', (await fails(readPublishedPosts(B))) === 500);
  ok('깨진 파일에는 쓰지 않는다', (await fails(addPublishedPost(B, { ...base, url: 'https://example.com/posts/3' }))) === 500 && (await readFile(brokenFile, 'utf-8')) === '{"posts": [ {');

  // 6) 상한 — 조용히 자르지 않는다
  const C = 'cap-tenant';
  const capFile = path.join(root, 'data', C, 'published-posts.json');
  await mkdir(path.dirname(capFile), { recursive: true });
  const many = Array.from({ length: MAX_POSTS }, (_, i) => ({ id: `p-${i}`, url: `https://example.com/c/${i}`, key: `example.com/c/${i}`, publishedOn: '2026-10-01', publishedOnSource: 'user', recordedAt: '2026-10-01T00:00:00Z', articleId: 'a', targetActionId: 'a', via: 'own' }));
  await writeFile(capFile, JSON.stringify({ version: 1, keyRule: 1, posts: many }), 'utf-8');
  ok(`${MAX_POSTS}줄을 넘으면 400`, (await fails(addPublishedPost(C, { ...base, url: 'https://example.com/c/new' }))) === 400);

  // 7) 키 규칙이 바뀐 옛 파일은 읽을 때 key를 다시 계산한다
  const K = 'rule-tenant';
  const ruleFile = path.join(root, 'data', K, 'published-posts.json');
  await mkdir(path.dirname(ruleFile), { recursive: true });
  await writeFile(ruleFile, JSON.stringify({ version: 1, keyRule: 0, posts: [{ ...many[0], url: 'https://www.example.com/x/1/?fbclid=1', key: 'stale' }] }), 'utf-8');
  ok('키 규칙이 다르면 key를 다시 계산한다', (await readPublishedPosts(K))[0]?.key === 'example.com/x/1');
} finally {
  await rm(root, { recursive: true, force: true });
}

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
