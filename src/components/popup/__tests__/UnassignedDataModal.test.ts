/**
 * @vitest-environment happy-dom
 *
 * 미지정 데이터 적용 모달 — 메인 화면(담당자 순서 변경)·설정 화면(운영일정 설정) 공용 컴포넌트.
 * 두 화면이 각자 vue/CSS 로 중복 구현하던 것을 하나로 합쳤으므로, 합친 쪽의 계약을 여기서 고정한다.
 *
 * 지키는 것:
 *  ① 열릴 때 첫 담당자가 기본 선택된다(선택 없이 적용 눌러 아무 일도 안 일어나는 상태 방지).
 *  ② 적용 → assignUnassigned(선택 staffId) 1회 + applied/close emit + triggerSearch.
 *     (재조회는 bookStore.load() 직접 호출 금지 규칙에 따라 searchVersion watch chain 으로만)
 *  ③ code!=='succeed' 면 모달을 닫지 않고 재조회도 걸지 않는다.
 *  ④ 담당자 목록은 prop 주입 — 컴포넌트가 스토어를 직접 읽지 않는다(설정 화면은 저장 전 편집 draft 를 넘긴다).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('notivue', () => ({
  push: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const mocks = vi.hoisted(() => ({
  assignUnassigned: vi.fn(),
  triggerSearch: vi.fn(),
}))
vi.mock('@/api/bookApi', () => ({
  assignUnassigned: mocks.assignUnassigned,
  getUnassignedReservations: vi.fn(),
}))
vi.mock('@/stores/useSchedulerFilterStore', () => ({
  useSchedulerFilterStore: () => ({ triggerSearch: mocks.triggerSearch }),
}))

import UnassignedDataModal from '@/components/popup/UnassignedDataModal.vue'

const DOC_A = 101
const DOC_B = 202
const doctors = [
  { staffId: DOC_A, name: '가담당' },
  { staffId: DOC_B, name: '나담당' },
]

/** Teleport(body) 라 wrapper.find 로는 안 잡힌다 — 문서에서 직접 찾는다. */
function queryAll(selector: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(selector))
}

function findButton(label: string): HTMLButtonElement {
  const btn = queryAll('button').find(b => b.textContent?.trim() === label)
  if (!btn) throw new Error(`버튼을 찾지 못했다: ${label}`)
  return btn as HTMLButtonElement
}

function mountModal() {
  return mount(UnassignedDataModal, { props: { visible: true, doctors } })
}

beforeEach(() => {
  mocks.assignUnassigned.mockReset()
  mocks.triggerSearch.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('UnassignedDataModal — 공용 미지정 데이터 적용 모달', () => {
  it('열리면 첫 담당자가 기본 선택되고, 버튼은 [나중에 설정] / [적용]', async () => {
    mountModal()
    await flushPromises()

    const radios = queryAll('input[type="radio"]') as HTMLInputElement[]
    expect(radios).toHaveLength(2)
    expect(radios[0].checked).toBe(true)
    expect(radios[1].checked).toBe(false)

    expect(() => findButton('나중에 설정')).not.toThrow()
    expect(() => findButton('적용')).not.toThrow()
  })

  it('prop 으로 받은 담당자만 렌더한다(스토어 직접 조회 없음)', async () => {
    mount(UnassignedDataModal, {
      props: { visible: true, doctors: [{ staffId: 999, name: '편집중담당' }] },
    })
    await flushPromises()

    expect(document.body.textContent).toContain('편집중담당')
    expect(document.body.textContent).not.toContain('가담당')
  })

  it('적용 → assignUnassigned(선택값) 호출 + applied/close emit + triggerSearch', async () => {
    mocks.assignUnassigned.mockResolvedValue({ data: { code: 'succeed', message: '적용되었습니다.' } })
    const wrapper = mountModal()
    await flushPromises()

    // 두 번째 담당자 선택 후 적용
    const radios = queryAll('input[type="radio"]') as HTMLInputElement[]
    radios[1].checked = true
    radios[1].dispatchEvent(new Event('change'))
    await flushPromises()

    findButton('적용').click()
    await flushPromises()

    expect(mocks.assignUnassigned).toHaveBeenCalledTimes(1)
    expect(mocks.assignUnassigned).toHaveBeenCalledWith(DOC_B)
    expect(wrapper.emitted('applied')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(mocks.triggerSearch).toHaveBeenCalledTimes(1)
  })

  it('code!=="succeed" 면 닫지 않고 재조회도 걸지 않는다', async () => {
    mocks.assignUnassigned.mockResolvedValue({ data: { code: 'failed', message: '실패' } })
    const wrapper = mountModal()
    await flushPromises()

    findButton('적용').click()
    await flushPromises()

    expect(mocks.assignUnassigned).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('applied')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(mocks.triggerSearch).not.toHaveBeenCalled()
  })

  it('[나중에 설정] 은 close 만 emit — 적용 API 를 부르지 않는다', async () => {
    const wrapper = mountModal()
    await flushPromises()

    findButton('나중에 설정').click()
    await flushPromises()

    expect(mocks.assignUnassigned).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('담당자가 없으면 안내 문구 + 적용 비활성', async () => {
    mount(UnassignedDataModal, { props: { visible: true, doctors: [] } })
    await flushPromises()

    expect(document.body.textContent).toContain('팀에 등록된 담당자가 없습니다.')
    expect(findButton('적용').disabled).toBe(true)
  })
})
