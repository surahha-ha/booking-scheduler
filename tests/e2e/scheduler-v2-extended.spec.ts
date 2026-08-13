import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 확장 시나리오 — LIVE 모드 권장
 *
 * 카드 hover, ⋮ 메뉴, 상태 변경, 예약 등록/수정 팝업, 드래그 검증 규칙.
 * MOCK 모드에서도 동작하지만 was 실 데이터/API 응답이 더 정확한 검증을 제공.
 *
 * 데이터 변경 정책: 상태 변경 시나리오는 cleanup으로 원상태 복원.
 */

async function navigateTo430(page: Page) {
  await page.goto('/book');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);
  const day30 = page.locator('.scheduleDateStrip__dayCell', { hasText: /^30$/ }).first();
  await expect(day30).toBeVisible();
  await day30.click();
  await expect.poll(
    async () => page.locator('.appointment-card').count(),
    { timeout: 15_000 }
  ).toBeGreaterThanOrEqual(1);
}

test.describe('SchedulerV2 - 카드 Hover / ⋮ 메뉴', () => {
  test('14. 카드 hover 시 ⋮ 버튼이 노출된다', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.hover();
    // hover 후 quickActionDelay(150ms) 대기
    await page.waitForTimeout(300);
    const dotBtn = page.locator('.quick-action-btn');
    await expect(dotBtn).toBeVisible();
  });

  test('15. ⋮ 클릭 시 popover가 열린다 (예약 모드 메뉴 3개)', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.hover();
    await page.waitForTimeout(300);
    await page.locator('.quick-action-btn').click();

    const popover = page.locator('.appointment-popover');
    await expect(popover).toBeVisible();
    // 예약 모드: 변경 / 예약 취소 / 예약 삭제
    await expect(popover.locator('.popover-menu__item', { hasText: '변경' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '예약 취소' })).toBeVisible();
    await expect(popover.locator('.popover-menu__item', { hasText: '예약 삭제' })).toBeVisible();
  });

  test('16. popover 외부 클릭 시 닫힘', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.hover();
    await page.waitForTimeout(300);
    await page.locator('.quick-action-btn').click();
    await expect(page.locator('.appointment-popover')).toBeVisible();

    // 빈 grid-cell 클릭으로 outside click
    await page.locator('.grid-cell').first().click({ force: true });
    await page.waitForTimeout(500);
    await expect(page.locator('.appointment-popover')).not.toBeVisible();
  });
});

test.describe('SchedulerV2 - 상태 변경 / 삭제', () => {
  test('17. ⋮ → "예약 삭제" 클릭 시 confirm dialog가 열린다 (취소로 닫음)', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.hover();
    await page.waitForTimeout(300);
    await page.locator('.quick-action-btn').click();
    await page.locator('.popover-menu__item', { hasText: '예약 삭제' }).click();

    // 확인 다이얼로그 = 자체 구현(AppDialogHost)
    const dialog = page.locator('.app-dialog').first();
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // "취소" 버튼으로 닫기 → 저장분 변경 없음 보장
    const cancelBtn = dialog.locator('.app-dialog__btn--ghost').first();
    await cancelBtn.click();
    await page.waitForTimeout(500);
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test('17-b. ⋮ → "예약 취소" 클릭 시 modify-state API가 호출된다 (자동 원복)', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.hover();
    await page.waitForTimeout(300);
    await page.locator('.quick-action-btn').click();

    /* 로컬 백엔드는 axios adapter 층에서 응답하므로 실제 네트워크 요청이 나가지 않는다.
     * → waitForRequest 대신 "상태가 실제로 바뀌었는가"를 저장분에서 확인한다. */
    const KEY = 'booking-scheduler:db:v2';
    const backup = await page.evaluate((k) => localStorage.getItem(k), KEY);
    const cancelledCount = async () => page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      if (!raw) return -1;
      return JSON.parse(raw).reservations.filter((r: any) => r.statusCode === '03').length;
    }, KEY);

    const before = await cancelledCount();

    await page.locator('.popover-menu__item', { hasText: '예약 취소' }).click();

    // '03' = 예약취소 — 저장분에 반영됐는지로 확인
    await expect.poll(cancelledCount, { timeout: 8_000 }).toBe(before + 1);

    // ─── 자동 원복: 저장분 스냅샷 복원 (다음 테스트는 새 페이지 로드라 여기서 다시 읽는다) ───
    if (backup) await page.evaluate(([k, b]) => localStorage.setItem(k, b), [KEY, backup]);
  });
});

