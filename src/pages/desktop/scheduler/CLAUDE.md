# 스케줄러 공용 UI 라이브러리 (UI/인터랙션 레이어)

> 본 문서는 `src/pages/desktop/scheduler/` 디렉토리 작업 시 자동 로드된다.
> 전체 개요와 절대 원칙은 [프로젝트 루트 CLAUDE.md](../../../../CLAUDE.md) 참조.
> 계산 엔진은 [src/scheduler-engine/CLAUDE.md](../../../scheduler-engine/CLAUDE.md) 참조.
>
> ⚠️ **이 디렉토리는 페이지가 아니라 공용 라이브러리다.** 활성 페이지(오케스트레이터)는
> `src/pages/desktop/scheduler-v3/SchedulerV3Page.vue`(`/book`)이며, 여기의 components/composables/adapters 를 조합해 쓴다.

---

## 📁 파일 구조

```
src/pages/desktop/scheduler/
├── appointmentCardMenu.ts           # 카드 ⋮ 메뉴 정의 (항목·활성 여부·API state 매핑) — 유일한 정의처
├── __tests__/                       # ⋮ 메뉴 매트릭스 회귀 · hover 이탈 순서
├── adapters/
│   ├── appointmentAdapter.ts        # raw 예약 → EngineAppointment (읽기)
│   └── dragResultAdapter.ts         # drag/resize 결과 → BookItemRequest (쓰기)
├── components/
│   ├── SchedulerHeader.vue          # 다중 행 헤더 (날짜 > 담당자)
│   ├── SchedulerTimeAxis.vue        # 시간축 + NowIndicator 라벨
│   ├── SchedulerGrid.vue            # 배경 그리드 + 셀 상태
│   ├── SchedulerDateStrip.vue       # 줄달력(날짜 스트립) — 공휴일·연도 라벨
│   ├── SchedulerToolbar.vue         # N칸 보기 + zoom
│   ├── AppointmentCard.vue          # 예약 카드 + popover
│   ├── AppointmentLayer.vue         # 카드 레이어
│   ├── NowIndicator.vue             # 현재 시각 가로선
│   ├── DragPreview.vue / ResizePreview.vue
│   ├── SubColResizeHandles.vue      # sub-column 폭 조정 핸들
│   └── __tests__/                   # 카드 렌더 · 현재시각선 경계 · 줄달력 공휴일
└── composables/
    ├── useSchedulerNavigation.ts    # 날짜 이동, displayDates
    ├── useSchedulerDrag.ts          # 드래그 상태 머신
    ├── useSchedulerResize.ts        # 리사이즈 상태 머신
    ├── useSchedulerReschedule.ts    # 변경(reschedule) 모드 상태 머신
    ├── useSchedulerHover.ts         # hover 상태
    ├── useSchedulerPopover.ts       # popover 상태
    ├── useSchedulerInteractionLock.ts  # 상호 배제
    ├── useNowIndicator.ts           # 현재 시각선 위치 — 가로선·시간축 라벨 공용 한 벌
    ├── useSubColResize.ts           # sub-column 폭 조정 상태
    └── __tests__/                   # 드롭 길이 보정 · resize 격자 · popover owner · 변경 커밋 순서
```
> 페이지 로컬 어댑터(`v3ParityAdapter`/`v3StoreInput`/`navSlots`)·카드 집계(`boardStatistics`)와 오케스트레이션은 `scheduler-v3/` 에 있다.

## 🔄 재사용 전략 (Store/API 유지 + 렌더링만 커스텀)

### 재사용 (변경 없음)
- `bookStore` — 예약 CRUD, 조회, 상태 변경 (직접 `load()` 호출 금지)
- `staffStore` — 담당자 목록, 운영시간, 휴무 규칙(`hospitalRules`)
- `useSchedulerFilterStore` — 검색 조건 + `searchVersion` + 조회 창(`setWindow`)
- `reservationSettingStore` — 예약장부 설정 / `holidayStore` — 공휴일 / `serviceItemStore` — 서비스 항목
- `useSchedulerRules` — `getBlockedReason` (blocked 판정)
- `ReservationPopup.vue` — 예약 등록/수정 팝업(`UiModal` 기반)
- `SchedulerSearchFilter.vue` — 검색 필터 바 (`scheduleBoard/components/` 에 위치)

### Adapter 패턴
- `appointmentAdapter.ts` — raw `SchedulerAppointment` → `EngineAppointment`
  - `resourceId = doctorName` (이름 기반 그룹핑) → `columnKey = "${date}_${resourceId}"`
  - `delYn==='Y'` 제외
