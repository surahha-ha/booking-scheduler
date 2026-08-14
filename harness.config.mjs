/** 하네스 설정 — 부트스트랩 §2 의 다섯 칸만 채운 첫날 상태. */
export default {
  project: {
    name: '예약 스케줄러 프론트엔드',
    // 판별질문: "한쪽만 고치면 런타임에 깨지는 상대가 있나?" → 없음(단일 저장소, API 는 mock)
    repos: { self: '.', peers: [] },
  },

  commands: {
    build: 'npm run build',
    // ⭐ 판별질문("종료코드만 보고 판정 가능한가")이 결함을 잡았다.
    //    package.json 의 test 는 watch 모드라 종료코드로 판정할 수 없다 → run 을 명시한다.
    unitTest: 'npx vitest run',
    e2e: 'npx playwright test',
    lint: 'npm run lint',
  },

  // 판별질문: "이걸 잘못하면 누가 수습하나?" → 1인 프로젝트라 저자 본인.
  approvals: { destructive: '저자 본인', spec: '저자 본인', release: '저자 본인' },

  dangerGuard: {
    enabled: true,
    // 판별질문: "실행 후 5분 안에 원상복구할 수단이 있나?"
    deny: [
      {
        pattern: /\bgit\s+push\b[^|;&\n]*(--force(?!-with-lease)|\s-f(?=\s|$))/,
        why: '강제 푸시는 원격 이력을 덮어씁니다. 되돌릴 수 없습니다.',
        recover: '되돌리려는 커밋이 있으면 revert 로 새 커밋을 쌓으세요.',
      },
      {
        pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(src|tests)\b/,
        why: '소스/테스트 디렉토리 삭제는 미커밋 작업까지 함께 사라집니다.',
        recover: '지우려는 대상이 일부라면 경로를 좁히세요. 전체 초기화라면 브랜치를 먼저 만드세요.',
      },
    ],
    ask: [
      {
        pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)\b/,
        why: '커밋되지 않은 작업이 사라집니다.',
        recover: '남길 것이 있으면 stash 하거나 브랜치를 만든 뒤 진행하세요.',
      },
    ],
    // 공유 자원 없음 — 이 프로젝트는 외부 저장소에 쓰지 않는다(API 는 mock).
    shared: { targetPattern: null, writePattern: null },
  },

  testFirst: { enabled: false, grandfather: true, scopes: [] },
  drift: { mirrors: [], approvedDifferences: [] },
  // 판별질문: "이 문서가 틀리면 누군가 잘못된 작업을 하나?"
  docs: { always: ['README.md'], archive: [] },
  qualityCycle: { lightPath: { enabled: true }, flakiness: [] },
};
