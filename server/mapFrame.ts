import { MAP_AVOID, MAP_COVER, inMapBox } from '../src/lib/mapImage.js';

/**
 * 지도 틀 정하기(순수 함수) — 표지들에 맞춰 줌 · 중심을 고르고(북쪽 위), 공군기지 상자(MAP_AVOID)와 지도 데이터 범위(MAP_COVER) 밖을 피한다.
 * OSM 시험(scratchpad osm-probe harness/frames.cjs frameFor)을 옮긴 것이다. 메인 프로세스(electron/mapRender.cjs)가 그리기 전 · 뒤에 같은
 * 범위를 다시 본다.
 *
 * 순서
 *   1. 공군기지 상자 안의 표지는 뺀다(dropped why 'avoid').
 *   2. 기본 여백(위 120 · 오른쪽 170 · 아래 120 · 왼쪽 170px)으로 표지에 맞는 줌 fitZoom을 정한다(최대 16.3).
 *   3. fitZoom부터 0.05씩 줌을 올리며 최소 여백(위 80 · 오른쪽 110 · 아래 90 · 왼쪽 110)으로도 맞는 줌까지, 표지가 최소 여백 안에 남고 틀이
 *      데이터 범위 안이며 1280×800 틀 전체가 기지 상자의 서 · 동 · 북 · 남 가운데 한쪽에 완전히 놓이는 중심을 찾는다 — 기본 중심에서 가장
 *      적게 옮기는 쪽(side · shiftPx).
 *   4. 어느 줌에서도 안 되면 기지 상자 중심에 가장 가까운 표지를 하나 빼고(why 'base') 다시 한다.
 *   5. 다 빼도 안 되면 실패(base-in-frame) — 지도를 만들지 않는다.
 */

/** MapLibre와 같은 512px 타일 웹 메르카토르. */
const TILE = 512;
export const MAP_WIDTH = 1280;
export const MAP_HEIGHT = 800;
/** 가장 크게 볼 줌 — 표지 하나여도 이보다 가까이 가지 않는다. */
export const MAP_MAX_ZOOM = 16.3;

export interface FramePad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const FRAME_PAD: FramePad = { top: 120, right: 170, bottom: 120, left: 170 };
export const FRAME_MIN_PAD: FramePad = { top: 80, right: 110, bottom: 90, left: 110 };

export type FrameSide = 'none' | 'west-of-base' | 'east-of-base' | 'north-of-base' | 'south-of-base';

export interface FrameMarker {
  lng: number;
  lat: number;
}

export type FrameResult<M extends FrameMarker> =
  | {
      ok: true;
      center: [number, number];
      zoom: number;
      fitZoom: number;
      /** [서, 남, 동, 북]. */
      bounds: [number, number, number, number];
      side: FrameSide;
      shiftPx: number;
      /** 그릴 표지(받은 순서). */
      markers: M[];
      dropped: { marker: M; why: 'avoid' | 'base' }[];
    }
  | { ok: false; why: 'no-markers' | 'base-in-frame'; dropped: { marker: M; why: 'avoid' | 'base' }[] };

