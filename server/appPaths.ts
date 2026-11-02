import path from 'node:path';

// 쓰기 가능한 상태(측정 데이터·오버레이·큐)의 루트를 한 곳에서 결정한다.
//
// - dev 체크아웃/웹: APP_DATA_DIR 미설정 → 기존과 동일하게 process.cwd() 기준(= 저장소 안).
// - Electron 패키징: main.cjs가 APP_DATA_DIR=userData(쓰기 가능)로 설정 → asar(읽기전용)를 피한다.
//
// 이 파일 하나만 갈아끼우면 store/overlay/큐가 모두 같은 루트를 따른다.
const APP_DATA_DIR = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : null;

/** 패키징(쓰기 가능한 사용자 데이터 폴더)에서 도는 중인지. */
export function packagedDataMode(): boolean {
  return APP_DATA_DIR !== null;
}

/** 측정 파이프라인 데이터 루트(FileResultStore의 data/). */
export const PIPELINE_DATA_DIR = APP_DATA_DIR
  ? path.join(APP_DATA_DIR, 'data')
  : path.resolve(process.cwd(), 'data');

/**
 * 코호트 공통 질문지 루트. data/ 밖에 둔다 — 코호트 순위·재계산 스크립트·웹 baking이 data/의
 * 폴더를 전부 브랜드로 보고 훑는다. dev·CI는 저장소의 cohort-banks/(커밋된 기준본),
 * 패키징은 userData/cohort-banks/.
 */
export const COHORT_BANK_DIR = APP_DATA_DIR
  ? path.join(APP_DATA_DIR, 'cohort-banks')
  : path.resolve(process.cwd(), 'cohort-banks');

/**
 * 설치본에 동봉된 코호트 공통 질문지(저장소 cohort-banks/의 기준본). 패키징에서만 있다(electron/main.cjs).
 * userData에 질문지가 없으면 여기서 가져온다 — 데스크톱이 따로 만들면 CI·저장소와 질문지가 두 벌이 된다.
 */
export const BUNDLED_COHORT_BANK_DIR = process.env.BUNDLED_COHORT_BANK_DIR || null;

/**
 * 동봉한 브랜드 질문지 — src/data/question-banks/<tenantId>/<판>.json(server/bundledBanks.ts). 여러 PC가 같은 판 이름으로 같은 질문을
 * 재게 한다(v0.4.49 브랜드 통일). 패키징은 asar의 src/data(SEED_DATA_DIR, electron/main.cjs) 아래, dev · CI는 저장소의 것 — CI의
 * data/는 비어 있어(.gitignore) 이게 없으면 저장소 설정이 올린 판을 AI로 새로 만든다. 웹(Vercel)은 쓰지 않는다 — 함수에 싣지 않는다
 * (vercel.json includeFiles는 src/data/*.json 한 단계).
 */
export const BUNDLED_BANK_DIR = process.env.VERCEL
  ? null
  : process.env.SEED_DATA_DIR
    ? path.join(process.env.SEED_DATA_DIR, 'question-banks')
    : path.resolve(process.cwd(), 'src', 'data', 'question-banks');

/** 런타임 상태 파일(오버레이·큐) 경로. 패키징이면 userData 바로 아래, 아니면 기존 server/ 경로. */
export function stateFilePath(name: string): string {
  return APP_DATA_DIR ? path.join(APP_DATA_DIR, name) : path.resolve(process.cwd(), 'server', name);
}