- `dragResultAdapter.ts` — drag/resize 결과 → `BookItemRequest`
  - 담당자는 이름으로 싣는다(`externalStaffNo` 에 이름 — 저장소가 이름→키 변환). 안정 ID 도입 시 `resolveDoctorName` 자리 하나만 바꾼다.

### 커스텀 엔진 전용
- `runLayout` 배치 파이프라인 / N칸 보기 / band 레이아웃 / sub-column·row 배정 / indent + z-index 레이어링 (`scheduler-engine/redesign/layoutPipeline.ts`)

## 📐 N칸 보기

각 날짜(또는 날짜+담당자) 컬럼 내부를 N개의 세로 sub-column 으로 분할한다(1~5).

- 헤더는 변경 없음 (날짜 > 담당자 구조 유지), body 내부만 N열 분할
- 전역 N 은 `slotDivision`(툴바), 컬럼별 예외는 `customSlots` override 가 우선한다 (`SchedulerV3Page.vue`)
- 툴바는 예약 화면에서만 표시 — TREATMENT 화면은 `effectiveSlotDivision` 이 N 을 강제한다

## 🔀 예약 / 방문 화면 분기 (`dataType`)

`APPOINTMENT`(예약장부)와 `TREATMENT`(코드상 "진료" — 완료·미이행·대기 상태를 다루는 방문 장부) 두 모드다. **이 표가 분기 매트릭스의 SSOT** 다. `docs/reference/03` 은 링크만 한다.

| 항목 | APPOINTMENT | TREATMENT |
|------|-------------|-----------|
| zoom(viewStep) | 툴바 슬라이더로 자유 조절 (1~5) | 설정 전체칸 값 강제(`SchedulerV3Page.vue` `viewState`). **1일 표시는 zoom 이 아니라 엔진이 `horizon=1` 로 강제** |
| N칸 보기 + 툴바 | 표시 | 툴바 숨김 + N 강제(`effectiveSlotDivision`) |
| 날짜 max | 제한 없음 | 오늘까지 |
| DateStrip | 오늘 기준 +30일(`headerWindowDays`) | 선택일 기준 -30일, 오늘이 끝 |
| `>` 버튼 | 항상 표시 | 오늘 도달 시 숨김 |
| 상태 필터 | `APPOINTMENT_STATUS_TYPE`: 예약(00) / 취소(03) | `TREATMENT_STATUS_TYPE`: 대기(05) / 완료(01) / 미이행(02) / 취소(03) |
| ⋮ popover | 변경 / 취소 / 초기화 / 예약 삭제 | 접수대기 / 완료 / 미이행 / 취소 / 초기화 / 진료 삭제 |
| hover 퀵액션 | 없음 | 00→접수(05), 05→완료(01) |
| ReservationPopup | 전체 수정 | 과거: 메모만, 현재 이후: 전체 수정 |
| API type | `reservation` | `treatment` |
| viewMode | 항상 DAY (UI 숨김) | 항상 DAY |

상태 라벨 문자열은 `src/messages/ko.json` 의 `terms.status` 가 소유한다(`constants/schedulerSearchFilter.ts` 가 참조). 라벨을 바꾸려면 거기만 고친다.

## 📊 상태코드 매핑

| 코드 | 의미(`terms.status`) | API state | `statusClass`(데이터 값) | 카드 컨테이너 클래스 |
|------|------|-----------|------------------------|--------------------|
| 00 | booked(예약) | — | `is-waiting` | **없음**(기본 스타일) |
| 01 | complete(완료) | `complete` | `is-done` | `status-done` |
| 02 | undone(미이행) | `noshow` | `is-undone` | `status-undone` |
| 03 | cancel(취소) | `cancel` | `is-cancel` | `status-cancel` |
| 05 | waiting(대기) | `waiting` | `is-receipt` | `status-receipt` |

> ⚠️ **`is-*` 는 CSS 클래스가 아니라 데이터 값이다.** `toStatusClassName()`(`utils/schedulerSearchFilterUtils.ts`)이 만들어
> `appointment.statusClass` 로 실려 오고, `AppointmentCard.vue` 의 `STATUS_CLASS_MAP` 이 `status-*` 로 번역해 DOM 에 붙인다.
> **`00` 은 그 맵에 키가 없어 클래스가 붙지 않는다** — `.appointment-card` 기본 배경이 곧 예약색이다. `.is-waiting` 셀렉터는 스타일시트에 없다.
>
> 카드 배경색 SSOT = `AppointmentCard.vue` + `scss/schedule/v3/_tokens.scss`. 색값은 스타일시트를 연다.

