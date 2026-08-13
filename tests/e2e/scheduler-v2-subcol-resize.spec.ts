import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 Sub-Column Resize Handle (column 분할선 drag로 N칸 보기 변경)
 *
 * 정책:
 *   - V3 는 edge-only: column(담당자) 그룹 경계에만 handle 노출 (모든 N 에서 column당 1개)
 *   - 좌측 drag(dx < -threshold): N-1 (min 1)   ← 방향 반전(우=증가)
 *   - 우측 drag(dx > +threshold): N+1 (max 4)
 *   - threshold = subColWidth × 0.4
 *   - 진료 모드(TREATMENT)에서도 handle 노출 (칸수조절 drag 는 예약·진료 공통)
 *
 * ⚠️ drag 로 N step 을 검증할 때는 단일 mousemove(steps 기본=1)로 이동한다.
 *    한 번의 mousemove = 최대 1 step 이라 threshold 를 크게 넘겨도 과증가하지 않아
 *    column 폭(→threshold)에 무관하게 결정적이다.
 */

/**
 * 칸수 ± 버튼 — aria-label 로 잡는다.
 * ⚠️ nth() 인덱스 금지: 툴바 개편에서 DOM 순서가 [늘리기, 줄이기] 로 바뀌어
 *    nth(0)=감소 전제가 깨졌다(라벨이 반대로 움직임). 라벨은 순서 변경에 영향받지 않는다.
 */
const decreaseBtn = (page: Page) => page.locator('button[aria-label="표시 칸 수 줄이기"]');
const increaseBtn = (page: Page) => page.locator('button[aria-label="표시 칸 수 늘리기"]');

async function navigate(page: Page) {
  await page.goto('/book');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);
}

/**
 * 첫 컬럼(담당자) edge handle 의 left(px).
 * ⚠️ V3 는 컬럼별 N칸(customSlots)이라 drag 로 N 을 바꿔도 전역 툴바 라벨은 불변.
 *    대신 그 컬럼의 sub-col 수가 바뀌어 컬럼 폭이 바뀌므로 → 첫 컬럼 오른쪽 경계(handle)의
 *    left 가 이동한다: 우측 drag(N+1) → 폭↑ → handle left 증가 / 좌측 drag(N-1) → 폭↓ → 감소.
 *    (모든 sub-col 은 전역 균일 폭이라 컬럼이 sub-col 1칸 단위로 넓어지고 뒤 컬럼이 밀린다.)
 */
async function firstHandleLeft(page: Page): Promise<number> {
  const box = await page.locator('.subcol-resize-handle').first().boundingBox();
  if (!box) test.fail();
  return box!.x;
}

/** 단일 mousemove(steps 기본=1) = 최대 1 step. handle 을 dx 만큼 끌어 정확히 1 step 발생. */
async function dragHandleOneStep(page: Page, dx: number) {
  const box = await page.locator('.subcol-resize-handle').first().boundingBox();
  if (!box) test.fail();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + 100;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('SchedulerV2 - Sub-Column Resize Handle', () => {
  test('36. N=1일 때 column당 handle 1개(오른쪽 끝) 노출', async ({ authedPage: page }) => {
    await navigate(page);
    // V3 기본 N=2 → − 버튼으로 N=1 로 내려 시나리오 성립.
    await decreaseBtn(page).click();
    await expect(page.locator('.schedulerToolbar__label')).toHaveText('1');
    // N=1 정책 변경: column당 오른쪽 끝 handle 1개씩 → 의사 column 수만큼 handle
    // 의사 수는 환경에 따라 달라지므로 >=1 검증
    const handles = await page.locator('.subcol-resize-handle').count();
    expect(handles).toBeGreaterThanOrEqual(1);
    // edge handle 클래스로도 검증
    const edgeHandles = await page.locator('.subcol-resize-handle--edge').count();
    expect(edgeHandles).toBeGreaterThanOrEqual(1);
  });

  test('37. N=2일 때 column당 handle 2개씩 노출 (분할선 1 + 오른쪽 끝 1)', async ({ authedPage: page }) => {
    await navigate(page);
    // V3 기본 N=2 (별도 조작 불필요).
    await expect(page.locator('.schedulerToolbar__label')).toHaveText('2');
    await page.waitForTimeout(300);

    const handles = await page.locator('.subcol-resize-handle').count();
    expect(handles).toBeGreaterThanOrEqual(2);
  });

  test('37-b. N=1 → 첫 컬럼 handle 우측 drag 시 그 컬럼이 넓어진다 (N 1→2)', async ({ authedPage: page }) => {
    await navigate(page);
    // 전역 N=1 로 내려 시작(customSlots 리셋). 이후 첫 컬럼만 drag 로 N=2.
    await decreaseBtn(page).click();
    await expect(page.locator('.schedulerToolbar__label')).toHaveText('1');
    await page.waitForTimeout(300);

    const before = await firstHandleLeft(page);
    // 우측 drag = N+1(증가) → 첫 컬럼 폭↑ → handle left 증가.
    await dragHandleOneStep(page, 250);
    const after = await firstHandleLeft(page);
    expect(after).toBeGreaterThan(before + 30);
  });

  test('38. 첫 컬럼 handle 우측 drag 시 그 컬럼이 넓어진다 (N 2→3)', async ({ authedPage: page }) => {
    await navigate(page);
    // V3 기본 N=2 로 시작.
    await expect(page.locator('.schedulerToolbar__label')).toHaveText('2');
    await page.waitForTimeout(300);

    const before = await firstHandleLeft(page);
    // 우측 drag = N+1(증가) → 첫 컬럼 폭↑ → handle left 증가.
    await dragHandleOneStep(page, 250);
    const after = await firstHandleLeft(page);
    expect(after).toBeGreaterThan(before + 30);
  });

  test('39. 첫 컬럼 handle 좌측 drag 시 그 컬럼이 좁아진다 (N 3→2)', async ({ authedPage: page }) => {
    await navigate(page);
    // 전역 N=3 로 올려 시작.
    await increaseBtn(page).click();
    await expect(page.locator('.schedulerToolbar__label')).toHaveText('3');
    await page.waitForTimeout(300);

    const before = await firstHandleLeft(page);
    // 좌측 drag = N-1(감소) → 첫 컬럼 폭↓ → handle left 감소.
    await dragHandleOneStep(page, -250);
    const after = await firstHandleLeft(page);
    expect(after).toBeLessThan(before - 30);
  });

  test('40. 진료 모드(TREATMENT)에서도 칸수조절 handle이 노출된다 (예약·진료 공통)', async ({ authedPage: page }) => {
    // 칸수조절 drag 를 진료 화면에도 적용 → SubColResizeHandles 는 v-if 없이 항상 렌더.
    await page.goto('/book?dataType=TREATMENT');
    await expect(page.locator('.scheduler-grid')).toBeVisible();
    await page.waitForTimeout(500);

    // edge-only 라 담당자 column 수만큼 handle (>=1)
    await expect.poll(
      async () => page.locator('.subcol-resize-handle').count(),
      { timeout: 5_000 }
    ).toBeGreaterThanOrEqual(1);
  });
});
