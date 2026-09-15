# 03. 카드 렌더 · CSS 토큰 · 포털 · 화면 분기

> 카드 표시·상태색, CSS 토큰(`_tokens.scss`), `.v3-qa-portal` teleport, 줄달력, z-index 정책.
> 기준: `main` @ `05a56f4` (2026-09-15)

---

## 1. 카드 (`scheduler/components/AppointmentCard.vue`)

- 좌표(top/left/width/height/z) = `runLayout` 이 산출한 **인라인 style**(JS 영역, CSS 로 못 바꿈).
- scoped 클래스 `.appointment-card` + 상태 클래스. **🔒 `.appointment-card` 는 e2e 락**(rename 금지).
- 표시 정보 = `displayInfo` 순서(예약장부 설정에서 드래그 재정렬 → 영속). line-clamp + 커스텀 툴팁.
- 고객명은 `flex: 0 1 auto`(EXT/당일 뱃지 이름 옆), 우측은 hover 액션 전용(겹침 해소).
- 외부 연동 건(`isExternalSync`) → 'EXT' 뱃지. '당일' 뱃지는 TREATMENT 화면에서 **그 장부에서 등록한 건**의 등록일이 오늘일 때만.

### 카드 상태색 (상태코드 매핑)

> 상태코드 ↔ API state ↔ 클래스 매핑 SSOT = [scheduler/CLAUDE.md](../../src/pages/desktop/scheduler/CLAUDE.md) 「📊 상태코드 매핑」. 여기서는 **색 토큰만** 다룬다.

| 코드 | 카드 클래스 | bg / border 토큰 |
|------|------------|-----------------|
| 00 | **없음**(기본 스타일) | `--scheduler-card-waiting-*` |
| 01 | `.status-done` | `--scheduler-card-done-*` |
| 02 | `.status-undone` | `--scheduler-card-undone-*` |
| 03 | `.status-cancel` | `--scheduler-card-cancel-*` (전화 취소선) |
| 05 | `.status-receipt` | `--scheduler-card-receipt-*` |

- **`00` 에는 클래스가 붙지 않는다.** `STATUS_CLASS_MAP`(`AppointmentCard.vue`)에 키가 없어 `.appointment-card` 기본 배경이 곧 예약색이다. `.is-waiting` 셀렉터는 존재하지 않는다.
- 색값은 `scss/schedule/v3/_tokens.scss` 가 SSOT — 문서에 박제하지 않는다. 브랜드색도 같은 파일(`_variables.scss` 와 함께).
- ⭐**예약 화면(`APPOINTMENT`)은 `00`·`03` 만 구분하고 나머지 상태는 예약(`00`)처럼 그린다.** `toDisplayStatus`(`src/utils/schedulerSearchFilterUtils.ts`)가 표시 직전에 접는다 — 표시용 변환이고 저장값은 그대로다. TREATMENT 화면은 5상태를 그대로 쓴다.

> 카드 5상태 + 팝업 상태뱃지가 **공유 토큰**을 본다 → `_tokens.scss` 값만 바꾸면 카드+팝업 동시 반영.

### 레이어링 밑바탕 마커 (`.is-long-card.is-layer-base`)

- ⭐**셀렉터는 두 클래스가 겹칠 때만**이다 — `isLongCard`(다른 예약이 시작하는 band 를 지나가는 **긴 예약**) **와** `isLayerBase`(**위에 얹힌 카드가 있음**) 둘 다. 판정은 엔진([01 §3-2](01-layout-engine.md)) — CSS 는 켜고 끄기만 한다.
  - 바는 '길다'가 아니라 '**아래에 가려진 것이 있다**'는 신호다. `isLongCard` 단독이면 아무에게도 가려지지 않은 긴 예약까지 바가 붙는다.
  - **두 플래그를 하나로 합치지 말 것** — 리사이즈 핸들 포털(§2)은 `isLayerBase` **단독** 조건이라 뜻이 다르다.
