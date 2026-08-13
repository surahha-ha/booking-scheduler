# V2 스케줄러 엔진 코어 재설계 설계서 (A-1)

> 본 문서는 장부설정(예약장부/진료일정)을 base 로 하는 V2 스케줄러 **엔진 코어 재구현**의 단일 기준이다.
> 화면정의서(명세) + `book_20260529.html` 프로토타입(레퍼런스 구현)을 종합해 확정했다.
> **원칙: 명세 > 프로토타입.** 프로토타입은 알고리즘 형태의 레퍼런스이며, 아래 §10의 버그/divergence 는 따르지 않는다.
>
> 본 문서는 **설계서**이며, 구현과 갈린 결정은 **§13** 에 모아 두었다.
> 설계와 라이브가 어긋나면 **라이브가 옳다** — §13 을 먼저 볼 것.

---

## 0. 범위

- **재구현 대상(엔진 코어)**: day-count/페이징 산출, operatingRange(band), unit colspan 분배, 카드 배치(placed/floating), rect/z 계산, 보기단계·N칸·row높이 반영.
- **재사용(셸/인프라)**: stores(book/staff/filter/customer), adapters, ReservationPopup, SchedulerSearchFilter, 컴포넌트 셸(Panel/Header/TimeAxis/Grid/Layer/NowIndicator), 인터랙션 state machine(drag/resize/hover/popover/scrollSync) — 좌표/필드 조정만.

## 1. 안전 원칙 (블래스트 반경 봉쇄)

1. **단일 불변 `LayoutConfig`** — 모든 입력을 정해진 순서로 top-down 1회 산출. 하위는 여기서만 읽음 → 사이클 차단.
2. **순수함수 파이프라인** — reactive 읽기 0, 결정적, 스냅샷 테스트 가능.
3. **골든마스터** — 프로토타입 `arrangeCards` 동작 = 타겟 기준(§11).
4. **경계 검증** — LayoutConfig 진입점에서 범위 검증(loud fail).
5. **명세 > 프로토타입.**

## 2. 입력 계약 — `LayoutConfig` (SSOT)

```
LayoutConfig = {
  // ── 예약장부 설정 (DB 저장, reservationSettingStore ← /book/v2/reservation/settings) ──
  cellDuration: 10|15|20|30|45|60       // = TIME_UNIT_MIN
  totalColumns: 6..10                    // = TOTAL_COL_CNT (예산 중앙값)
  displayInfo: DisplayField[]            // 순서 보존, [0]=NAME 고정. (가상 field: DISP_ORDER)
  rowHeightLevel: 1|2|3|4|5              // 카드 HEIGHT(=정보 줄 수). (가상 field: ROW_HEIGHT_LEVEL)
  // ── 진료일정 설정 (staffStore ← effective-rules + work-hours) ──
  hours: { [weekday|doctorId]: { 오전?, 오후?, 야간?, 점심?, 저녁? } }   // 세션 + 휴게
  closed: { offRules[], dateOverrides[], holidays[] }
  // ── 라이브 뷰 상태 (DB 저장 X) ──
  dataType: 'APPOINTMENT' | 'TREATMENT'
  selectedDate: 'YYYY-MM-DD'
  viewStep: 1|2|3|4|5                    // 보기단계(zoom) = 컬럼 예산 ±2/step
  slotDivision: number                   // N칸보기 (unit 칸수 cap)
  customSlots: { [key]: number }         // 칸수조절 드래그 override (state-only)
  doctorPageIdx: number                  // 의사컬럼 페이지
  // ── 필터 ──
  selectedDoctorIds: string[]            // [] = 전체
  // ── 환경 ──
  availableWidth: number
}
```

경계 검증: `cellDuration ∈ {10,15,20,30,45,60}`, `totalColumns ∈ [6,10]`, `viewStep ∈ [1,5]`, `rowHeightLevel ∈ [1,5]`.

## 3. 보기단계 / N칸 / row높이 (width ↔ height 분리)

