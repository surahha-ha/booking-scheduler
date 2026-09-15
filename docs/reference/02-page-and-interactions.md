# 02. 페이지 셸 + 인터랙션 레이어

> `/book` → `SchedulerV3Page.vue` 가 엔진·컴포넌트·store 를 잇는 오케스트레이터.
> 인터랙션(drag/resize/reschedule/hover/popover)은 `scheduler/composables/` 에 상태머신으로 분리.
> 기준: `main` @ `05a56f4` (2026-09-15)

---

## 1. 페이지 셸 (`scheduler-v3/`)

| 파일 | 책임 |
|------|------|
| `SchedulerV3Page.vue` | `/book` 메인. store 인스턴스화 → 입력 조립 → `runLayout` → 파리티 → 렌더 + 인터랙션 배선 |
| `v3StoreInput.ts` | store/api shape → `RunLayoutInput` 조립. **`.vue` 에 계산을 두지 않으려는 분리**(원칙). load 직접호출 금지, read 만 |
| `v3ParityAdapter.ts` | 엔진 출력(`BandInfo`/`ResolvedColumn`) → 재사용 컴포넌트(`Header`/`TimeAxis`/`Grid`) props 변환. 순수함수 |
| `navSlots.ts` | date-anchored 페이징 순수계산(reactive 무의존). 헤더 담당자 `<>` 이동 후 "착지 컬럼 날짜"로 selectedDate 재고정 → 밀도 변해도 좌측 날짜 안 끌림 |
| `boardStatistics.ts` | 상태 칩·회원 건수 집계 — **화면에 그려진 칸**의 예약을 센다(§5) |
| `searchScrollFocus.ts` | 최근 예약 검색에서 고른 카드로 스크롤·강조 |

> **카드는 파리티 어댑터 대상이 아님.** `AppointmentCard` 는 hover/popover/drag/resize 4개 inject 가 필수라 "렌더 전용"이 불가 → 카드+composable 을 `scheduler/` 에서 통째 도입. 파리티는 헤더/축/그리드만.

---

## 2. 인터랙션 composable (`scheduler/composables/`)

| composable | 책임 | 핵심 |
|-----------|------|------|
| `useSchedulerInteractionLock` | drag/resize/hover/popover/reschedule/subcol-resize **상호배제** | `acquire(type)`→handle\|null, idle 일 때만 성공 |
| `useSchedulerDrag` | 카드 이동 상태머신 | mousedown→threshold(5px)→commit→drop API |
| `useSchedulerResize` | 시간 resize | top/bottom handle, Y축만 hitTest, min/maxDuration 제약 |
| `useSchedulerReschedule` | "변경" 모드 | begin(id)→배너→pickSlot(cell)→commit |
| `useSchedulerHover` | 카드 hover + 퀵액션 | lock 중 진입 차단 |
| `useSchedulerPopover` | ⋮ 퀵액션 팝오버 | outside-click/ESC/scroll 닫힘. 위치는 `utils/popoverPlacementUtils.ts` |
| `useSubColResize` | 컬럼별 칸수(N) 드래그 조절 | dx threshold ±1 step, customSlots override |
| `useSchedulerNavigation` | 날짜 이동 | selectedDate 단일 기준, scroll 힌트 |
| `useNowIndicator` | 현재 시각선 위치 계산 | 본문 가로선·시간축 라벨이 **같은 한 벌**을 본다. band 와 같은 반개구간 |

의존: 모든 인터랙션 composable 이 `useSchedulerInteractionLock` 을 인자로 받음. `Popover` 는 `Hover` 에 의존.

> ⭐`useNowIndicator` 는 가로선과 축 라벨이 같은 계산을 각자 들고 있다가 **보이는 구간의 부등호가 갈린** 사고로 뽑아낸 것이다 — 운영 종료 정각 1분 동안 축 라벨만 남았다. **한쪽에서만 고치지 말 것.**

