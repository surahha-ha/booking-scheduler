import { test as base, expect } from '@playwright/test';

/** 로컬 백엔드 저장분 키 — src/mocks/persist.ts 의 KEY 와 같아야 한다. */
const DB_KEY = 'booking-scheduler:db:v2';

/**
 * e2e 공통 베이스.
 *
 * 이 앱에는 로그인이 없다. 기존 스펙들이 `authedPage` 를 주입받도록 작성돼 있어
 * 이름만 유지하고 실제로는 일반 `page` 를 그대로 넘긴다.
 *
 * ★ 테스트 격리: 저장분(localStorage)을 페이지 스크립트 실행 "전에" 지운다.
 *   지우지 않으면 앞 테스트가 추가한 그룹·항목·상태변경이 다음 테스트의 기대값
 *   (칩 개수, 저장 버튼 활성 등)을 깨뜨린다. 매 테스트가 시드에서 새로 시작한다.
 */
export const test = base.extend<{ authedPage: import('@playwright/test').Page }>({
  authedPage: async ({ page }, use) => {
    await page.addInitScript((key) => {
      try {
        window.localStorage.removeItem(key);
      }
      catch { /* 저장소 접근 불가 환경 — 시드로 시작하므로 무해 */ }
    }, DB_KEY);
    await use(page);
  },
});

export { expect };
