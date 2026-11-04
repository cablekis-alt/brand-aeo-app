// 군산 지도 한 장 그리기(오프스크린 창 osmmap://app/render.html 안) — MapLibre(WebGL)로 바탕을 그리고, 2D 캔버스에 옮겨
// 표지 · 이름 · 동 이름 · 범례 · 축척 · 출처를 얹은 뒤 PNG로 만든다(electron/mapRender.cjs가 부른다).
// 오프스크린 창에서 CDP Page.captureScreenshot은 WebGL · 가속 캔버스 층을 빼고 찍으므로(실측) 화면을 찍지 않고 여기서 인코딩한다.
// 글꼴은 Windows 기본 'Malgun Gothic'이다 — 글꼴 파일 · 글꼴 서버를 쓰지 않는다(스타일에도 글자 레이어가 없다).
// spec은 메인이 검사한 것이다: { center:[lng,lat], zoom, markers:[{lng,lat,kind,label}], areaLabels, legend, maxAreaLabels, avoid:[w,s,e,n], timeoutMs }
// window.renderFrame(spec) → { ok:true, png(dataURL), stats } | { ok:false, code:'webgl-unavailable'|'timeout'|'render-failed', message, stats }
import * as maplibregl from './maplibre-gl.mjs'

const W = 1280
const H = 800
const LAND = '#f5f3ee'
const FONT = "'Malgun Gothic', sans-serif"
const KIND = {
  attraction: { color: '#2b59c3', word: '관광지' },
  stay: { color: '#0f8a6a', word: '숙소' },
  food: { color: '#d9532b', word: '음식점' },
}
const LABEL = { size: 33, weight: 700, color: '#1c2333', halo: 8 }
const AREA = { size: 25, weight: 400, color: '#7d7566', halo: 6, spacing: 2 }
const WATER = { size: 25, weight: 400, color: '#4a82a8', halo: 5, spacing: 2 }
const LEGEND = { size: 28, weight: 400, color: '#2b2f38', halo: 0 }
const SCALE = { size: 24, weight: 400, color: '#3a3f4a', halo: 0 }
/** 표지 반지름 · 겹침 상자 반 폭 */
const MK = 14
const MKB = 16
const ATTRIB = { text: '© OpenStreetMap contributors', size: 28, weight: 400, color: '#333842', halo: 0 }
const ATTRIB_H = ATTRIB.size + 14
const LEGEND_PAD = 14
const LEGEND_GAP = 24

maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', location.href).href)
const pmProtocol = new pmtiles.Protocol()
maplibregl.addProtocol('pmtiles', pmProtocol.tile)

const measure = document.createElement('canvas').getContext('2d')

function setFont(ctx, o) {
  ctx.font = `${o.weight} ${o.size}px ${FONT}`
  ctx.letterSpacing = `${o.spacing || 0}px`
}
function textWidth(text, o) {
  setFont(measure, o)
  return measure.measureText(text).width
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inside = (a, m) => a.x >= m && a.y >= m && a.x + a.w <= W - m && a.y + a.h <= H - m
const grow = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p })

function niceScale(metersPerPx) {
  const want = 150 * metersPerPx
  const steps = [20, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000]
  let best = steps[0]
  for (const s of steps) if (s <= want) best = s
  return { meters: best, px: best / metersPerPx, text: best >= 1000 ? `${best / 1000} km` : `${best} m` }
}

/** 이름 자리: 오른쪽 → 왼쪽 → 위 → 아래 → 대각선. 다른 이름 · 표지 · 범례 · 축척 · 출처와 겹치지 않고 그림 안(여백 8px)이어야 한다. */
function placeLabel(px, py, w, h, taken) {
  const r = MKB + 2
  const g = 3
  const cands = [
    { x: px + r + g, y: py - h / 2 },
    { x: px - r - g - w, y: py - h / 2 },
    { x: px - w / 2, y: py - r - g - h },
    { x: px - w / 2, y: py + r + g },
    { x: px + r, y: py - r - h },
    { x: px + r, y: py + r },
    { x: px - r - w, y: py - r - h },
    { x: px - r - w, y: py + r },
  ]
  for (const c of cands) {
    const box = { x: c.x, y: c.y, w, h }
    if (!inside(box, 8)) continue
    if (taken.some((t) => overlaps(grow(box, 3), t))) continue
    return box
  }
  return null
}

