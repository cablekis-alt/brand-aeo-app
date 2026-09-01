import { weekLabel } from '../lib/format'

interface WeekPickerProps {
  weeks: string[]
  value: string
  onChange: (weekOf: string) => void
}

export default function WeekPicker({ weeks, value, onChange }: WeekPickerProps) {
  if (weeks.length === 0) return null
  return (
    <label className="week-pick">
      <span>주차</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {[...weeks].reverse().map((weekOf) => (
          <option key={weekOf} value={weekOf}>
            {weekLabel(weekOf)}
          </option>
        ))}
      </select>
    </label>
  )
}
