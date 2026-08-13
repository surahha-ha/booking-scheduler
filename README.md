# booking-scheduler

담당자별 타임그리드 예약 스케줄러. 병원·미용실·상담소·학원처럼 **담당자와 시간대가 있는 곳이면 어디든** 쓸 수 있도록 만든 웹앱이다.

## 무엇을 하는가

- **담당자별 컬럼 타임그리드** — 날짜 × 담당자 2단 헤더, 컬럼 N칸 분할, 줌, 동시 예약 자동 레인 배치
- **예약 관리** — 카드 드래그 이동 / 상하 리사이즈로 시간 변경 / 팝업 등록·수정·삭제 / 상태 전이
- **운영 규칙** — 영업시간·점심·휴무일·요일별 휴무·담당자별 근무시간
- **마스터 관리** — 담당자, 서비스 항목, 표시 설정(시간 단위·카드 표시 항목·행 높이)

배치·크기는 전부 계산으로 낸다. 외부 캘린더 라이브러리를 쓰지 않고 자체 레이아웃 엔진(`src/scheduler-engine/`)이
좌표를 산출하며, **모든 예약을 항상 렌더링한다** — 숨김이나 "더보기"가 없다.

## 기술 스택

Vue 3 (`<script setup>`) · Vite 5 · Pinia · Vue Router · Vue I18n · Bootstrap 5 / BootstrapVueNext
테스트: Vitest + happy-dom, Playwright(e2e)

## 시작하기

```bash
pnpm install
npm run dev          # http://localhost:5173
```

데이터는 브라우저 localStorage 에 저장된다. 별도 백엔드나 DB 없이 바로 돌아간다.

```bash
npm run test         # 단위 테스트 (watch)
npm run test:e2e     # e2e
npm run lint
npm run build
```

## 로드맵

1. **localStorage** — 백엔드 없이 브라우저에만 저장 (현재)
2. **Docker + Postgres** — NestJS + Prisma API 서버
3. **AWS ECS/Fargate** — 컨테이너 배포 + RDS, Google OAuth 로그인

## 라이선스

MIT