function renderError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function waitFor(map, ev, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(renderError('timeout', `지도가 ${Math.round(ms / 1000)}초 안에 ${ev}에 이르지 않았습니다.`)), ms)
    map.once(ev, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function glInfo(map) {
  const canvas = map.getCanvas()
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  if (!gl) return { webgl: false }
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    webgl: true,
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  }
}

/** 바탕(WebGL)만 옮겨 그린 직후의 색 수 · 가장 흔한 색 비율 — 덧그림과 상관없이 바탕이 그려졌는지 메인이 본다. */
function baseStats(ctx) {
  const d = ctx.getImageData(0, 0, W, H).data
  const colors = new Map()
  let n = 0
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const i = (y * W + x) * 4
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)
      colors.set(key, (colors.get(key) || 0) + 1)
      n += 1
    }
  }
  const top = Math.max(...colors.values())
  return { colors: colors.size, dominantShare: Math.round((top / n) * 1000) / 1000 }
}

/** 동 · 리 · 섬 · 호수 이름 후보(타일의 점). 공군기지 상자(avoid) 안의 것은 뺀다. */
function areaCandidates(map, avoid) {
  const out = []
  const seen = new Set()
  const push = (f, style, rank) => {
    const p = f.properties || {}
    const name = p['name:ko'] || p.name
    if (!name || seen.has(name)) return
    const [lng, lat] = f.geometry.coordinates
    if (avoid && lng >= avoid[0] && lng <= avoid[2] && lat >= avoid[1] && lat <= avoid[3]) return
    seen.add(name)
    out.push({ name, lng, lat, style, rank })
  }
  for (const f of map.querySourceFeatures('protomaps', { sourceLayer: 'water' })) {
    if (f.geometry.type === 'Point' && ['lake', 'river', 'bay', 'reservoir'].includes(f.properties.kind_detail || f.properties.kind)) push(f, WATER, 0)
  }
  for (const f of map.querySourceFeatures('protomaps', { sourceLayer: 'earth' })) {
    if (f.geometry.type === 'Point' && f.properties.kind === 'island') push(f, AREA, 1)
  }
  for (const f of map.querySourceFeatures('protomaps', { sourceLayer: 'places' })) {
    if (f.geometry.type !== 'Point') continue
    const k = f.properties.kind
    const d = f.properties.kind_detail
    if (k === 'macrohood' || k === 'neighbourhood') push(f, AREA, 2)
    else if (k === 'locality' && d !== 'city' && d !== 'town') push(f, AREA, 3)
  }
  return out
}

function legendLayout(kinds) {
  const items = kinds.map((k) => ({ k, w: textWidth(KIND[k].word, LEGEND) }))
  const inner = items.reduce((s, it) => s + 2 * MK + 8 + it.w, 0) + LEGEND_GAP * (items.length - 1)
  return { items, box: { x: 24, y: 24, w: inner + LEGEND_PAD * 2, h: LEGEND.size + 8 + LEGEND_PAD * 2 } }
}

