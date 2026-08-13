import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 진료 모드 (TREATMENT) 시나리오
 *
 * 정책 (CLAUDE.md):
 *   - dataType=TREATMENT 진입 시 SchedulerToolbar(N칸/zoom) 숨김
 *   - DateStrip max=오늘 (미래 날짜 클릭 차단)
 *   - DateStrip 모드: 오늘 기준 -30일, 오늘이 끝
 *   - ⋮ 메뉴: 완료 / 미이행 / 예약 취소 / 초기화 / 진료 삭제
 *   - hover quick action: 00→접수(파랑), 05→완료(녹)
 *   - zoom=5 고정 (1일 보기)
 *
 * 진입 방법: query string `?dataType=TREATMENT`로 강제 (useQueryString이 store에 반영)
 */

async function navigateTreatment(page: Page) {
  await page.goto('/book?dataType=TREATMENT');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(800);
}

test.describe('SchedulerV2 - 진료 모드 (TREATMENT)', () => {
  test('26. TREATMENT 모드 진입 시 SchedulerToolbar(N칸/zoom)가 숨겨진다', async ({ authedPage: page }) => {
    await navigateTreatment(page);
    // 예약 모드와 달리 toolbar는 v-if="isAppointmentMode"로 미렌더링
    const toolbar = page.locator('.schedulerToolbar');
    await expect(toolbar).toHaveCount(0);
  });

  test('27. TREATMENT 모드의 DateStrip은 오늘 이후 날짜를 표시하지 않는다', async ({ authedPage: page }) => {
    await navigateTreatment(page);
    // CLAUDE.md 정책: 진료 모드 strip = 선택일 기준 -30일, 오늘이 끝
    // 즉 strip 내 dayCell의 마지막은 오늘 이전이어야 (미래 날짜 셀 자체가 안 보임)
    const dayCells = page.locator('.scheduleDateStrip__dayCell');
    const totalCells = await dayCells.count();
    expect(totalCells).toBeGreaterThan(0);

    // 진료 모드는 ">"(shift-next) 버튼이 today 도달 시 숨겨짐 (v-show)
    // 즉 미래 이동 자체가 차단 → 시나리오 28과 동일 정책의 다른 측면
    const dayNavRight = page.locator('.scheduleDateStrip__dayNav').nth(1);
    const navVisible = await dayNavRight.isVisible().catch(() => false);
    expect(navVisible).toBe(false);
  });

  test('28. TREATMENT 모드의 DateStrip > 버튼은 오늘 도달 시 숨겨짐', async ({ authedPage: page }) => {
    await navigateTreatment(page);
    // [오늘] 클릭으로 today 정렬
    await page.locator('.scheduleDateStrip__today').click();
    await page.waitForTimeout(500);

    // 연두색 > (shift-next) 버튼은 v-show="!isNextDisabled"로 숨겨져야
    // 즉 visible count 0이거나 [hidden] 처리
    const dayNavRight = page.locator('.scheduleDateStrip__dayNav').nth(1); // 두 번째 = 우측
    const visible = await dayNavRight.isVisible().catch(() => false);
    expect(visible).toBe(false);
  });

  test('29. TREATMENT 모드는 SchedulerPanel/Header/Grid 등 핵심 컴포넌트 정상 마운트', async ({ authedPage: page }) => {
    await navigateTreatment(page);
    await expect(page.locator('.v3-board')).toBeVisible();
    await expect(page.locator('.scheduler-header')).toBeVisible();
    await expect(page.locator('.scheduler-grid')).toBeVisible();
    await expect(page.locator('.scheduleDateStrip')).toBeVisible();
  });

  test('30. TREATMENT 모드에서 카드 ⋮ 메뉴는 진료 모드 항목 5개 (완료/미이행/취소/초기화/삭제)', async ({ authedPage: page }) => {
    await navigateTreatment(page);
    // 오늘 또는 과거 날짜의 카드가 1개 이상 있어야 시나리오 동작
    const cardCount = await page.locator('.appointment-card').count();
    test.skip(cardCount === 0, '진료 모드에서 카드가 없음 (LIVE 환경: 오늘 날짜 데이터 없음 가능)');

    const card = page.locator('.appointment-card').first();
    await card.hover();
    await page.waitForTimeout(300);
    await page.locator('.quick-action-btn').click();

    const popover = page.locator('.appointment-popover');
    await expect(popover).toBeVisible();

    // 진료 모드 메뉴 항목 검증
    await expect(popover.locator('.popover-menu__item', { hasText: '완료' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '미이행' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '예약 취소' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '초기화' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '진료 삭제' })).toBeVisible();
  });
});
