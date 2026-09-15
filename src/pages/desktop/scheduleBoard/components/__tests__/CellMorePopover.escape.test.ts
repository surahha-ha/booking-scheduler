/**
 * @vitest-environment happy-dom
 *
 * CellMorePopover — ESC 로 닫힌다 (회귀 A-6)
 *
 * 이 popover 에는 키보드 이벤트 핸들러가 하나도 없어, 닫으려면 × 를 마우스로 눌러야만 했다.
 * 같은 제품의 카드 ⋮ 팝오버는 이미 ESC 로 닫히므로 두 팝오버가 다르게 동작했다.
 *
 * 검증 범위
 * - 열려 있을 때 ESC → close 를 emit 한다
 * - 닫혀 있을 때 ESC → 아무 일도 없다(다른 화면의 ESC 를 가로채지 않아야 한다)
 * - 언마운트 후 ESC → 리스너가 남아 있지 않다
 * - ESC 가 아닌 키는 무시한다
 */

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CellMorePopover from '../CellMorePopover.vue'

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

function mountPopover(open: boolean) {
  return mount(CellMorePopover, {
    props: { open, top: 0, left: 0, dayNumber: 12, isOff: false },
    attachTo: document.body,
  })
}

describe('CellMorePopover — ESC 닫기', () => {
  it('🔑 열려 있을 때 ESC 를 누르면 close 를 emit 한다', async () => {
    const wrapper = mountPopover(true)

    pressEscape()

    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('🔑 닫혀 있을 때는 ESC 를 가로채지 않는다', async () => {
    const wrapper = mountPopover(false)

    pressEscape()

    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('닫히면 리스너를 해제한다 — 닫은 뒤 ESC 는 무시된다', async () => {
    const wrapper = mountPopover(true)

    pressEscape()
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.setProps({ open: false })
    pressEscape()

    // 닫힌 뒤에는 늘어나지 않는다
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('언마운트하면 리스너가 남지 않는다', async () => {
    const wrapper = mountPopover(true)
    wrapper.unmount()

    // 언마운트된 컴포넌트가 document 리스너를 붙든 채 남아 있으면 여기서 터진다
    expect(() => pressEscape()).not.toThrow()
  })

  it('ESC 가 아닌 키는 무시한다', async () => {
    const wrapper = mountPopover(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })
})