/** 얹을 것들의 자리를 정한다. 범례 · 축척 · 출처 자리를 먼저 잡고, 표지 · 이름 · 동 이름은 그 밖에 놓는다. */
function layout(map, spec) {
  const taken = []
  const kinds = ['attraction', 'stay', 'food'].filter((k) => spec.markers.some((m) => m.kind === k))
  const markers = spec.markers.map((m) => {
    const p = map.project([m.lng, m.lat])
    return { ...m, px: p.x, py: p.y }
  })
  const legend = kinds.length && spec.legend !== false ? legendLayout(kinds) : null
  const lat = map.getCenter().lat
  const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom())
  const scale = niceScale(mpp)
  const scaleBox = { x: 18, y: H - 18 - 44, w: scale.px + textWidth(scale.text, SCALE) + 36, h: 44 }
  const attrW = textWidth(ATTRIB.text, ATTRIB) + 24
  const attribution = { x: W - attrW - 10, y: H - ATTRIB_H - 10, w: attrW, h: ATTRIB_H }
  for (const u of [legend && legend.box, scaleBox, attribution]) if (u) taken.push(grow(u, 4))
  for (const m of markers) taken.push(grow({ x: m.px - MKB, y: m.py - MKB, w: 2 * MKB, h: 2 * MKB }, 2))
  const labels = []
  const dropped = []
  for (const m of markers) {
    const w = textWidth(m.label, LABEL)
    const h = LABEL.size * 1.2
    const box = placeLabel(m.px, m.py, w, h, taken)
    if (!box) {
      dropped.push(m.label)
      continue
    }
    taken.push(box)
    labels.push({ text: m.label, box })
  }
  const areas = []
  if (spec.areaLabels) {
    const cands = areaCandidates(map, spec.avoid)
      .map((a) => {
        const p = map.project([a.lng, a.lat])
        return { ...a, px: p.x, py: p.y, d: Math.hypot(p.x - W / 2, p.y - H / 2) }
      })
      .filter((a) => a.px > 40 && a.px < W - 40 && a.py > 40 && a.py < H - 40)
      .sort((a, b) => a.rank - b.rank || a.d - b.d)
    for (const a of cands) {
      if (areas.length >= spec.maxAreaLabels) break
      const w = textWidth(a.name, a.style)
      const h = a.style.size * 1.2
      const box = { x: a.px - w / 2, y: a.py - h / 2, w, h }
      if (!inside(box, 12)) continue
      if (taken.some((t) => overlaps(grow(box, 14), t))) continue
      taken.push(grow(box, 6))
      areas.push({ text: a.name, box, style: a.style })
    }
  }
  return { markers, legend, scale, scaleBox, attribution, labels, dropped, areas }
}

