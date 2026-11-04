// 군산 지도 스타일(Protomaps basemap v4 스키마) — 글꼴(glyphs) · 스프라이트 없음, 글자 레이어 없음.
// 군사 · 비행장 땅은 그리지 않는다(바탕 땅 그대로). 활주로 · 유도로(roads kind aeroway)도 그리지 않는다.
// 이름 · 표지 · 범례 · 출처는 electron/map/render.js가 2D 캔버스로 얹는다. 이 스타일은 화면 표현만 정하고 OSM 데이터는 바꾸지 않는다.
//   node scripts/build-map-style.mjs [출력 — 기본 electron/map/style.json]   (만든 파일을 커밋한다)
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] || 'electron/map/style.json'
const SRC = 'protomaps'
const C = {
  land: '#f5f3ee',
  water: '#b5d6ec',
  waterLine: '#b5d6ec',
  green: '#dcebd2',
  wood: '#d2e4c5',
  farm: '#f0f0e1',
  wetland: '#d9ebe3',
  cemetery: '#e2e9da',
  sand: '#f3ebcc',
  rock: '#e7e3dc',
  urban: '#eeebe5',
  civic: '#f1ebe2',
  hospital: '#f3e6e4',
  pedestrian: '#ebe8e2',
  building: '#e9e5dd',
  buildingLine: '#dcd6cb',
  casingMinor: '#d9d3c7',
  casingMajor: '#d5c4a3',
  casingHighway: '#d4a663',
  fillHighway: '#fbdca8',
  fillTrunk: '#fff1cf',
  fillMajor: '#ffffff',
  fillMinor: '#ffffff',
  path: '#cbc3b4',
  rail: '#b9b4ac',
  ferry: '#8fbcd9',
  boundaryRegion: '#a79cb8',
  boundaryCounty: '#c6bdd0',
}
const z = (stops) => ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()]
const kindIn = (...k) => ['in', ['get', 'kind'], ['literal', k]]
const detailIn = (...k) => ['in', ['get', 'kind_detail'], ['literal', k]]
/** 군사 · 비행장 — 칠하지 않는다. */
const HIDDEN_LANDUSE = ['military', 'airfield', 'aerodrome', 'runway', 'taxiway', 'apron', 'helipad', 'naval_base', 'range', 'danger_area', 'barracks', 'bunker']
const fill = (id, kinds, color, extra = {}) => ({
  id,
  type: 'fill',
  source: SRC,
  'source-layer': 'landuse',
  filter: ['all', kindIn(...kinds), ['!', kindIn(...HIDDEN_LANDUSE)]],
  paint: { 'fill-color': color, 'fill-antialias': true, ...extra },
})

// 도로 폭(채움) — 줌별 px. 테두리는 채움 + 양쪽 c.
const W = {
  highway: [[8, 1.0], [10, 1.6], [12, 2.6], [14, 5], [16, 10], [18, 20]],
  trunk: [[8, 0.7], [10, 1.2], [12, 2.2], [14, 4.4], [16, 9], [18, 18]],
  major: [[10, 0.6], [12, 1.4], [14, 3.2], [16, 7.5], [18, 15]],
  minor: [[12, 0.4], [13, 0.8], [14, 1.6], [16, 4.5], [18, 10]],
  service: [[13, 0.4], [14, 0.9], [16, 2.6], [18, 6]],
  path: [[14, 0.6], [16, 1.2], [18, 2.0]],
}
const casing = (stops, c = [[10, 0.5], [12, 0.6], [14, 0.8], [16, 1.2], [18, 2]]) =>
  stops.map(([zz, w]) => {
    let cc = c[0][1]
    for (const [cz, cw] of c) if (zz >= cz) cc = cw
    return [zz, w + 2 * cc]
  })

const ROAD_BASE = ['all', ['!=', ['get', 'kind'], 'aeroway'], ['!', ['boolean', ['get', 'is_tunnel'], false]]]
const road = (id, filter, stops, color, minzoom, extra = {}) => ({
  id,
  type: 'line',
  source: SRC,
  'source-layer': 'roads',
  minzoom,
  filter: ['all', ROAD_BASE, filter],
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': color, 'line-width': z(stops), ...extra },
})
const isHighway = kindIn('highway')
const isTrunk = ['all', kindIn('major_road'), detailIn('trunk', 'primary', 'trunk_link', 'primary_link')]
const isMajor = ['all', kindIn('major_road'), ['!', detailIn('trunk', 'primary', 'trunk_link', 'primary_link')]]
const isMinor = ['all', kindIn('minor_road', 'other'), ['!=', ['get', 'kind_detail'], 'service']]
const isService = ['all', kindIn('minor_road'), ['==', ['get', 'kind_detail'], 'service']]

