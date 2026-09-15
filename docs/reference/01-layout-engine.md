# 01. 레이아웃 엔진 코어 (`scheduler-engine/redesign/`)

> 화면에 카드를 그리기까지의 **모든 좌표·배치 계산**. Vue 의존 0, 순수함수, 테스트 가능.
> 설계 원본 = [REDESIGN.md](../../src/scheduler-engine/REDESIGN.md)(13섹션 잠금 모델 — §13 은 설계↔라이브 divergence). 본 문서는 라이브 코드 기준 요약.
> 기준: `main` @ `05a56f4` (2026-09-15)

---

## 1. 파일 4개와 책임

| 파일 | 책임 | 주요 export |
|------|------|------------|
| `layoutTypes.ts` | 타입 계약(입출력 DTO) | `LayoutConfig`(SSOT), `Unit`, `BandSpec`/`BandInfo`, `Rect`, `DataType`, `LayoutMode` |
| `layoutCore.ts` | 저수준 순수함수 | `computeBudget`, `maxConcurrent`(sweep-line), `arrangeCards`(★배치 마스터), `packPages`, `buildPageColumns`, `isLongerCard`(열 선택용 길이 비교), `EMPTY_LANE_STACK_CAP` |
| `layoutPipeline.ts` | end-to-end 합성 + 좌표/밴드/카드폭 | `deriveLayoutConfig`, `buildUnitSequence`, `resolveUnitHours`(운영시간 폴백 체인), `computeOperatingRange`, `computeBandHeights`, `computeRects`, `runLayout` |
| `runLayoutAdapter.ts` | store shape → 엔진 입력 변환 | `buildRunLayoutInput`, `resolveDoctorKey`(조인키), `dailyScheduleToUnitHours`/`workRowToUnitHours`, `unitKeyOf`(컬럼 키 — 상태 칩 집계도 이걸 쓴다) |

진입점은 **`runLayout(input)`** 단 하나. 페이지는 `v3StoreInput.buildStoreRunLayoutInput()` 로 input 을 만들어 호출한다.

---

## 2. `runLayout` 파이프라인 (단방향 — 사이클 금지)

```
runLayout(RunLayoutInput)
 1. deriveLayoutConfig()      → LayoutConfig (모든 입력 1회 정규화·검증, SSOT)
 2. buildUnitSequence()       → Unit[] {date, doctorId, slots}
 3. packPages()               → Page[] {slotStart, slotEnd}  (글로벌 sub-col 시퀀스를 budget 칸씩 분할, carry-over)
 4. 윈도우 선택               → slotOffset(date-anchored)
 5. buildPageColumns()        → PageColumn[] (페이지 범위와 겹치는 unit 조각)
 6. computeColumnPixels()     → 컬럼 leftPx/widthPx (APPOINTMENT=budget 고정, TREATMENT=stretch)
 7. 컬럼별 arrangeCards()     → placed/floating/expandedRows (페이지 조각만으로 재산정)
 8. computeOperatingRange()   → bands[] (운영시간 union + 휴게 + apptEnvelope 확장)
 9. computeBandHeights()      → BandInfo[] (band 별 maxRows × rowHeight + topPx 누적)
10. computeRects()            → Rect[] {top,left,width,height,z,isFloating,isLayered,isLayerBase,isLongCard}   ★최종 좌표
```

**핵심 잠금 규칙**: 날짜 수(day-count)는 별도 공식이 아니라 unit 패킹의 **결과로 emerge** 한다. `데이터 → slots → 패킹 → cols` 단방향, 역참조 없음.

---

## 3. 카드폭·배치 — 가장 민감한 부분 (★불변식)

### 3-1. 카드폭 = 항상 레인폭 (expand 거부 확정)
`computeRects` 내부:
```
subColWidth = col.widthPx / col.subColCount         # 레인 1칸 폭
left  = col.leftPx + (m.column − col.subColStart) × subColWidth (+ base indent)
width = subColWidth − CARD_RIGHT_GAP (− base indent) − subColWidth × CARD_ADD_STRIP_RATIO
width = max(MIN_CARD_WIDTH, width)
```
- 카드는 **항상 정확히 1레인 폭.** "혼자=풀폭" expand 는 상세 검토 후 **최종 거부**(N칸보기 엄수, 풀폭 금지).
- **모든 카드 우측 strip**(`CARD_ADD_STRIP_RATIO`, 레인폭 대비 비율): 카드를 그만큼 좁혀, 그 자리 그리드 셀 hover 시 **+추가**가 노출됨(점유 시간대에도 N=1 추가 가능, 별도 버튼 없음).