- **농도는 층수 비례 계단**이다. `cardStyle` 이 `--layer-marker-opacity` 를 `layerDepth` 로 산출해 인라인으로 싣고 `::before` 마커가 받는다(하한 있음 — 취소 회색처럼 연한 상태색이 배경에 묻지 않는 최소값). 같은 상태색을 유지한 채 농도만 낮춰, 계단 들여쓰기와 같은 방향으로 '누가 맨 아래인가'가 읽히게 한다.
- 색 토큰 `--scheduler-layer-base-marker`(`_tokens.scss`).
- **`border-left` 가 아니라 `::before`** 다. `:hover`·`.is-invalid`·`status-*` 가 모두 `border-*` 를 덮어써서 마커가 지워지기 때문. 같은 이유로 새 카드 장식은 border 로 만들지 말 것.
- 알려진 잔여: hover 시 카드 자체 border 가 굵어져 마커가 1px 우측으로 밀린다(`::before` 는 padding box 기준).

---

## 2. `.v3-qa-portal` teleport — hover ⋮ 와 hover 주황 테두리 (★특이사항)

가장 까다로웠던 부분. **시도→거부**가 반복돼 현재 패턴으로 수렴했다.

### 문제
- hover 한 카드의 **⋮ 버튼**과 **주황 테두리**가, z 가 더 높은 인접(겹친) 카드에 잘려 뜨문뜨문 보임. z 서열이 `Z_BASE`/`Z_FLOAT` 2단계뿐이어도 겹친 카드에 잘리는 문제 자체는 같다.

### 거부된 해법 (하지 말 것)
- ❌ **카드 전체 z-lift**(hover 시 z 최상위): 긴 카드가 다른 카드를 덮어버림 → 거부.
- ❌ **body fixed teleport**: 스크롤 시 카드와 분리돼 안 따라옴 → 거부.

### 현재 해법 (정답)
- ⋮ 와 주황 테두리를 **보드 내부 포털 `.v3-qa-portal` 로 teleport**(absolute + 카드 rect 좌표, 전 카드 위 z).
- 주황 테두리(`.appointment-hover-border`)는 **투명 박스 + 테두리만** 별도로 teleport, `pointer-events: none`, 기존 카드 border 에 가산.
- 조건: `isHovered && !isDragTarget && !isResizeTarget`.
- ⋮ popover 는 **window 캡처 scroll 리스너로 닫음**(bodyEl scroll 만으론 미발화 — 브라우저 전체 스크롤 시 떠다니던 문제).
- **밑바탕(`isLayerBase`) 카드의 리사이즈 핸들도 같은 포털로 사본(`.resize-handle-portal`)을 띄운다.** 꼬리 위에 얹힌 float 이 카드 안 하단 핸들을 가려 잡을 수 없었다. hover z-lift 는 금지 정책이라 ⋮ 와 같은 포털 패턴을 재사용한다. 전 카드에 켜면 e2e 의 `.resize-handle--bottom` 좌표 클릭을 포털이 가로챈다.

---

## 3. 우측 +추가 strip

- 모든 카드를 우측으로 `CARD_ADD_STRIP_RATIO` 만큼 좁힌다(엔진). 그 자리에 기존 그리드 셀의 **hover +추가**가 노출됨.
- 헤더 "+추가 버튼" 대신 채택된 방식 → 점유 시간대에도(N=1 포함) 추가 진입 가능, 별도 버튼 불요.
- 비율은 라이브 튜닝으로 여러 번 좁혀졌다 — 값은 코드.

---

## 4. CSS 토큰 — 원칙

### 무사이드이펙트 3대 원칙
1. **토큰은 `:root` 에 정의** — 팝업(`UiModal`)이 body 로 teleport → `.v3-page` 스코프 안 닿음. `:root` 라야 도달.
2. **클래스명 절대 불변** — e2e spec 이 `.appointment-card`/`.grid-cell`(+`.is-*`)/`.tisp-*`/`.tcs-*` 셀렉터로 의존.
3. **편집 경계 = 색/간격/테두리/폰트/그림자 토큰만** — 카드 기하(top/left/w/h)는 JS.

### 안전 치환법
`var(--token, 현재값)` — fallback 이 현재값이라 **시각 무변·오타 안전**. SCSS 는 `$var:#hex` → `$var:var(--token,#hex)` 한 줄로 전파(단 `darken/mix` 색함수 인자엔 불가).

