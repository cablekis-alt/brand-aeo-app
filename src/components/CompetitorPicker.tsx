import { useState } from 'react'
import type { CompetitorEntry } from '../lib/api'

export interface PickerOption {
  id: string
  label: string
  sub: string
  danger?: boolean
  onPick: () => void
}

export interface PickerGroup {
  head: string
  options: PickerOption[]
}

/**
 * 경쟁사 편집 서랍의 고르기 상자 — 「바꾸기·빼기」, 「측정에 넣기」, 「+ 경쟁사 추가」가 같이 쓴다.
 * 후보를 묶음별로 보이고, typed가 있으면 이름·홈페이지를 직접 넣는 칸을 맨 위에 둔다.
 */
export default function CompetitorPicker({
  title,
  note,
  error,
  groups,
  typed,
}: {
  title: string
  note?: string
  /** 고른 것을 넣지 못한 이유(이미 있는 이름 등). */
  error?: string | null
  groups: PickerGroup[]
  /**
   * 직접 넣기. onHomepageOnly가 있으면 이름을 비우고 홈페이지만 넣었을 때 그 줄의 주소만 바꾼다
   * (「바꾸기·빼기」에서 연 경우 — 같은 경쟁사의 홈페이지가 바뀌었을 때).
   */
  typed?: { submitLabel: string; onSubmit: (entry: CompetitorEntry) => void; onHomepageOnly?: (homepage: string) => void }
}) {
  const [name, setName] = useState('')
  const [homepage, setHomepage] = useState('')
  const homepageOnly = Boolean(typed?.onHomepageOnly) && !name.trim() && Boolean(homepage.trim())
  const submit = () => {
    if (!typed) return
    if (homepageOnly) {
      typed.onHomepageOnly?.(homepage.trim())
      return
    }
    const n = name.trim()
    if (!n) return
    typed.onSubmit({ name: n, aliases: [n], domains: homepage.trim() ? [homepage.trim()] : [] })
  }
  const shown = groups.filter((g) => g.options.length > 0)
  return (
    <div className="ce-picker" role="group" aria-label={title}>
      <b className="ce-picker-title">{title}</b>
      {note && <p className="ce-picker-note">{note}</p>}
      {error && (
        <p className="ce-picker-error" role="alert">
          {error}
        </p>
      )}
      {typed && (
        <form
          className="ce-picker-typed"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label>
            <span className="sr-only">경쟁사 이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름(예: 해오름펜션)" />
          </label>
          <label>
            <span className="sr-only">홈페이지(선택)</span>
            <input value={homepage} onChange={(e) => setHomepage(e.target.value)} placeholder="홈페이지(없으면 비워 두기)" />
          </label>
          <button type="submit" className="btn soft" disabled={!name.trim() && !homepageOnly}>
            {homepageOnly ? '홈페이지만 바꾸기' : typed.submitLabel}
          </button>
        </form>
      )}
      {typed?.onHomepageOnly && (
        <p className="ce-picker-note">이름을 비우고 홈페이지만 넣으면 이 경쟁사의 주소만 바꿔요.</p>
      )}
      {shown.map((g) => (
        <div key={g.head} className="ce-picker-group">
          <span className="ce-picker-head">{g.head}</span>
          {g.options.map((o) => (
            <button key={o.id} type="button" className={`ce-picker-opt${o.danger ? ' danger' : ''}`} onClick={o.onPick}>
              <span className="ce-picker-label">{o.label}</span>
              {o.sub && <span className="ce-picker-sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      ))}
      {shown.length === 0 && !typed && <p className="ce-picker-note">고를 곳이 없어요.</p>}
    </div>
  )
}
