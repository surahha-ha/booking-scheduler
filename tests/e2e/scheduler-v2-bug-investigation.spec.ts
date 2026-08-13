import { test, expect } from './fixtures/testBase';

/**
 * 버그 #1 조사: SchedulerToolbar의 + 버튼 클릭이 patientSlotSpan에 반영되지 않음
 *
 * 검증 단계:
 *   (1) + 버튼 클릭 자체가 발생하는가?  → 직접 dispatchEvent 가능 여부
 *   (2) Vue child의 onSlotSpanChange(delta=1) 함수가 실행되는가?
 *       → emit('update:patientSlotSpan', next) 발생 여부
 *   (3) 부모 SchedulerPage의 @update:patient-slot-span 핸들러가 호출되는가?
 *   (4) zoomState.patientSlotSpan이 갱신되는가?
 *   (5) child props.patientSlotSpan이 갱신되어 label에 반영되는가?
 *
 * 본 테스트는 운영코드를 수정하지 않고, 외부에서 관찰만 함.
 * 결과는 BUG_REPORT.md로 정리됨.
 */

test('bug#1 조사: SchedulerToolbar + 버튼 → patientSlotSpan 갱신 흐름', async ({
  authedPage: page,
}) => {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[bug1]')) console.log(`[browser ${msg.type()}]`, text);
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await page.goto('/book');
  await expect(page.locator('.schedulerToolbar')).toBeVisible();
  await page.waitForTimeout(500);

  const label = page.locator('.schedulerToolbar__label');
  // ⚠️ nth() 인덱스 금지: 툴바 개편에서 DOM 순서가 [늘리기, 줄이기] 로 바뀌었다.
  const minusBtn = page.locator('button[aria-label="표시 칸 수 줄이기"]');
  const plusBtn = page.locator('button[aria-label="표시 칸 수 늘리기"]');

  console.log('\n=== 초기 상태 ===');
  console.log('label:', await label.textContent());
  console.log('minus visible:', await minusBtn.isVisible(), 'enabled:', await minusBtn.isEnabled());
  console.log('plus  visible:', await plusBtn.isVisible(), 'enabled:', await plusBtn.isEnabled());
  console.log('plus pointer-events:', await plusBtn.evaluate((el) => getComputedStyle(el).pointerEvents));
  console.log('plus overlapping element:',
    await plusBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === el ? '(self)' : (top?.className ?? 'unknown');
    })
  );

  // 1) 일반 click
  console.log('\n=== Step 1: + click ===');
  await plusBtn.click();
  await page.waitForTimeout(800);
  console.log('label after click:', await label.textContent());

  // 2) 직접 dispatchEvent (vue가 listen 중인 click 이벤트 트리거)
  console.log('\n=== Step 2: el.click() ===');
  await plusBtn.evaluate((el: HTMLElement) => el.click());
  await page.waitForTimeout(800);
  console.log('label after el.click:', await label.textContent());

  // 3) page-level evaluate로 vue 컴포넌트 인스턴스 검사
  console.log('\n=== Step 3: vue instance 검사 ===');
  const vueDiag = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    const root = document.getElementById('app') as any;
    out.appExists = !!root;
    out.appHasVue = !!root?.__vue_app__;
    // 라벨 element의 vnode 추적
    const label = document.querySelector('.schedulerToolbar__label') as any;
    if (label) {
      const vnode = label.__vnode || label.__vueParentComponent;
      out.labelHasVnode = !!vnode;
    }
    return out;
  });
  console.log(vueDiag);

  // 4) 마우스 직접 down/up (force=true이지만 native)
  console.log('\n=== Step 4: 마우스 down/up 직접 ===');
  const box = await plusBtn.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(800);
    console.log('label after mouse down/up:', await label.textContent());
  }

  // 5) - 버튼은 동작하는지 비교 (1 → 0이면 onSlotSpanChange는 작동, 단지 +가 안되는 것)
  console.log('\n=== Step 5: - 버튼 클릭 (대조군) ===');
  await minusBtn.click();
  await page.waitForTimeout(500);
  console.log('label after minus click:', await label.textContent());

  // 6) zoom 슬라이더로 zoomLevel 변경 (이미 통과한 시나리오)
  console.log('\n=== Step 6: zoom slider 변경 (대조군) ===');
  await page.locator('.schedulerToolbar__slider').fill('2');
  await page.waitForTimeout(500);
  console.log('slider value after fill 2:', await page.locator('.schedulerToolbar__slider').inputValue());
  console.log('label (patientSlotSpan) after slider change:', await label.textContent());

  // 결론은 BUG_REPORT.md에 기록됨
  // 이 테스트는 실패하지 않음 — 진단 정보만 수집
});
