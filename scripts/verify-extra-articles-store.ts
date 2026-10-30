/**
 * 추가 글 저장소(server/extraArticles.ts)와 집행 원장의 짝을 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 쓴다 — 저장소
 * data/와 앱 데이터는 건드리지 않는다. 서버 · AI는 부르지 않는다.
 *
 * 왜: 추가 글의 id(topic:…)에 초안 · 브리프 · 올린 기록이 모두 붙는다. 같은 질문을 두 글이 맡거나, 동시에 만들다 앞 글이 덮이거나,
 * 깨진 파일을 빈 목록으로 읽고 덮어쓰면 그 글의 기록이 어느 글의 것인지 잃는다. 올린 기록에 싣는 질문 스냅샷이 원장 검사(checkTopic)를
 * 통과하지 못하면 「올렸어요」가 400으로 막힌다.
 *
 *   npx tsx scripts/verify-extra-articles-store.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'verify-extra-articles-store-'));
// 모듈이 불러올 때 데이터 폴더를 정하므로, 환경 변수를 먼저 두고 동적으로 불러온다.
process.env.APP_DATA_DIR = root;
const { createExtraArticle, patchExtraArticle, readExtraArticles } = await import('../server/extraArticles');
const { addPublishedPost } = await import('../server/publishedPosts');
const { readActionStates } = await import('../server/actionStates');
const { EXTRA_LIMITS, extraTopicSnapshot, topicArticleId } = await import('../src/lib/extraArticles');

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

const T = 'fake-extra';
const input = (ids: string[], texts: string[], extra: Record<string, unknown> = {}) => ({
  id: topicArticleId(ids),
  name: '가상 주제',
  bankVersion: 'v3',
  questionIds: ids,
  questionTexts: texts,
  createdWeek: '2026-W44',
  ...extra,
});

try {
  // 1) 읽기 — 파일이 없으면 빈 목록
  const empty = await readExtraArticles(T);
  ok('파일이 없으면 빈 목록 · 깨지지 않음', empty.articles.length === 0 && !empty.corrupt);

  // 2) 만들기 — 질문 · 문장을 짝지어 id 순으로 정렬해 저장한다
  const r1 = await createExtraArticle(T, { ...input(['c1-012', 'c1-011'], ['가상 질문 열둘', '가상 질문 열하나']), name: '  가상   주차장 안내 ', angle: ' 주말 기준 ' });
  ok('만들면 정렬한 id · 짝 맞춘 문장으로 저장', r1.article.id === 'topic:c1-011+c1-012' && r1.article.questionIds.join() === 'c1-011,c1-012' && r1.article.questionTexts.join() === '가상 질문 열하나,가상 질문 열둘');
  ok('이름 · 각도의 공백을 정리한다', r1.article.name === '가상 주차장 안내' && r1.article.angle === '주말 기준');
  ok('새로 만든 글은 되살림이 아니다', r1.revived === false && r1.articles.length === 1 && r1.article.createdWeek === '2026-W44');
  const file = JSON.parse(await readFile(path.join(root, 'data', T, 'extra-articles.json'), 'utf-8')) as { version: number; articles: unknown[] };
  ok('파일 모양 { version: 1, articles }', file.version === 1 && file.articles.length === 1);

  // 3) 부딪힘 — 409
  ok('살아 있는 같은 id는 409', (await fails(createExtraArticle(T, input(['c1-011', 'c1-012'], ['가상 질문 열하나', '가상 질문 열둘'])))) === 409);
  ok('다른 글이 맡은 질문 문장(공백만 다름)은 409', (await fails(createExtraArticle(T, input(['c1-007', 'c1-020'], ['가상 질문 일곱', '가상  질문 열하나 '])))) === 409);
  const overlapMsg = await createExtraArticle(T, input(['c1-007', 'c1-020'], ['가상 질문 일곱', '가상 질문 열하나'])).then(
    () => '',
    (err: Error) => err.message,
  );
  ok('겹침 이유에 맡은 글 이름이 있다', overlapMsg.includes("'가상 주차장 안내' 글이 맡고 있어요"));
  ok('다른 판의 같은 문장도 겹침(409)', (await fails(createExtraArticle(T, input(['c9-001'], ['가상 질문 열둘'], { bankVersion: 'v4' })))) === 409);

  // 4) 잘못된 값 — 400
  ok('id가 고른 질문과 다르면 400', (await fails(createExtraArticle(T, { ...input(['c1-007'], ['가상 질문 일곱']), id: 'topic:c1-008' }))) === 400);
  ok('정렬하지 않은 id도 400', (await fails(createExtraArticle(T, { ...input(['c1-007', 'c1-008'], ['가상 질문 일곱', '가상 질문 여덟']), id: 'topic:c1-008+c1-007' }))) === 400);
  ok('판이 없으면 400', (await fails(createExtraArticle(T, input(['c1-007'], ['가상 질문 일곱'], { bankVersion: '' })))) === 400);
  ok('판을 안 보내도 400', (await fails(createExtraArticle(T, { ...input(['c1-007'], ['가상 질문 일곱']), bankVersion: undefined }))) === 400);
  ok('이름이 없으면 400', (await fails(createExtraArticle(T, input(['c1-007'], ['가상 질문 일곱'], { name: '  ' })))) === 400);
  ok(`이름이 ${EXTRA_LIMITS.name}자를 넘으면 400`, (await fails(createExtraArticle(T, input(['c1-007'], ['가상 질문 일곱'], { name: '가'.repeat(EXTRA_LIMITS.name + 1) })))) === 400);
  ok(`각도가 ${EXTRA_LIMITS.angle}자를 넘으면 400`, (await fails(createExtraArticle(T, input(['c1-007'], ['가상 질문 일곱'], { angle: '가'.repeat(EXTRA_LIMITS.angle + 1) })))) === 400);
  const many = Array.from({ length: EXTRA_LIMITS.questions + 1 }, (_, i) => `m-${String(i).padStart(3, '0')}`);
  ok(`질문이 ${EXTRA_LIMITS.questions}개를 넘으면 400`, (await fails(createExtraArticle(T, input(many, many.map((id) => `가상 ${id}`))))) === 400);
  ok('질문이 없으면 400', (await fails(createExtraArticle(T, input([], [])))) === 400);
  ok('문장 수가 다르면 400', (await fails(createExtraArticle(T, input(['c1-007', 'c1-008'], ['가상 질문 일곱'])))) === 400);
  ok('같은 질문을 두 번 고르면 400', (await fails(createExtraArticle(T, input(['c1-007', 'c1-007'], ['가상 질문 일곱', '가상 질문 일곱'])))) === 400);
  ok('잘못된 값은 파일을 바꾸지 않는다', (await readExtraArticles(T)).articles.length === 1);

  // 5) 편수 상한 — 살아 있는 글 10편
  for (let i = 0; i < EXTRA_LIMITS.articles - 1; i += 1) {
    const id = `k-${String(i).padStart(3, '0')}`;
    await createExtraArticle(T, input([id], [`가상 상한 질문 ${i}`], { name: `가상 상한 ${i}` }));
  }
  ok(`살아 있는 글이 ${EXTRA_LIMITS.articles}편이면 더 만들면 409`, (await fails(createExtraArticle(T, input(['z-001'], ['가상 넘침 질문'])))) === 409);

  // 6) 빼기 · 되살리기 — 지우지 않는다
  const removed = await patchExtraArticle(T, { id: 'topic:k-000', removed: true });
  ok('빼기는 표시만 한다(목록에 남는다)', Boolean(removed.article.removedAt) && removed.articles.some((a) => a.id === 'topic:k-000'));
  const room = await createExtraArticle(T, input(['z-001'], ['가상 넘침 질문'], { name: '가상 새 글' }));
  ok('뺀 글은 편수에 세지 않는다', room.articles.filter((a) => !a.removedAt).length === EXTRA_LIMITS.articles);
  ok('살아 있는 글이 다시 10편이면 되살리기도 409', (await fails(patchExtraArticle(T, { id: 'topic:k-000', removed: false }))) === 409);
  await patchExtraArticle(T, { id: 'topic:z-001', removed: true });
  const before = (await readExtraArticles(T)).articles.find((a) => a.id === 'topic:k-000');
  const revived = await createExtraArticle(T, input(['k-000'], ['가상 상한 질문 0'], { name: '가상 되살린 글', bankVersion: 'v4' }));
  ok(
    '같은 질문으로 다시 만들면 같은 id로 되살린다(만든 시각 유지 · 이름 · 판은 새 값)',
    revived.revived && !revived.article.removedAt && revived.article.createdAt === before?.createdAt && revived.article.name === '가상 되살린 글' && revived.article.bankVersion === 'v4',
  );
  ok('되살려도 줄이 늘지 않는다', revived.articles.filter((a) => a.id === 'topic:k-000').length === 1);
  await patchExtraArticle(T, { id: 'topic:k-001', removed: true });
  const taken = await createExtraArticle(T, input(['z-002'], ['가상 넘침 질문'], { name: '가상 이어받은 글' }));
  ok('뺀 글의 질문 문장은 다른 글이 맡을 수 있다', taken.article.id === 'topic:z-002' && !taken.revived);
  await patchExtraArticle(T, { id: 'topic:k-002', removed: true });
  const reviveClash = await patchExtraArticle(T, { id: 'topic:z-001', removed: false }).then(
    () => '',
    (err: Error & { status?: number }) => `${err.status} ${err.message}`,
  );
  ok('그 질문을 다른 글이 맡은 뒤 뺀 글을 되살리면 겹침 409', reviveClash.startsWith('409') && reviveClash.includes("'가상 이어받은 글' 글이 맡고 있어요"));
  await patchExtraArticle(T, { id: 'topic:z-002', removed: true });
  const back = await patchExtraArticle(T, { id: 'topic:z-001', removed: false });
  ok('PATCH removed:false로 되살린다', back.revived && !back.article.removedAt);

  // 7) 고치기 — 이름 · 각도, 바꿀 것 없음 · 모르는 글
  const renamed = await patchExtraArticle(T, { id: 'topic:c1-011+c1-012', name: '가상 주차 안내', angle: '' });
  ok('이름을 고치고 빈 각도는 지운다', renamed.article.name === '가상 주차 안내' && renamed.article.angle === undefined && renamed.article.updatedAt >= r1.article.updatedAt);
  ok('고쳐도 id · 질문은 그대로', renamed.article.id === r1.article.id && renamed.article.questionTexts.join() === r1.article.questionTexts.join());
  ok('바꿀 것이 없으면 400', (await fails(patchExtraArticle(T, { id: 'topic:c1-011+c1-012' }))) === 400);
  ok('모르는 글은 400', (await fails(patchExtraArticle(T, { id: 'topic:none', removed: true }))) === 400);
  ok('removed가 참거짓이 아니면 400', (await fails(patchExtraArticle(T, { id: 'topic:c1-011+c1-012', removed: 'yes' }))) === 400);

  // 8) 동시에 두 건 — 쓰기 줄이 순서를 지킨다
  const T2 = 'fake-extra-concurrent';
  const [a, b] = await Promise.allSettled([
    createExtraArticle(T2, input(['c1-001'], ['가상 동시 질문 하나'], { name: '가상 동시 1' })),
    createExtraArticle(T2, input(['c1-002'], ['가상 동시 질문 둘'], { name: '가상 동시 2' })),
  ]);
  const both = (await readExtraArticles(T2)).articles;
  ok('동시에 만든 두 글이 모두 남는다', a.status === 'fulfilled' && b.status === 'fulfilled' && both.length === 2);
  ok('두 번째 응답은 앞 글을 포함한 목록', b.status === 'fulfilled' && b.value.articles.map((x) => x.name).join() === '가상 동시 1,가상 동시 2');
  const clash = await Promise.allSettled([
    createExtraArticle(T2, input(['c1-003'], ['가상 같은 질문'], { name: '가상 먼저' })),
    createExtraArticle(T2, input(['c1-004'], ['가상 같은 질문'], { name: '가상 나중' })),
  ]);
  ok(
    '같은 질문을 동시에 만들면 먼저 선 것만 남고 나중 것은 409',
    clash[0].status === 'fulfilled' && clash[1].status === 'rejected' && (clash[1].reason as { status?: number }).status === 409,
  );

  // 9) 깨진 파일 — 읽기는 빈 목록 + corrupt, 쓰기는 거절하고 덮지 않는다
  const T3 = 'fake-extra-broken';
  await mkdir(path.join(root, 'data', T3), { recursive: true });
  const brokenPath = path.join(root, 'data', T3, 'extra-articles.json');
  await writeFile(brokenPath, '{ 깨진', 'utf-8');
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  const broken = await readExtraArticles(T3);
  const writeStatus = await fails(createExtraArticle(T3, input(['c1-001'], ['가상 질문 하나'])));
  const patchStatus = await fails(patchExtraArticle(T3, { id: 'topic:c1-001', removed: true }));
  // 모양은 맞지만 읽지 못한 줄이 섞인 파일도 깨진 것으로 본다
  const T4 = 'fake-extra-partial';
  await mkdir(path.join(root, 'data', T4), { recursive: true });
  const partialPath = path.join(root, 'data', T4, 'extra-articles.json');
  const good = r1.article;
  const partialText = JSON.stringify({ version: 1, articles: [good, { ...good, id: 'topic:wrong' }] });
  await writeFile(partialPath, partialText, 'utf-8');
  const partial = await readExtraArticles(T4);
  const partialWrite = await fails(createExtraArticle(T4, input(['c1-099'], ['가상 다른 질문'])));
  console.error = origError;
  ok('깨진 파일은 알리고 빈 목록 · corrupt', broken.articles.length === 0 && broken.corrupt && errors.length >= 1);
  ok('깨진 파일에는 만들기 · 고치기를 거절(500)', writeStatus === 500 && patchStatus === 500);
  ok('깨진 파일을 덮지 않는다', (await readFile(brokenPath, 'utf-8')) === '{ 깨진');
  ok('읽지 못한 줄이 섞이면 corrupt · 쓰지 않는다', partial.corrupt && partial.articles.length === 0 && partialWrite === 500 && (await readFile(partialPath, 'utf-8')) === partialText);

  // 10) 원장 — 추가 글의 질문 스냅샷을 실은 「올렸어요」가 통과한다(checkTopic)
  const def = renamed.article;
  const own = await addPublishedPost(T, {
    url: 'https://fake-extra.example/posts/parking',
    articleId: def.id,
    targetActionId: def.id,
    via: 'own',
    markDone: true,
    topic: extraTopicSnapshot(def),
  });
  ok('자사 줄 기록이 스냅샷과 함께 남는다', own.post.topic?.bankVersion === 'v3' && own.post.topic.questionIds.join('+') === 'c1-011+c1-012' && own.post.topic.questionTexts.length === 2);
  ok('자사 줄은 그 글의 상태를 「집행함」으로', (await readActionStates(T))[def.id]?.status === 'done');
  const channel = await addPublishedPost(T, {
    url: 'https://fakeblog.tistory.com/12',
    articleId: def.id,
    targetActionId: 'listing:tistory.com',
    via: 'channel',
    markDone: false,
    topic: extraTopicSnapshot(def),
  });
  const statesAfter = await readActionStates(T);
  ok('채널 줄 기록(markDone false)은 채널 항목 상태를 건드리지 않는다', channel.post.via === 'channel' && channel.states === undefined && statesAfter['listing:tistory.com'] === undefined);
  const revivedDef = revived.article;
  const otherBank = await addPublishedPost(T, {
    url: 'https://fake-extra.example/posts/revived',
    articleId: revivedDef.id,
    targetActionId: revivedDef.id,
    via: 'own',
    topic: extraTopicSnapshot(revivedDef),
  });
  ok('되살린 글(다른 판)의 스냅샷도 통과', otherBank.post.topic?.bankVersion === 'v4');
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
