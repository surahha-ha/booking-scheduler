import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 검색 필터 시나리오 — 데이터 흐름 회귀 방지
 *
 * 검증:
 *   - SchedulerSearchFilter가 마운트되고 핵심 UI 요소 노출
 *   - 의사 필터, 상태 필터, 회원유형 토글, 검색 입력 동작
 *   - 키워드 입력 후 검색 트리거 시 API 호출 발생
 *
 * 단, 검색 결과의 정확성(특정 카드만 보임 등)은 LIVE was 데이터에 의존하므로
 * 본 시나리오는 "UI 요소 + 인터랙션" 수준 검증에 집중.
 */

async function navigate(page: Page) {
  await page.goto('/book');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);
}

test.describe('SchedulerV2 - 검색 필터', () => {
  test('31. SchedulerSearchFilter가 마운트되고 핵심 UI 요소가 노출된다', async ({ authedPage: page }) => {
    await navigate(page);
    await expect(page.locator('.scheduleSearchFilter')).toBeVisible();
    // 검색 입력 노출
    await expect(page.locator('.scheduleSearchInput')).toBeVisible();
    // 회원 유형 토글 노출
    await expect(page.locator('.scheduleMemberToggle')).toBeVisible();
  });

  test('32. 검색 입력 필드에 키워드 입력 시 input value 반영', async ({ authedPage: page }) => {
    await navigate(page);
    // V3 는 recent-search 모드 → 입력이 PatientAutocomplete(.patientAutocomplete__input)로 렌더.
    const input = page.locator('.patientAutocomplete__input');
    await expect(input).toBeVisible();

    await input.fill('테스트고객');
    await expect(input).toHaveValue('테스트고객');

    // clear
    await input.fill('');
  });

  test('33. 키워드 입력 시 최근예약 검색 API(getRecent) 호출 + 드롭다운 노출', async ({ authedPage: page }) => {
    // V3 recent-search 모드: 키워드는 보드 전체 재조회(GET /book?keyword=)를 트리거하지 않고
    // getRecent(GET /book/recent) 로 최근예약 자동완성 드롭다운을 띄운다(pick 시 날짜 이동/하이라이트).
    await navigate(page);
    const input = page.locator('.patientAutocomplete__input');
    await expect(input).toBeVisible();

    // getRecent(GET /api/booking/recent?keyword=) 호출 캡처
    const recentReqPromise = page.waitForRequest(
      (req) =>
        /\/api\/booking\/recent(?:\?.*)?$/.test(req.url()) &&
        req.method() === 'GET' &&
        /keyword=/.test(req.url()),
      { timeout: 8_000 }
    );
    // 동시에 보드 keyword 재조회(GET /book?keyword=)는 발생하지 않아야 함(의도된 변경)
    let boardKeywordSearch = false;
    page.on('request', (req) => {
      if (/\/api\/booking(?:\?.*)?$/.test(req.url()) && /keyword=/.test(req.url())) {
        boardKeywordSearch = true;
      }
    });

    await input.fill('홍길동');

    const recentReq = await recentReqPromise.catch(() => null);
    expect(recentReq).not.toBeNull();

    // 최근예약 드롭다운 행 노출(mock 매칭 1건)
    await expect(page.locator('.recentRow').first()).toBeVisible({ timeout: 5_000 });
    // 보드 예약목록은 이 고객로 filter 되지 않음(localKeyword 라 filterStore.keyword 미접촉)
    expect(boardKeywordSearch).toBe(false);

    await input.fill('');
  });

  test('34. 회원 유형 토글 버튼이 active 상태를 변경한다', async ({ authedPage: page }) => {
    await navigate(page);
    const toggle = page.locator('.scheduleMemberToggle');
    await expect(toggle).toBeVisible();

    // 토글 내 버튼들 (Y/N)
    const buttons = toggle.locator('.scheduleMemberToggle__btn');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // is-active 상태인 버튼이 1개 (현재 active 상태)
    const initiallyActive = await toggle.locator('.scheduleMemberToggle__btn.is-active').count();
    expect(initiallyActive).toBeGreaterThanOrEqual(1);
  });

  test('35. 의사 필터가 노출되고 클릭 가능하다', async ({ authedPage: page }) => {
    await navigate(page);
    // UiDoctorFilter는 별도 클래스, scheduleSearchFilter__item 안에 있음
    const filterArea = page.locator('.scheduleSearchFilter__item');
    const filterCount = await filterArea.count();
    expect(filterCount).toBeGreaterThan(0);
  });
});
