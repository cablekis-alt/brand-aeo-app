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

/** 런타임 상태 파일(오버레이·큐) 경로. 패키징이면 userData 바로 아래, 아니면 기존 server/ 경로. */
export function stateFilePath(name: string): string {
  return APP_DATA_DIR ? path.join(APP_DATA_DIR, name) : path.resolve(process.cwd(), 'server', name);
}
