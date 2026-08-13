import { test, expect } from './fixtures/testBase';

/**
 * 검색필터 일자 클릭 → 달력 팝업
 *
 * ⚠️ 회귀 배경: 클릭 핸들러는 처음부터 있었지만 팝업이 화면에 보이지 않았다.
 *    검색필터바(.scheduleSearchFilter)가 overflow-x:auto 라 CSS 사양상 overflow-y 도 auto 로
 *    계산되고, absolute 팝업이 바 높이(약 29px) 밖에서 전부 잘렸다.
 *    → .scheduleDatePopup 을 position:fixed + 트리거 기준 좌표로 바꿔 조상 클리핑을 벗어난다.
 *    그래서 "DOM 에 존재하는가" 가 아니라 "그 자리에 실제로 그려지는가" 를 봐야 한다.
 */

/** 팝업이 DOM 에만 있는 게 아니라 화면에 실제로 그려지는지 (중심점 hit-test). */
async function calendarState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const pop = document.querySelector<HTMLElement>('.scheduleDatePopup');
    if (!pop) return { open: false, visible: false, selected: '' };
    const r = pop.getBoundingClientRect();
    const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      open: true,
      visible: pop.contains(topEl),
      selected: pop.querySelector('.dp__active_date')?.textContent?.trim() ?? '',
    };
  });
}

test.describe('SchedulerV3 - 검색필터 일자 달력', () => {
  test('D1. 일자를 누르면 달력이 화면에 보이고, 보고 있던 날짜가 선택돼 있다', async ({
    authedPage: page,
  }) => {
    await page.goto('/book');
    await expect(page.locator('.scheduler-grid')).toBeVisible();
    await page.waitForTimeout(500);

    expect((await calendarState(page)).open).toBe(false);

    await page.locator('.scheduleNavDate__text').first().click();
    await expect.poll(async () => (await calendarState(page)).visible, { timeout: 5_000 }).toBe(true);

    // 고정 시계 2026-05-30 → 30 일이 선택 표시
    expect((await calendarState(page)).selected).toBe('30');
  });

  test('D2. 달력에서 날짜를 고르면 팝업이 닫히고 보드가 그 날짜로 이동한다', async ({
    authedPage: page,
  }) => {
    await page.goto('/book');
    await expect(page.locator('.scheduler-grid')).toBeVisible();
    await page.waitForTimeout(500);

    await page.locator('.scheduleNavDate__text').first().click();
    await expect.poll(async () => (await calendarState(page)).visible, { timeout: 5_000 }).toBe(true);

    await page.locator('.scheduleDatePopup .dp__cell_inner', { hasText: /^15$/ }).first().click();

    await expect(page.locator('.scheduleNavDate__text')).toHaveText(/05월 15일/);
    await expect.poll(async () => (await calendarState(page)).open, { timeout: 5_000 }).toBe(false);
    // 보드 헤더도 따라 이동 (라벨만 바뀌고 보드가 안 움직이는 회귀 차단)
    await expect(page.locator('.v3-header-inner').first()).toContainText('05-15');
  });

  test('D3. 달력 바깥을 누르면 닫힌다', async ({ authedPage: page }) => {
    await page.goto('/book');
    await expect(page.locator('.scheduler-grid')).toBeVisible();
    await page.waitForTimeout(500);

    await page.locator('.scheduleNavDate__text').first().click();
    await expect.poll(async () => (await calendarState(page)).visible, { timeout: 5_000 }).toBe(true);

    await page.locator('.scheduler-grid').first().click({ position: { x: 5, y: 5 } });
    await expect.poll(async () => (await calendarState(page)).open, { timeout: 5_000 }).toBe(false);
  });
});