| 컨트롤 | 영향 | 저장 |
|--------|------|------|
| **보기단계(viewStep)** | 컬럼 **예산(width)**: `budget = totalColumns + 2×(3 - viewStep)` → 범위 **[2,14]** | 라이브 |
| **N칸보기(slotDivision)** | unit(날짜·의사) 내부 **colspan(width)** cap | 라이브 |
| **row 높이(rowHeightLevel)** | 카드 **HEIGHT** = 정보 1~5줄 | **DB 저장** |

- width(컬럼/colspan) ↔ height(정보 줄 수)는 **독립**.
- 인위적 `budget<4→4` 클램프 없음(프로토 버그). `totalColumns∈[6,10]` + `±2×(3-step)`이면 자연히 [2,14].

## 4. 파생 파이프라인 (단방향 — 사이클 금지)

```
1. cellDuration = TIME_UNIT_MIN
2. budget       = clamp(totalColumns + 2×(3 - viewStep), 2, 14)
3. units        = buildUnitSequence()   // (날짜,의사) 시퀀스, selectedDate부터 forward
                    unit.slots = customSlots[key] ?? min(maxConcurrent(cellDuration 기준), slotDivision), 최소 1
4. pages        = sub-column 연속 패킹(units, budget): 모든 unit.slots 를 글로벌 시퀀스로 펼쳐
                    budget 칸씩 분할. unit 칸수가 budget 초과 시 그 unit 이 여러 페이지에 carry-over(압축 아님).
                    Page = {slotStart, slotEnd}(글로벌 sub-col 범위).
5. cols         = 윈도우 선택 → 컬럼들 {unitIndex,subColStart,subColCount,slotsStartIdx,unitSlots}
                    라이브는 date-anchored `slotOffset` 이 기본, `doctorPageIdx` 는 구 경로 fallback(§13).
                    경계에 걸친 unit 은 부분 sub-col. 잔여 칸 우측은 다음 unit(다음 의사/요일) 이 이어짐.
6. operatingRange = union(cols 의 날짜×의사 진료시간 세션) + 휴게 band
7. bands        = operatingRange / cellDuration   (휴게 band 축소)
8. perUnit 배치 = arrangeCards(unitAppts, unit.slots) → {placed, floating, expandedRows}   (§5)
9. bandHeights  = maxRows(=expandedRows 반영) × rowHeight(rowHeightLevel)
10. rects       = (placed/floating, bands, cols) → {top,left,width,height,z}   (floating 폭 축소는 폐기 — §13)
```

**사이클 차단**: 날짜수는 별도 공식이 아니라 ④ unit 패킹의 **결과**로 emerge. unit.slots 는 데이터(maxConcurrent)에 의존하나 단방향(`데이터 → slots → 패킹 → cols`). 역방향 없음.

**진료/예약 통합**: 동일 알고리즘. 진료=1일(units 모두 selectedDate), 예약=N일. 프로토타입의 `docLayout`(진료 비율축소)은 **사용 안 함**(§10-D).

**페이징 2종(보드 영역)**:
- 날짜 `< >` = ±(보이는 일자 수).
- 의사컬럼 `< >` = `doctorPageIdx` ±1 (unit 페이징, 진료=예약 동일).

## 5. 카드 배치 — `arrangeCards(cards, subColumnCount)` (프로토 31879 기준 포팅)

