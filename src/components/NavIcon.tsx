/**
 * 사이드바 메뉴 아이콘 — 24px 격자의 선 아이콘 한 줄짜리 path. 아이콘 패키지를 들이지 않고 쓰는 것만 둔다.
 * 색은 currentColor라 메뉴 글자색(기본·선택·호버)을 그대로 따른다.
 */
const PATHS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  measure: 'M3 12h4l3-8 4 16 3-8h4',
  status: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  diagnosis: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20',
  gap: 'M5 20V10M12 20V4M19 20v-7',
  citation: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ranking: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  content: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  library: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  site: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  performance: 'M4 17l5-5 4 4 7-8M14 8h6v6',
  report: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  updown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
} as const

export type NavIconName = keyof typeof PATHS

export default function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      className="nav-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
