# CLAUDE.md — booking-scheduler

이 파일은 Claude Code 가 이 저장소에서 작업할 때의 진입점이다. **여기서 해당 문서로 라우팅만 하고, 규칙 본문은 각 문서에 있다.**

---

## 프로젝트 개요

담당자별 타임그리드 예약 스케줄러(Vue 3 + Vite). 병원·미용실·상담소·학원처럼 **담당자와 시간대가 있는 곳이면 어디든** 쓰도록 만든 자족형 웹앱이다. 백엔드가 없다 — API 는 `src/mocks/` 의 axios adapter 가 브라우저 안에서 처리하고 localStorage 에 영속한다.

- 활성 화면은 하나: `/book` → `src/pages/desktop/scheduler-v3/SchedulerV3Page.vue`. 라우트 정의는 `src/pages/index.js`.
- 렌더링은 자체 레이아웃 엔진(`src/scheduler-engine/redesign/`)이 좌표를 계산한다. 외부 캘린더 라이브러리 없음.
- 도메인 용어는 `src/messages/ko.json` 의 `terms` 가 단일 출처다(담당자·서비스 항목·고객·운영시간·휴무). 업종을 바꾸려면 그 섹션만 고친다. 문구·주석·문서는 이 용어표를 따른다(두 장부는 예약=`APPOINTMENT`, 방문=`TREATMENT`; 근무일 문맥은 "운영"). 코드 식별자(`doctorName`·`TREATMENT`·`TreatmentItem*` 등)와 파일명에는 이식 전 이름이 남아 있으며 이는 의도적이다 — 식별자 개명은 별도 결정 사항.

```bash
pnpm install         # 락파일은 pnpm-lock.yaml 하나뿐 — npm install 은 드리프트를 낸다
npm run dev          # http://localhost:5180 (vite.config.js 의 server.port)
npm run test         # vitest (watch) — 판정용은 npx vitest run
npm run test:e2e     # Playwright. dev 서버를 자동 기동한다(떠 있으면 재사용)
npm run lint         # eslint . — ★lint 판정은 이 명령으로만
npm run build
```

> ⚠️ `npx eslint src tests --ext …` 처럼 경로를 직접 주면 flat config 를 우회해 커밋본까지 `no-unused-vars` 로 거짓 빨간불이 난다. 판정은 `npm run lint` 로만 한다.
> ⚠️ 테스트가 `Failed to resolve import` 로 **collect 단계에서** 죽으면 회귀가 아니라 `node_modules` 가 낡은 것이다 — `pnpm install` 후 재판정.

---

## 작업 유형 라우팅 — 이 작업을 한다면

| 작업 | 먼저 읽을 것 |
| - | - |
| 스케줄러 레이아웃·배치 계산 | [src/scheduler-engine/REDESIGN.md](src/scheduler-engine/REDESIGN.md)(설계 SSOT) + [src/scheduler-engine/CLAUDE.md](src/scheduler-engine/CLAUDE.md) |
| 스케줄러 UI·인터랙션(카드·드래그·팝오버) | [src/pages/desktop/scheduler/CLAUDE.md](src/pages/desktop/scheduler/CLAUDE.md) |
| 엔진·페이지·CSS·검증 전반 인수인계 | [docs/reference/](docs/reference/README.md) |
| 운영시간·휴무 설정(어느 축이 이기나·상속) | `src/pages/desktop/scheduleBoard/offDayRules.ts` + `src/constants/operatingHours.ts` 가 규칙의 SSOT. 계약 테스트 `src/composables/__tests__/schedulerOpenHours.contract.test.ts` |
| API 요청/응답 필드·경로 변경 | `src/api/*Api.ts`(타입) ↔ `src/mocks/routes.ts`·`src/mocks/db.ts`(구현)를 **함께** 고친다. 스모크 `src/mocks/__tests__/` |
| 화면·컴포넌트·문구·흐름 신설/변경 | 전역 `ui-ux-guide` 스킬. 레포 계층 문서(`docs/rules/ui-ux.md`)는 **아직 없다** — 화면 작업을 시작하면 스킬의 템플릿으로 먼저 만든다 |
| 테스트 작성/보강 | `writing-good-tests` 스킬 |
| 커밋 직전 검증 | `npm run lint` → `npx vitest run` → `vite build` → e2e(건드린 스펙만 좁게, 아래 표) |

하위 `CLAUDE.md`(`src/scheduler-engine/`, `src/pages/desktop/scheduler/`)는 **작업 디렉토리에 따라 자동 로드**된다. 스케줄러 상세 규칙을 여기에 옮겨 적지 않는다.