```
입력: cards[{id,startMin,endMin,dur}], subColumnCount(= 그 unit 칸수)
출력: { placed[{id,column,subRow}], floating[{id,column,floatOverId,subRow}], expandedRows{startMin:depth} }
원칙:
  1) 모든 카드는 placed 또는 floating (누락 금지)
  2) floating 은 columns[] 갱신 안 함 (남의 자리 안 뺏음)
  3) 우선순위: 일반배치 → row확장(같은 startTime이 칸수 초과) → floating(다른 startTime이 끼어듦)
알고리즘:
  - 정렬: startMin asc, dur DESC
  - startMin 그룹화. 각 그룹:
    · availableCols = endMin ≤ startMin 인 빈 칸
    · 그룹이 빈 칸에 들어가면 → 일반배치(placeBase)
    · 부족하면 → 가장 긴 카드 base, 나머지 floatPlace(가장 긴 occupying 카드 위)
    · subRow 스택 + expandedRows[startMin] = base+float 깊이
floating 조건(명세 확정): 같은 시작/종료끼리는 겹침 없이 나란히/스택.
  time 영역에 가장 긴 예약이 있고 그 span 안에 다른-시작 예약이 빈 칸 없이 겹칠 때만 그 위에 floating.
```

## 6. z-index (연속 duration z 아님)

설계 의도는 "연속 duration z" 폐기였고, 라이브는 그것을 **2단계 상수**로 단순화해 실현했다.

```
base 카드 : Z_BASE  = 0        (layoutPipeline.ts)
floating  : Z_FLOAT = 10       (computeRects 에서 부여)
NowIndicator/popover/handles : 카드 z 대역 위 예약(컴포넌트 CSS 상수 — scheduler/CLAUDE.md 「Z-index 정책」)
```

- 설계에 있던 **floating width −10px** 와 **이동/하이라이트 z=15** 는 라이브에 없다(§13).
- 겹친 floating 의 좌측 들여쓰기(`FLOAT_INDENT_PX=10`)는 z 가 아니라 **left/width** 로 처리된다(`computeRects`).

## 7. cellDuration 동적화 (프로토 버그 A 수정)

- band 경계·동시예약(maxConcurrent) 계산·drag/resize snap·isPast 판정의 **모든 `30` 하드코딩을 `cellDuration` 로 치환**. timeUnit=10/20/45/60 정합.

## 8. 순수함수 시그니처

라이브 실측(`redesign/`, 2026-07-24). 설계안과 이름·인자가 갈린 곳은 **라이브 기준**으로 적는다.

```ts
// layoutPipeline.ts
deriveLayoutConfig(settings, site, viewState, ...): LayoutConfig
buildUnitSequence(cfg, doctors, apptsByUnitKey): Unit[]     // (날짜,의사) + slots
computeOperatingRange(cfg, units, apptEnvelope?): { bands, breaks }
computeBandHeights(perUnit, bands, rowHeightLevel): BandInfo[]
computeRects(columns, bandInfos, rowHeightLevel, ...): Rect[]   // z = §6
runLayout(input): { columns, bandInfos, rects }             // ★진입점(설계안엔 없던 합성 함수)

// layoutCore.ts
computeBudget(totalColumns, viewStep): number               // §3 — cfg 가 아니라 값 2개
arrangeCards(cards, subColumnCount): { placed, floating, expandedRows }   // §5
packPages(units, budget): Page[]                            // sub-col 연속 분할(글로벌 slot, carry-over)
buildPageColumns(units, page): PageColumn[]                 // 설계안의 buildColumns
```

## 9. 데이터 의존성 핫스팟 (변경 시 광범위 — 주의)

- `cellDuration`: band·동시예약·snap·grid·NowIndicator (~8곳)
- `totalColumns`/`viewStep`: budget → 페이징/colspan/표시 일자수
- `slotDivision`: unit 칸수 → arrangeCards/floating
- 의사 필터: units/페이징/operatingRange/휴진맵

## 10. 프로토타입 대비 수정사항 (맹신 금지)

| # | 프로토타입 | 처리 |
|---|-----------|------|
| A | `round(dur/30)` 30분 하드코딩 | 🔴 `cellDuration` 로 치환 |
| B | viewStep = 컬럼 수만 | row높이(정보 줄수)는 **별도 rowHeightLevel(DB)** 로 분리 |
| C | horizon=90, maxUnits, default cap 3 등 매직넘버 | 상수화/정리 (cap=slotDivision) |
| D | 진료 `docLayout`(비율축소) | **폐기** — 진료도 unit 패킹+페이징(예약과 동일) |
| E | budget `v<4→4` 클램프 | **폐기** — 범위 [2,14] |
| F | floating z 일괄 10 | level/subRow 기반 보강 |