const mx = (lng: number) => (lng + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const unmx = (x: number) => x * 360 - 180;
const unmy = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** 두 상자가 겹치는가(맞닿는 것은 겹침이 아니다). */
export function boxesOverlap(a: readonly number[], b: readonly number[]): boolean {
  return a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!;
}

/** 중심 · 줌으로 계산한 width×height 그림의 범위 [서, 남, 동, 북] — electron/mapRender.cjs frameBounds와 같은 계산. */
export function mapFrameBounds(center: readonly [number, number], zoom: number, width = MAP_WIDTH, height = MAP_HEIGHT): [number, number, number, number] {
  const s = TILE * 2 ** zoom;
  const cx = mx(center[0]) * s;
  const cy = my(center[1]) * s;
  return [unmx((cx - width / 2) / s), unmy((cy + height / 2) / s), unmx((cx + width / 2) / s), unmy((cy - height / 2) / s)];
}

export interface FrameOptions {
  width?: number;
  height?: number;
  pad?: FramePad;
  minPad?: FramePad;
  maxZoom?: number;
  /** 피할 상자 — null이면 피하지 않는다(검사용). 기본 MAP_AVOID. */
  avoid?: readonly number[] | null;
  cover?: readonly number[];
}

/** 표지들에 맞는 틀. 표지는 받은 순서를 지키고, 뺀 표지는 dropped에 까닭과 함께. */
export function frameFor<M extends FrameMarker>(markersIn: readonly M[], opts: FrameOptions = {}): FrameResult<M> {
  const width = opts.width ?? MAP_WIDTH;
  const height = opts.height ?? MAP_HEIGHT;
  const pad = opts.pad ?? FRAME_PAD;
  const minPad = opts.minPad ?? FRAME_MIN_PAD;
  const maxZoom = opts.maxZoom ?? MAP_MAX_ZOOM;
  const avoid = opts.avoid === undefined ? MAP_AVOID : opts.avoid;
  const cover = opts.cover ?? MAP_COVER;
  const dropped: { marker: M; why: 'avoid' | 'base' }[] = [];
  let markers = markersIn.filter((m) => {
    if (avoid && inMapBox(m, avoid)) {
      dropped.push({ marker: m, why: 'avoid' });
      return false;
    }
    return true;
  });
  if (!markers.length) return { ok: false, why: 'no-markers', dropped };
  for (;;) {
    const r = tryFrame(markers, width, height, pad, minPad, maxZoom, avoid, cover);
    if (r) return { ok: true, ...r, markers, dropped };
    if (markers.length <= 1) return { ok: false, why: 'base-in-frame', dropped };
    // 기지에 가장 가까운 표지를 빼고 다시 — 같은 거리면 뒤 표지부터(받은 순서의 앞 표지 — 자리 글자에 나온 장소 — 를 남긴다).
    const c = avoid ? [(avoid[0]! + avoid[2]!) / 2, (avoid[1]! + avoid[3]!) / 2] : [0, 0];
    const dist = (m: M) => Math.hypot(m.lng - c[0]!, m.lat - c[1]!);
    let at = 0;
    markers.forEach((m, i) => {
      if (dist(m) <= dist(markers[at]!)) at = i;
    });
    dropped.push({ marker: markers[at]!, why: 'base' });
    markers = markers.filter((_m, i) => i !== at);
  }
}

function tryFrame(
  markers: readonly FrameMarker[],
  width: number,
  height: number,
  pad: FramePad,
  minPad: FramePad,
  maxZoom: number,
  avoid: readonly number[] | null,
  cover: readonly number[],
): { center: [number, number]; zoom: number; fitZoom: number; bounds: [number, number, number, number]; side: FrameSide; shiftPx: number } | null {
  const xs = markers.map((m) => mx(m.lng));
  const ys = markers.map((m) => my(m.lat));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const span = (a: number, b: number) => Math.max(b - a, 1e-9);
  const fitZ = Math.min(
    maxZoom,
    Math.log2(Math.min((width - pad.left - pad.right) / (span(x0, x1) * TILE), (height - pad.top - pad.bottom) / (span(y0, y1) * TILE))),
  );
  const zFull = Math.log2(Math.min((width - minPad.left - minPad.right) / (span(x0, x1) * TILE), (height - minPad.top - minPad.bottom) / (span(y0, y1) * TILE)));
  const zMax = Math.min(maxZoom, zFull);
  const clamp = (v: number, [a, b]: readonly [number, number]) => Math.min(Math.max(v, a), b);
  for (let z = Math.round(fitZ * 100) / 100; z <= zMax + 1e-9; z = Math.round((z + 0.05) * 100) / 100) {
    const s = TILE * 2 ** z;
    // 기본 중심(기본 여백으로 맞춘 자리)
    const pcx = ((x0 + x1) / 2) * s + (pad.right - pad.left) / 2;
    const pcy = ((y0 + y1) / 2) * s + (pad.bottom - pad.top) / 2;
    // 표지가 최소 여백 안에 남는 중심 범위 — 그리고 데이터 범위 안
    const cx: [number, number] = [
      Math.max(x1 * s + minPad.right - width / 2, mx(cover[0]!) * s + width / 2),
      Math.min(x0 * s - minPad.left + width / 2, mx(cover[2]!) * s - width / 2),
    ];
    const cy: [number, number] = [
      Math.max(y1 * s + minPad.bottom - height / 2, my(cover[3]!) * s + height / 2),
      Math.min(y0 * s - minPad.top + height / 2, my(cover[1]!) * s - height / 2),
    ];
    if (cx[0] > cx[1] || cy[0] > cy[1]) continue;
    const options: { side: FrameSide; cx: number; cy: number }[] = [];
    if (!avoid) options.push({ side: 'none', cx: clamp(pcx, cx), cy: clamp(pcy, cy) });
    else {
      const ax0 = mx(avoid[0]!) * s;
      const ax1 = mx(avoid[2]!) * s;
      const ay0 = my(avoid[3]!) * s;
      const ay1 = my(avoid[1]!) * s;
      const sides: { side: FrameSide; cx: [number, number]; cy: [number, number] }[] = [
        { side: 'west-of-base', cx: [cx[0], Math.min(cx[1], ax0 - width / 2)], cy },
        { side: 'east-of-base', cx: [Math.max(cx[0], ax1 + width / 2), cx[1]], cy },
        { side: 'north-of-base', cx, cy: [cy[0], Math.min(cy[1], ay0 - height / 2)] },
        { side: 'south-of-base', cx, cy: [Math.max(cy[0], ay1 + height / 2), cy[1]] },
      ];
      for (const o of sides) {
        if (o.cx[0] > o.cx[1] || o.cy[0] > o.cy[1]) continue;
        options.push({ side: o.side, cx: clamp(pcx, o.cx), cy: clamp(pcy, o.cy) });
      }
    }
    if (!options.length) continue;
    options.sort((a, b) => Math.hypot(a.cx - pcx, a.cy - pcy) - Math.hypot(b.cx - pcx, b.cy - pcy));
    const best = options[0]!;
    return {
      zoom: z,
      fitZoom: Math.round(fitZ * 100) / 100,
      center: [unmx(best.cx / s), unmy(best.cy / s)],
      bounds: [unmx((best.cx - width / 2) / s), unmy((best.cy + height / 2) / s), unmx((best.cx + width / 2) / s), unmy((best.cy - height / 2) / s)],
      side: best.side,
      shiftPx: Math.round(Math.hypot(best.cx - pcx, best.cy - pcy)),
    };
  }
  return null;
}