e2e 를 좁게 돌릴 때의 대응: 엔진·격자 → `validation`·`drag`·`extended` / 조회·통계 → `scheduler-v2`·`search-filter` / 예약 팝업·서비스 항목 → `treatment-item`·`extended` / 운영시간·휴무 → `date-picker`. 파일명은 `tests/e2e/scheduler-v2-*.spec.ts` 지만 라우트는 `/book` 하나다(파일명만 잔존).

---

## 절대 원칙 — 어기면 바로 깨진다

스케줄러는 커스텀 엔진이다. 아래는 그 전제를 지키는 규칙이라 **예외가 없다.**

- **외부 스케줄러 라이브러리 신규 도입 금지.** 렌더링을 외부에 위임하면 도메인 요구를 끝까지 충족할 수 없다는 판단으로 자체 엔진을 만들었다.
- **CSS 기반 땜질 금지.** 배치·크기는 전부 계산으로 낸다.
- **계산 / 상태 / 렌더링 / 인터랙션을 분리한다.** 단일 컴포넌트에 몰지 않는다.
- **범용 캘린더로 설계하지 않는다.** 예약 도메인이 우선이다.
- **모든 예약은 항상 렌더링한다.** 숨김·"더보기" 없음.
- **`bookStore.load()` 직접 호출 금지.** 재조회는 `useSchedulerFilterStore` 의 `searchVersion` watch chain 으로만 트리거한다.
- **`.vue` 에 복잡한 계산 로직을 넣지 않는다** → `.ts` 로 분리.
- **공통 규칙·기능·화면은 공통 모듈로 관리한다.** 두 번째 자리에 같은 판정을 복사하지 않는다 → 아래 절.

## 공통화 — 같은 규칙을 두 번 쓰지 않는다

**같은 판정·같은 기능·같은 화면 조각이 두 번째 자리에 필요해지면, 복사하지 말고 공통 모듈로 올린 뒤 양쪽이 그것을 부른다.** 급해서 옆에 붙여 넣은 한 벌이 다음 사이클의 결함이 된다.

**왜** — 복제된 규칙은 **틀렸다는 사실이 드러나지 않는다.** 한쪽만 고치면 나머지는 조용히 옛 규칙으로 남고, 테스트도 리뷰도 고친 쪽만 본다. 이식 원본에서 실제로 난 일이다.

- 휴무 상속 규칙을 축 단위로 바꿨는데 밴드(`layoutPipeline`)가 따라오지 않아 **밴드는 열려 있는데 클릭하면 "운영시간 밖"** 이 됐다.
- 기본 운영시간이 예약검증(`'09:00'`)과 밴드(분 단위)에 각각 박혀 있어 손으로 맞춰야 했다 → 지금은 `src/constants/operatingHours.ts` 한 곳에서 파생한다.
- 같은 상속 판정이 설정 화면과 뷰어에 한 벌씩 있어, 갈리면 **같은 날 같은 담당자가 보기와 설정에서 다르게** 보였다 → `scheduleBoard/offDayRules.ts`.

**어디에 두나**

| 무엇 | 자리 |
| - | - |
| 도메인 판정(순수함수) | 그 도메인의 `*Rules.ts` (예: `scheduleBoard/offDayRules.ts`, `components/popup/reservationTimeRules.ts`, `utils/memberRules.ts`) |
| 화면 사이 공유 상수 | `src/constants/*.ts` — 값은 **한 번만** 적고 나머지는 파생시킨다 |
| 화면 조각 | `src/components/` 공통 컴포넌트(`ui/UiModal.vue` 등) |

**자료구조가 달라 함수를 합칠 수 없으면** — 예약검증은 `HH:mm` 으로 판정하고 밴드는 분으로 배치한다 — **판정 순서(정책)만 순수함수로 올리고 자료구조 접근은 각 호출자가 어댑터로 한다.** 그래도 합쳐지지 않는 계층은 **계약 테스트로 묶는다**(`schedulerOpenHours.contract.test.ts`: 같은 상황에 두 계층이 같은 답을 내는지). 억지로 한 함수로 만들지 않는다 — 어댑터가 규칙보다 복잡해지면 그 공통화는 실패다.

**판정** — 같은 규칙의 두 번째 사본을 만들려는 순간이 공통화 시점이다. "지금은 두 곳뿐"은 이유가 되지 않는다.

## 변경의 검증 범위

규칙 대부분이 **무엇을 지킬 것인가**라면, 이건 **변경이 검증 범위 안에 있는가**다. 분량 규칙이 아니다 — 작게 고쳐도 버그는 난다. 문제는 아무도 확인하지 않는 변경이다.

