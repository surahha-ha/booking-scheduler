import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 검증 규칙 시나리오 — drag/resize 검증 + no-change 회귀 방지
 *
 * 검증 정책 (CLAUDE.md):
 *   - HARD_BLOCKED: closedDate / closedWeekday → 빨강 preview, commit 차단
 *   - WARNING: outsideHours → 주황 preview, confirm alert
 *   - SOFT (가능): lunch / dinner / blockedTime
 *   - 과거 시간 (band 종료 < 현재) → invalid
 *   - 같은 위치 drop/resize → 회색 preview (no-change), commit 미발생
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

/**
 * 카드 bottom resize handle 을 잡을 좌표(중앙)를 반환.
 * ⚠️ hover 시 카드에 테두리(is-hovered)가 생겨 handle 위치가 미세하게 밀린다
 *   → 먼저 hover 를 발생시킨 뒤 handle boundingBox 를 재측정해야 정확히 grab 된다
 *     (hover 전 좌표로 잡으면 mousedown 이 handle 밖에 떨어져 resize 가 시작되지 않음).
 */
async function grabBottomHandle(page: Page): Promise<{ gx: number; gy: number }> {
  const card = page.locator('.appointment-card').first();
  await card.scrollIntoViewIfNeeded(); // mock 카드 14:00(오전 뷰포트 밖) → 좌표 조작 전 스크롤 인
  await page.waitForTimeout(200);
  const box = await card.boundingBox();
  if (!box) test.fail();
  // hover 발생 → 레이아웃 settle 후 handle 재측정
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.waitForTimeout(200);
  const bh = await card.locator('.resize-handle--bottom').boundingBox();
  if (!bh) test.fail();
  return { gx: bh!.x + bh!.width / 2, gy: bh!.y + bh!.height / 2 };
}

test.describe('SchedulerV2 - 검증 규칙', () => {
  test('22. resize 시작 직후 preview는 회색(is-no-change) 노출', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const { gx, gy } = await grabBottomHandle(page);

    // bottom handle mousedown 직후(이동 없음) = resize 시작 상태.
    // startResize 는 isNoChange:true 로 초기화하고, mousedown 은 mousemove 를 발생시키지 않으므로
    // origin 과 동일 → 회색(is-no-change) preview.
    // ⚠️ 미세 이동으로 검증하면 카드 최소높이 탓에 bottom handle 이 14:30 라인보다 아래라
    //    첫 hitTest 가 다음 snap 셀로 넘어가 is-no-change 가 깨진다(fragile). 이동 없이 초기 상태를 본다.
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.waitForTimeout(200);

    const preview = page.locator('.resize-preview');
    await expect(preview).toBeVisible();
    // 같은 origin과 동일 endMinute이면 is-no-change 클래스 (회색 점선)
    await expect(preview).toHaveClass(/is-no-change/);

    await page.mouse.up();
    await page.waitForTimeout(200);
  });

  test('23. drag/resize 중 grid-cell hover overlay (+ 추가)는 표시되지 않는다', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.scrollIntoViewIfNeeded(); // mock 카드는 14:00(오전 뷰포트 밖) → 좌표 조작 전 스크롤 인
    await page.waitForTimeout(200);
    const box = await card.boundingBox();
    if (!box) test.fail();

    // resize 진행 중 상태
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 80, { steps: 5 });
    await page.waitForTimeout(300);

    // hover overlay 0개여야
    const overlayCount = await page.locator('.grid-cell__hover-overlay').count();
    expect(overlayCount).toBe(0);

    await page.mouse.up();
  });

  test('24. drag/resize 중 카드의 ⋮ quick action 버튼은 노출되지 않는다 (interaction lock)', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const card = page.locator('.appointment-card').first();
    await card.scrollIntoViewIfNeeded(); // mock 카드는 14:00(오전 뷰포트 밖) → 좌표 조작 전 스크롤 인
    await page.waitForTimeout(200);
    const box = await card.boundingBox();
    if (!box) test.fail();

    // bottom resize 중
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 50, { steps: 5 });
    await page.waitForTimeout(300);

    // 진행 중에는 ⋮ 버튼 안 보여야
    const dotBtnVisible = await page.locator('.quick-action-btn').first().isVisible({ timeout: 500 }).catch(() => false);
    expect(dotBtnVisible).toBe(false);

    await page.mouse.up();
  });

  test('25. resize → 다음 band로 이동 시 preview는 파랑(valid)으로 표시', async ({ authedPage: page }) => {
    await navigateTo430(page);
    const { gx, gy } = await grabBottomHandle(page);

    // band 높이가 매우 클 수 있으므로 (사용자 LIVE 환경 11:00에 13개 카드)
    // 다음 band 위치를 grid-row.height 기준으로 추정. 충분히 큰 dy 사용.
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    // 800px 이동 (band 높이가 매우 커도 다음 band 보장)
    await page.mouse.move(gx, gy + 800, { steps: 12 });
    await page.waitForTimeout(500);

    const preview = page.locator('.resize-preview');
    await expect(preview).toBeVisible();
    // 다른 시간대로 갔으니 is-no-change 없어야 / is-invalid도 없어야
    await expect(preview).not.toHaveClass(/is-no-change/);
    await expect(preview).not.toHaveClass(/is-invalid/);

    // ESC로 cancel — 데이터 변경 방지 (자동 원복)
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(500);
  });
});
