# map-data — 군산 지도 데이터(OpenStreetMap)

군산 블로그 글의 지도 자리에 넣을 그림을 앱이 직접 그릴 때 쓰는 바탕 데이터입니다(카카오 · 네이버 지도는 이용 조건 때문에 쓰지 않습니다).
그리기는 데스크톱 앱의 메인 프로세스가 오프스크린 창에서 합니다(`electron/mapRender.cjs`, `electron/map/`). 바깥 지도 · 글꼴 서버는 부르지 않습니다.

## 파일

| 파일 | 내용 |
|---|---|
| `gunsan-20261103.pmtiles` | PMTiles v3 벡터 타일(17,723,203바이트). 설치본에는 `resources/map/gunsan.pmtiles`로 들어갑니다(asar 밖 — Range로 읽습니다). |
| `NOTICE-OSM.txt` | ODbL 알림 + 지도 라이브러리(maplibre-gl · pmtiles · fflate) 라이선스 글, 끝에 maplibre-gl에 함께 묶인 의존 라이브러리 24개의 라이선스 원문(`[BEGIN …]` ~ `[END …]`, 손으로 고치지 않음). 설치본 `resources/map/NOTICE-OSM.txt`. |
| `pmtiles.LICENSE.txt` | pmtiles 라이선스 글(npm 묶음에 LICENSE 파일이 없어 따로 둠). 설치본 `dist-electron/map-vendor/pmtiles.LICENSE.txt`에도 복사합니다. 저작권자 줄은 아직 TODO입니다 — 채우기 전에는 설치본을 만들 수 없습니다(아래 「라이선스」). |

## 어떻게 만들었나

- 원본: Protomaps Basemap 일일 빌드 `20261103.pmtiles`(basemap 4.15.2, OpenStreetMap 2026-11-03 04:00 UTC 기준, planetiler 0.10.2).
  Protomaps 일일 빌드 목록에 적힌 원본 크기는 139,266,691,175바이트, md5 `H1NTaGGlxP+Af8Wa15gIVQ==`입니다.
- 범위: 동경 126.28–126.92, 북위 35.70–36.07, 줌 0–15(군산시 전체 + 새만금 · 고군산 · 금강 건너).
- 방법: `scripts/map-data/extract-gunsan.mjs <원본 주소> <출력>` — 원본의 디렉터리를 읽어 상자 안 타일 본문만 Range로 받고(동시 요청 없음),
  본문은 바꾸지 않고(gzip MVT 그대로) 새 PMTiles v3 파일로 씁니다. 같은 본문은 한 번만 넣습니다.
- 결과: 타일 3,487장(본문 2,482개), 레이어 boundaries · buildings · earth · landcover · landuse · places · pois · roads · water.
- sha256: `50c25efc72af917d17794cd3b00bf08de7b714761d4038ec14e6869843bdbdec` (`scripts/verify-map-render.ts`가 확인합니다).

## 확인

```
node scripts/map-data/verify-extract.mjs map-data/gunsan-20261103.pmtiles              # 이 PC 안에서만: 모든 타일 읽기 · gzip 풀기 · MVT 첫 바이트
node scripts/map-data/verify-extract.mjs map-data/gunsan-20261103.pmtiles <원본 주소>  # 표본 40장을 원본과 바이트 비교(바깥 요청)
```

2026-11-05 이 PC 안 확인: 읽음 3,487 · 빠짐 0 · MVT 아님 0.

## 바꿀 때

- 지도 데이터는 `extraResources`(asar 밖)입니다. 설치본(CI `release-desktop`)에 들어가고, `patch:asar`(`scripts/patch-installed-asar.ts`)도 포터블 zip의 `resources/map/`을 asar보다 먼저 옮깁니다(바뀐 파일만, 옛 파일은 `<이름>.v<옛 버전>.bak`, 옮기지 못하면 asar를 바꾸지 않고 멈춤 — `scripts/verify-patch-asar.ts`). 지도 데이터 파일이 없는 설치본은 지도를 그리지 않고 「지도 데이터 파일이 없어요」로 알립니다(`no-map-data`).
- 파일 이름(빌드 날짜)을 바꾸면 `electron-builder.yml`의 `extraResources`, `electron/mapRender.cjs`(개발 경로), `NOTICE-OSM.txt`, `scripts/verify-map-render.ts`(크기 · sha256)도 함께 고칩니다.
- 공군기지 상자(AVOID)와 데이터 범위(COVER)는 `electron/mapRender.cjs`에 있습니다. 범위를 넓히면 COVER도 맞춥니다.

## 라이선스

- `scripts/build-electron-server.mjs`(설치본 재료 만들기 — `electron:pack`)는 먼저 `scripts/map-data/notice.mjs`로 알림을 검사합니다. 자리 글자(「<저작권자 확인 필요>」 · `TODO(`)가 `NOTICE-OSM.txt` · `pmtiles.LICENSE.txt`에 남았거나 의존 라이브러리 글이 `node_modules`와 다르면 멈춥니다.
- pmtiles 저작권자 줄: pmtiles 저장소(https://github.com/protomaps/pmtiles)의 LICENSE에서 Copyright 줄을 확인해 두 파일의 「Copyright (c) <저작권자 확인 필요>」 줄을 그대로 바꾸고, TODO 안내 두 줄을 지웁니다(두 파일의 pmtiles 글은 같아야 합니다 — `scripts/verify-map-render.ts`).
- maplibre-gl 판을 올리면 `node scripts/map-data/notice.mjs --write`로 의존 라이브러리 글을 다시 만듭니다.

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright
이 파일은 원본을 상자로 잘라 낸 것이며 내용은 바꾸지 않았습니다. ODbL 1.0으로 이용할 수 있습니다.
지도 그림에는 오른쪽 아래에 「© OpenStreetMap contributors」를 넣습니다.