## 11. 골든마스터 픽스처 (A-2)

- 변경 부분(arrangeCards/packPages/budget): **프로토 동작을 타겟으로 신규 단언**.
  - G-arrange-1: 같은 startMin, 칸수 내 → 나란히(floating 0)
  - G-arrange-2: 칸수 초과 같은 startMin → row확장(expandedRows)
  - G-arrange-3: 긴 예약 + 다른-시작 겹침 → floating (폭 축소는 폐기 — §13)
  - G-pack-1: 일자별 slots 누적 → 페이지 분할(마지막 압축)
  - G-budget: totalColumns×viewStep → [2,14] 매핑(11-1 표)
- 안 변하는 부분(헤더/날짜빌더): 현재 V2 출력 스냅샷 유지.

## 12. 후속/통합 미결

- ~~**BE 가상 field 2개**: `DISP_ORDER`, `ROW_HEIGHT_LEVEL`~~ → **해결됨**. `settings.cardHeightLevel` / `settings.displayInfo` 로 BE 영속 중(`layoutPipeline.ts` 의 `rowHeightLevel`/`displayInfo` 정규화).
- **데이터 로딩 윈도우**: unit 패킹이 forward 날짜를 소비 → bookStore 조회 범위 가변(페이지 채울 만큼).
- **검색 인덱스**: `예약 테이블 (tenantId, delYn, startAt)` (recent 검색 perf).
- **나이/성별/생년월일**: 회원정보 보강(통합회원만), 서버측 배치+캐시.
- **성능**: 순수함수 + 메모이제이션으로 reactive 재계산 봉쇄.

## 13. 설계 → 라이브 divergence (2026-07-24 대조)

설계 확정 후 구현 과정에서 **의도적으로 바뀌거나 폐기된** 결정들. 위 본문을 SSOT 로 읽되, 아래는 라이브가 이긴다.

| 설계(§) | 설계안 | 라이브 | 사유 |
|---|---|---|---|
| §4·§6·§11 | floating **width −10px** 축소 | **폐기** (`FLOAT_SHRINK` 없음) | 계단식 축소가 지저분하다는 지적 |
| §6 | base z = `auto`(DOM 순서) | `Z_BASE = 0` 명시값 | 2단계 상수로 단순화 |
| §6 | 이동/하이라이트 z = `15` | **미구현** | 카드 z 대역은 base/float 2단계뿐 |
| §10-F | floating z 를 level/subRow 기반으로 보강 | **미구현** (일괄 `Z_FLOAT=10`) | 2단계로 충분했음 |
| (설계 없음) | — | 겹친 floating `FLOAT_INDENT_PX=10`px 들여쓰기 | 겹칠 때 하단 카드 식별용으로 신설 |
| §4-5 | `pages[doctorPageIdx]` 로 윈도우 선택 | date-anchored **`slotOffset`** 이 기본, `doctorPageIdx` 는 구 경로 fallback | 재조회로 밀도 변해도 좌측 날짜 안 끌리게 |
| §2 | `cellDuration ∈ {10,20,30,45,60}` | **`15` 추가** | 허용 timeUnit 확장 |
| §8 | `computeBudget(cfg)` / `buildColumns` | `computeBudget(totalColumns, viewStep)` / `buildPageColumns` | 순수함수 인자 최소화 |
| (설계 없음) | — | `CARD_ADD_STRIP_RATIO` 우측 strip (22%→10%→**3%**) | hover +추가 노출 영역 확보 |

> 이 표는 **설계 이력을 지우지 않기 위한** 것이다. 본문에서 폐기된 항목을 삭제하지 않고 여기로 연결한 이유이기도 하다.