---

## 3. 인터랙션 상태머신 흐름

### Drag
```
mousedown → [PendingDrag]
  ├ 이동 <5px → cleanup + onClick(handleEdit)        # 클릭=수정 팝업
  └ ≥5px → commitDragStart → lock.acquire('drag')
     ├ 실패 → cleanup
     └ 성공 → [Dragging] mousemove: hitTest→snap→validate→preview
        mouseup: isValid && 위치변경?
          → handleDrop → dragResultToBookItemRequest(result, raw, resolveDoctorName)
            → bookStore.modify... → filterStore.triggerSearch()  # 재조회 루프
```
- **같은 위치 드롭** = `isNoChange` → 회색 preview, **API 미호출**.
- 같은 컬럼 이동 = sub-column 원본 유지(시간만), 다른 컬럼 = hitTest subColIndex 사용.

### Resize
- top handle = startMinute 변경(end anchor 유지), bottom = 반대. preview 는 sub-column 폭 유지(left/width 불변).
- 시각 산출은 `resolveResizeRange`(`useSchedulerResize.ts`) 한 함수 — snap·최소/최대 duration·하루 끝(`clampEndToDay`)을 같이 본다. **드롭·변경 커밋과 같은 격자·같은 하루 끝 규칙**을 공유한다(아래 §8).

### Reschedule(변경 모드)
```
카드 ⋮ "변경" → begin(id): 원본 캡처(rescheduleOriginRaw) + lock('reschedule') + 배너
  → (다른 날짜로 이동 가능) 빈 슬롯 클릭 → pickSlot: 원 duration 유지
  → handleRescheduleCommit → dragResultToBookItemRequest(..., rescheduleOriginRaw) → modify → triggerSearch
```
- commit 은 **기존 handleDrop 경로 재사용**(신규 API 0). cross-date 변경 버그는 `rescheduleOriginRaw` 를 begin 시점에 캡처해 해결.

### Validate (drag/resize 공통)
- closedDate/closedWeekday → **invalid**(빨간 preview, commit 차단).
- outsideHours → valid + warning(파란 preview, confirm). lunch/dinner/blockedTime → soft(등록 가능).
- 과거 시간 → invalid(**band 종료 기준** 판정, band 안이면 past 아님). 단 이미 지난 예약의 시각 보정은 허용한다.
- 구간 전체를 cellDuration 단위로 순회, 1곳이라도 blocked 면 invalid.
- 안내 문구는 `useSchedulerRules` 가 고른다 — 등록 팝업과 같은 문장(`useSchedulerRules.blockWarning.test.ts`).

---

## 4. 상호배제 락 (`useSchedulerInteractionLock`)

```
type InteractionType = 'idle' | 'drag' | 'resize' | 'create' | 'subcol-resize' | 'reschedule'
acquire(type): idle 일 때만 LockHandle 반환, 아니면 null(진입 거부)
unlock(): 소유 토큰 일치 시만 해제(다른 lock 으로 교체됐으면 no-op)
```
- hover/popover 는 `if (interactionLock.isLocked) return` 으로 진입 자체를 막고, lock 발생 시 watch 가 clearHover/close 호출.
- **drag 중 hover 차단** 같은 동시진입이 이 락으로 일괄 처리됨. 새 인터랙션 추가 시 `InteractionType` 에 등록 필수.

---

## 5. 데이터 흐름 / 네비게이션 / URL

### searchVersion watch chain (★load 직접호출 금지의 이유)
```
filterStore.patch(..., trigger=true) | triggerSearch() → searchVersion++
  → bookStore watch(searchVersion, immediate) → loadDoctor() → loadSchedule(anchor, days) → appointments 갱신
```
- 이 chain 은 bookStore 전역이다. 그래서 `bookStore.load()` 직접 호출 금지 — 반드시 filterStore 경유.
- 같은 이유로 `serviceItemStore.load` 는 동시 호출이 진행 중 조회를 함께 기다린다 — 예약 팝업과 설정 팝업이 거의 동시에 부르면 뒤에 온 쪽이 빈 목록으로 초기 선택을 하던 간헐 결함의 수리.