test.describe('SchedulerV2 - 예약 등록 팝업', () => {
  test('18. 빈 grid-cell 클릭 시 ReservationPopup(ADD 모드)이 열린다', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);

    const emptyAddCells = page.locator('.grid-cell.is-empty-add');
    const total = await emptyAddCells.count();
    test.skip(total === 0, '빈 셀 없음 (모든 시간대가 카드로 점유됨)');

    // grid 전체 height가 매우 클 수 있으므로 viewport 안에 들어가는 첫 빈 셀 선택
    // (이전 fixme 사유였던 'last cell이 viewport 한참 밖이라 click dispatch 실패' 회피)
    const viewport = page.viewportSize();
    const vh = viewport?.height ?? 720;
    const cells = await emptyAddCells.all();
    let targetBox: { x: number; y: number; width: number; height: number } | null = null;
    for (const cell of cells) {
      const box = await cell.boundingBox();
      if (!box) continue;
      if (box.y >= 0 && box.y + box.height <= vh) {
        targetBox = box;
        break;
      }
    }
    // viewport 내 셀이 없으면 첫 셀로 scroll 후 진행
    if (!targetBox) {
      const first = emptyAddCells.first();
      await first.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      targetBox = await first.boundingBox();
    }
    expect(targetBox).not.toBeNull();

    const cx = targetBox!.x + targetBox!.width / 2;
    const cy = targetBox!.y + targetBox!.height / 2;
    await page.mouse.click(cx, cy, { delay: 50 });
    await page.waitForTimeout(1000);

    // ReservationPopup 의 모달 wrapper class = `.schedulePopup`
    const popup = page.locator('.schedulePopup').first();
    await expect(popup).toBeVisible({ timeout: 8_000 });

    // 닫기
    const closeBtn = page.locator('.schedulePopup .uiModal__close').first();
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  });

  test('19. 카드 클릭 (threshold 미만) 시 ReservationPopup 수정 모드가 열린다', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();

    // mock 카드는 14:00(오전 뷰포트 밖 아래) → 좌표 클릭 전 스크롤 인.
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = await card.boundingBox();
    if (!box) test.fail();

    // mousedown→mouseup 거의 이동 없이 (threshold 5px 미만)
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 1, y + 1);
    await page.mouse.up();
    await page.waitForTimeout(800);

    // ReservationPopup 의 모달 wrapper class = `schedulePopup`
    const popup = page.locator('.schedulePopup .uiModal__content').first();
    await expect(popup).toBeVisible({ timeout: 8_000 });

    const closeBtn = page.locator('.schedulePopup .uiModal__close').first();
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  });
});

test.describe('SchedulerV2 - 검증 규칙', () => {
  test('20. 휴무 시간대(.is-closed) 셀은 클릭해도 ReservationPopup이 열리지 않는다', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);
    const closedCell = page.locator('.grid-cell.is-closed').first();
    const exists = await closedCell.count();
    test.skip(exists === 0, '휴무 셀이 없음 (mock 환경에서는 모든 요일 운영시간 설정됨)');

    await closedCell.click({ force: true });
    await page.waitForTimeout(800);
    const popup = page.locator('.schedulePopup').first();
    const visible = await popup.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(visible).toBe(false);
  });

  test('21. 과거 시간대(.is-past) 셀은 클릭해도 ReservationPopup이 열리지 않는다', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);
    const pastCell = page.locator('.grid-cell.is-past').first();
    const exists = await pastCell.count();
    test.skip(exists === 0, '과거 셀이 없음 (오늘이거나 미래 날짜)');

    let popupOpened = false;
    page.once('dialog', () => {
      popupOpened = true;
    });

    await pastCell.click({ force: true });
    await page.waitForTimeout(800);
    const popup = page.locator('.schedulePopup').first();
    const isVisible = await popup.isVisible({ timeout: 1_500 }).catch(() => false);
    expect(isVisible).toBe(false);
  });
});