const style = {
  version: 8,
  name: 'gunsan-light',
  sources: {
    [SRC]: { type: 'vector', url: 'pmtiles://osmmap://app/gunsan.pmtiles', attribution: '© OpenStreetMap contributors' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': C.land } },
    { id: 'earth', type: 'fill', source: SRC, 'source-layer': 'earth', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.land } },
    {
      id: 'landcover',
      type: 'fill',
      source: SRC,
      'source-layer': 'landcover',
      paint: {
        'fill-color': ['match', ['get', 'kind'], ['forest'], C.wood, ['grassland', 'scrub'], C.green, ['farmland'], C.farm, ['barren'], C.rock, ['glacier'], '#ffffff', C.land],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 8, 0],
      },
    },
    fill('landuse-farm', ['farmland', 'orchard', 'vineyard', 'plant_nursery'], C.farm),
    fill('landuse-urban', ['commercial', 'industrial', 'railway', 'retail', 'dam'], C.urban),
    fill('landuse-civic', ['school', 'college', 'university', 'kindergarten'], C.civic),
    fill('landuse-hospital', ['hospital'], C.hospital),
    fill('landuse-green', ['park', 'nature_reserve', 'garden', 'village_green', 'recreation_ground', 'golf_course', 'grass', 'meadow', 'grassland', 'playground', 'allotments', 'pitch', 'protected_area', 'national_park', 'zoo', 'theme_park'], C.green),
    fill('landuse-wood', ['wood', 'forest', 'scrub'], C.wood),
    fill('landuse-wetland', ['wetland', 'marsh', 'swamp', 'mud'], C.wetland),
    fill('landuse-cemetery', ['cemetery', 'grave_yard'], C.cemetery),
    fill('landuse-sand', ['beach', 'sand'], C.sand),
    fill('landuse-rock', ['bare_rock', 'scree'], C.rock),
    fill('landuse-pedestrian', ['pedestrian', 'pier', 'platform'], C.pedestrian),
    {
      id: 'water',
      type: 'fill',
      source: SRC,
      'source-layer': 'water',
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!', kindIn('swimming_pool', 'fountain', 'reef')]],
      paint: { 'fill-color': C.water },
    },
    {
      id: 'water-line',
      type: 'line',
      source: SRC,
      'source-layer': 'water',
      minzoom: 9,
      filter: ['all', ['==', ['geometry-type'], 'LineString'], kindIn('river', 'canal', 'stream', 'drain', 'ditch')],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C.waterLine,
        'line-width': z(
          [
            [9, 0.6, 0],
            [12, 1.4, 0.4],
            [15, 3, 1.2],
            [18, 6, 2.5],
          ].map(([zz, big, small]) => [zz, ['match', ['get', 'kind'], ['river', 'canal'], big, small]]),
        ),
      },
    },
    {
      id: 'boundaries-county',
      type: 'line',
      source: SRC,
      'source-layer': 'boundaries',
      minzoom: 9,
      filter: kindIn('county'),
      paint: { 'line-color': C.boundaryCounty, 'line-width': z([[9, 0.6], [14, 1.2], [18, 1.8]]), 'line-dasharray': [3, 2] },
    },
    {
      id: 'boundaries-region',
      type: 'line',
      source: SRC,
      'source-layer': 'boundaries',
      filter: kindIn('region', 'country'),
      paint: { 'line-color': C.boundaryRegion, 'line-width': z([[6, 0.8], [12, 1.4], [18, 2.4]]), 'line-dasharray': [4, 2] },
    },
    {
      id: 'buildings',
      type: 'fill',
      source: SRC,
      'source-layer': 'buildings',
      minzoom: 14,
      paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 16, 0.95] },
    },
    {
      id: 'ferry',
      type: 'line',
      source: SRC,
      'source-layer': 'roads',
      minzoom: 10,
      filter: kindIn('ferry'),
      paint: { 'line-color': C.ferry, 'line-width': z([[10, 0.6], [14, 1.2], [18, 2]]), 'line-dasharray': [3, 3] },
    },
    road('path', kindIn('path'), W.path, C.path, 14.5, { 'line-dasharray': [2, 1.5] }),
    road('rail', kindIn('rail'), [[10, 0.6], [14, 1.2], [18, 2.4]], C.rail, 10, { 'line-dasharray': [4, 2] }),
    road('service-casing', isService, casing(W.service), C.casingMinor, 14),
    road('minor-casing', isMinor, casing(W.minor), C.casingMinor, 12.5),
    road('service', isService, W.service, C.fillMinor, 14),
    road('minor', isMinor, W.minor, C.fillMinor, 12.5),
    road('major-casing', isMajor, casing(W.major), C.casingMajor, 10),
    road('trunk-casing', isTrunk, casing(W.trunk), C.casingMajor, 8),
    road('major', isMajor, W.major, C.fillMajor, 10),
    road('trunk', isTrunk, W.trunk, C.fillTrunk, 8),
    road('highway-casing', isHighway, casing(W.highway, [[8, 0.5], [12, 0.7], [14, 1], [16, 1.4], [18, 2]]), C.casingHighway, 7),
    road('highway', isHighway, W.highway, C.fillHighway, 7),
    // 군사 · 비행장 땅은 맨 위에서 바탕색으로 덮는다 — 안쪽 풀밭 · 건물 · 길이 활주로 모양을 드러내지 않게(테두리 · 이름 없음).
    {
      id: 'mask-military',
      type: 'fill',
      source: SRC,
      'source-layer': 'landuse',
      filter: kindIn(...HIDDEN_LANDUSE),
      paint: { 'fill-color': C.land, 'fill-antialias': false },
    },
  ],
}
writeFileSync(OUT, JSON.stringify(style, null, 1))
console.log(`style: ${style.layers.length} layers -> ${OUT}`)