### URL query ↔ store
- `useQueryString()` 이 route query `dataType`/`viewMode` ↔ filterStore 양방향 동기화. `SchedulerV3Page` 가 호출한다 — 페이지 재구성 때 이 호출을 빠뜨리면 query 동기화가 조용히 깨진다(전례 있음).

### 데이터 윈도우 (조회 ≠ 표시)
- **표시**: `runLayout(horizonDays)` 로 미래 빈 날짜까지 컬럼 생성 가능(패킹 지평 = `HORIZON_DAYS`).
- **조회**: 지평이 아니라 **현재 페이지에 실제로 보이는 날짜 범위**만 본다 — `SchedulerV3Page` 의 `visibleDates`(컬럼들의 distinct date) 첫~끝 span 이 `dataWindowAnchor`/`dataWindowDays` → `filterStore.setWindow()` → `windowAnchorDate`/`windowDays`.
- 페이징으로 보이는 날짜가 바뀌면 그 범위로 **슬라이드**(start 도 함께 이동) → `endDate` 누적 성장·미래 빈 페이지 무한조회 방지. `setWindow()` 는 anchor+days 동일 시 dedup 후 trigger.

### 상태 칩·회원 건수 = 화면에 그려진 칸 (`scheduler-v3/boardStatistics.ts`)
- 칩 옆 숫자는 서버 집계가 아니라 **지금 화면에 그려진 칸의 예약**을 센다. 조회 창은 표시보다 길고 페이지 경계 칸은 담당자 일부만 보여, 어떤 파라미터를 보내도 집계 모수와 카드 수가 같아질 수 없었다.
- 세는 기준은 엔진이 카드를 놓는 칸 키와 같은 `unitKeyOf` — 카드 수와 숫자가 **정의상** 일치한다.
- ★**상태 필터는 엔진 입력이 아니라 rect 에서만 숨긴다**(`filterByStatus`). 그래서 칩을 켜도 칸 폭·표시 날짜·다른 칩 숫자가 변하지 않는다. 목록 요청에서 `status` 를 빼고 모든 상태를 받는다.
- 거르는 기준과 세는 기준이 둘 다 `toDisplayStatus` 라, 예약장부에서 완료·미이행·대기는 '예약' 칩에 들어가고 '예약' 필터로도 보인다(카드가 '예약'으로 그려지는 것과 한 규칙).
- 회원 판정은 카드 뱃지와 한 벌(`utils/memberRules.isIntegratedMember`).
- 조건이 바뀐 재조회가 떠 있는 동안은 `bookStore.appointmentsStale` 로 0 을 표기하고, 조회 실패 시 해제한다.

### date-anchored 페이징 (navSlots.ts)
- 좌측 끝 = `selectedDate`. 윈도우 = 전역 sub-col 시퀀스 `[colOffset, colOffset+budget)`.
- 헤더 담당자 `<>` = 윈도우 budget 칸 이동 후 착지 컬럼 날짜로 selectedDate 재고정(재조회로 밀도 변해도 점프 차단).
- zoom/N칸/customSlots 변경 시 `colOffset=0` 리셋.

---

## 6. Adapter 변환 규칙 (`scheduler/adapters/`)

### appointmentAdapter (읽기)
- `startDateTime: Date` → `startMinute`(= h×60+m) + `date`('YYYY-MM-DD').
- **`resourceId = doctorName`**(이름 기반 그룹핑) → `columnKey = "${date}_${resourceId}"`.
- `delYn==='Y'` 필터링. 외부 연동 건은 `isExternalSync` → 'EXT' 뱃지.

