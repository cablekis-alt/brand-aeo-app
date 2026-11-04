// 군산 범위만 잘라 PMTiles v3로 쓴다 — 타일 본문은 원본 그대로(gzip MVT), 같은 본문은 한 번만.
// node scripts/map-data/extract-gunsan.mjs <source-url> <out.pmtiles>
//   source-url: Protomaps 일일 빌드(.pmtiles, HTTP Range로 읽는다). map-data/gunsan-20261103.pmtiles는 빌드 20261103에서 만들었다(map-data/README.md).
//   원본에서 디렉터리와 상자 안 타일 본문만 차례로 받는다(동시 요청 없음). 앱은 이 스크립트를 쓰지 않는다 — 지도 데이터를 새로 만들 때만.
//   만든 뒤에는 scripts/map-data/verify-extract.mjs로 확인한다.
import { PMTiles, FetchSource, SharedPromiseCache, zxyToTileId, findTile } from 'pmtiles'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const [SRC_URL, OUT] = process.argv.slice(2)
const UA = 'brand-aeo-app gunsan extract (one-time)'
const BOX = { w: 126.28, e: 126.92, s: 35.70, n: 36.07 }
const ZMIN = 0
const ZMAX = 15

const src = new FetchSource(SRC_URL, new Headers({ 'User-Agent': UA }))
const cache = new SharedPromiseCache(400)
const pm = new PMTiles(src, cache)
const h = await pm.getHeader()
const meta = await pm.getMetadata()

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}
async function entryOf(id) {
  let off = h.rootDirectoryOffset
  let len = h.rootDirectoryLength
  for (let d = 0; d < 4; d++) {
    const dir = await cache.getDirectory(src, off, len, h)
    const e = findTile(dir, id)
    if (!e) return null
    if (e.runLength > 0) return e
    off = h.leafDirectoryOffset + e.offset
    len = e.length
  }
  throw new Error('directory depth exceeded')
}

// 1) 상자 안 타일의 원본 위치
const tiles = [] // { id, srcOff, len }
for (let z = ZMIN; z <= ZMAX; z++) {
  const x0 = lon2x(BOX.w, z), x1 = lon2x(BOX.e, z), y0 = lat2y(BOX.n, z), y1 = lat2y(BOX.s, z)
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const id = zxyToTileId(z, x, y)
      const e = await entryOf(id)
      if (e) tiles.push({ id, srcOff: e.offset, len: e.length })
    }
}
tiles.sort((a, b) => a.id - b.id)

// 2) 본문 받기 — 겹치지 않는 원본 구간을 모아 큰 구간으로 합쳐 차례로 받는다(동시 요청 없음)
const uniq = [...new Map(tiles.map((t) => [t.srcOff, t.len])).entries()].sort((a, b) => a[0] - b[0])
const GAP = 64 * 1024
const MAXREQ = 4 * 1024 * 1024
const ranges = []
for (const [off, len] of uniq) {
  const last = ranges[ranges.length - 1]
  if (last && off - (last.off + last.len) <= GAP && off + len - last.off <= MAXREQ) last.len = Math.max(last.len, off + len - last.off)
  else ranges.push({ off, len })
}
const body = new Map() // srcOff -> Buffer
let fetched = 0
for (const r of ranges) {
  const res = await src.getBytes(h.tileDataOffset + r.off, r.len, undefined, h.etag)
  const buf = Buffer.from(res.data)
  fetched += buf.length
  for (const [off, len] of uniq) if (off >= r.off && off + len <= r.off + r.len) body.set(off, buf.subarray(off - r.off, off - r.off + len))
}
if (body.size !== uniq.length) throw new Error(`missing bodies ${body.size}/${uniq.length}`)

// 3) 새 타일 데이터 — tileId 차례, 같은 원본 본문은 처음 자리를 다시 가리킨다
const outOff = new Map()
const chunks = []
let dataLen = 0
const entries = []
for (const t of tiles) {
  let o = outOff.get(t.srcOff)
  if (o === undefined) {
    o = dataLen
    outOff.set(t.srcOff, o)
    chunks.push(body.get(t.srcOff))
    dataLen += t.len
  }
  entries.push({ tileId: t.id, offset: o, length: t.len, runLength: 1 })
}

