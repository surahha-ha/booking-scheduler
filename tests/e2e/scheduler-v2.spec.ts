import { test, expect } from './fixtures/testBase';

/**
 * V2 커스텀 스케줄러 (/book) 핵심 시나리오
 *
 * 데이터 가정: 로컬 백엔드(시드 + localStorage)가 오늘 기준으로 전개한 예약.
 *
 * 로그인 없음 — fixtures/testBase.ts 가 일반 page 를 주입한다.
 */

test.describe('SchedulerV2 - 페이지 진입 / 렌더링', () => {
  test('1. /book 진입 후 핵심 컴포넌트가 렌더링된다', async ({ authedPage: page }) => {
    await page.goto('/book');

    // 외부 redirect되지 않고 V2 페이지에 머물러야 함
    await expect(page).toHaveURL(/\/book$/);

    // 검색필터 + DateStrip + Panel 모두 렌더
    await expect(page.locator('.scheduleDateStrip')).toBeVisible();
    await expect(page.locator('.v3-board')).toBeVisible();
    await expect(page.locator('.scheduler-header')).toBeVisible();
    await expect(page.locator('.scheduler-grid')).toBeVisible();
  });

  test('2. 예약 모드에서 SchedulerToolbar(N칸/줌)가 보인다', async ({ authedPage: page }) => {
    await page.goto('/book');
    await expect(page.locator('.schedulerToolbar')).toBeVisible();
    // 슬라이더 1~5
    await expect(page.locator('.schedulerToolbar__slider')).toHaveAttribute('min', '1');
    await expect(page.locator('.schedulerToolbar__slider')).toHaveAttribute('max', '5');
  });
});

test.describe('SchedulerV2 - 날짜 네비게이션', () => {
  test('3. [오늘] 버튼이 보이고 클릭 가능하다', async ({ authedPage: page }) => {
    await page.goto('/book');
    const todayBtn = page.locator('.scheduleDateStrip__today');
    await expect(todayBtn).toBeVisible();
    await expect(todayBtn).toContainText('오늘');
    await todayBtn.click();
    // 클릭 후에도 strip은 남아있음
    await expect(page.locator('.scheduleDateStrip')).toBeVisible();
  });

  test('4. DateStrip 좌우 이동 버튼(‹/›)이 동작한다', async ({ authedPage: page }) => {
    await page.goto('/book');
    const dayCellsBefore = await page.locator('.scheduleDateStrip__dayCell').allTextContents();

    // 연두색 ‹ (shift-prev)
    const prev = page.locator('.scheduleDateStrip__dayNav').first();
    await prev.click();

    // strip이 갱신되어 cell 텍스트가 바뀜
    await expect.poll(async () => {
      const after = await page.locator('.scheduleDateStrip__dayCell').allTextContents();
      return JSON.stringify(after) !== JSON.stringify(dayCellsBefore);
    }, { timeout: 5_000 }).toBe(true);
  });
});

test.describe('SchedulerV2 - Toolbar 인터랙션', () => {
  test('5. N칸 보기 + 버튼이 patientSlotSpan을 2→3로 증가시킨다', async ({ authedPage: page }) => {
    await page.goto('/book');
    const label = page.locator('.schedulerToolbar__label');
    await expect(label).toBeVisible();
    // V3 예약모드 기본 N칸 = 2 (SchedulerV3Page slotDivision ref(2)).
    await expect(label).toHaveText('2');

    // ⚠️ nth() 인덱스 금지: 툴바 개편에서 DOM 순서가 [늘리기, 줄이기] 로 바뀌어
    //    nth(1)=증가 전제가 깨졌다. aria-label 은 순서 변경에 영향받지 않는다.
    const plusBtn = page.locator('button[aria-label="표시 칸 수 늘리기"]');
    await plusBtn.click();
    await expect(label).toHaveText('3');
  });

  test('6. zoom 슬라이더 값을 변경하면 input이 반영된다', async ({ authedPage: page }) => {
    await page.goto('/book');
    const slider = page.locator('.schedulerToolbar__slider');
    await slider.fill('1');
    await expect(slider).toHaveValue('1');
    await slider.fill('5');
    await expect(slider).toHaveValue('5');
  });
});

test.describe('SchedulerV2 - 그리드 / 카드', () => {
  test('7. 그리드 셀이 렌더링된다 (smoke)', async ({ authedPage: page }) => {
    await page.goto('/book');
    const cells = page.locator('.grid-cell');
    // 첫 셀이 보일 때까지 자동 wait
    await expect(cells.first()).toBeVisible();
    await expect.poll(async () => cells.count(), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('8. 그리드 셀이 상태 클래스(is-zebra/is-past 등) 중 하나로 분류된다', async ({ authedPage: page }) => {
    await page.goto('/book');
    await expect(page.locator('.grid-cell').first()).toBeVisible();
    // 상태 클래스가 적어도 1개 이상 부여되었는지 (셀 분류 로직이 작동했음을 의미)
    await expect.poll(
      async () =>
        page.locator(
          '.grid-cell.is-zebra, .grid-cell.is-past, .grid-cell.is-closed, .grid-cell.is-lunch, .grid-cell.is-dinner, .grid-cell.is-now'
        ).count(),
      { timeout: 10_000 }
    ).toBeGreaterThan(0);
  });
});

test.describe('SchedulerV2 - 데이터 적재', () => {
  test('9. 예약 조회 API가 정상 응답한다', async ({ authedPage: page }) => {
    const bookReqPromise = page.waitForResponse(
      (res) => /\/api\/booking(?:\?.*)?$/.test(res.url()) && res.request().method() === 'GET',
      { timeout: 15_000 }
    );
    await page.goto('/book');
    const res = await bookReqPromise;
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // 응답 코드가 성공 (was: 'succeed', mock: 'SUCCESS')
    expect(['succeed', 'SUCCESS', 'Success']).toContain(body.code);
  });

  test('9-b. 4월 30일 cell 클릭 시 카드 화면 렌더', async ({ authedPage: page }) => {
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
  });
});

test.describe('SchedulerV2 - 헤더', () => {
  test('10. 헤더에 날짜 행과 의사 행이 렌더된다', async ({ authedPage: page }) => {
    // V3 는 날짜축 헤더 <>(header-row--date .header-nav)·본문 page-nav 를 설계상 숨김(display:none).
    // 날짜 이동 UI 는 DateStrip(‹/›) 이 담당 → 테스트 4 가 커버. 여기선 V3 헤더 구조(날짜+의사 행) 스모크.
    await page.goto('/book');
    const header = page.locator('.scheduler-header');
    await expect(header).toBeVisible();
    await expect(header.locator('.header-cell').first()).toBeVisible();
    const texts = await header.locator('.header-cell').allTextContents();
    expect(texts.some((t) => /\d{2}-\d{2}/.test(t))).toBe(true); // 날짜 행 (예: 05-30)
    expect(texts.some((t) => /박지우|장준서|황채원|박하준|임유진|안지호|최도윤|한서연|안시윤|최예은/.test(t))).toBe(true); // 담당자 행
  });
});