> ⋮ 메뉴 항목을 컴포넌트에 직접 나열하지 않는다 — `appointmentCardMenu.ts` 의 `buildCardMenu(dataType, status)` 가 유일한 정의처다.
> `AppointmentCard.vue` 는 렌더링과 부수효과(dialog·store 호출)만 맡는다.
>
> ⋮ **초기화**는 상태 `00` 으로 되돌리는 것이라 API state 도 `default_` 를 보낸다(`toApiState()`). 취소·미이행 건을 되살리는 유일한 경로가 이 초기화라서, 중복 예약 검사(`mocks/routes.ts`)는 취소 건도 일부러 막는다.

> ⭐**예약 화면(`APPOINTMENT`)은 `00`·`03` 만 구분하고 나머지 상태는 예약(`00`)처럼 그린다.** `toDisplayStatus`(`utils/schedulerSearchFilterUtils.ts`)가 표시 직전에 접는다 — 표시용 변환이고 저장값은 그대로다. 상태 칩 집계(`scheduler-v3/boardStatistics.ts`)와 상태 필터(`filterByStatus`)도 같은 함수를 쓴다.

## 🎯 Z-index 정책

카드의 z 값은 **레이아웃 엔진이 계산해 내려준다.** `redesign/layoutPipeline.ts` 가 `Z_BASE`/`Z_FLOAT` **2단계**만 부여하고(`computeRects`), `v3ParityAdapter.ts` 가 이를 그대로 전달한다.

