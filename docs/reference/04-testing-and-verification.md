# 04. 테스트 · 검증 · 실행계획 방법론

> 스케줄러가 어떻게 테스트·검증되는지, 작업을 어떤 사이클로 진행하는지. 인수자가 같은 품질로 이어가기 위한 가이드.
> 기준: `main` @ `05a56f4` (2026-09-15).
> **테스트 개수는 문서에 박제하지 않는다** — 세다가 반드시 어긋난다. 수량이 필요하면 아래 명령으로 실측한다.

---

## 1. 테스트 구성 (현재)

### 엔진 (`src/scheduler-engine/__tests__/`)
| 파일 | 범위 |
|------|------|
| `layoutPipeline.test.ts` | runLayout end-to-end, 좌표/밴드/카드폭/페이징/화면 분기 |
| `layoutCore.golden.test.ts` | **골든마스터** arrangeCards/packPages/budget |
| `runLayoutAdapter.test.ts` | store shape → 엔진 입력 변환 |
| `schedulerHitTest.test.ts` | 좌표 → 셀·시각 역산. `NowIndicator` · `TimeAxis` · drag/resize 가 함께 쓴다 |
| `minuteToBandOffsetPx.test.ts` | band 내부 **시간 비례 보간**(현재시각선이 눈금을 키울수록 뒤처지던 결함의 회귀) |
| `schedulerSnapGrid.step.test.ts` | `floorToStep`/`ceilToStep` 격자 연산 + **예약 단위를 한 번만 적는다**(`STEP_MIN` 파생) |
| `schedulerSnapGrid.dayEnd.test.ts` | 하루 끝 규칙(`clampEndToDay`) — 드롭·resize 공용 |
| `schedulerSnapGrid.contract.test.ts` | **계약** — 예약 수정 팝업과 보드 드롭·변경·resize 가 같은 예약을 같은 시각으로 저장하는지 |
| `normalizeRangeToGrid.test.ts` | 격자 밖 예약의 드롭 보정(미리보기 길이 = 저장값) |
| `schedulerInteraction.test.ts` | drag `isNoChange`·quickAction·toType + snap·clampToOptions(**프로덕션 함수 실물 호출**) |

> ⚠️ `schedulerInteraction.test.ts` 의 snap·clamp 는 예전엔 **구현을 복제한 사본**이라 프로덕션 코드를 한 줄도 돌리지 않았다(구현이 틀려도 그린). 지금은 `schedulerSnapGrid.snapMinute` 와 `components/popup/reservationTimeRules` 를 직접 부른다. NowIndicator 오늘 판정은 마운트 테스트(`components/__tests__/nowIndicatorToday.test.ts`)에 있다. **사본 테스트를 다시 만들지 말 것.**

**엔진 게이트 = `npx vitest run src/scheduler-engine/__tests__/`** (모든 엔진 변경 후 회귀 0 확인). 수량은 이 명령의 출력이 SSOT.

### 페이지 셸 단위 (`scheduler-v3/__tests__/`)
- `navSlots`(페이징 순수계산) · `v3ParityAdapter`(출력→props 변환) · `v3StoreInput`(입력 조립) · `boardStatistics`(칸 집계) · `searchScrollFocus`.
- `SchedulerV3Page.*` — `saveClose`(저장 실패 시 팝업 유지·연타 중복요청 차단) · `boardStatistics`(칩 숫자 = 카드 수) · `holidayDates`(공휴일 축) · `recentPick`(최근 예약 검색 → 카드 이동). 공용 마운트 하네스는 `v3PageHarness.ts`(SSE·라우터·API·HTTP 클라이언트 mock).

### 컴포넌트·UI 단위 (`scheduler/`)
- `components/__tests__/` — `AppointmentCard`(카드 렌더/분기) · `nowIndicatorOffset`·`nowIndicatorToday`(현재시각선 경계) · `SchedulerDateStrip.holidayYear`(줄달력 공휴일·연도 라벨).
- `composables/__tests__/` — `useSchedulerDrag.duration`(드롭 보정 길이) · `useSchedulerResize.grid`(resize 격자) · `useSchedulerPopover.ownerSlot` · `useSchedulerReschedule.commitOrder`.
- `__tests__/` — `useSchedulerHover.leaveOrder` · `appointmentCardMenu`(⋮ 항목·초기화 활성·API state). **`appointmentCardMenu.ts` 를 직접 import** 한다 — 메뉴 로직을 테스트가 복제하지 말 것.

