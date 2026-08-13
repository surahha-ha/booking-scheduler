import { test, expect } from './fixtures/testBase';
import type { Page } from '@playwright/test';

/**
 * V2 스케줄러 — 서비스 항목 마스터 + 서비스 항목 설정 popup 회귀 시나리오
 *
 * 회귀 안전망 (e2e 작성 = 실행 통과까지 한 사이클):
 *   T1. 빈 셀 클릭 → ReservationPopup 서비스 내용 영역에 그룹 칩 노출 (검진 및 상담, 임플란트)
 *   T2. ⚙ 클릭 → 설정 popup + ReservationPopup 동시 노출 → ESC 로 설정만 닫힘
 *   T3. ⚙ → 그룹 추가 → 신규 그룹이 칩 목록에 즉시 반영
 *   T4. 설정 popup 내부 클릭 시 ReservationPopup 이 사라지지 않는다
 *   T5. 항목 9개 이상 → < > 페이저 노출 + 페이지 전환 동작 (Phase2 #1)
 *   T6. 일반 그룹에 항목 0개면 저장 버튼 비활성, 1개 이상이면 활성 (Phase2 #5)
 *   T7. 우측 공간 부족 시 설정 popup 이 ReservationPopup 영역을 덮는다 (Phase2 M8 fallback)
 *   T8. 그룹명 중복 차단 — whitespace 정규화 ('  검진  및  상담  ' → 기존 '검진 및 상담' 매치)
 *   T9. 고객명 dropdown Tab → 첫 후보 자동선택 + 다음 input(전화번호) focus 이동
 *   T10. pick 된 고객명을 수정하면 전화번호도 함께 empty 처리 (회귀 방지)
 *   T11. 고객명을 모두 지우면 자동완성 dropdown 도 닫힘 (회귀 방지)
 *   T12. 서비스 항목(그룹/항목)과 memo 독립 + 단일선택 토글오프 (회귀 방지)
 */

async function navigateToScheduler(page: Page) {
  await page.goto('/book');
  await expect(page.locator('.scheduler-grid')).toBeVisible();
  await page.waitForTimeout(500);
}

async function openReservationPopup(page: Page) {
  // 빈 시간대 셀 클릭으로 ADD 모드 ReservationPopup 오픈
  const emptyAddCells = page.locator('.grid-cell.is-empty-add');
  const total = await emptyAddCells.count();
  test.skip(total === 0, '빈 셀 없음 (모든 시간대 카드 점유)');

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

  const popup = page.locator('.schedulePopup').first();
  await expect(popup).toBeVisible({ timeout: 8_000 });
  return popup;
}

