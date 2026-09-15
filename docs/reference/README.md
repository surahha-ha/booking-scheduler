# 스케줄러 인수인계 문서 (scheduler-v3)

> 기준: `main` @ `05a56f4` (2026-09-15). 대상 = `/book` 라이브 스케줄러.
> 목적: 코어 ts·연관관계·불변식·예외·테스트/검증 방법을 인수인계 가능하게 한 곳에 정리.
> 본 디렉토리는 **읽기 전용 인수인계 묶음**이다. 엔진 설계서 원본은 [src/scheduler-engine/REDESIGN.md](../../src/scheduler-engine/REDESIGN.md).
> 이 문서들은 이식 원본의 인수인계 문서를 이 레포 코드 기준으로 다시 쓴 것이다 — 원본에 있던 사내 시스템·구 엔진 서술은 뺐다.

---

## 0. 용어 — "V3" 가 무엇인가

- 커밋·코드에 등장하는 `V3`/`SchedulerV3Page`/`redesign/` 은 **자체 엔진을 코어부터 재설계한 현재 라이브 구현**의 이름이다. 이 레포에는 그 이전 세대 엔진이 없으므로 "V3 = 이 레포의 스케줄러" 로 읽으면 된다.
- e2e 스펙 파일명의 `scheduler-v2-*` 는 이식 전 이름이 남은 것이다. 라우트는 `/book` 하나뿐이다.
- 이 레포의 하위 `CLAUDE.md` 두 종은 라이브 코드 기준으로 정합돼 있다(이식 원본과 달리 "목표 아키텍처" 문서가 아니다).

---

## 1. 디렉토리 3중 구조 (가장 먼저 알아야 할 것)

라이브 스케줄러는 **세 디렉토리**에 나뉘어 있다. 이 분리를 모르면 "어디를 고쳐야 하지?"에서 막힌다.

| 레이어 | 위치 | 역할 | Vue 의존 |
|--------|------|------|---------|
| **순수 엔진** | `src/scheduler-engine/redesign/` | 좌표·배치 계산(`runLayout`). 입력→`Rect[]` 순수함수 | ❌ 없음 |
| **페이지 셸** | `src/pages/desktop/scheduler-v3/` | `/book` 이 마운트하는 `SchedulerV3Page.vue` + 입력 조립·페이징·파리티 어댑터·카드 집계 | ✅ |
| **재사용 컴포넌트/인터랙션** | `src/pages/desktop/scheduler/` | 카드·헤더·그리드 등 컴포넌트 + drag/resize/hover 등 composable | ✅ |

```
src/
├── scheduler-engine/
│   ├── REDESIGN.md                      # ★엔진 코어 설계서(§13 = 설계↔라이브 divergence)
│   ├── redesign/                        # ★라이브 엔진
│   │   ├── layoutTypes.ts               #   타입 계약 (LayoutConfig 등)
│   │   ├── layoutCore.ts                #   저수준 순수함수 (budget/maxConcurrent/arrangeCards/packPages)
│   │   ├── layoutPipeline.ts            #   ★end-to-end runLayout + 좌표/밴드/카드폭 계산
│   │   └── runLayoutAdapter.ts          #   store shape → 엔진 입력 변환
│   ├── schedulerHitTest.ts              # 좌표→셀·시각 역산 (NowIndicator/TimeAxis/drag/resize)
│   ├── schedulerSnapGrid.ts             # 스냅 격자 (drag/resize/팝업 공용)
│   ├── schedulerDateUtils.ts            # 네비게이션 날짜 계산
│   ├── schedulerHeaderBuilder.ts        # SchedulerHeader 행 조립
│   └── __tests__/
│
├── pages/desktop/scheduler-v3/          # ★라이브 페이지 셸
│   ├── SchedulerV3Page.vue              #   /book 메인 오케스트레이터
│   ├── v3StoreInput.ts                  #   store/api → RunLayoutInput 조립(.vue 계산 분리)
│   ├── v3ParityAdapter.ts               #   엔진 출력 → 재사용 컴포넌트 props 변환
│   ├── navSlots.ts                      #   date-anchored 페이징 순수계산
│   ├── boardStatistics.ts               #   상태 칩·회원 건수 = 화면에 그려진 칸의 집계
│   ├── searchScrollFocus.ts             #   검색 결과 카드로 스크롤·포커스
│   └── __tests__/
│
└── pages/desktop/scheduler/             # ★재사용 컴포넌트 + 인터랙션
    ├── components/                       #   AppointmentCard / SchedulerGrid / Header / TimeAxis / DateStrip ...
    ├── composables/                      #   useSchedulerDrag/Resize/Hover/Popover/Reschedule/InteractionLock/NowIndicator ...
    ├── adapters/                         #   appointmentAdapter / dragResultAdapter
    ├── appointmentCardMenu.ts            #   카드 ⋮ 메뉴 정의(항목·활성여부·API state)
    └── __tests__/
```