### 설정·팝업·스토어 단위
- `scheduleBoard/components/__tests__/` — 운영시간/휴무 설정(`SchedulerSettingsTreatmentSetting.*`: 축 상속·지정일·팀 범위·저장 게이트·시간 입력 …)·보기 화면·검색 필터·담당자 순서. 가장 큰 묶음이다.
- `scheduleBoard/__tests__/offDayRules.test.ts` — 휴무 상속 순수함수.
- `components/popup/__tests__/` — 예약 팝업·서비스 항목 설정·고객 자동완성·항목 규칙.
- `stores/__tests__/` — bookStore 경합·stale·담당자 게이트, staffStore 운영시간/휴무/공휴일, filterStore 창 이동, serviceItemStore 동시 로드.
- `mocks/__tests__/` — 라우트 스모크(`mockRoutes.smoke`)·어댑터 통합·외부 연동 mock. **API 계약을 바꾸면 여기가 먼저 빨간불이어야 한다.**

### 계약 테스트 — 합칠 수 없는 두 계층을 묶는다
- `composables/__tests__/schedulerOpenHours.contract.test.ts` — **예약검증(`useSchedulerRules`)과 타임라인 밴드(`layoutPipeline.resolveUnitHours`)가 같은 상황에 같은 답을 내는지** 고정한다.
- 두 계층은 자료구조도 반환값도 달라(`HH:mm` 판정 ↔ 분 단위 배치) 한 함수로 합칠 수 없다. 그래서 값 자체는 `constants/operatingHours` 가 소유하고, **동치성은 이 테스트가 지킨다.**
- 실제 사고: 휴무 상속을 축 단위로 바꿨을 때 밴드가 따라오지 않아 **밴드는 열려 있는데 클릭하면 "운영시간 밖"** 이 됐다. 눈검증 제보로 겨우 발견됐다.
- ★깨지면 값을 맞추지 말고 **어느 쪽이 옳은지 먼저 정한다.** 양쪽을 각자 고쳐 맞추면 다음 변경에서 또 갈린다.

### e2e (`tests/e2e/*.spec.ts`, Playwright)
| spec | 범위 |
|------|----|
| `scheduler-v2.spec.ts` | 기본 렌더/네비 |
| `scheduler-v2-extended.spec.ts` | 확장 시나리오(상태 전이·취소 다이얼로그) |
| `scheduler-v2-drag.spec.ts` · `scheduler-v2-validation.spec.ts` | drag / drag·resize 검증 |
| `scheduler-v2-subcol-resize.spec.ts` | 칸수 조절 |
| `scheduler-v2-treatment-item.spec.ts` | 서비스 항목 마스터·설정 팝업(빈 그룹 이탈 차단 포함) |
| `scheduler-v2-treatment-mode.spec.ts` | TREATMENT 화면 분기(⋮ 메뉴 6항목) |
| `scheduler-v2-search-filter.spec.ts` | 검색필터·상태 칩 |
| `scheduler-v3-date-picker.spec.ts` | 날짜 선택 달력 |
| `scheduler-v2-bug-investigation.spec.ts` | 회귀 조사 |

- 실행 = `npx playwright test`(dev 서버 자동 기동, 로컬 mock). 수량 실측 = `npx playwright test --list`.
- 픽스처(`tests/e2e/fixtures/`): `testBase`(매 테스트 localStorage 초기화) · `board`(오늘 이후 첫 평일로 이동·가려지지 않은 빈 셀 고르기) · `cardPointer`(뷰포트 안에 중심이 있는 카드만 잡기). **실행일·시드 분포에 독립**하게 만든 것이니 날짜를 못 박는 헬퍼를 새로 쓰지 말 것.
- 다이얼로그는 `.app-dialog`(확인 `.app-dialog__btn--primary`, 취소 `--ghost`). 브라우저 `alert()` 는 세션을 멈춘다.
- 설정은 `retries: 1` — 재시도로 통과하면 flaky 로 분류돼 진짜 실패와 섞이지 않는다. 실패 1건이 다음 테스트 teardown 을 밀어 연쇄 실패를 만든 전력이 있어 trace 는 재시도에서만 수집한다.

> ⚠️ spec 파일명은 `scheduler-v2-*` 지만 라우트는 `/book` 하나다(파일명만 잔존).

---

## 2. 골든마스터 (엔진 변경의 안전판)

`layoutCore.golden.test.ts` = `arrangeCards` 동작을 **타겟 기준으로 고정**.

| 케이스 | 검증 |
|--------|------|
| G-arrange-1 | 같은 startMin, 칸수 내 → 나란히(floating 0) |
| G-arrange-2 | 칸수 초과 같은 startMin → row 확장(expandedRows) |
| G-arrange-3 | 긴 예약 + 다른-시작 겹침 → floating |
| G-pack-1 | 일자별 slots 누적 → 페이지 분할(carry-over) |
| G-budget | totalColumns×viewStep → 예산 범위 매핑 |

