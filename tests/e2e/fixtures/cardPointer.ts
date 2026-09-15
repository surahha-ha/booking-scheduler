import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 마우스 좌표로 카드를 조작(클릭·drag·resize)하는 스펙의 공용 헬퍼.
 */

/** 취소·완료·미이행 예약은 readOnly 라 drag/resize 가 시작되지 않는다. */
export const EDITABLE_CARD =
  '.appointment-card:not(.status-cancel):not(.status-done):not(.status-undone)';

/**
 * 좌표 조작이 가능한 카드를 고른다.
 *
 * ⚠️ `.first()` 를 그냥 잡으면 안 된다 — 시드에는 그리드 높이 전체(2500px+)를 차지하는
 *   장시간 예약이 섞여 있고, 그런 카드는 화면에 일부가 이미 보이므로
 *   `scrollIntoViewIfNeeded()` 가 스크롤을 생략한다. 그 상태의 카드 중심 좌표는 뷰포트
 *   바깥이라 mouse 이벤트가 어떤 요소에도 닿지 않는다(`elementsFromPoint` 가 빈 배열)
 *   → 클릭도 resize 도 시작되지 않는다. 뷰포트에 담기는 크기의 카드만 고른다.
 */
export async function pickPointerCard(page: Page, maxHeight = 300): Promise<Locator> {
  const index = await page.evaluate(
    ({ sel, maxH }) => {
      const els = Array.from(document.querySelectorAll(sel));
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (r.height > 0 && r.height <= maxH) return i;
      }
      return -1;
    },
    { sel: EDITABLE_CARD, maxH: maxHeight },
  );
  expect(index, `좌표 조작 가능한 카드(높이 ≤ ${maxHeight}px)가 없다`).toBeGreaterThanOrEqual(0);

  const card = page.locator(EDITABLE_CARD).nth(index);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  return card;
}

/** 카드 중심 좌표. 뷰포트 안에 들어와 있는지까지 확인한다. */
export async function centerOf(page: Page, card: Locator): Promise<{ x: number; y: number }> {
  const box = await card.boundingBox();
  expect(box, '카드 boundingBox 측정 실패').not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const vp = page.viewportSize();
  expect(y, '카드 중심이 뷰포트 밖이다').toBeLessThan(vp?.height ?? 720);
  expect(y).toBeGreaterThan(0);
  return { x, y };
}

/**
 * 카드 bottom resize handle 을 잡을 좌표(중앙)를 반환.
 * ⚠️ hover 시 카드에 테두리(is-hovered)가 생겨 handle 위치가 미세하게 밀린다
 *   → 먼저 hover 를 발생시킨 뒤 handle boundingBox 를 재측정해야 정확히 grab 된다
 *     (hover 전 좌표로 잡으면 mousedown 이 handle 밖에 떨어져 resize 가 시작되지 않음).
 */
export async function grabBottomHandle(page: Page): Promise<{ gx: number; gy: number }> {
  const card = await pickPointerCard(page);
  const { x, y } = await centerOf(page, card);
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  const bh = await card.locator('.resize-handle--bottom').boundingBox();
  expect(bh, 'bottom resize handle 측정 실패').not.toBeNull();
  return { gx: bh!.x + bh!.width / 2, gy: bh!.y + bh!.height / 2 };
}
