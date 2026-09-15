# 스케줄러 계산 엔진 (계산 레이어)

> 본 문서는 `src/scheduler-engine/` 디렉토리 작업 시 자동 로드된다.
> 전체 개요와 절대 원칙은 [프로젝트 루트 CLAUDE.md](../../CLAUDE.md) 참조.
> UI/인터랙션 레이어는 [src/pages/desktop/scheduler/CLAUDE.md](../pages/desktop/scheduler/CLAUDE.md) 참조.
>
> ⚠️ **활성 레이아웃 경로는 `redesign/`이다.** `SchedulerV3Page` 는 `redesign/layoutPipeline` 의 `runLayout` 을 호출한다.
> 설계 SSOT 는 [REDESIGN.md](REDESIGN.md) — 단 설계와 라이브가 어긋나면 **라이브가 옳다**(§13 divergence 를 먼저 볼 것).

---

## 📁 파일 구조

```
src/scheduler-engine/                    # 순수 계산 엔진 (Vue 의존성 없음)
├── redesign/                            # ★ 활성 엔진
│   ├── layoutPipeline.ts                # runLayout — 파이프라인 진입점 + 좌표/밴드/카드폭
│   ├── layoutCore.ts                    # 저수준 순수함수 (budget / maxConcurrent / arrangeCards / packPages)
│   ├── layoutTypes.ts                   # RunLayoutInput / LayoutConfig / Rect 타입 계약
│   └── runLayoutAdapter.ts              # store 입력 ↔ 엔진 어댑터 (resolveDoctorKey · unitKeyOf)
├── schedulerHeaderBuilder.ts            # 날짜 > 담당자 헤더 트리
├── schedulerHitTest.ts                  # band 기반 hitTest + minuteToBand{Top,Offset,Bottom}Px
│                                        #   Offset = band 내부 시간 비례 보간(현재시각선)
│                                        #   Bottom = 하단 여백(EMPTY_ROW_GAP_PX) 제외한 카드 바닥
├── schedulerSnapGrid.ts                 # 예약 격자 — snapMinute / floorToStep·ceilToStep
│                                        #   / clampEndToDay(하루 끝) / normalizeRangeToGrid(격자 밖 보정)
│                                        #   ★단위는 고정 30분(constants/componentConstants.ts 의 STEP_MIN 파생)
├── schedulerDateUtils.ts                # 날짜 유틸
├── types/scheduler.types.ts             # 엔진 base 타입
├── REDESIGN.md                          # 설계서 (엔진 코어 명세, §13 = 설계↔라이브 divergence)
└── __tests__/                           # Vitest — 목록·범위는 아래 「테스트」 표
```

구 3-Phase 엔진(`schedulerAppointmentLayout`·`schedulerTimeSlotBuilder`)은 이 레포에 **없다.** 이식 원본의 문서·주석에 남은 "Phase 1/2/3", `startMinute × 10 + rowIndex + 1` z 공식은 그 엔진 이야기라 여기엔 해당하지 않는다.

## 🧠 배치 엔진 — 활성 경로

활성 배치는 `redesign/layoutPipeline` 의 `runLayout` 이다. 파이프라인·배치·rect/z 계산의 **정본은 [REDESIGN.md](REDESIGN.md)** — 파생 파이프라인(§4), `arrangeCards` placed/floating(§5), z-index(§6), 순수함수 시그니처(§8). 라이브 기준 요약은 [docs/reference/01](../../docs/reference/01-layout-engine.md). 엔진 내부 규칙을 바꾸기 전 둘과 `redesign/` 실제 코드를 대조할 것.

⚠️ **'더 긴 예약' 판정은 두 곳에 있고 정의가 다르다** — 배치(열 선택)는 `isLongerCard`(`layoutCore.ts`), 층 판정(`computeRects` 의 layering pass)은 자체 비교(길이가 같으면 **먼저 시작한 카드가 아래**). 길이만 보던 종전 정의가 같은 길이·다른 시작 쌍을 같은 자리에 포갰기 때문이다. **한쪽만 고치면 배치와 들여쓰기가 서로 다른 규칙으로 돈다** — [REDESIGN.md §5](REDESIGN.md).

⚠️ **어느 시간으로 band 를 열지는 `resolveUnitHours`(`layoutPipeline.ts`) 한 함수가 정한다.** 예약검증(`useSchedulerRules`)이 같은 상황에 같은 답을 내야 하며, 그 동치성은 `src/composables/__tests__/schedulerOpenHours.contract.test.ts` 가 지킨다. 기본 운영시간 값은 `src/constants/operatingHours.ts` 에서만 파생한다 — 여기서 숫자를 따로 적지 말 것.

## 🧪 테스트 (Vitest, `__tests__/`)

| 파일 | 범위 |
|------|------|
| `layoutCore.golden.test.ts` | 코어 골든 스냅샷(arrangeCards / packPages / budget) |
| `layoutPipeline.test.ts` | runLayout 파이프라인 end-to-end |
| `runLayoutAdapter.test.ts` | store 입력 ↔ 엔진 어댑터 |
| `schedulerHitTest.test.ts` | 좌표 → 셀·시각 역산 |
| `minuteToBandOffsetPx.test.ts` | band 내부 시간 비례 보간(현재시각선) |
| `schedulerSnapGrid.step.test.ts` | `floorToStep`/`ceilToStep` + 예약 단위를 한 번만 적는지 |
| `schedulerSnapGrid.dayEnd.test.ts` | 하루 끝 규칙(`clampEndToDay`) |
| `schedulerSnapGrid.contract.test.ts` | **계약** — 예약 팝업과 보드가 같은 시각으로 저장하는지 |
| `normalizeRangeToGrid.test.ts` | 격자 밖 예약의 드롭 보정 |
| `schedulerInteraction.test.ts` | drag `isNoChange`·quickAction + snap·clampToOptions(**프로덕션 함수 실물 호출**) |

> 실행: `npx vitest run src/scheduler-engine/__tests__/`
> ⚠️ snap·clamp 테스트를 **사본으로 다시 만들지 말 것** — 예전엔 구현을 복제해 프로덕션 코드를 한 줄도 돌리지 않았다(틀려도 그린).
> ⚠️ 골든 단언이 깨지면 **"의도된 변경"인지 "회귀"인지 먼저 판단**하고, 의도면 갱신 + 커밋 메시지에 명시한다.

## ⚠️ 엔진 금지사항

- 외부 스케줄러 라이브러리 사용 금지
- `transform(scale)` 금지
- row height 고정 금지 (band 밀도 기반 가변)
- 날짜 하드코딩 금지
- 복잡한 계산 로직을 `.vue` 파일에 직접 작성 금지
- `bookStore.load()` 직접 호출 금지
- `ceil(count/N)` 사용 금지 (반드시 실제 배치 시뮬레이션 기반)
- lane expansion 방식 금지 (sub-column + indent 방식)
- 카드폭을 풀폭·가변으로 바꾸는 것 금지 — 항상 레인폭(`subColWidth`). 세 번 시도되고 세 번 거부됐다
