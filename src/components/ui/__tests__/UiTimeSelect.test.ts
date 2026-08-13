/**
 * @vitest-environment happy-dom
 *
 * UiTimeSelect — 시각 목록을 펼쳐 하나를 고르는 커스텀 select.
 *
 * native <select> 대신 직접 만든 이유는 목록이 길고(5분 단위 운영시간) 위/아래로
 * 펼치는 방향까지 제어해야 하기 때문이다. 그래서 이 컴포넌트의 계약은 세 갈래다.
 *   1) v-model : 고른 값을 emit 만 하고, 표시값은 항상 modelValue 를 따른다(자체 보관 안 함)
 *   2) 열고 닫기 : 버튼 토글 / 바깥 클릭 / Esc — 이 셋만이 닫는 경로다
 *   3) 펼침 방향 : 아래 공간이 maxHeight 보다 좁고 위가 더 넓으면 위로 펼친다
 *
 * 바깥 클릭·Esc 는 document 캡처 리스너라 실제 DOM 에 붙어야 재현된다 → attachTo 사용.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import UiTimeSelect from '@/components/ui/UiTimeSelect.vue'

const OPTIONS = ['09:00', '09:30', '10:00']

let wrapper: any = null

function mountSelect(props: Record<string, unknown> = {}) {
  wrapper = mount(UiTimeSelect, {
    props   : { modelValue: '', options: OPTIONS, ...props },
    attachTo: document.body,
  })
  return wrapper
}

/**
 * 목록이 펼쳐져 있는가 (v-show 이므로 노드는 항상 있다).
 * element.style.display 는 happy-dom 에서 한 번 보였다 숨겨진 뒤 갱신이 안 되므로
 * style 속성 문자열을 직접 본다.
 */
function isOpen(w: any) {
  return !(w.find('.timeSelect__list').attributes('style') ?? '').includes('display: none')
}

function items(w: any) {
  return w.findAll('.timeSelect__item')
}

function buttonText(w: any) {
  return w.find('.timeSelect__text').text()
}

/** 버튼의 화면 위치를 원하는 대로 속인다 — happy-dom 은 레이아웃이 없어 전부 0 을 준다 */
function fakeButtonRect(w: any, rect: { top: number; bottom: number }) {
  w.find('.timeSelect__btn').element.getBoundingClientRect = () => ({
    ...rect, left: 0, right: 100, width: 100, height: rect.bottom - rect.top, x: 0, y: rect.top,
  })
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('UiTimeSelect — 표시', () => {
  it('값이 없으면 placeholder 를, 있으면 그 값을 보여준다', async () => {
    const w = mountSelect({ modelValue: '', placeholder: '시작시간' })
    expect(buttonText(w)).toBe('시작시간')

    await w.setProps({ modelValue: '09:30' })
    expect(buttonText(w)).toBe('09:30')
  })

  it('처음에는 목록이 닫혀 있다', () => {
    expect(isOpen(mountSelect())).toBe(false)
  })

  it('options 를 순서대로 그린다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    expect(items(w).map((i: any) => i.text())).toEqual(OPTIONS)
  })

  it('현재 값과 같은 항목에만 is-active 가 붙는다 (스크롤 위치의 기준점)', async () => {
    const w = mountSelect({ modelValue: '09:30' })
    await w.find('.timeSelect__btn').trigger('click')

    expect(items(w).map((i: any) => i.classes('is-active'))).toEqual([false, true, false])
  })

  it('목록에 없는 값이 들어와도 그대로 보여준다 (표시는 modelValue 를 따른다)', () => {
    // 컴포넌트가 값을 자체 보관/검증하지 않는다는 뜻 — 정합은 부모 책임
    expect(buttonText(mountSelect({ modelValue: '23:55' }))).toBe('23:55')
  })

  it('invalid / readonly 는 data 속성으로 드러난다 (스타일 훅)', async () => {
    const w = mountSelect()
    expect(w.find('.timeSelect').attributes('data-invalid')).toBe('false')
    expect(w.find('.timeSelect').attributes('data-readonly')).toBe('false')

    await w.setProps({ invalid: true, readonly: true })
    expect(w.find('.timeSelect').attributes('data-invalid')).toBe('true')
    expect(w.find('.timeSelect').attributes('data-readonly')).toBe('true')
  })
})

describe('UiTimeSelect — 고르기', () => {
  it('항목을 누르면 그 값이 emit 되고 목록이 닫힌다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    await items(w)[2].trigger('click')

    expect(w.emitted('update:modelValue')).toEqual([['10:00']])
    expect(isOpen(w)).toBe(false)
  })

  it('고른 값을 스스로 반영하지는 않는다 — 부모가 v-model 로 되돌려줘야 바뀐다', async () => {
    const w = mountSelect({ modelValue: '09:00' })
    await w.find('.timeSelect__btn').trigger('click')
    await items(w)[1].trigger('click')

    // emit 만 했을 뿐, 표시값은 아직 예전 값이다
    expect(buttonText(w)).toBe('09:00')
  })

  it('이미 고른 값을 다시 눌러도 그대로 emit 한다 (선택 취소 개념이 없다)', async () => {
    const w = mountSelect({ modelValue: '09:30' })
    await w.find('.timeSelect__btn').trigger('click')
    await items(w)[1].trigger('click')

    expect(w.emitted('update:modelValue')).toEqual([['09:30']])
  })
})

