import { test, expect } from './fixtures/testBase';
import { centerOf, pickPointerCard } from './fixtures/cardPointer';
import { navigateToFutureWeekday, openAddReservationPopup } from './fixtures/board';

/**
 * V2 스케줄러 확장 시나리오
 *
 * 카드 hover, ⋮ 메뉴, 상태 변경, 예약 등록/수정 팝업, 드래그 검증 규칙.
 * 백엔드는 axios adapter 층의 로컬 mock 이라 요청이 밖으로 나가지 않는다.
 *
 * 데이터 변경 정책: 상태 변경 시나리오는 cleanup으로 원상태 복원.
 * 날짜 이동은 board.ts 의 navigateToFutureWeekday — "30일" 고정은 일요일(휴무)에 걸리면 빈 셀이 없어 skip 된다.
 */

test.describe('SchedulerV2 - 카드 Hover / ⋮ 메뉴', () => {
  test('14. 카드 hover 시 ⋮ 버튼이 노출된다', async ({ authedPage: page }) => {
    await navigateToFutureWeekday(page);
    // .first() 는 시드의 거대 카드(중심이 뷰포트 밖)에 걸릴 수 있어 뷰포트에 담기는 카드만 고른다
    const card = await pickPointerCard(page);
    await card.hover();
    // hover 후 quickActionDelay(150ms) 대기
    await page.waitForTimeout(300);
    const dotBtn = page.locator('.quick-action-btn');
    await expect(dotBtn).toBeVisible();
  });

  test('15. ⋮ 클릭 시 popover가 열린다 (예약 모드 메뉴 3개)', async ({ authedPage: page }) => {
    await navigateToFutureWeekday(page);
    // .first() 는 시드의 거대 카드(중심이 뷰포트 밖)에 걸릴 수 있어 뷰포트에 담기는 카드만 고른다
    const card = await pickPointerCard(page);
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
    await navigateToFutureWeekday(page);
    // .first() 는 시드의 거대 카드(중심이 뷰포트 밖)에 걸릴 수 있어 뷰포트에 담기는 카드만 고른다
    const card = await pickPointerCard(page);
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
    await navigateToFutureWeekday(page);
    // .first() 는 시드의 거대 카드(중심이 뷰포트 밖)에 걸릴 수 있어 뷰포트에 담기는 카드만 고른다
    const card = await pickPointerCard(page);
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
    await navigateToFutureWeekday(page);
    // .first() 는 시드의 거대 카드(중심이 뷰포트 밖)에 걸릴 수 있어 뷰포트에 담기는 카드만 고른다
    const card = await pickPointerCard(page);
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
    await navigateToFutureWeekday(page);

    const total = await page.locator('.grid-cell.is-empty-add').count();
    test.skip(total === 0, '빈 셀 없음 (모든 시간대가 카드로 점유됨)');

    // 가려지지 않은 빈 셀을 클릭해 등록 팝업을 연다. 덮인 셀을 누르면 수정 팝업이 열려
    // "ADD 모드" 검증이 헛돌므로 헬퍼가 제목까지 확인한다(board.ts).
    const popup = await openAddReservationPopup(page);
    await expect(popup).toContainText('예약 등록');

    // 닫기
    const closeBtn = page.locator('.schedulePopup .uiModal__close').first();
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  });

  test('19. 카드 클릭 (threshold 미만) 시 ReservationPopup 수정 모드가 열린다', async ({
    authedPage: page,
  }) => {
    await navigateToFutureWeekday(page);
    const card = await pickPointerCard(page);
    const { x, y } = await centerOf(page, card);

    // mousedown→mouseup 거의 이동 없이 (threshold 5px 미만)
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
    await navigateToFutureWeekday(page);
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
    await navigateToFutureWeekday(page);
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
