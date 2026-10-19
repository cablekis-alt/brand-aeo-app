/**
 * 집행 원장(server/publishedPosts.ts)의 쓰기 규칙을 확인한다. 임시 폴더에만 쓴다 — 저장소 data/와 앱 데이터는 건드리지 않는다.
 *
 * 왜: 원장은 지운 기록을 되찾을 길이 없는 유일한 집행 기록이다. 같은 주소가 두 글에 붙거나, 날짜를 고치다 기록 시각이 덮이거나,
 * 동시에 쓰다 줄이 사라지거나, 깨진 파일을 빈 목록으로 읽고 덮어쓰면 전후 비교의 기준이 통째로 사라진다.
 *
 *   npx tsx scripts/verify-published-posts.ts
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  ok('상한은 뺀 적 없는 기록으로 센다(뺀 기록만 가득하면 새로 적힌다)', await (async () => {
    const D = 'cap-removed-tenant';
    const f = path.join(root, 'data', D, 'published-posts.json');
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify({ version: 1, keyRule: 2, posts: many.map((p) => ({ ...p, removedAt: '2026-10-02T00:00:00Z', removedReason: 'mistake' })) }), 'utf-8');
    return (await fails(addPublishedPost(D, { ...base, url: 'https://example.com/c/new' }))) === null;
  })());

  // 8) 같은 글은 여러 곳(자사 블로그 줄 · 그 블로그가 속한 채널 줄)에 같은 주소로 적을 수 있다
  const S = 'same-article-tenant';
  const own = await addPublishedPost(S, { articleId: 'content:a', targetActionId: 'content:a', via: 'own', url: 'https://fake.tistory.com/5', markDone: true });
  const channel = await addPublishedPost(S, { articleId: 'content:a', targetActionId: 'listing:platform:tistory.com', via: 'channel', url: 'https://fake.tistory.com/5?category=1', markDone: true });
  const sStates = await readActionStates(S);
  ok('같은 글을 다른 곳에 같은 주소로 적으면 그 곳에도 한 줄이 생기고 집행함이 된다', !channel.existing && channel.posts.length === 2 && own.post.key === channel.post.key && sStates['listing:platform:tistory.com']?.status === 'done');
  const conflictBody = await addPublishedPost(S, { articleId: 'content:b', targetActionId: 'content:b', via: 'own', url: 'https://fake.tistory.com/5' }).then(
    () => null,
    (err: { status?: number; detail?: { conflict?: { id?: string } } }) => err,
  );
  ok('다른 글이면 409와 가로막은 기록을 함께 준다', conflictBody?.status === 409 && Boolean(conflictBody.detail?.conflict?.id));
  const redated = await addPublishedPost(S, { articleId: 'content:a', targetActionId: 'content:a', via: 'own', url: 'https://fake.tistory.com/5', publishedOn: '2026-10-03', publishedOnChosen: true });
  ok('같은 곳에 날짜를 골라 다시 적으면 그 날로 고친다', redated.existing && redated.post.id === own.post.id && redated.post.publishedOn === '2026-10-03' && redated.post.recordedAt === own.post.recordedAt);
  await writeActionState(S, 'listing:old2.example', { status: 'done', publishedUrls: ['https://old2.example/a/9'] });
  const relegacy = await addPublishedPost(S, { articleId: 'content:a', targetActionId: 'listing:old2.example', via: 'channel', url: 'https://old2.example/a/9', publishedOn: '2026-09-20', publishedOnChosen: true });
  const afterRelegacy = await readPublishedPosts(S);
  ok('옛 기록을 같은 곳에 다시 적으면 원장으로 옮기고 글 · 올린 날을 채운다', relegacy.existing && !relegacy.post.legacy && relegacy.post.articleId === 'content:a' && relegacy.post.publishedOn === '2026-09-20' && afterRelegacy.filter((p) => p.key === 'old2.example/a/9').length === 1);

  // 8-b) 옛 기록과 같은 글의 다른 곳 — 한쪽에 적었다고 다른 곳의 옛 기록이 사라지거나 「다른 글」로 막히면 안 된다
  const L = 'legacy-two-rows-tenant';
  await writeActionState(L, 'content:a', { status: 'done', publishedUrls: ['https://fake.tistory.com/31'] });
  await addPublishedPost(L, { articleId: 'content:a', targetActionId: 'listing:platform:tistory.com', via: 'channel', url: 'https://fake.tistory.com/31' });
  const lPosts = await readPublishedPosts(L);
  ok('옛 기록(자사 줄)은 같은 글을 채널 줄에 적어도 그대로 보인다', lPosts.some((p) => p.legacy && p.targetActionId === 'content:a') && lPosts.some((p) => !p.legacy && p.targetActionId === 'listing:platform:tistory.com'));
  await writeActionState(L, 'listing:platform:tistory.com', { status: 'done', publishedUrls: ['https://fake.tistory.com/32'] });
  ok('채널 줄의 옛 기록이 있어도 같은 글을 자사 줄에 적을 수 있다(옛 기록을 「다른 글」로 단정하지 않는다)', (await fails(addPublishedPost(L, { articleId: 'content:a', targetActionId: 'content:a', via: 'own', url: 'https://fake.tistory.com/32' }))) === null);
  await writeActionState(L, 'listing:x.example', { status: 'done', publishedUrls: ['https://x.example/a/7'] });
  const kept = await addPublishedPost(L, { articleId: 'content:a', targetActionId: 'listing:x.example', via: 'channel', url: 'https://x.example/a/7', publishedOn: '2026-10-19', publishedOnChosen: false });
  ok('옛 기록을 날짜 없이 다시 적어 옮기면 올린 날은 모름으로 둔다(오늘로 채우지 않는다)', kept.post.publishedOn === null && kept.post.publishedOnSource === 'legacy');

  // 8-c) 되살리기도 상한을 지킨다
  const Q = 'cap-restore-tenant';
  const qFile = path.join(root, 'data', Q, 'published-posts.json');
  await mkdir(path.dirname(qFile), { recursive: true });
  await writeFile(qFile, JSON.stringify({ version: 1, keyRule: 3, posts: [...many, { ...many[0], id: 'p-removed', url: 'https://example.com/c/removed', key: 'example.com/c/removed', removedAt: '2026-10-02T00:00:00Z', removedReason: 'mistake' }] }), 'utf-8');
  ok('뺀 적 없는 기록이 가득하면 되살리기도 400', (await fails(patchPublishedPost(Q, 'p-removed', { restore: true }))) === 400);

  // 8-d) 질문 은행에서 고른 글(topic:)의 질문 스냅샷 — 질문 id의 뜻은 은행 판마다 바뀌어 그때의 판 · 문장을 고정한다
  const P = 'topic-tenant';
  const topicArticle = 'topic:v5-001+v5-007';
  const snap = { bankVersion: 'v5', questionIds: ['v5-001', 'v5-007'], questionTexts: ['가상 질문 하나', '가상 질문 둘'] };
  const withTopic = await addPublishedPost(P, { articleId: topicArticle, targetActionId: topicArticle, via: 'direct', url: 'https://fake.tistory.com/41', markDone: true, topic: snap });
  const pStates = await readActionStates(P);
  ok('topic 글 기록이 질문 스냅샷을 고정하고 그 글을 집행함으로 바꾼다', JSON.stringify(withTopic.post.topic) === JSON.stringify(snap) && pStates[topicArticle]?.status === 'done');
  ok('계획에 없는 항목 id(topic:)의 기록도 남는다', (await readPublishedPosts(P)).some((p) => p.articleId === topicArticle && !p.removedAt));
  ok('topic: 글이 아니면 스냅샷을 받지 않는다(400)', (await fails(addPublishedPost(P, { ...base, url: 'https://fake.tistory.com/42', topic: snap }))) === 400);
  ok('질문 id가 비었거나 문자열이 아니면 400', (await fails(addPublishedPost(P, { articleId: 'topic:x', targetActionId: 'topic:x', via: 'direct', url: 'https://fake.tistory.com/43', topic: { bankVersion: 'v5', questionIds: [1, 2], questionTexts: ['a', 'b'] } }))) === 400);
  ok('은행 판이 있는데 문장 수가 다르면 400', (await fails(addPublishedPost(P, { articleId: 'topic:a+b', targetActionId: 'topic:a+b', via: 'direct', url: 'https://fake.tistory.com/44', topic: { bankVersion: 'v5', questionIds: ['a', 'b'], questionTexts: ['a'] } }))) === 400);
  ok('스냅샷 질문이 글(topic:)의 질문과 다르면 400', (await fails(addPublishedPost(P, { articleId: 'topic:v5-001+v5-002', targetActionId: 'topic:v5-001+v5-002', via: 'direct', url: 'https://fake.tistory.com/47', topic: { bankVersion: 'v5', questionIds: ['v5-030'], questionTexts: ['다른 질문'] } }))) === 400);
  const longId = `topic:${Array.from({ length: 30 }, (_, i) => `c1-${String(i + 1).padStart(3, '0')}`).join('+')}`;
  const longRec = await addPublishedPost(P, { articleId: longId, targetActionId: longId, via: 'direct', url: 'https://fake.tistory.com/48', markDone: true });
  ok('질문을 많이 고른 글(200자 넘는 id)도 자르지 않고 기록한다', longRec.post.articleId === longId && (await readActionStates(P))[longId]?.status === 'done');
  ok('id가 상한을 넘으면 자르지 않고 400', (await fails(addPublishedPost(P, { articleId: `topic:${'x'.repeat(5000)}`, targetActionId: 'topic:x', via: 'direct', url: 'https://fake.tistory.com/49' }))) === 400);
  const noBankTopic = await addPublishedPost(P, { articleId: 'topic:v4-002', targetActionId: 'topic:v4-002', via: 'direct', url: 'https://fake.tistory.com/45', topic: { bankVersion: null, questionIds: ['v4-002'] } });
  ok('은행 판을 모르면 질문 id만 남긴다', noBankTopic.post.topic?.bankVersion === null && noBankTopic.post.topic.questionTexts.length === 0);
  await addPublishedPost(P, { articleId: 'topic:v5-009', targetActionId: 'topic:v5-009', via: 'direct', url: 'https://fake.tistory.com/46' });
  const addSnap = await addPublishedPost(P, { articleId: 'topic:v5-009', targetActionId: 'topic:v5-009', via: 'direct', url: 'https://fake.tistory.com/46', topic: { bankVersion: 'v5', questionIds: ['v5-009'], questionTexts: ['가상 질문 셋'] } });
  ok('스냅샷이 없던 기록을 다시 적으면 스냅샷을 붙인다', addSnap.existing && addSnap.post.topic?.bankVersion === 'v5');

  // 9) 읽는 중에 쓰기 — 윈도우는 다른 요청이 파일을 연 순간 rename이 실패한다(EPERM). 다시 시도해 줄이 사라지지 않고 임시 파일도 남지 않는다.
  const R = 'reader-tenant';
  let reading = true;
  const readers = Array.from({ length: 4 }, async () => {
    while (reading) await readPublishedPosts(R).catch(() => undefined);
  });
  const burst = await Promise.allSettled([
    ...Array.from({ length: 60 }, (_, i) => addPublishedPost(R, { ...base, url: `https://example.com/read/${i}` })),
    ...Array.from({ length: 20 }, (_, i) => writeActionState(R, `listing:r${i}.example`, { status: 'doing' })),
  ]);
  reading = false;
  await Promise.all(readers);
  const leftovers = (await readdir(path.join(root, 'data', R))).filter((f) => f.endsWith('.tmp'));
  const rPosts = await readPublishedPosts(R);
  ok('읽는 중에도 쓰기 실패 0건 · 줄 유실 0건 · 남은 임시 파일 0개', burst.every((b) => b.status === 'fulfilled') && rPosts.length === 60 && leftovers.length === 0);

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