**프로토타입 버그는 골든에서 의도적으로 divergence**(`REDESIGN.md §10`): budget 하한 클램프, `round(dur/30)` 30분 하드코딩→sweep-line, 페이지 꽉 찼을 때 overflow unit 0폭 유실→다음 페이지로.

> 카드폭/배치 변경 시 골든 단언이 깨지면, **"의도된 변경"인지 "회귀"인지 먼저 판단**하고 의도면 갱신 + 커밋 메시지에 명시(회귀 오인 방지).

---

## 3. 검증 사이클

```
실행계획 작성 → 재검토(특히 삭제 시 정밀 import 확인)
  → 구현 → 1차 검증(단위/lint/build) → 버그 수정
  → 검증(e2e / baseline 실측)
  → 눈검증 PASS → push
```

### 단계별 게이트
1. **lint/단위/build**: `npm run lint` + `npx vitest run` + `npx vite build`. 파이프로 넘기지 말고 종료코드·요약 줄로 판정한다(`… | tail` 은 종료코드가 tail 것).
2. **e2e**: 건드린 스펙만 좁게, 커밋 전 전체 1회. 로그 파일로 받아 `passed/failed/flaky/skipped` 줄을 읽는다.
3. **눈검증(필수)**: 라이브 폭·위치·색 변경은 **눈검증 전 push 금지**.
4. **baseline 실측**: e2e 실패가 이번 변경 회귀인지 판별 — `git stash` 로 되돌려 같은 실패가 재현되면 prior baseline(무관).

### 단언을 낮춰서 통과시키지 않는다
- 빨간 테스트를 `isEqualTo`→`contains`/`isNotNull` 로 내리지 않는다. 고칠 것은 **기대값 하나**다.
- 기대 문구 한 줄만 바꿔 그린이면 표시 문자열만 바뀐 것(새 테스트 불필요). 다른 것까지 손대야 그린이면 분기·계약이 바뀐 것이라 새 테스트를 쓴다.

### 사이드이펙트 전수 검토
- 파일 삭제/대규모 변경 전 **정밀 `import` grep** 으로 깨짐 0 확인.
- ⚠️ `git grep -l "이름"` 은 주석/타입도 잡음 → import 기준으로 판별.

---

## 4. 검증 시 알아둘 환경 함정

- **lint 를 경로 지정으로 돌리면 거짓 빨간불** — `npx eslint src tests --ext …` 는 flat config 를 우회한다. `npm run lint` 로만.
- **CSS 한 줄 안 먹을 때**: scoped/specificity 의심 전에 **빌드 CSS(`dist/assets/*.css`)에서 같은 룰 내 속성 중복** 먼저 확인.
- **빌드 분할**: `/book` lazy import 라 토큰은 `:root` 전역화로 부팅 번들 영향 최소화.
- **e2e 가 dev 서버 HMR 에 흔들린다** — e2e 가 도는 동안 `src` 를 편집하지 않는다(주석만 바꿔도 리로드).
- **하네스 `.harness/*.test.mjs`** 는 vitest 대상이 아니다(`vite.config.js` 제외 목록). `node --test` 전용.

---

## 5. e2e 작성 타이밍 (판단 기준)

- **즉시 작성**: 회귀 위험 큰 시나리오(인터랙션 상태머신, 데이터 정합, 분기 로직, 다이얼로그 차단 규칙).
- **QA 일괄**: 단순 UI(색·간격·라벨).

---

## 6. 실행계획(plan) 작성 관례

큰 엔진/CSS 변경은 **구현 전 실행계획을 먼저** 작성하고 합의 후 착수한다.

> 실행계획 = 진단(확정 사실) → 목표 → 알고리즘/설계 → **영향범위·사이드이펙트 표** → 단계별 증분 → 테스트 → 눈검증 체크리스트 → 리스크/롤백. 삭제·라이브 변경일수록 재검토.

---

## 7. 반복된 함정 Top (인수자 주의)

1. **카드폭을 풀폭/가변으로 바꾸려는 충동** → 3번 거부됨. 레인폭 고정이 확정.
2. **위로 띄우려고 z-lift** → 긴 카드 덮음. `.v3-qa-portal` teleport 가 정답.
3. **`bookStore.load()` 직접 호출** → searchVersion chain 우회로 버그.
4. **클래스 rename** → e2e 깨짐.
5. **골든 단언 갱신을 회귀로 오인**(또는 반대) → 의도/회귀 판단 후 커밋 메시지 명시.
6. **운영시간 판정 두 계층을 한쪽만 고침** → 계약 테스트가 잡는다. 값을 맞추지 말고 옳은 쪽을 정한다.
7. **mock 응답에 db 객체를 그대로 돌려줌** → store 가 원본을 참조해 반응성이 끊긴다. 응답은 JSON 왕복.