> 레이어별 z 값 표(SSOT) = [docs/reference/03 §6](../../../../docs/reference/03-card-css-and-portal.md#6-z-index-정책).

- ⚠️ **카드 hover 시 z-lift 금지.** 긴 카드를 덮는다. 위로 띄워야 하면 `.v3-qa-portal` teleport 패턴을 쓴다.
- ⚠️ drag/resize 중에도 카드 z 를 올리지 않는다.

## 🖱️ 인터랙션 규칙

### Drag
- threshold 5px: mousedown 후 5px 미만 이동 → 클릭 (`onClick → handleEdit`)
- snap: `snapMinute(rawMinute, config)` → 예약 시간 단위로 반올림 (`scheduler-engine/schedulerSnapGrid.ts`).
  **예약 시간 단위는 30분 고정이다(정책)** — 값은 `constants/componentConstants.ts` 의 `STEP_MIN` 한 곳에만 있고 `DEFAULT_SNAP_CONFIG.intervalMinutes` 는 거기서 파생한다. 예약장부 설정의 "예약 단위"(10·20·30·45분)는 **타임라인 눈금 간격(cellDuration)** 이지 예약 시간 단위가 아니다 — 45분 눈금에서도 드래그·팝업은 30분 격자로 놓인다. Shift 세밀 모드는 없다.
  격자 내림·올림은 같은 파일의 `floorToStep`/`ceilToStep` 한 벌을 드롭 보정(`normalizeRangeToGrid`)·resize(`resolveResizeRange`)·팝업(`reservationTimeRules.ts`)·`staffStore` 가 함께 쓰고, 하루 끝(자정→23:59/23:30)은 `clampEndToDay` 한 자리다.
- 같은 column 이동: sub-column 원본 유지, 시간만 변경
- 다른 column 이동: hitTest subColIndex 사용
- 같은 위치: `isNoChange = true` → 회색 preview → API 미호출
- drag 중 커서: `body.is-dragging-active * { cursor: grabbing }`

### Resize
- top handle: startMinute 변경, endMinute(anchor) 유지
- bottom handle: endMinute 변경, startMinute(anchor) 유지
- preview: sub-column 폭 유지 (left/width 불변)
- resize 중 커서: `body.is-resizing-active * { cursor: ns-resize }`

### Validate (drag/resize 공통)
- closedDate / closedWeekday → invalid (빨간 preview, commit 차단)
- outsideHours → valid + warning (파란 preview, confirm)
- lunch / dinner / blockedTime → valid (soft blocked, 등록 가능)
- 과거 시간 → invalid (band 종료 기준 판정). 단 **이미 지난 예약의 시각 보정은 막지 않는다**(`SchedulerV3Page.vue` 주석)
- 구간 전체 순회: cellDuration 단위로 start~end 순회, 1곳이라도 blocked 면 invalid
- 차단 사유 문구는 `useSchedulerRules` 가 고른다 — 이동(드래그·리사이즈)과 등록 팝업이 **같은 문장**을 쓴다(`useSchedulerRules.blockWarning.test.ts`)

### Hover / Popover
- hover 시 카드 z 는 올리지 않는다 (겹친 카드 순서 유지)
- ⋮ 버튼 + hover 주황 테두리 + **밑바탕 카드 리사이즈 핸들 사본**(`.resize-handle-portal`): `.v3-qa-portal` 로 Teleport (보드 좌표 absolute, 카드 rect 기준)
  — 카드 stacking context 밖으로 빼야 z 높은 인접 카드에 안 잘린다
  — 핸들 사본은 `rect.isLayerBase` 카드가 hover 중일 때만. 전 카드에 켜면 e2e 의 `.resize-handle--bottom` 좌표 클릭을 포털이 가로챈다
  — ⭐**좌측 세로 바의 조건은 `isLongCard` + `isLayerBase` 둘 다**(CSS 셀렉터 `.is-long-card.is-layer-base`).
    바는 '길다'가 아니라 '**아래에 가려진 것이 있다**'는 신호다. 두 플래그를 **하나로 합치지도 말 것** — 포털 조건은 `isLayerBase` 단독이라 뜻이 다르다
  — ⭐긴 예약 판정을 **밴드 관통(`startIdx≠endIdx`)으로 되돌리지 말 것.** band 는 `cellDuration` 단위라 10분 그리드에선 30분 예약도 3밴드를 걸쳐 **전 카드에 바가 붙는다**. 기준은 '**다른 예약이 시작하는 band 를 지나가는가**'(`passesOtherRows`)
- popover: `Teleport to="body"` + fixed 좌표 (트리거 ⋮ 버튼 기준, 왼쪽으로 펼침). 위치 계산은 `utils/popoverPlacementUtils.ts`
- scroll 시 popover 닫힘 (window 캡처 scroll 리스너)
- blocker(`.v3-blocker`): ReservationPopup 열림 시만 표시 (popover 는 outside click)

## ⏱️ 시간축

### operatingRange (band 생성 기준)
- 표시 중인 날짜들의 **요일별 운영시간**에서 `min(start) ~ max(end)` — 어느 시간으로 여는지는 엔진 `resolveUnitHours` 한 함수가 정한다
- `hospitalRules.weekly[weekday].open.start/end` + `breaks[].end` (dinner 포함)
- 예약이 operatingRange 밖이면 확장
- weekly 데이터 없으면 `constants/operatingHours.ts` 의 기본값으로 fallback
- 역전 방어: `minStart >= maxEnd` → fallback

### NowIndicator
- 오늘 column: 실선(`--scheduler-now`, `_tokens.scss`)
- 다른 날짜 column: 점선 (repeating-linear-gradient)
- TimeAxis: 시각 뱃지 + ● pulse 애니메이션
- ⭐**위치 계산은 `composables/useNowIndicator.ts` 한 벌이다** — 본문 가로선과 시간축 라벨이 각자 계산을 들고 있다가 **보이는 구간의 부등호가 갈려** 운영 종료 정각 1분 동안 축 라벨만 남은 적이 있다. band 와 같은 반개구간을 쓰고, band 안 위치는 `minuteToBandOffsetPx`(시간 비례 보간)로 낸다.

## 🧱 레이아웃 구조

```
SchedulerV3Page (scheduler-v3/, 오케스트레이터)
  ├── SchedulerSearchFilter (scheduleBoard/ 재사용)
  ├── SchedulerDateStrip + SchedulerToolbar
  └── (CSS Grid: corner + header + timeAxis + body)
       ├── SchedulerHeader (날짜 행 < > + 담당자 행 < >)
       ├── SchedulerTimeAxis (시간 라벨 + NowIndicator 마커)
       └── Body (scroll master)
            ├── SchedulerGrid (배경 + 셀 상태 + +추가 hover)
            ├── AppointmentLayer
            │    └── AppointmentCard × N
            ├── DragPreview / ResizePreview
            └── NowIndicator (가로선)
```

스크롤 동기화: body (master) → header (가로 slave) + timeAxis (세로 slave)

---

## 🧮 `.vue` 에 아직 남아 있는 계산

루트 `CLAUDE.md` 절대원칙(**`.vue` 에 복잡한 계산 로직을 넣지 않는다 → `.ts` 로 분리**)의 **미이행 목록**이다. 그 파일을 손댈 때 같이 빼면 된다. **여기에 새로 추가하지 않는다.**

| 자리 | 무엇 |
| - | - |
| `SchedulerV3Page.vue` | `toBookingGrid` · `scanWarning` 구간 순회 · `todayEdgeRect` |
| `SubColResizeHandles.vue` | `handles` |
| `SchedulerSettingsReservationSetting.vue` | `columnTracks` · `appointmentStyle`(45분 특례) |

> 해소된 것 — `NowIndicator`·`SchedulerTimeAxis` 의 계산 2벌은 `composables/useNowIndicator` 한 벌로, `ReservationPopup.vue` 의 시간 규칙은 `components/popup/reservationTimeRules.ts` 로, 팝오버 위치는 `utils/popoverPlacementUtils.ts` 로 빠졌다.
