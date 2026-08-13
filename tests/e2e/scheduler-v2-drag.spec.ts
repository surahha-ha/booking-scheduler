import { test, expect } from './fixtures/testBase';

/**
 * V2 카드 drag 시나리오
 *
 * 정책:
 *  - threshold 5px 이상 이동 후 drop
 *  - snap 30분 단위
 *  - drop 후 mock의 modify API가 호출되어 dragState 갱신
 *  - 자동 원복: drop 후 카드를 다시 원위치로 drag (변경된 데이터 cleanup)
 *
 * 대상 카드는 시드에서 렌더된 것을 좌표로 집어 쓴다(고정 ID 가정 없음).
 */

async function navigateTo430(page: import('@playwright/test').Page) {
  // query string으로 viewMode=DAY 강제
  await page.goto('/book?viewMode=DAY&dataType=APPOINTMENT');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);
  const day30 = page.locator('.scheduleDateStrip__dayCell', { hasText: /^30$/ }).first();
  await expect(day30).toBeVisible();
  await day30.click();
  // 카드 렌더 대기
  await expect.poll(
    async () => page.locator('.appointment-card').count(),
    { timeout: 15_000 }
  ).toBeGreaterThanOrEqual(3);
}

test.describe('SchedulerV2 - Drag 인터랙션', () => {
  // LIVE 모드 전용: was 실제 호출 → 데이터 변경 후 자동 원복
  const isLive = process.env.E2E_LIVE === '1';
  (isLive ? test : test.skip)(
    '11. 카드 drag → modify API 호출 → 자동 원복 (LIVE 모드 전용)',
    async ({ authedPage: page }) => {
      await navigateTo430(page);

      const card = page.locator('.appointment-card').first();
      await expect(card).toBeVisible();
      const initialBox = await card.boundingBox();
      expect(initialBox).not.toBeNull();
      if (!initialBox) return;

      let modifyId: number | null = null;
      let initialBody: any = null;

      page.on('request', async (req) => {
        const m = /\/api\/booking\/modify\/(\d+)/.exec(req.url());
        if (m && req.method() === 'PUT' && modifyId === null) {
          modifyId = Number(m[1]);
          initialBody = req.postDataJSON();
        }
      });

      // drag: 80px 아래로 (band 높이 기준 약 30~60분 이동)
      const startX = initialBox.x + initialBox.width / 2;
      const startY = initialBox.y + 6;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY + 10, { steps: 3 });
      await page.mouse.move(startX, startY + 80, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(2000);

      // modify API가 호출되었어야
      expect(modifyId).not.toBeNull();
      expect(initialBody).toMatchObject({
        startDate: expect.any(String),
        endDate: expect.any(String),
      });

      // ─── 자동 원복: 원래 시간으로 다시 PUT ───
      if (modifyId !== null && initialBody) {
        // 원본 시간 추정: dragState 추적 안 되므로 was에 직접 PUT 보내 복원
        // initialBody에서 방향 반대로(-30분 또는 -60분) 보냄
        const origStart = new Date(initialBody.startDate);
        const origEnd = new Date(initialBody.endDate);
        // 80px → 약 30~60분 이동했으므로 30분 위로 보냄
        origStart.setMinutes(origStart.getMinutes() - 30);
        origEnd.setMinutes(origEnd.getMinutes() - 30);
        const restoreBody = {
          ...initialBody,
          startDate: toIsoLocal(origStart),
          endDate: toIsoLocal(origEnd),
        };
        const restoreRes = await page.request.put(
          `/api/booking/modify/${modifyId}`,
          { data: restoreBody, headers: { 'Content-Type': 'application/json' } }
        );
        expect(restoreRes.ok()).toBe(true);
      }
    }
  );

  function toIsoLocal(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  test('12. mousedown 후 5px 미만 이동 → 클릭 처리 (modify API 미호출)', async ({
    authedPage: page,
  }) => {
    await navigateTo430(page);

    // 첫 카드 (mock/LIVE 모두 고객명 무관)
    const card = page.locator('.appointment-card').first();
    await expect(card).toBeVisible();

    const box = await card.boundingBox();
    if (!box) test.fail();

    let modifyCalled = false;
    page.on('request', (req) => {
      if (/\/api\/booking\/modify\//.test(req.url())) modifyCalled = true;
    });

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + 6;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 2, startY + 1);
    await page.mouse.up();
    await page.waitForTimeout(1000);

    expect(modifyCalled).toBe(false);
  });

  test('13. ESC 키로 drag 취소 → modify API 미호출', async ({ authedPage: page }) => {
    await navigateTo430(page);

    const card = page.locator('.appointment-card').first();
    await expect(card).toBeVisible();

    const box = await card.boundingBox();
    if (!box) test.fail();

    let modifyCalled = false;
    page.on('request', (req) => {
      if (/\/api\/booking\/modify\//.test(req.url())) modifyCalled = true;
    });

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + 6;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 80, { steps: 8 });
    // ESC로 취소
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(800);

    expect(modifyCalled).toBe(false);
  });
});