### dragResultAdapter (쓰기)
- `start/endDate` = `toDate + newMinute` → ISO. 담당자는 이름으로 싣는다(저장소가 이름→키 변환).
- resize 는 시간만 변경(날짜/담당자 불변), 나머지 고객 필드는 원본 복사. 서비스 항목 필드도 그대로 실어 보낸다(`dragResultAdapter.treatmentItem.test.ts`).

---

## 7. "수정 시 연관" 주의점

| 바꾸는 곳 | 파급 |
|----------|------|
| `useSchedulerInteractionLock` | 모든 인터랙션 composable. `InteractionType` 동기화 |
| `resolveDoctorName`/`resourceId`/`columnKey` 포맷 | hitTest·컬럼 매칭·layout 정합 전부(깨지면 예약 미표시) |
| validate 함수 제거/변경 | drag·resize 조건 검증 전체(과거/휴무 무시 위험) |
| navigation date watch | filterStore.periodDate→searchVersion 재조회 체인 |
| `bookStore.load()` 직접 호출 | ❌ 금지 — searchVersion chain 우회=버그 |
| 페이지 재구성 | `useQueryString` 호출 누락 주의(전례 있음) |
| mock 응답 생성 | `mocks/index.ts` 의 응답은 JSON 왕복으로 분리한다 — db 객체를 그대로 돌려주면 store 가 원본을 참조해 in-place 변형에 반응성이 끊긴다(실제 결함) |

---

## 8. 과거 버그·교훈 (재발 방지)

- **예약 미표시**: adapter 가 ID 를 썼는데 컬럼은 `doctorName` → `resourceId=doctorName` 으로 통일.
- **snap 비정규 시간(17:20)**: snap 10분 → **예약 단위**로 교체. ⚠️**예약 단위는 `cellDuration` 이 아니라 고정 30분**(`constants/componentConstants.ts` 의 `STEP_MIN`)이고 `DEFAULT_SNAP_CONFIG` 가 거기서 파생한다. 예약장부 설정의 "예약 단위"(10·20·30·45분)는 **타임라인 눈금**(`cellDuration`)이라 45분 눈금에서도 드래그·팝업은 30분 격자로 놓인다. Shift 세밀 모드는 제거됐다.
- **격자 밖 예약을 옮기면 미리보기와 저장값이 달랐다**: 저장은 `normalizeRangeToGrid` 로 보정하는데 미리보기는 원본 길이를 써서, 놓는 순간 카드가 줄었다(09:30~10:10 → 10:00). 미리보기 길이도 같은 보정(`bookingDurationOf`)을 지난다.
- **하루 끝이 `T24:00:00` 으로 저장**: 시간축을 24:00 까지 늘린 뒤 드롭·resize 하면 종료가 자정으로 나갔다. 규칙을 `clampEndToDay` 한 자리로 모아(시작 23:00 이상이면 23:59, 아니면 마지막 칸 23:30) **드롭·변경 커밋·resize·팝업이 공유**한다. 팝업 쪽 순수함수는 `components/popup/reservationTimeRules.ts`.
- **popover 스크롤 시 깨짐**: body teleport(fixed)는 카드와 분리됨 → window 캡처 scroll 리스너로 닫는다. (hover ⋮/테두리는 `.v3-qa-portal` 로 별도 해결 — [03](03-card-css-and-portal.md))
- **popover 클릭이 edit 팝업 염**: mousedown 전파 → `@mousedown.stop`.
- **변경모드 cross-date commit 실패**: begin 시점 raw 캡처(`rescheduleOriginRaw`)로 해결.
- **순서 저장 시 운영시간 삭제**: `saveTreatmentSettings`(전체 replace)는 `workingHours` 반드시 동봉.
- **상태 배지가 항상 0**: 상태 집계 mock 이 합계 행 '전체'(`STATUS_TOTAL_LABEL`)를 빠뜨렸다. 합계 행을 앞에 붙이고 스모크가 합계 행과 상태별 합을 각각 단언한다.
