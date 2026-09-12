import { useEffect, useState } from 'react'

/**
 * 지금 화면의 숫자가 **측정값인지 예시(데모)인지**를 한 곳에서 안다.
 *
 * 서버는 측정 전 주차를 요청받으면 조용히 데모 스토어로 넘긴다(server/index.ts sourceFor).
 * 화면은 그 사실을 몰라서 데모 숫자를 실제처럼 보여 줬고, 2026-09-12 하루에만 두 번 그걸 진짜로
 * 읽었다. 오류가 아니라 "그럴듯한 숫자"라서 더 위험하다.
 *
 * 서버가 데모를 줄 때 `X-Data-Source: demo` 헤더를 붙이고, 클라이언트가 자체 폴백(데모 스코어카드)을
 * 쓸 때도 여기 기록한다. Layout이 이 집합이 비어 있지 않으면 배너를 띄운다.
 *
 * 키는 요청 경로다. 같은 경로가 나중에 실제 데이터로 응답하면 지워지므로, 측정이 끝나고 다시
 * 불러오면 배너가 저절로 내려간다. 브랜드·주차·화면이 바뀌면 호출부(useWeeklyData·Layout)가
 * clearDataSource()로 비운다 — 안 그러면 이전 주차의 데모 표시가 새 주차에 남는다.
 */
const demoPaths = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function noteDataSource(path: string, demo: boolean): void {
  const had = demoPaths.has(path)
  if (demo) demoPaths.add(path)
  else demoPaths.delete(path)
  if (had !== demo) emit()
}

export function clearDataSource(): void {
  if (demoPaths.size === 0) return
  demoPaths.clear()
  emit()
}

/** 지금 화면에 데모 응답이 하나라도 섞여 있는가. */
export function useDemoData(): boolean {
  const [demo, setDemo] = useState(demoPaths.size > 0)
  useEffect(() => {
    const fn = () => setDemo(demoPaths.size > 0)
    listeners.add(fn)
    fn()
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return demo
}
