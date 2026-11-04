// 잘라 낸 파일 검사 — 모든 타일을 읽고(gzip 풀기 · MVT 첫 바이트), 원본 주소를 주면 표본 40장을 원본과 바이트 비교한다.
// node scripts/map-data/verify-extract.mjs <file.pmtiles> [source-url]
//   source-url이 없으면 이 PC 안에서만 확인한다(바깥 요청 없음 — sample은 null).
import { PMTiles, FetchSource } from 'pmtiles'
import { openSync, readSync, fstatSync } from 'node:fs'

const [FILE, SRC_URL] = process.argv.slice(2)
const fd = openSync(FILE, 'r')
const size = fstatSync(fd).size
const local = {
  getKey: () => FILE,
  getBytes: async (offset, length) => {
    const len = Math.min(length, size - offset)
    const b = Buffer.alloc(len)
    readSync(fd, b, 0, len, offset)
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + len) }
  },
}
const out = new PMTiles(local)
const src = SRC_URL ? new PMTiles(new FetchSource(SRC_URL, new Headers({ 'User-Agent': 'brand-aeo-app gunsan extract check (one-time)' }))) : null
const h = await out.getHeader()
const meta = await out.getMetadata()
const BOX = { w: h.minLon, e: h.maxLon, s: h.minLat, n: h.maxLat }
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}
let read = 0, missing = 0, badMvt = 0
const all = []
for (let z = h.minZoom; z <= h.maxZoom; z++) {
  const x0 = lon2x(BOX.w, z), x1 = lon2x(BOX.e, z), y0 = lat2y(BOX.n, z), y1 = lat2y(BOX.s, z)
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const t = await out.getZxy(z, x, y)
      if (!t) { missing++; continue }
      read++
      const b = new Uint8Array(t.data)
      if (b.length > 0 && b[0] !== 0x1a) badMvt++
      all.push([z, x, y])
    }
}
// 표본: 줌마다 고르게 40장
let sample = null
if (src) {
  const picks = []
  for (let i = 0; i < 40; i++) picks.push(all[Math.floor((i * all.length) / 40)])
  let same = 0, diff = 0
  for (const [z, x, y] of picks) {
    const a = new Uint8Array((await out.getZxy(z, x, y)).data)
    const b = new Uint8Array((await src.getZxy(z, x, y)).data)
    if (a.length === b.length && a.every((v, i) => v === b[i])) same++
    else diff++
  }
  sample = { same, diff }
}
console.log(JSON.stringify({ header: { specVersion: h.specVersion, minZoom: h.minZoom, maxZoom: h.maxZoom, tileType: h.tileType, tileCompression: h.tileCompression, clustered: h.clustered, numAddressedTiles: h.numAddressedTiles, numTileContents: h.numTileContents, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] }, metaKeys: Object.keys(meta), layers: (meta.vector_layers || []).map((l) => l.id), read, missing, badMvt, sample }, null, 1))