**왜 셋으로 나뉘나**: 엔진은 reactive 0·테스트 가능해야 함(`redesign/`). 카드/composable 은 검증된 것을 통째 재사용(`scheduler/`). 페이지 셸은 둘을 잇고 페이징·파리티만 담당(`scheduler-v3/`). `v3ParityAdapter` 가 "엔진 출력 ↔ 재사용 컴포넌트 props" 사이를 메운다.

그 밖의 스케줄러 관련 자리:
- `src/pages/desktop/scheduleBoard/` — 검색 필터 바, 설정 팝업(예약장부 설정·운영시간/휴무 설정·담당자 순서), 휴무 규칙 순수함수(`offDayRules.ts`).
- `src/components/popup/` — 예약 등록/수정 팝업(`ReservationPopup`), 서비스 항목 설정 팝업, 고객명 자동완성. 시간 규칙은 `reservationTimeRules.ts`, 항목 규칙은 `treatmentItemRules.ts`.
- `src/mocks/` — API 구현(브라우저 내 axios adapter)·저장소·시드·localStorage 영속화. `src/api/*Api.ts` 의 타입이 계약이고 `mocks/routes.ts` 가 구현이다.

---

## 2. 데이터 흐름 한 장 요약

```
검색필터/날짜이동 → filterStore.searchVersion++ ──(watch chain)──▶ bookStore.load()
                                                                        │ (직접 호출 금지!)
                                                                        ▼
                              bookStore.appointments / staffStore.doctors·hours
                                                                        │
                                  v3StoreInput.buildStoreRunLayoutInput()│ (입력 조립)
                                                                        ▼
                                   redesign/runLayout(input)  →  { columns, bandInfos, rects }
                                                                        │
                          ┌─────────────────────────┴──────────────────────────┐
                          ▼ (파리티)                                            ▼ (직접)
              v3ParityAdapter → Header/TimeAxis/Grid props          rects → AppointmentLayer/Card (인라인 style)
                          │                                                     │
                          └──────────────── SchedulerV3Page 렌더 ───────────────┘
                                            ▲
                          drag/resize/reschedule → adapter → bookStore.modify → searchVersion++ (재조회 루프)
```

네트워크는 없다. `bookStore.load()` 가 부르는 axios 는 `src/mocks/index.ts` 의 adapter 로 종착해 `mocks/db.ts` 를 읽고, 응답은 JSON 왕복(직렬화 경계 재현)으로 돌아온다.

---

## 3. 절대 지켜야 할 불변식 (어기면 회귀 — 재발 방지 목록)

이 목록은 이식 원본에서 **여러 번 깨졌다가 되돌린** 것들이다. 건드리기 전 반드시 확인.

1. **카드폭 = 항상 `subColWidth`(레인폭).** 풀폭/1칸폭 절대 금지.
   - "혼자=풀폭(expand)", "floating 풀폭 아래 나열", "floating 폭 축소" 세 번 다 시도→**거부·REVERT**됨.
   - floating = 레인폭(localRow 세로 스택). **겹친 floating(`isLayered`)의 `FLOAT_INDENT_PX` 계단 들여쓰기(층수 `layerDepth` 배수)는 살아 있다** — [01 §3-2](01-layout-engine.md).
   - 모든 카드 우측 strip(`CARD_ADD_STRIP_RATIO`) = hover 시 그 자리 그리드 +추가 노출(N=1 포함, 별도 버튼 불요).
