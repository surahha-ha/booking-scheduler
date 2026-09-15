import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 보드(날짜 스트립·그리드)를 다루는 스펙의 공용 헬퍼.
 * 실행일·시드 분포에 따라 결과가 갈리는 선택을 여기서 막는다.
 */

/**
 * 오늘보다 뒤인 **평일** 중 카드가 있는 첫 날짜로 이동한다.
 *
 * ⚠️ 날짜를 "30일" 처럼 숫자로 못 박으면 실행일에 따라 결과가 갈린다 —
 *   그 날이 일요일(매주 휴무)이면 빈 셀도 valid 목적지도 없고, 오늘이면 지난 시간대가 섞인다.
 *   실사고: 2026-08-13 실행 시 첫 "30" 이 일요일 8/30 이라 resize 검증이 항상 invalid 였다.
 *   예약 스트립은 오늘부터 30일이므로 오늘 다음 칸부터 순서대로 훑는다.
 */
export async function navigateToFutureWeekday(page: Page) {
  await page.goto('/book');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);

  const cells = page.locator('.scheduleDateStrip__dayCell');
  const todayIdx = await cells.evaluateAll(
    els => els.findIndex(el => el.classList.contains('is-today')),
  );
  expect(todayIdx, '스트립에 오늘 칸이 없다').toBeGreaterThanOrEqual(0);
  const total = await cells.count();

  for (let i = todayIdx + 1; i < total; i++) {
    const cell = cells.nth(i);
    const cls = (await cell.getAttribute('class')) ?? '';
    if (/is-weekend-sat|is-weekend-sun|is-disabled/.test(cls)) continue;
    await cell.click();
    await page.waitForTimeout(400);
    if ((await page.locator('.appointment-card').count()) >= 1) return;
  }
  throw new Error('오늘 이후 평일 중 카드가 있는 날짜를 찾지 못했다');
}

/**
 * 뷰포트 안에 있고 **다른 요소에 가려지지 않은** 빈 셀(`is-empty-add`)의 중심 좌표.
 *
 * ⚠️ `is-empty-add` 는 "그 셀에 배정된 예약이 없다"는 뜻일 뿐, 이웃 셀의 카드(절대 위치)가
 *   그 위를 덮고 있을 수 있다. 그 지점을 클릭하면 빈 셀이 아니라 카드가 받아 **예약 수정** 팝업이 열린다.
 *   실사고: 첫 빈 셀이 카드에 덮여 있어 등록 팝업 검증(T1·T12)이 수정 팝업을 보고 실패했다.
 *   `elementFromPoint` 로 최상단이 그 셀인지 확인한 것만 고른다.
 */
export async function pickUncoveredEmptyCell(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    // 운영시간 밖(is-outside)은 클릭 시 확인 다이얼로그가 먼저 뜨고, 휴무·과거는 열리지 않는다 → 제외
    const cells = Array.from(document.querySelectorAll<HTMLElement>(
      '.grid-cell.is-empty-add:not(.is-outside):not(.is-closed):not(.is-past):not(.is-disabled)',
    ));
    for (const cell of cells) {
      const r = cell.getBoundingClientRect();
      if (r.height <= 0 || r.top < 0 || r.bottom > vh) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && (top === cell || cell.contains(top))) return { x, y };
    }
    return null;
  });
}

/**
 * 가려지지 않은 빈 셀을 클릭해 **등록(ADD) 모드** 예약 팝업을 연다.
 * 열린 팝업이 수정 모드면 셀 선택이 잘못된 것이므로 여기서 바로 실패시킨다.
 */
export async function openAddReservationPopup(page: Page): Promise<Locator> {
  const pt = await pickUncoveredEmptyCell(page);
  expect(pt, '뷰포트 안에 가려지지 않은 빈 셀이 없다').not.toBeNull();
  await page.mouse.click(pt!.x, pt!.y, { delay: 50 });

  const popup = page.locator('.schedulePopup').first();
  await expect(popup).toBeVisible({ timeout: 8_000 });
  await expect(popup, '빈 셀 클릭인데 수정 팝업이 열렸다(셀이 카드에 덮여 있음)').not.toContainText('예약 수정');
  return popup;
}
