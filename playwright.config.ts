import { defineConfig, devices } from '@playwright/test';

/**
 * 스케줄러 E2E 설정
 * - vite dev server를 webServer로 자동 기동 (이미 떠있으면 reuseExistingServer)
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  /* 1회 재시도 — 통과하면 flaky 로 분류돼 "진짜 실패"와 섞이지 않는다.
   * 이 스위트는 실패 1건이 다음 테스트의 teardown 을 밀어 연쇄 실패를 만든 전력이 있다. */
  retries: 1,
  // 워커가 하나뿐인 dev 서버에 몰리면 초기 로딩이 타임아웃으로 밀린다(기본값 = CPU 절반).
  workers: 2,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: 'http://localhost:5180',
    /* 실패마다 수집하면 그 덤프 시간이 context teardown 을 timeout 너머로 밀어
     * 무관한 후속 테스트까지 "Tearing down context exceeded" 로 죽인다.
     * 재시도 때만 수집해 최초 실행 경로를 가볍게 유지한다. */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