describe('UiTimeSelect — 열고 닫기', () => {
  it('버튼을 누를 때마다 열리고 닫힌다', async () => {
    const w = mountSelect()
    const btn = w.find('.timeSelect__btn')

    await btn.trigger('click')
    expect(isOpen(w)).toBe(true)

    await btn.trigger('click')
    expect(isOpen(w)).toBe(false)
  })

  it('바깥을 클릭하면 닫힌다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(isOpen(w)).toBe(false)
  })

  it('목록 안을 클릭한 것은 바깥 클릭이 아니다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    w.find('.timeSelect__list').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(isOpen(w)).toBe(true)
  })

  it('Esc 를 누르면 닫힌다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()

    expect(isOpen(w)).toBe(false)
  })

  it('Esc 외의 키로는 닫히지 않는다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()

    expect(isOpen(w)).toBe(true)
  })

  it('readonly 면 버튼이 비활성이라 열 수 없다', async () => {
    const w = mountSelect({ readonly: true })

    expect(w.find('.timeSelect__btn').attributes('disabled')).toBeDefined()
    // 비활성 버튼을 우회해 토글이 호출돼도 readonly 가드가 막는다
    await w.find('.timeSelect__btn').trigger('click')
    expect(isOpen(w)).toBe(false)
  })

  it('사라질 때 document 리스너를 되돌려 놓는다 (닫힌 팝업이 클릭을 삼키지 않게)', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const w = mountSelect()

    w.unmount()
    wrapper = null

    const events = remove.mock.calls.map(c => c[0])
    expect(events).toContain('click')
    expect(events).toContain('keydown')
  })
})

describe('UiTimeSelect — 펼침 방향', () => {
  it('아래 공간이 넉넉하면 아래로 펼친다', async () => {
    const w = mountSelect()
    fakeButtonRect(w, { top: 10, bottom: 46 }) // 화면 위쪽 → 아래가 넓다

    await w.find('.timeSelect__btn').trigger('click')

    expect(w.find('.timeSelect__list').classes()).toContain('down')
  })

  it('아래가 좁고 위가 더 넓으면 위로 펼친다', async () => {
    const w = mountSelect()
    // 창 높이 768 기준, 아래 38px 밖에 안 남고 위는 700px → 위로 펼쳐야 잘리지 않는다
    fakeButtonRect(w, { top: 700, bottom: 730 })

    await w.find('.timeSelect__btn').trigger('click')

    expect(w.find('.timeSelect__list').classes()).toContain('up')
  })

  it('필요 높이(maxHeight)가 작으면 좁은 아래 공간에도 그냥 아래로 펼친다', async () => {
    const w = mountSelect({ maxHeight: 20 })
    fakeButtonRect(w, { top: 700, bottom: 730 })

    await w.find('.timeSelect__btn').trigger('click')

    expect(w.find('.timeSelect__list').classes()).toContain('down')
  })

  it('방향은 열 때 정해진다 — 닫힌 뒤 다시 열면 그때 상황으로 다시 판단한다', async () => {
    const w = mountSelect()
    const btn = w.find('.timeSelect__btn')

    fakeButtonRect(w, { top: 700, bottom: 730 })
    await btn.trigger('click')
    expect(w.find('.timeSelect__list').classes()).toContain('up')

    await btn.trigger('click') // 닫기 — 이때는 방향 재계산 안 함
    fakeButtonRect(w, { top: 10, bottom: 46 })
    await btn.trigger('click')
    expect(w.find('.timeSelect__list').classes()).toContain('down')
  })
})

describe('UiTimeSelect — 휠 스크롤 가둠', () => {
  /** 목록의 스크롤 상태를 지어낸다 (happy-dom 은 레이아웃이 없어 전부 0) */
  function fakeScroll(w: any, { scrollTop, clientHeight, scrollHeight }: Record<string, number>) {
    const el = w.find('.timeSelect__list').element
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    el.scrollTop = scrollTop
  }

  async function wheelAndSeeIfLeaked(w: any, deltaY: number) {
    const onDocWheel = vi.fn()
    document.addEventListener('wheel', onDocWheel)
    await w.find('.timeSelect__list').trigger('wheel', { deltaY })
    document.removeEventListener('wheel', onDocWheel)
    return onDocWheel.mock.calls.length > 0
  }

  it('목록이 더 내려갈 수 있으면 휠이 바깥으로 새지 않는다 (뒤 화면 스크롤 방지)', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')
    fakeScroll(w, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 })

    expect(await wheelAndSeeIfLeaked(w, 10)).toBe(false)
  })

  it('맨 아래에서 더 내리면 바깥으로 넘긴다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')
    fakeScroll(w, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 })

    expect(await wheelAndSeeIfLeaked(w, 10)).toBe(true)
  })

  it('맨 위에서 더 올리면 바깥으로 넘긴다', async () => {
    const w = mountSelect()
    await w.find('.timeSelect__btn').trigger('click')
    fakeScroll(w, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 })

    expect(await wheelAndSeeIfLeaked(w, -10)).toBe(true)
  })
})