// 4) 디렉터리 직렬화(PMTiles v3)
function varint(arr, n) {
  while (n >= 0x80) {
    arr.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  arr.push(n)
}
function serialize(es) {
  const a = []
  varint(a, es.length)
  let last = 0
  for (const e of es) { varint(a, e.tileId - last); last = e.tileId }
  for (const e of es) varint(a, e.runLength)
  for (const e of es) varint(a, e.length)
  for (let i = 0; i < es.length; i++) {
    const e = es[i]
    if (i > 0 && e.offset === es[i - 1].offset + es[i - 1].length) varint(a, 0)
    else varint(a, e.offset + 1)
  }
  return gzipSync(Buffer.from(a))
}
let root = serialize(entries)
let leaves = Buffer.alloc(0)
if (127 + root.length > 16384) {
  // 잎 디렉터리로 나눈다
  for (let per = 4096; ; per *= 2) {
    const rootEntries = []
    const leafBufs = []
    let leafLen = 0
    for (let i = 0; i < entries.length; i += per) {
      const part = entries.slice(i, i + per)
      const b = serialize(part)
      rootEntries.push({ tileId: part[0].tileId, offset: leafLen, length: b.length, runLength: 0 })
      leafBufs.push(b)
      leafLen += b.length
    }
    root = serialize(rootEntries)
    leaves = Buffer.concat(leafBufs)
    if (127 + root.length <= 16384) break
  }
}

const metaOut = {
  ...meta,
  description: `Gunsan extract of Protomaps basemap build ${SRC_URL.split('/').pop()} (bbox ${BOX.w},${BOX.s},${BOX.e},${BOX.n}; z${ZMIN}-${ZMAX})`,
}
const metaBuf = gzipSync(Buffer.from(JSON.stringify(metaOut)))

// 5) 머리말과 파일
const header = Buffer.alloc(127)
header.write('PMTiles', 0, 'ascii')
header.writeUInt8(3, 7)
const rootOff = 127
const metaOff = rootOff + root.length
const leafOff = metaOff + metaBuf.length
const dataOff = leafOff + leaves.length
const u64 = (pos, n) => header.writeBigUInt64LE(BigInt(n), pos)
u64(8, rootOff); u64(16, root.length)
u64(24, metaOff); u64(32, metaBuf.length)
u64(40, leafOff); u64(48, leaves.length)
u64(56, dataOff); u64(64, dataLen)
u64(72, entries.length); u64(80, entries.length); u64(88, outOff.size)
header.writeUInt8(1, 96) // clustered
header.writeUInt8(2, 97) // internal gzip
header.writeUInt8(h.tileCompression, 98)
header.writeUInt8(h.tileType, 99)
header.writeUInt8(ZMIN, 100)
header.writeUInt8(ZMAX, 101)
header.writeInt32LE(Math.round(BOX.w * 1e7), 102)
header.writeInt32LE(Math.round(BOX.s * 1e7), 106)
header.writeInt32LE(Math.round(BOX.e * 1e7), 110)
header.writeInt32LE(Math.round(BOX.n * 1e7), 114)
header.writeUInt8(12, 118)
header.writeInt32LE(Math.round(126.711 * 1e7), 119)
header.writeInt32LE(Math.round(35.983 * 1e7), 123)

writeFileSync(OUT, Buffer.concat([header, root, metaBuf, leaves, ...chunks]))
console.log(JSON.stringify({ tiles: entries.length, contents: outOff.size, requests: ranges.length, fetchedMB: +(fetched / 1048576).toFixed(2), outMB: +((dataOff + dataLen) / 1048576).toFixed(2), rootBytes: root.length, leafBytes: leaves.length, srcVersion: meta.version ?? null, attribution: meta.attribution ?? null }, null, 1))