### 3-2. floating (겹침 초과분)
- 같은 시각에 칸수보다 예약이 많으면, 가장 긴 base 위에 **floating** 으로 얹힘.
- floating = **레인폭 그대로** + `localRow` 세로 스택(`Z_FLOAT`). 폭 축소는 **폐지됨**(계단식 축소가 지저분하다는 지적으로 제거).
- 단 **들여쓰기는 남아 있다** — floating 중 실제로 다른 카드와 겹치는 것(`isLayered`)만 들여씀(상한 = 레인폭×0.5). `computeRects`(`layerDepthOf`/`FLOAT_INDENT_PX`). 겹치지 않는 floating 은 indent 0.
- ⭐들여쓰기는 **층수(`layerDepth`)만큼의 계단**이다 — `under(c, x)` = 렌더 겹침 && (`c` 가 더 길거나, **길이가 같으면 `c` 가 먼저 시작**), `layerDepth` = under 인 카드들의 **depth 최댓값 + 1**(없으면 0). (길이 desc, 시작 asc) 순회 1패스라 아래 카드의 depth 가 항상 먼저 확정된다.
  - ⚠️ **종전 정의("겹치는 더 긴 카드들의 서로 다른 duration 개수")로 되돌리지 말 것.** 길이가 같고 시작만 다른 쌍이 동률이 돼 **같은 `left`·같은 폭으로 포개졌다**.
  - 배치용 `isLongerCard`(`layoutCore.ts`)와 **정의가 다르다** — 시작 시각 tie-break 는 층 판정에만 있다. 기준을 바꾸려면 두 곳을 함께 본다([REDESIGN §5](../../src/scheduler-engine/REDESIGN.md)).
- 얹힘이 생긴 sub-col 에서 **밑에 깔린 카드 전부**가 `isLayerBase` 로 표시된다 — `computeRects` 가 `isLayered`·`layerDepth` 와 한 번에 산출한다. 3층 스택이면 index0 뿐 아니라 **중간층 index1 도 true** 다.
  - ⭐**좌측 세로 바는 `isLayerBase` 단독이 아니다** — `isLongCard` 와 **둘 다**일 때만 그린다([03 §1](03-card-css-and-portal.md)). `isLayerBase` 단독 조건은 **리사이즈 핸들 포털**이 쓰므로 두 플래그를 합치지 말 것.
- ⭐**`isLongCard`(긴 예약) = 꼬리가 '다른 예약이 시작하는 band' 를 지나가는가** — 판정은 `passesOtherRows`(누적합 `rowBandPrefix` 로 O(1)). **밴드 관통(`startIdx ≠ endIdx`)이 아니다**: band 는 `cellDuration` 단위라 10분 그리드에선 30분 예약도 3밴드를 걸쳐 **전 카드가 긴 예약이 된다**. 기준은 그리드가 아니라 이웃이다.
- ⭐**layering 판정 기준은 시간(분) 겹침이 아니라 렌더 겹침**이다. `computeRects` 는 컬럼당 3-pass — ①세로(`top`/`height`) → ②layering 판정(①의 `top`/`height` 로 겹침 계산) → ③가로(`left`/`width`). 가로는 세로에 영향을 주지 않아 순환이 없다.
  - 이유 = 관통(multi-band) 카드 height 정밀화가 긴 카드를 `endBand` 진입 직전까지 자르면 화면에서는 두 카드가 위아래로 나란히 놓인다. 분 단위로만 보면 여전히 겹쳐서, 겹치지도 않은 카드에 들여쓰기·그림자·마커가 붙었다(실제 제보 버그).
  - 단 "**더 긴** 예약 위 얹힘만 layering" 의 길이 비교는 **duration 기준을 유지**한다 — 렌더 `height` 는 band 구성에 따라 같은 길이도 달라져 기준으로 쓸 수 없다.