function haloText(ctx, text, x, y, o, align = 'left') {
  setFont(ctx, o)
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  if (o.halo) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.lineWidth = o.halo
    ctx.strokeStyle = '#ffffff'
    ctx.strokeText(text, x, y)
  }
  ctx.fillStyle = o.color
  ctx.fillText(text, x, y)
}
function roundRect(ctx, r, radius, fill, alpha, stroke) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, radius)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.restore()
  if (stroke) {
    ctx.beginPath()
    ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, radius)
    ctx.lineWidth = 1
    ctx.strokeStyle = stroke
    ctx.stroke()
  }
}
/** 표지 모양: 관광지 ● · 숙소 ○ · 음식점 ■ */
function drawMarker(ctx, kind, x, y) {
  const c = KIND[kind] ? KIND[kind].color : '#333333'
  ctx.save()
  if (kind === 'stay') {
    ctx.beginPath()
    ctx.arc(x, y, MK + 1.5, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, MK - 3.5, 0, Math.PI * 2)
    ctx.lineWidth = 5
    ctx.strokeStyle = c
    ctx.stroke()
  } else if (kind === 'food') {
    ctx.beginPath()
    ctx.roundRect(x - MK + 1, y - MK + 1, 2 * MK - 2, 2 * MK - 2, 4)
    ctx.fillStyle = c
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.arc(x, y, MK - 0.5, 0, Math.PI * 2)
    ctx.fillStyle = c
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
  ctx.restore()
}
function drawOverlay(ctx, L) {
  for (const a of L.areas) haloText(ctx, a.text, a.box.x + a.box.w / 2, a.box.y + a.box.h / 2 + 1, a.style, 'center')
  for (const m of L.markers) drawMarker(ctx, m.kind, m.px, m.py)
  for (const l of L.labels) haloText(ctx, l.text, l.box.x, l.box.y + l.box.h / 2 + 1, LABEL)
  if (L.legend) {
    const b = L.legend.box
    roundRect(ctx, b, 10, '#ffffff', 0.92, '#d9d4ca')
    let x = b.x + LEGEND_PAD
    const y = b.y + b.h / 2
    for (const it of L.legend.items) {
      drawMarker(ctx, it.k, x + MK, y)
      haloText(ctx, KIND[it.k].word, x + 2 * MK + 8, y + 1, LEGEND)
      x += 2 * MK + 8 + it.w + LEGEND_GAP
    }
  }
  const s = L.scaleBox
  roundRect(ctx, s, 8, '#ffffff', 0.85)
  const x0 = s.x + 12
  const yb = s.y + 30
  ctx.beginPath()
  ctx.moveTo(x0, yb - 10)
  ctx.lineTo(x0, yb)
  ctx.lineTo(x0 + L.scale.px, yb)
  ctx.lineTo(x0 + L.scale.px, yb - 10)
  ctx.lineWidth = 3
  ctx.lineJoin = 'miter'
  ctx.strokeStyle = '#3a3f4a'
  ctx.stroke()
  haloText(ctx, L.scale.text, x0 + L.scale.px + 10, yb - 6, SCALE)
  const a = L.attribution
  roundRect(ctx, a, 8, '#ffffff', 0.9)
  haloText(ctx, ATTRIB.text, a.x + 12, a.y + a.h / 2 + 1, ATTRIB)
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

async function draw(spec, stats, mark) {
  const style = await (await fetch('./style.json')).json()
  mark('styleMs')
  let map
  try {
    map = new maplibregl.Map({
      container: 'map',
      style,
      center: spec.center,
      zoom: spec.zoom,
      bearing: 0,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      renderWorldCopies: false,
      maxZoom: 19,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    })
  } catch (err) {
    throw renderError(/webgl/i.test(String(err && err.message)) ? 'webgl-unavailable' : 'render-failed', String((err && err.message) || err).slice(0, 200))
  }
  try {
    map.on('error', (e) => stats.errors.push(String((e && e.error && e.error.message) || e).slice(0, 200)))
    await waitFor(map, 'load', spec.timeoutMs)
    mark('loadMs')
    if (!map.loaded() || !map.areTilesLoaded()) await waitFor(map, 'idle', spec.timeoutMs)
    mark('idleMs')
    stats.gl = glInfo(map)
    stats.zoom = map.getZoom()
    const b = map.getBounds()
    stats.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]

    const out = document.createElement('canvas')
    out.width = W
    out.height = H
    const ctx = out.getContext('2d')
    ctx.fillStyle = LAND
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(map.getCanvas(), 0, 0, W, H)
    stats.base = baseStats(ctx)

    const L = layout(map, spec)
    stats.labels = { placed: L.labels.length, dropped: L.dropped }
    stats.areaLabels = L.areas.map((a) => a.text)
    stats.scale = { meters: L.scale.meters, text: L.scale.text }
    stats.markersOutside = L.markers.filter((m) => m.px < 0 || m.py < 0 || m.px > W || m.py > H).map((m) => m.label)
    drawOverlay(ctx, L)
    mark('overlayMs')
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'))
    if (!blob) throw renderError('render-failed', 'PNG를 만들지 못했습니다.')
    const png = await blobToDataUrl(blob)
    mark('encodeMs')
    return png
  } finally {
    map.remove()
  }
}

window.renderFrame = async function renderFrame(spec) {
  const t0 = performance.now()
  const stats = { errors: [], timings: {} }
  const mark = (k) => {
    stats.timings[k] = Math.round(performance.now() - t0)
  }
  try {
    const png = await draw(spec, stats, mark)
    return { ok: true, png, stats }
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'render-failed', message: String((err && err.message) || err).slice(0, 300), stats }
  }
}
window.rendererReady = true