### 자리
- `scss/schedule/v3/_tokens.scss` — 스케줄러 토큰(`:root`). accent/brand/now/cell/stripe/header 계열 + 카드 5상태.
- `scss/schedule/v3/_preview.scss` — `DragPreview`/`ResizePreview` 공용 `@mixin preview-box`(scoped 격리 유지).
- `scss/schedule/_popup-common.scss`·`_popup-mixin.scss`·`_setting-chip.scss` — 팝업·설정 칩 공용.
- 공유 CSS(`SearchFilter`/`Settings` 전역) 정리는 미착수 — 진짜 공유라 신중.

---

## 5. 화면 분기 · 줄달력

> **분기 매트릭스 SSOT = [scheduler/CLAUDE.md](../../src/pages/desktop/scheduler/CLAUDE.md) 「🔀 예약 / 방문 화면 분기」.**
> 같은 표를 두 곳에서 관리하다 ⋮ 메뉴 항목이 한쪽만 갱신돼 어긋난 전례가 있어, 여기서는 중복하지 않는다.
> ⋮ 메뉴의 실제 정의처는 `pages/desktop/scheduler/appointmentCardMenu.ts` 다.

### 줄달력(SchedulerDateStrip) 특이사항
- 중립색 + 강조색 한 벌, 날짜 타이트 + `::before` 원형 강조.
- 당일 미선택 시 테두리 동그라미(`box-shadow inset` = 공간 미차지, 레이아웃 안정).
- 공휴일 셀 = `holidayStore.isHoliday` → `is-holiday`(붉은색). 요일색 뒤에 두어 토요일 공휴일도 붉다. 셀이 걸친 연도는 줄달력이 직접 `ensureYears` 로 보장한다(페이지의 `visibleDates` watch 는 보드 컬럼 기준이라 창을 덮지 않음).
- 연도 라벨 = "1월 앞에만"(`yearLabelFor`). 맨 앞 월에도 붙이는 안은 "보고 있는 연도가 늘 왼쪽에 떠 있다" 로 반려됐으니 다시 넣지 말 것.
- 공휴일 소스는 `api/publicHolidayApi.ts` → mock `db.selectNationalHolidays`(양력 고정일만). 외부 API 는 붙이지 않았다 — 자족 원칙과 서비스키 노출 문제.

---

## 6. Z-index 정책

| 레이어 | 비고 |
|--------|------|
| AppointmentLayer | 카드 컨테이너(Grid pointer-events 충돌 방지) |
| 카드 base / floating | `Z_BASE` / `Z_FLOAT` — 엔진 산출 |
| `.v3-qa-portal`(hover ⋮·테두리·핸들 사본) | 전 카드 위 |
| NowIndicator | 카드 위, 포털 아래 |
| Blocker(`.v3-blocker`, 팝업 열림 시 보드 클릭 차단) | sticky 헤더 위·팝업 아래. popover 는 outside-click 이라 blocker 없음 |
| Popover / `.app-dialog` | 최상위 |

값은 각 컴포넌트 스타일과 `_tokens.scss`·`_modals.scss` 를 연다.

> ⚠️ 카드 hover 시 **z-lift 금지**(긴 카드 덮음). 위로 띄워야 하면 `.v3-qa-portal` teleport 패턴 사용.

---

## 7. 특이사항 모음

- **중앙 page-nav `‹›` 버튼은 현재 숨김**: `.v3-page-nav { display: none }`. 다시 보이려면 `none → flex` **한 곳만** 변경(템플릿 버튼·핸들러·`canBodyNext` 는 보존됨). 교훈: CSS 한 줄 안 먹으면 scoped/specificity 의심 전에 **같은 룰 내 속성 중복**부터 빌드 CSS 로 확인(`display:none` 뒤 `display:flex` 가 이김).
- **`/book` lazy import** → scoped 는 코드분할. 토큰만 전역(`:root`)화해 부팅 번들 영향 최소화(전역 styles.scss 로 블록 이동은 지양).
- **다이얼로그는 `.app-dialog`(`AppDialogHost.vue`) 하나** — `useDialog().alert/confirm`. 설정 팝업은 다이얼로그가 떠 있는 동안 ESC·바깥 클릭이 자기를 닫지 않도록 `useDialogGuard` 로 막는다.