- ⭐**관통(multi-band) 카드의 꼬리는 `endBand` 의 마지막 행까지 그린다** (`blockedAtRow`). 11:30~12:30 이면 12:30 밴드의 **마지막 예약까지** 길어져야 한다. 밴드 하단 여백(`EMPTY_ROW_GAP_PX`)은 그 시간대에 예약을 추가하는 클릭 자리라 꼬리에 포함하지 않는다 → **카드 바닥 = 마지막 행 바닥.**
  - 자르는 경우는 하나뿐 — 같은 레인에서 **시간이 겹치지 않는** 카드가 그 band 에서 시작하면 그중 **최소 `localRow` 직전**까지만 그린다. row 0 이면 `endBand` 진입 직전.
  - **시간이 겹치는 카드는 절단 사유가 아니다** — `arrangeCards` 불변식상 그건 항상 float 라 꼬리 위에 얹히고, layering pass 가 들여쓰기·마커로 처리한다. 여기서 잘라 버리면 10:30~11:30 예약이 11:00 에서 끝난 것처럼 보이고 layering 도 사라진다(실제 제보 버그).
- floating 은 columns[] 를 갱신하지 않음(남의 자리 안 뺏음).

### 3-3. `arrangeCards` (배치 마스터, `layoutCore.ts`)
- 정렬: `startMin` asc, `dur` DESC(긴 예약 우선).
- startMin 그룹화 → 빈 칸(`endMin ≤ startMin`)에 placeBase, 부족분은 floatPlace.
- ⭐**floatPlace 열 선택 1순위 = 그 칸에서 시간이 겹치는 '더 긴' 카드 수(`isLongerCard`)**. **짧은 예약은 빈 칸이 남아 있는 한 긴 예약 위에 얹지 않는다.** 대가는 그 칸의 스택이 깊어지는 만큼 밴드가 두꺼워지는 것이고, 상한이 `EMPTY_LANE_STACK_CAP`(기본 무제한 = 명세 그대로). 비용은 **N 을 좁혔을 때와 페이지 경계 압축(`subColCount < unitSlots`)** 에서만 난다.
- `expandedRows[startMin]` = base+float 깊이 → band 높이 산정에 사용.
- **누락 카드 0 보장**(안전망: 미배치분 floating 강제).

---

## 4. 핵심 상수 (`layoutPipeline.ts`) — 값은 코드를 연다

| 상수 | 의미 |
|------|----|
| `CARD_RIGHT_GAP` | 모든 카드 우측 gap |
| `CARD_ADD_STRIP_RATIO` | 우측 +추가 strip 비율(레인폭 대비) ★불변식 |
| `INDENT_PX` | base level 계단 들여쓰기(상한 = 레인폭×0.5) |
| `FLOAT_INDENT_PX` | 겹친 floating(`isLayered`) **한 층당** 들여쓰기 — `layerDepth` 배(상한 = 레인폭×0.5) |
| `Z_BASE` / `Z_FLOAT` | 기본/플로팅 z-index (2단계뿐) |
| `MIN_CARD_WIDTH` | 최소 카드폭 클램프 |
| `ROW_HEIGHT_BY_LEVEL` | rowHeightLevel 별 카드 1행 px (설정 영속값과 단일 소스) |
| `BREAK_BAND_RATIO` | 휴게/비운영 band 축소 비율 |
| `EMPTY_ROW_GAP_PX` | **카드가 걸친 band 전부**의 하단 빈 영역(추가 클릭·드롭 자리) 높이 — 시작 카드가 없어도 **관통만 하면** 붙는다(`BandInfo.hasGap`). **카드 높이 설정과 무관한 고정값** — 예전엔 '+1행'이라 큰 레벨에서 보드가 늘어졌다 |
| `EMPTY_LANE_STACK_CAP` | (`layoutCore.ts`) 긴 예약 회피(§3-3)로 한 칸에 쌓을 수 있는 스택 상한. 낮추면 종전 분산 배치로 되돌아간다 |
| `DEFAULT_OPERATING_START_MIN/END_MIN` | 운영시간 fallback. **정의는 `src/constants/operatingHours.ts`** — 예약검증(`useSchedulerRules`)과 같은 값이어야 해서 `'HH:mm'` 문자열에서 분을 파생시킨다. 여기서 숫자를 따로 적지 말 것(갈리면 밴드는 열렸는데 클릭이 막힌다) |
| `HORIZON_DAYS` | APPOINTMENT 모드 forward 지평 |
| `VALID_CELL_DURATIONS` | 허용 timeUnit (30 하드코딩 전부 제거됨) |
| budget 식 | `computeBudget`(`layoutCore.ts`) — 보기단계(zoom) → 컬럼 예산, 하한·상한 클램프 |

---

## 5. APPOINTMENT vs TREATMENT 분기 — 엔진 차원