test.describe('SchedulerV2 - 서비스 항목 마스터', () => {
  test('T1. ReservationPopup 서비스 내용에 그룹 칩 노출 (검진 및 상담, 임플란트)', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    // TreatmentContentSelector 영역 존재
    const selector = popup.locator('.treatmentContentSelector');
    await expect(selector).toBeVisible({ timeout: 5_000 });

    // 그룹 칩들 — 로컬 저장소 시드 기준: 검진 및 상담, 임플란트 (직접입력 그룹 폐기)
    const chips = selector.locator('.tcs-groupChip');
    await expect(chips).toHaveCount(2);

    await expect(chips.nth(0)).toHaveText(/검진 및 상담/);
    await expect(chips.nth(1)).toHaveText(/임플란트/);

    // ADD 진입 시 첫 그룹이 기본 선택됨 (default-first-group)
    await expect(chips.nth(0)).toHaveClass(/is-active/);
  });

  test('T2. ⚙ 클릭 → 두 popup 동시 노출 → ESC 로 설정 popup 만 닫힘', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    // ⚙ 설정 버튼 클릭
    const settingBtn = popup.locator('.tcs-settingBtn');
    await expect(settingBtn).toBeVisible();
    await settingBtn.click();

    // 설정 popup 노출
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    // ReservationPopup 도 여전히 노출 (modeless 동시 노출)
    await expect(popup).toBeVisible();

    // ESC → 설정 popup 만 닫힘
    await page.keyboard.press('Escape');
    await expect(settingRoot).toBeHidden({ timeout: 3_000 });

    // ReservationPopup 은 유지
    await expect(popup).toBeVisible();
  });

  test('T4. 설정 popup 내부 클릭 시 ReservationPopup 이 사라지지 않는다 (회귀)', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    // 설정 popup 내부 여러 영역 클릭 — body 로 propagate 되어
    // 모달의 hide-on-outside-click 이 트리거되면 안 됨.
    // 1) 그룹 row 클릭
    await settingRoot.locator('.tisp-row', { hasText: '검진 및 상담' }).click();
    await page.waitForTimeout(200);
    await expect(popup).toBeVisible();
    await expect(settingRoot).toBeVisible();

    // 2) 헤더 영역 클릭 (인터랙션 없는 영역)
    await settingRoot.locator('.tisp-header').click();
    await page.waitForTimeout(200);
    await expect(popup).toBeVisible();
    await expect(settingRoot).toBeVisible();

    // 3) 항목 영역 빈 공간 클릭
    await settingRoot.locator('.tisp-col').nth(1).click();
    await page.waitForTimeout(200);
    await expect(popup).toBeVisible();
    await expect(settingRoot).toBeVisible();
  });

  test('T3. 설정 popup 에서 그룹 추가 → 칩 목록에 반영', async ({ authedPage: page }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    // "+ 추가" 클릭 — capture phase mousedown listener 와 충돌 가능. native click 으로 우회
    const addBtn = settingRoot.locator('.tisp-addBtn');
    await expect(addBtn).toBeVisible();
    await page.evaluate(() => {
      const btn = document.querySelector('.tisp-root .tisp-addBtn') as HTMLButtonElement | null;
      btn?.click();
    });
    await page.waitForTimeout(300);

    // 인라인 input 활성 → 좌측 그룹명 input (우측 "서비스 항목 입력" 과 구분)
    const newInput = settingRoot.locator('input[placeholder="그룹명 입력 + Enter"]');
    await expect(newInput).toBeVisible({ timeout: 5_000 });
    await newInput.fill('E2E 신규 그룹');
    await newInput.press('Enter');

    // 신규 그룹이 좌측 리스트에 반영됨
    await expect(settingRoot.locator('.tisp-row', { hasText: 'E2E 신규 그룹' })).toBeVisible({
      timeout: 3_000,
    });

    // 설정 popup 닫기 후 ReservationPopup 의 그룹 칩 목록에도 반영
    // (serviceItemStore.load(true) 가 onSettingPopupClosed 에서 호출됨)
    await settingRoot.locator('button:has-text("취소")').click();
    await expect(settingRoot).toBeHidden({ timeout: 3_000 });

    const chips = popup.locator('.tcs-groupChip');
    await expect(chips.filter({ hasText: 'E2E 신규 그룹' })).toHaveCount(1, { timeout: 3_000 });
  });

  test('T5. 항목 9개 이상 → 페이저 < > 노출 + 페이지 전환', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    // 설정 popup 으로 임플란트 그룹에 9개 항목 추가 (시드 2개 그룹 중 비어있는 임플란트 활용)
    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    // 임플란트 그룹 선택
    await settingRoot.locator('.tisp-row', { hasText: '임플란트' }).click();

    // 항목 9개 추가
    // auto-grow: 입력 시 빈 draft 행이 뒤에 추가되어 input 이 2개가 되므로 첫 행(입력 중인 행)을 특정.
    const itemInput = settingRoot.locator('input[placeholder="서비스 항목 입력"]').first();
    for (let i = 1; i <= 9; i++) {
      await itemInput.fill(`항목${i}`);
      await itemInput.press('Enter');
      await page.waitForTimeout(80);
    }

    // 설정 popup 닫기
    await settingRoot.locator('button:has-text("저장")').click();
    await expect(settingRoot).toBeHidden({ timeout: 3_000 });

    // 임플란트 칩 선택
    await popup.locator('.tcs-groupChip', { hasText: '임플란트' }).click();

    // 페이저 < > 노출
    const pagers = popup.locator('.tcs-itemPager');
    await expect(pagers).toHaveCount(2, { timeout: 3_000 });
    const prevBtn = pagers.first();
    const nextBtn = pagers.last();

    // 페이지 0: prev disabled, next enabled. 항목 8개 노출 (총 9개)
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();
    const chipsP0 = popup.locator('.tcs-itemChip');
    await expect(chipsP0).toHaveCount(8);

    // next 클릭 → 페이지 1
    await nextBtn.click();
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeDisabled();
    // 마지막 페이지에는 1개만
    await expect(popup.locator('.tcs-itemChip')).toHaveCount(1);
    await expect(popup.locator('.tcs-itemChip')).toHaveText(/항목9/);
  });

  test('T6. 선택된 그룹의 항목 유무에 따른 저장 활성화 (그룹 단위 검증)', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    const saveBtn = settingRoot.locator('button:has-text("저장")');

    // 진입 시 첫 일반 그룹 "검진 및 상담"(항목 2개)이 선택됨 → 활성
    await expect(saveBtn).toBeEnabled();

    // 임플란트 그룹(항목 0개) 선택 → 비활성
    await settingRoot.locator('.tisp-row', { hasText: '임플란트' }).click();
    await expect(saveBtn).toBeDisabled();

    // 임플란트에 항목 1개 추가 → 활성으로 복귀
    // auto-grow: 입력 시 빈 draft 행이 뒤에 추가되어 input 이 2개가 되므로 첫 행(입력 중인 행)을 특정.
    const itemInput = settingRoot.locator('input[placeholder="서비스 항목 입력"]').first();
    await itemInput.fill('임플란트 상담');
    await itemInput.press('Enter');
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });

    // 검진 및 상담 그룹 재선택 → 여전히 활성 (다른 그룹 항목 추가와 무관)
    await settingRoot.locator('.tisp-row', { hasText: '검진 및 상담' }).click();
    await expect(saveBtn).toBeEnabled();
  });

  test('T7. 우측 공간 부족 시 설정 popup 이 ReservationPopup 영역을 덮는다', async ({
    authedPage: page,
  }) => {
    // 좁은 viewport 로 우측 공간 부족 상태 강제
    await page.setViewportSize({ width: 900, height: 800 });
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    const popupBox = await popup.locator('.uiModal__content').first().boundingBox();
    expect(popupBox).not.toBeNull();

    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    const settingBox = await settingRoot.boundingBox();
    expect(settingBox).not.toBeNull();

    // 설정 popup 이 ReservationPopup 보다 크거나 같고 (덮음),
    // 좌상단이 ReservationPopup 의 좌상단 이전(또는 동일) 영역에서 시작
    expect(settingBox!.width).toBeGreaterThanOrEqual(popupBox!.width);
    expect(settingBox!.height).toBeGreaterThanOrEqual(popupBox!.height);
    expect(settingBox!.x).toBeLessThanOrEqual(popupBox!.x + 1);
    expect(settingBox!.y).toBeLessThanOrEqual(popupBox!.y + 1);

    // 우측/하단도 ReservationPopup 을 완전히 포함
    expect(settingBox!.x + settingBox!.width).toBeGreaterThanOrEqual(popupBox!.x + popupBox!.width - 1);
    expect(settingBox!.y + settingBox!.height).toBeGreaterThanOrEqual(popupBox!.y + popupBox!.height - 1);
  });

  test('T9. 고객명 dropdown Tab → 첫 후보 자동선택 + 다음 input focus 이동', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    const patientInput = popup.locator('input[data-field="patientName"]');
    await expect(patientInput).toBeVisible();

    await patientInput.click();
    await patientInput.fill('고객');

    // mock 은 customerName.includes('고객') 매칭으로 3건 반환 (고객A/B/C)
    const dropdown = popup.locator('.patientAutocomplete__list');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    const rows = popup.locator('.patientAutocomplete__row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('고객A');

    // Tab → 첫 후보 자동 선택
    await patientInput.press('Tab');

    // form 값 채워짐 (formatPhoneNumber: 01010000001 → 010-1000-0001)
    await expect(patientInput).toHaveValue('고객A');
    const phoneInput = popup.locator('input[data-field="patientPhone"]');
    await expect(phoneInput).toHaveValue('010-1000-0001');

    // dropdown 닫힘 + 다음 input(전화번호)에 focus
    await expect(dropdown).toBeHidden();
    await expect(phoneInput).toBeFocused();
  });

  test('T10. pick 된 고객명을 수정하면 전화번호도 함께 empty 처리', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    const patientInput = popup.locator('input[data-field="patientName"]');
    const phoneInput = popup.locator('input[data-field="patientPhone"]');

    // pick (Tab) → phone 자동 채워짐 + phone readonly
    await patientInput.click();
    await patientInput.fill('고객');
    await expect(popup.locator('.patientAutocomplete__list')).toBeVisible({ timeout: 5_000 });
    await patientInput.press('Tab');
    await expect(patientInput).toHaveValue('고객A');
    await expect(phoneInput).toHaveValue('010-1000-0001');

    // pick 후 고객명을 추가 입력 (= 다른 고객로 변경 의도)
    //  - patientPhone 이 empty 로 비워져야 함 (사양)
    //  - phone readonly 도 해제되어 사용자 직접 입력 가능
    await patientInput.click();
    await patientInput.press('End');
    await patientInput.type('B', { delay: 30 });

    await expect(phoneInput).toHaveValue('');
    await expect(phoneInput).not.toHaveAttribute('readonly', /.+/);
  });

  test('T11. 고객명을 모두 지우면 자동완성 dropdown 도 닫힘', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    const patientInput = popup.locator('input[data-field="patientName"]');
    const dropdown = popup.locator('.patientAutocomplete__list');

    // "고객" 입력 → dropdown 노출 + 3건
    await patientInput.click();
    await patientInput.fill('고객');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('.patientAutocomplete__row')).toHaveCount(3);

    // 고객명 전체 삭제 → dropdown 닫힘
    await patientInput.fill('');
    await expect(dropdown).toBeHidden();

    // 다시 입력 시 dropdown 재노출되어야 — 정상 흐름 보장
    await patientInput.fill('고객');
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
  });

  test('T8. 그룹명 중복 차단 — whitespace 정규화', async ({ authedPage: page }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    await popup.locator('.tcs-settingBtn').click();
    const settingRoot = page.locator('.tisp-root');
    await expect(settingRoot).toBeVisible({ timeout: 5_000 });

    // 시드: "검진 및 상담" 그룹 이미 존재
    const existingRow = settingRoot.locator('.tisp-row', { hasText: '검진 및 상담' });
    await expect(existingRow).toHaveCount(1);

    // + 추가 → whitespace 변형 입력
    await page.evaluate(() => {
      const btn = document.querySelector('.tisp-root .tisp-addBtn') as HTMLButtonElement | null;
      btn?.click();
    });
    const newInput = settingRoot.locator('input[placeholder="그룹명 입력 + Enter"]');
    await expect(newInput).toBeVisible({ timeout: 3_000 });

    // '  검진  및  상담  ' → normalize 후 '검진및상담' === 기존 '검진 및 상담' 의 정규화 결과
    await newInput.fill('  검진  및  상담  ');
    await newInput.press('Enter');

    // toast 노출 (notivue) — 모달 위에 노출
    const toast = page.locator('.Notivue__notification', { hasText: '이미 동일한 이름의 그룹이 존재합니다' });
    await expect(toast).toBeVisible({ timeout: 3_000 });

    // 그룹 추가 안 됨 — ReservationPopup 의 그룹 칩 수가 시드 그대로 (2개: 검진 및 상담, 임플란트)
    await expect(popup.locator('.tcs-groupChip')).toHaveCount(2);
  });

  test('T12. 서비스 항목 그룹↔상세 필수 쌍 + memo 독립 + 그룹 토글오프', async ({
    authedPage: page,
  }) => {
    await navigateToScheduler(page);
    const popup = await openReservationPopup(page);

    const selector = popup.locator('.treatmentContentSelector');
    await expect(selector).toBeVisible({ timeout: 5_000 });

    // memo textarea — readonly 속성 없음 (항상 자유 편집)
    const memo = selector.locator('.tcs-memo');
    await expect(memo).toBeVisible();
    await expect(memo).not.toHaveAttribute('readonly', /.*/);

    // (1) ADD 진입 시 첫 그룹(검진 및 상담)+첫 항목(구강검진) 자동 선택 — 그룹↔항목 필수 쌍
    const groupChip = selector.locator('.tcs-groupChip', { hasText: '검진 및 상담' });
    await expect(groupChip).toHaveClass(/is-active/);
    const firstItem = selector.locator('.tcs-itemChip', { hasText: '구강검진' });
    await expect(firstItem).toHaveClass(/is-active/);

    // (2) memo 입력 → 값 유지
    await memo.fill('고객 요청사항');
    await expect(memo).toHaveValue('고객 요청사항');

    // (3) 다른 항목(스케일링) 클릭 → 선택 이동. memo 무관(자동기입/덮어쓰기 없음)
    const item2 = selector.locator('.tcs-itemChip', { hasText: '스케일링' });
    await item2.click();
    await expect(item2).toHaveClass(/is-active/);
    await expect(firstItem).not.toHaveClass(/is-active/);
    await expect(memo).toHaveValue('고객 요청사항');

    // (4) 항목 토글오프 없음 — 활성 항목 재클릭해도 선택 유지 (그룹 선택 중 항목 필수)
    await item2.click();
    await expect(item2).toHaveClass(/is-active/);
    await expect(selector.locator('.tcs-itemChip.is-active')).toHaveCount(1);

    // (5) 활성 그룹 재클릭 → 그룹+항목 동시 해제 (쌍 규칙: 둘 다 또는 둘 다 없음)
    await groupChip.click();
    await expect(selector.locator('.tcs-groupChip.is-active')).toHaveCount(0);
    await expect(selector.locator('.tcs-itemChip.is-active')).toHaveCount(0);

    // memo 는 토글 이후에도 유지
    await expect(memo).toHaveValue('고객 요청사항');
  });
});
