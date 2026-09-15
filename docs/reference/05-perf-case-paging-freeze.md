# 05. 성능 사례 — 페이징 90초+ freeze (devtools × 반응성 O(N²))

> 이식 원본에서 겪은 사례(2026-08). "화면이 20초 멈춘다"는 체감의 범인이 **렌더도 네트워크도 아니었던** 사례.
> 원인 규명 → 수리 → 재발 방지 가드레일까지의 전 과정 기록. 수리(`markRaw` 커밋 규약)는 이 레포의 `bookStore.ts` 에 그대로 들어 있다. 유사 증상 재발 시 이 문서부터.

---

## 1. 증상

- `/book` 에서 **조회 범위 밖으로 담당자 페이징** 시 화면 전체가 20초 이상 멈춤(클릭·스크롤 불능).
- 사용자 시계 실측 20초+, 자동화 계측으로는 **97~154초** Long Task 확인.
- 최초 랜딩은 정상(수 초), 이미 조회한 범위 안의 페이징도 정상(수십 ms) — **재조회가 걸리는 페이징만** 발생.
- **운영 빌드에서는 미발현. dev + Vue Devtools 확장이 설치된 브라우저 조합에서만 발생.**

## 2. 무죄가 확정된 것들 (실측)

| 용의자 | 실측 | 판정 |
| - | - | - |
| 네트워크(목록 응답) | 0.26~2.6초 | 무죄 |
| DOM 패치(카드 75건 렌더) | ~0.25초 | 무죄 |
| 레이아웃 엔진(`runLayout`) | 회당 0.1~3.6ms | 무죄 |
| 앱 코드의 배열/날짜 루프 | freeze 중 Array 메서드 7,790회·`new Date` 6,321회 (몽키패치 표본) | 무죄 |

기존 렌더 계측이 "패치 232ms"로 찍히는데 체감이 20초였던 이유:
계측은 `layout.rects` **변경 후**(렌더 단계)를 쟀고, freeze 는 그 **앞 단계**(응답→스토어 반영)였다.

## 3. 추적 과정 (재사용 가능한 진단 사다리)

1. **Long Task/LoAF 관측** — `PerformanceObserver`(longtask·long-animation-frame)로
   freeze 가 `XMLHttpRequest.onloadend` 발 **단일 태스크 97,703ms** 임을 확인.
   핸들러 자체는 1ms — 뒤따르는 microtask 연쇄(promise then→스토어 반영→반응성)가 전부.
2. **URL 귀속** — `XMLHttpRequest.prototype`(open + onloadend setter) 래핑으로
   범인 요청 = 장부 본조회 확정. 응답은 고작 **3일치**였다(데이터량 무죄).
3. **함수 귀속** — dev 서버에 `Document-Policy: js-profiling` 응답 헤더를 추가하고
   **JS Self-Profiling API**(`new Profiler`)로 스택 샘플링:
   샘플 59%가 Vue 반응성의 `traverse`(+track/get/ownKeys 합계 ~80%),
   그중 **99.5%의 스택 상위가 `applyBookItemToAppointment`**(`bookStore.ts`).
4. **기제 확정** — 스택에 `set → trigger → endBatch → job(즉시 실행) → deep getter → traverse`
   = **`flush:'sync'` 인 deep watcher**. pinia 소스에서 발견: dev 빌드는 `devtoolsPlugin` 이
   모든 스토어에 `$subscribe(…, {detached: true, flush: 'sync'})` 를 건다(= deep watch on `$state`).

## 4. 원인 체인 (둘이 곱해질 때만 폭발)

1. **뇌관(외부)** — dev 빌드 + Vue Devtools 확장 → pinia devtools 구독자가
   **상태 쓰기 1회마다 그 스토어 `$state` 전체를 동기 재귀순회**.
2. **증폭기(우리 코드)** — `applyBookItemToAppointment` 가 **반응형** 예약 객체에
   필드 ~30개를 **개별 대입**. 대입 1회 = 전체 순회 1회.
3. 합계: 예약 N건 × 30 트리거 × 순회 O(N×45필드) = **O(N²)** — N=100~160 에서 97~154초.

랜딩이 멀쩡했던 이유: 랜딩은 새 객체 생성 경로가 짧고, 페이징 재조회의
`upsertAppointments` 는 **기존 객체를 필드별로 재사용 갱신**하는 경로였기 때문.

## 5. 수리 (이 레포 `bookStore.ts` 에 반영됨)

- **예약 객체를 `markRaw`(비반응형)로 생성** — 필드 대입이 반응성 트리거를 만들지 않는다.
  커밋은 **배열 교체 1회**(`appointments.value = nextList`)가 유일한 트리거.
  ⚠️ `splice` 로 바꾸면 안 된다 — 같은 참조·같은 순서면 no-op 이 되어 재조회 갱신이 화면에 안 남는다.
- **읽기 전용 payload 스냅샷 `markRaw`** — deep 순회 대상 축소.
- **`selectedDate → periodDate` 동기화 비트리거화**(`SchedulerV3Page`) — 페이징 1회에
  `searchVersion` 이 이중 발화해 담당자·장부·통계 **전 세트가 2번** 나가던 중복 제거.
  재조회는 조회 윈도우 경로(`applyDataWindow → setWindow`)가 단독 담당.

**결과 실측(원본)**: 커버 밖 페이징 클릭→카드 표시 **97~154초 → 0.85초**, API 8콜 → 4콜, 연타 5회 무결, Long Task 최대 127ms.

이 레포는 네트워크 대신 mock adapter 라 응답 지연이 없지만, **스토어 반영 단계의 O(N²)는 동일하게 재현될 수 있다** — 시드를 키워 실측할 때 devtools 확장이 켜져 있으면 그 자체가 뇌관이다.

## 6. 가드레일 — 하지 말 것 / 의심할 것

- **대량 데이터를 반응형 스토어 객체에 "필드별 대입"으로 넣지 않는다.**
  plain(또는 `markRaw`) 객체로 완성한 뒤 **참조 교체 1회**로 커밋한다.
  스케줄러는 "전량 교체 → 전량 재계산" 규약이라 항목 단위 반응성이 필요 없다.
- **"내 자리에서만 느려요" = dev 전용 병목 의심.** devtools 확장 + dev 빌드 조합은
  운영에 없는 sync deep 구독을 모든 pinia 스토어에 추가한다.
- **계측이 체감과 어긋나면 계측 위치부터 의심한다.** 렌더 계측은 반영 단계 freeze 를 못 본다.
- **측정 중 탭 가시성 필수.** 탭이 가려지면(`visibilityState: hidden`) rAF 정지·타이머 분단위
  스로틀링으로 모든 타이밍 측정이 왜곡된다.
- 함수 단위 프로파일이 필요하면 dev 서버 응답 헤더 `Document-Policy: js-profiling` 을 `vite.config.js` `server.headers` 에 넣고 **JS Self-Profiling API** 를 쓴다. 이 레포 설정에는 **아직 넣지 않았다** — 필요할 때 dev 전용으로 추가한다.