2. **`bookStore.load()` 직접 호출 금지.** `filterStore.triggerSearch()` 또는 `patch(..., trigger=true)` 로만.
3. **e2e 락 클래스 rename 금지**: `.appointment-card`, `.grid-cell`(+ `.is-empty-add/.is-closed/.is-past/.is-zebra/.is-lunch/.is-dinner/.is-now`), `.tisp-*`, `.tcs-*`, `.app-dialog*`. e2e spec 셀렉터가 의존.
4. **hover ⋮·hover 주황 테두리·밑바탕 리사이즈 핸들 = `.v3-qa-portal` teleport**(보드 absolute + rect 좌표). body fixed teleport 는 **스크롤 안 따라와 실패**. 카드 자체 z-lift 는 **긴 카드 덮어 거부**.
5. **카드 top/left/width/height/z = `runLayout` 인라인 style(JS 영역).** CSS 로 못 바꾼다. CSS 편집 경계 = **색/간격/테두리/폰트/그림자 토큰만**.
6. **CSS 토큰은 `:root` 에 정의**(`scss/schedule/v3/_tokens.scss`). 팝업이 body 로 teleport 돼 `.v3-page` 스코프가 안 닿는다. `--scheduler-*` 관례 사용(새 접두 발명 금지).
7. **외부 스케줄러 라이브러리·`transform(scale)`·row height 고정·날짜 하드코딩·`ceil(count/N)` 금지.** (엔진은 실제 배치 시뮬레이션 기반)
8. **명세 > 프로토타입.** `REDESIGN.md §10` 의 프로토타입 버그(30분 하드코딩/budget 클램프)는 따르지 않는다.
9. **예약 시간 단위 = 고정 30분**(`constants/componentConstants.ts` 의 `STEP_MIN`, 여기서 `DEFAULT_SNAP_CONFIG` 파생). 예약장부 설정의 "예약 단위"는 **타임라인 눈금**(`cellDuration`)이지 예약 격자가 아니다 — 드롭·resize·팝업이 같은 격자와 같은 하루 끝 규칙(`clampEndToDay`)을 쓴다. [02 §8](02-page-and-interactions.md).
10. **긴 예약(`isLongCard`) 판정을 밴드 관통(`startIdx ≠ endIdx`)으로 되돌리지 말 것.** band 는 `cellDuration` 단위라 10분 그리드에선 30분 예약까지 전부 걸려 **전 카드에 좌측 바가 붙는다**. 기준은 '다른 예약이 시작하는 band 를 지나가는가'. [01 §3-2](01-layout-engine.md).
11. **운영시간 판정은 두 계층이 같은 답을 내야 한다** — 예약검증(`useSchedulerRules`)과 밴드(`resolveUnitHours`). 계약 테스트 `schedulerOpenHours.contract.test.ts` 가 깨지면 값을 맞추지 말고 **어느 쪽이 옳은지 먼저 정한다.** [04 §1](04-testing-and-verification.md).

---

## 4. 작업할 때 먼저 확인하는 순서 (체크리스트)

1. 고치려는 게 **계산(좌표/배치)인가 → `redesign/`**, **UI/이벤트인가 → `scheduler/` 컴포넌트·composable**, **연결/페이징/집계인가 → `scheduler-v3/`**, **API 계약인가 → `api/*Api.ts` + `mocks/routes.ts`** 인지 분류.
2. 위 **§3 불변식**에 걸리는지 확인(특히 카드폭·load 직접호출·클래스 rename).
3. 색/스타일이면 [03](03-card-css-and-portal.md) 에서 토큰·teleport·JS 기하 경계 확인.
4. 변경 후 게이트: `npx vitest run src/scheduler-engine/__tests__/` + `npm run lint` + (라이브 렌더 영향 시) `npm run build` + 눈검증. 전체 판정은 [04 §3](04-testing-and-verification.md).
5. **라이브 폭/위치 변경은 눈검증 전 push 금지.**

---

## 5. 문서 색인

| 문서 | 내용 |
|------|------|
| [01-layout-engine.md](01-layout-engine.md) | 엔진 코어(`redesign/`): runLayout 파이프라인, 상수 위치, 카드폭/floating/strip, 화면 분기, 수정 영향도 |
| [02-page-and-interactions.md](02-page-and-interactions.md) | 페이지 셸 + composable: drag/resize/reschedule, 상호배제 락, 네비게이션/데이터 윈도우/URL 동기화, 카드 집계, adapter |
| [03-card-css-and-portal.md](03-card-css-and-portal.md) | 카드 렌더·상태색 토큰, `.v3-qa-portal` 포털, 줄달력 특이사항, z-index 정책 |
| [04-testing-and-verification.md](04-testing-and-verification.md) | 테스트 구성(엔진/단위/계약/e2e), 골든마스터, 검증 사이클, 환경 함정 |
| [05-perf-case-paging-freeze.md](05-perf-case-paging-freeze.md) | 성능 사례: 페이징 freeze(devtools sync deep 구독 × 필드별 대입 O(N²)) — 진단 사다리·수리·가드레일 |

### 관련 문서
- [src/scheduler-engine/REDESIGN.md](../../src/scheduler-engine/REDESIGN.md) — 엔진 코어 설계서(잠금 모델 13섹션). **§13 = 설계 → 라이브 divergence** 를 먼저 볼 것.
- [src/scheduler-engine/CLAUDE.md](../../src/scheduler-engine/CLAUDE.md) · [src/pages/desktop/scheduler/CLAUDE.md](../../src/pages/desktop/scheduler/CLAUDE.md) — 자동 로드 규칙(현행 + 가드레일).