- **실행되지 않을 경로를 만들지 않는다.** 묻지 않은 옵션·설정·확장점, 1회용 코드의 추상화, 일어날 수 없는 경우의 방어코드는 요구사항도 테스트도 없어 검증 대상 밖에 남는다. 필요해지는 시점에 만든다.
- **요청에 없는 변경을 섞지 않는다.** 인접 코드의 포맷·주석·네이밍을 "겸사겸사" 고치면 리뷰어도 테스트도 그것을 보고 있지 않다. 이번 수정으로 안 쓰이게 된 import·변수는 지우되, **원래부터 죽어 있던 코드는 보고만 하고 건드리지 않는다.**

**판정:** 바뀐 줄마다 "요청의 어느 부분인가"를 답할 수 있어야 한다. 정리·리팩터를 명시적으로 지시받았다면 그것이 요청이므로 제외다.

## 코드 컨벤션

| 파일 유형 | 언어 | 역할 |
| - | - | - |
| `.vue` | JavaScript + `<script setup>` | 화면 조립, props/emit |
| `composables/*.ts` | TypeScript | 상태 머신, 인터랙션 로직 |
| `stores/*.ts` | TypeScript | Pinia 스토어 |
| `scheduler-engine/*.ts` | TypeScript | 배치 계산, 좌표 변환 |
| `api/*.ts` | TypeScript | API 호출 + **해당 요청/응답 타입 정의** |
| `mocks/*.ts` | TypeScript | 브라우저 내 API 구현(routes)·저장소(db)·영속화(persist)·시드(csvSeed) |

- 타입 전용 디렉토리(`src/types/`)는 **없다.** 타입은 쓰이는 곳에 co-locate 하고, API 계약 타입은 각 `api/*Api.ts` 안에 둔다.
- 다이얼로그는 `src/lib/useDialog.ts`(`alert`/`confirm`) 하나로 띄운다. 호스트는 `components/frame/AppDialogHost.vue`(`.app-dialog`). 브라우저 `alert()` 금지 — e2e 가 멈춘다.
- 스케줄러 작업 시 응답 순서: **구조 → 설계 이유 → 타입 → 계산 로직 → 컴포넌트 구조 → 코드.** 코드부터 쓰지 않는다.

---

## 문서 규약

| 디렉토리 | 성격 |
| - | - |
| `docs/reference/` | 인수인계 (상시, 라이브 코드 기준) |
| `src/scheduler-engine/REDESIGN.md` | 엔진 설계서. 설계와 라이브가 어긋나면 **라이브가 옳다** — §13 을 먼저 볼 것 |

- 상시 문서 상단에는 **기준 브랜치·커밋**을 적는다. 기준 없는 서술은 어느 시점에선 반드시 거짓이 된다.
- 문서와 코드가 어긋나면 **코드가 옳다.** 발견 즉시 문서를 고친다.
- **현행성 감사 범위에 자동 로드 `CLAUDE.md` 3종(루트·`scheduler/`·`scheduler-engine/`)을 반드시 포함한다.** 항상 컨텍스트에 실리는 파일이 가장 오래 stale 로 남는다.
- md 는 lint 대상이 아니다. `npx eslint <파일>.md` 는 md 를 JS 로 파싱해 `Parsing error` 를 낸다.

### 무엇을 어디에 쓰나 — SSOT 3원칙

1. **한 사실은 한 곳(SSOT).** 같은 표·정의를 두 문서에 복제하지 않는다. 두 번째 문서는 **링크**한다. (예: ⋮ 분기 매트릭스 SSOT = `scheduler/CLAUDE.md`, `reference/03` 은 링크만)
2. **코드가 SSOT 인 값은 문서에 적지 않는다.** 상수값·테스트 수·함수 시그니처는 **값 대신 위치**를 적는다. `CARD_RIGHT_GAP = 4px`(X) → `CARD_RIGHT_GAP`(`layoutPipeline.ts`)(O). **라인번호 금지 — 심볼명으로.**
3. **현행과 이력을 분리한다.** 자동 로드 문서와 상시 문서 본문에는 **현행 + 재발방지 가드레일만**. 지난 경위는 같은 문서 하단 `## 이력` 으로 격리한다.

> 단, **이력이 곧 규칙인 것은 본문에 남긴다.** "N번 거부됨"(카드폭 풀폭 등) 같은 가드레일은 자동 로드에 있어야 다음 사람이 반복하지 않는다.

## 커밋

- 한글, prefix `feat :` `fix :` `chore :` `refactor :` `test :` `docs :` (콜론 앞 공백). 제목에 검증 실측(lint·단위·e2e)을 괄호로 적는 관례.
- 이식 원본 저장소의 커밋 해시·시스템명은 적지 않는다 — "어떤 동작"으로만 쓴다.