동일 알고리즘, **입력 2개만 다름**:

| 분기점 | APPOINTMENT | TREATMENT |
|--------|------|------|
| `buildUnitSequence` horizon | `HORIZON_DAYS` forward | `1`일(selectedDate 만) |
| `computeColumnPixels` stretch | `false`(budget 고정, 잔여 우측은 다음 unit) | `true`(컬럼 full-width 펴기, empty 제거) |
| unit 칸수 모델 | `LayoutMode='A'` 기본=`min(maxConcurrent, slotDivision)` / `'B2'`=`slotDivision` 고정 | 동일 |

> ⚠️ TREATMENT stretch + 카드폭 strip 의 상호작용은 별도 케이스 점검 대상(0폭 엣지).

---

## 6. "여기 고치면 저기 바뀐다" 영향 맵

| 바꾸는 곳 | 함께 바뀌는 것 | 먼저 확인 |
|----------|---------------|----------|
| `CARD_RIGHT_GAP` / `CARD_ADD_STRIP_RATIO` | **모든 카드 width** + strip hover-add 영역 | 골든 테스트 width 단언 갱신 |
| `INDENT_PX` | base 카드 left↑·width↓ (floating 무관) | indent 상한(레인폭×0.5) |
| `ROW_HEIGHT_BY_LEVEL` | 카드 height + band 누적 topPx 전부 | 설정 영속값(`reservationSettingStore`)과 SSOT 일치 |
| `EMPTY_ROW_GAP_PX` | 예약 있는 band 높이 → 그 아래 모든 band topPx | 보드 전체 세로 길이(DOM 실측으로 확인) |
| `arrangeCards` 알고리즘 | placed/floating 분류 → z·width·band 높이 | 골든 G-arrange-1/2/3 |
| `computeColumnPixels` stretch | 모든 컬럼 widthPx | TREATMENT 모드 별도 눈검증 |
| `cellDuration`(timeUnit) | band 경계·`maxConcurrent`·snap·grid·NowIndicator | 30 하드코딩 잔재 없는지 |
| `budget`(totalColumns/viewStep) | 페이징·표시 일자수·carry-over | navSlots 페이징([02](02-page-and-interactions.md)) |
| `resolveDoctorKey`(runLayoutAdapter) | 예약↔컬럼 조인(현재=이름) | 담당자 이름 중복 시 컬럼이 합쳐진다 |
| `resolveUnitHours` 우선순위 | band 가 열리는 시간 전부 + 예약검증과의 동치 | `schedulerOpenHours.contract.test.ts` |

---

## 7. 주의·예외·특이사항

- **조인 키 전환 준비됨**: `resolveDoctorKey()` 는 이미 `doctorId 우선 → 없으면 doctorName` 형태. 안정 ID 도입 시 이 한 함수(+ `dragResultAdapter` 의 `resolveDoctorName`)만 교체.
- **운영시간 소스 2종**: `dailyScheduleToUnitHours`(사업장 weekly + 휴게 split) / `workRowToUnitHours`(담당자 기본 운영시간 **단일 구간**에서 사업장 휴게를 차감). 그룹핑 모드 `name`(이름) vs `team`(팀)으로 갈림.
- ⭐**어느 시간으로 band 를 열지는 `resolveUnitHours`(`layoutPipeline.ts`) 한 함수가 정한다** — 담당자 특정일자 → 담당자 요일(휴게만 사업장 지정일자·공휴일 값으로 교체) → 사업장 지정일자 → 공휴일 → **기본값**. 규범(무엇이 무엇을 이기나)의 순수함수 = `src/pages/desktop/scheduleBoard/offDayRules.ts`.
  - 예약검증(`useSchedulerRules`)이 같은 상황에 **같은 답**을 내야 한다 — 갈리면 "밴드는 열려 있는데 클릭하면 운영시간 밖"이 된다(실제 사고). 자료구조가 달라 함수를 합칠 수 없으므로 동치성은 계약 테스트가 지킨다([04 §1](04-testing-and-verification.md)).
- **operatingRange 역전 방어**: `minStart >= maxEnd` 면 기본값 fallback. 운영시간 밖 예약은 `apptEnvelope` 로 range 확장.
- **페이지 조각의 expandedRows 재계산**: 페이지에 안 보이는 칸의 스택이 band 높이를 과대하게 키우는 것 방지(페이지 카드만으로 재산정).
