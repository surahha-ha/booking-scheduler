import { test as base, expect } from '@playwright/test';

/**
 * e2e 공통 베이스.
 *
 * 이 앱에는 로그인이 없다. 기존 스펙들이 `authedPage` 를 주입받도록 작성돼 있어
 * 이름만 유지하고 실제로는 일반 `page` 를 그대로 넘긴다.
 */
export const test = base.extend<{ authedPage: import('@playwright/test').Page }>({
  authedPage: async ({ page }, use) => {
    await use(page);
  },
});

export { expect };
