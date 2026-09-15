/**
 * @vitest-environment happy-dom
 */
// 진료항목 설정 팝업 — 그룹 전환·삭제 확인·중복 차단.
//
// 이 화면의 위험은 "다른 그룹 것을 건드린다"와 "실수로 지운다" 둘이다.
// 그래서 빈 그룹 이탈 차단, 삭제 확인, 동일명 차단을 계약으로 고정한다.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DOMWrapper, flushPromises, mount} from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  alert  : vi.fn().mockResolvedValue(true),
  confirm: vi.fn().mockResolvedValue(true),
  error  : vi.fn(),
  load      : vi.fn().mockResolvedValue(undefined),
  createItem: vi.fn().mockResolvedValue(undefined),
  deleteItem: vi.fn().mockResolvedValue(undefined),
  updateItem: vi.fn().mockResolvedValue(undefined),
}))

const GROUP_A = 1
const GROUP_B = 2
const GROUP_EMPTY = 3

function seedGroups() {
  return [
    {serviceGroupId: GROUP_A, serviceGroupName: '교정', items: [
      {serviceItemId: 11, serviceItemName: '교정상담'},
      {serviceItemId: 12, serviceItemName: '교정검진'},
    ]},
    {serviceGroupId: GROUP_B, serviceGroupName: '보철', items: [{serviceItemId: 21, serviceItemName: '크라운'}]},
    {serviceGroupId: GROUP_EMPTY, serviceGroupName: '빈그룹', items: []},
  ]
}

vi.mock('@/lib/useDialog', () => ({
  useDialog: () => ({alert: mocks.alert, confirm: mocks.confirm}),
}))
vi.mock('notivue', () => ({push: {error: mocks.error}}))
vi.mock('@/stores/serviceItemStore', async () => {
  const {ref} = await import('vue')
  const groups = ref<any[]>([])
  return {
    useServiceItemStore: () => ({
      groups,
      userGroups: groups,
      load      : mocks.load,
      createItem: mocks.createItem,
      deleteItem: mocks.deleteItem,
      createGroup: vi.fn(),
      updateGroup: vi.fn(),
      deleteGroup: vi.fn(),
      updateItem : mocks.updateItem,
    }),
    __groups: groups,
  }
})

import TreatmentItemSettingPopup from '@/components/popup/TreatmentItemSettingPopup.vue'

async function storeGroups() {
  const mod = await import('@/stores/serviceItemStore') as unknown as { __groups: { value: any[] } }
  return mod.__groups
}

// 팝업은 visible 이 되면 document 에 keydown/mousedown 리스너를 건다(capture). unmount 하지
// 않으면 앞 테스트의 인스턴스가 리스너를 붙든 채 남아, 뒤 테스트의 ESC 한 번에 여러 인스턴스가
// 반응한다 — 마운트한 것은 afterEach 에서 반드시 내린다.
const mountedPopups: ReturnType<typeof mount>[] = []

async function openPopup() {
  const wrapper = mount(TreatmentItemSettingPopup, {
    props: {visible: false},
    attachTo: document.body,
  })
  mountedPopups.push(wrapper)
  await wrapper.setProps({visible: true})
  await flushPromises()
  return wrapper
}

// 팝업은 Teleport to body 라 wrapper 탐색이 닿지 않는다 — document 에서 찾는다.
const q = (sel: string) => Array.from(document.querySelectorAll(sel)).map((el) => new DOMWrapper(el))
/** 좌측 그룹 리스트의 행 */
const groupRows = () => q('.tisp-col--group .tisp-row')
/** 우측 항목 입력칸(draft) */
const draftInputs = () => q('.tisp-col:not(.tisp-col--group) .tisp-input')
/** 우측 항목 행의 삭제(×) 버튼 */
const itemDeleteButtons = () => q('.tisp-item-delete-button')

/** 빈그룹을 선택한 채로 연다 — 닫기 확인은 "선택한 그룹"이 비어 있을 때만 뜬다. */
async function openOnEmptyGroup() {
  const wrapper = await openPopup()
  await groupRows()[2].trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(async () => {
  const groups = await storeGroups()
  groups.value = seedGroups()
  mocks.alert.mockClear()
  mocks.confirm.mockClear().mockResolvedValue(true)
  mocks.error.mockClear()
  mocks.createItem.mockClear().mockResolvedValue(undefined)
  mocks.deleteItem.mockClear().mockResolvedValue(undefined)
  mocks.updateItem.mockClear().mockResolvedValue(undefined)
  document.body.innerHTML = ''
})

// visible=false 로 되돌리면 컴포넌트의 teardown() 이 리스너를 뗀다. unmount 까지 하면
// Teleport + attachTo 로 붙인 노드를 해체하다 전체 순차 실행에서 프로세스가 죽는다.
afterEach(async () => {
  const popups = mountedPopups.splice(0)
  for (const w of popups) await w.setProps({visible: false})
})

describe('그룹 전환', () => {
  it('전환 뒤 등록하면 바뀐 그룹으로 들어간다', async () => {
    await openPopup()

    await groupRows()[1].trigger('click')
    await flushPromises()

    const input = draftInputs()[0]
    await input.setValue('브릿지')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(mocks.createItem).toHaveBeenCalledWith(
      expect.objectContaining({serviceGroupId: GROUP_B, serviceItemName: '브릿지'}),
    )
  })

  // 되돌림(7f9814f) 뒤 유일한 안전장치 — 입력 중 다른 그룹 행을 누르면 브라우저가
  // mousedown → blur → click 순으로 처리해, blur 의 커밋이 "그때 선택돼 있던 그룹"으로 먼저
  // 확정된 뒤 click 이 그룹을 바꾼다. 그룹을 await 뒤에 읽도록 바뀌면 엉뚱한 그룹에 들어간다.
  // 기대값 출처: 브라우저 이벤트 순서(mousedown → blur → click) + commitItemDraft 가
  // createItem 호출 전에 selectedGroup 을 동기로 읽는 현행.
  it('입력 중 다른 그룹을 누르면 blur 가 먼저 돌아 입력한 그룹에 등록되고, 그 뒤 전환된다', async () => {
    await openPopup()

    const input = draftInputs()[0]
    await input.setValue('장치조정')
    // 브라우저 순서 그대로: blur(커밋) → click(전환). 사이에 flush 를 두지 않는다.
    await input.trigger('blur')
    await groupRows()[1].trigger('click')
    await flushPromises()

    expect(mocks.createItem).toHaveBeenCalledTimes(1)
    expect(mocks.createItem).toHaveBeenCalledWith(
      expect.objectContaining({serviceGroupId: GROUP_A, serviceItemName: '장치조정'}),
    )
    // 전환은 그대로 일어난다 — 등록이 전환을 막지 않는다
    expect(groupRows()[1].classes()).toContain('is-active')
    // 등록된 입력이 바뀐 그룹의 입력칸에 남아 있지 않다(남으면 다음 blur 에 보철로 또 들어간다)
    expect((draftInputs()[0].element as HTMLInputElement).value).toBe('')
  })
})

describe('빈 그룹은 두고 떠날 수 없다', () => {
  it('항목이 없는 그룹에서 다른 그룹으로 넘어가려 하면 막고 안내한다', async () => {
    const wrapper = await openPopup()

    await groupRows()[2].trigger('click') // 빈그룹 선택
    await flushPromises()
    await groupRows()[0].trigger('click') // 교정으로 이동 시도
    await flushPromises()

    // 어느 그룹이 비었는지 이름으로 말한다 — 다른 그룹에 막 등록한 사용자가
    // "등록하지 않았다"를 자기 등록이 안 된 것으로 읽은 결함.
    expect(mocks.alert).toHaveBeenCalledWith(
      '진료항목이 없는 그룹: 빈그룹\n진료항목을 등록하거나 그룹을 삭제하세요.',
      expect.anything(),
    )
    // 전환되지 않았다 — 빈그룹 행이 여전히 활성
    expect(groupRows()[2].classes()).toContain('is-active')
  })

  it('항목이 있는 그룹 사이는 자유롭게 옮긴다', async () => {
    const wrapper = await openPopup()

    await groupRows()[1].trigger('click')
    await flushPromises()

    expect(mocks.alert).not.toHaveBeenCalled()
    expect(groupRows()[1].classes()).toContain('is-active')
  })
})

describe('푸터', () => {
  it('버튼은 하나다 — CRUD 는 조작 시점에 이미 반영돼 저장할 잔여 변경이 없다', async () => {
    await openPopup()

    const footerButtons = q('.tisp-footer .btn-action')
    expect(footerButtons).toHaveLength(1)
    expect(footerButtons[0].text()).toBe('취소')
  })

  // 이 테스트가 보려는 것은 "취소 버튼이 닫기 경로를 탄다"뿐이라, 확인이 낄 여지가 없는
  // 상태(빈 그룹 없음)로 두고 순수 경로를 지킨다.
  it('누르면 close 를 emit 한다', async () => {
    const groups = await storeGroups()
    groups.value = seedGroups().filter((g) => g.items.length)
    const wrapper = await openPopup()

    await q('.tisp-footer .btn-action')[0].trigger('click')
    await flushPromises()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

// 선택되지 않은 빈 그룹은 닫기 확인이 말하지 않으므로, 어느 그룹이 비었는지는 목록이 알린다.
// 색으로 상태를 말하지 않는다 — 빈 그룹은 에러가 아니라 항목을 채워 넣어야 할 중간 상태다.
describe('빈 그룹 표시', () => {
  const rowMeta = (i: number) => groupRows()[i].find('.tisp-rowMeta')

  it('항목이 없는 그룹에만 라벨이 붙는다', async () => {
    await openPopup()

    expect(rowMeta(0).exists()).toBe(false) // 교정 — 항목 있음
    expect(rowMeta(1).exists()).toBe(false) // 보철 — 항목 있음
    expect(rowMeta(2).text()).toBe('항목 없음') // 빈그룹
  })

  // 라벨과 수정/삭제는 같은 칸을 나눠 쓰고 hover 로 교체된다(.tisp-rowTail 의 grid 겹침).
  // 둘이 각자 자리를 차지하면 라벨이 수정/삭제 폭만큼 안쪽으로 밀려 헤더 힌트와 어긋난다.
  it('라벨과 수정·삭제는 같은 칸에 들어간다 — 헤더 힌트와 우측 정렬', async () => {
    await openPopup()

    const row = groupRows()[2]
    const tail = row.find('.tisp-rowTail')
    expect(tail.find('.tisp-rowMeta').exists()).toBe(true)
    expect(tail.find('.tisp-rowActions').exists()).toBe(true)

    // 꼬리가 행의 마지막 — 우측 끝에 붙는다
    const children = row.element.children
    expect(children[children.length - 1].className).toContain('tisp-rowTail')
  })

  it('항목이 생기면 라벨이 사라진다', async () => {
    await openPopup()
    expect(rowMeta(2).exists()).toBe(true)

    const groups = await storeGroups()
    groups.value[2].items = [{serviceItemId: 31, serviceItemName: '스케일링'}]
    await flushPromises()

    expect(rowMeta(2).exists()).toBe(false)
  })
})

// 빈 그룹은 예약 팝업에서 고를 수 없는 껍데기다. 그룹 전환은 아예 막지만(위 describe),
// 닫기는 막지 않고 확인만 받는다 — 막으면 그룹만 먼저 만든 사용자가 팝업에 갇힌다.
describe('닫기 — 선택한 그룹이 비어 있으면 막는다', () => {
  const footerCancel = () => q('.tisp-footer .btn-action')[0]

  it('선택한 그룹이 비어 있으면 안내하고 닫지 않는다', async () => {
    const wrapper = await openOnEmptyGroup()

    await footerCancel().trigger('click')
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringContaining('진료항목이 없는 그룹: 빈그룹'),
      expect.anything(),
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // 전체 그룹을 훑던 때는 다른 그룹 때문에 뜬 확인창을 자기 그룹 검증으로 읽었다(QA).
  // 판정은 그룹 전환 차단과 같이 "지금 선택한 그룹" 하나다.
  it('다른 그룹이 비어 있어도 선택한 그룹에 항목이 있으면 묻지 않는다', async () => {
    const wrapper = await openPopup() // 첫 그룹(교정, 항목 있음)이 선택된다. 빈그룹은 시드에 있다

    await footerCancel().trigger('click')
    await flushPromises()

    expect(mocks.alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // 회귀: 바깥 클릭(mousedown)이 입력칸 blur 보다 먼저 닫기 판정을 돌려, 방금 입력한 그룹을
  // 빈 그룹으로 보았다 — 등록은 되는데 안내창이 그 그룹명을 올렸다.
  it('입력만 하고 바깥을 클릭하면 먼저 등록하고, 그 그룹은 빈 그룹으로 세지 않는다', async () => {
    const groups = await storeGroups()
    mocks.createItem.mockImplementation(async ({serviceGroupId, serviceItemName}) => {
      groups.value.find((g) => g.serviceGroupId === serviceGroupId).items.push({serviceItemId: 99, serviceItemName})
    })
    const wrapper = await openPopup()

    await groupRows()[2].trigger('click') // 빈그룹 선택
    await flushPromises()
    await draftInputs()[0].setValue('스케일링')
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
    await flushPromises()

    expect(mocks.createItem).toHaveBeenCalledWith({serviceGroupId: GROUP_EMPTY, serviceItemName: '스케일링'})
    expect(mocks.alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // X·취소·그룹 전환 세 경로가 같은 alert(버튼 하나)·같은 문구다 — 경로마다 다르면 사용자는
  // 규칙이 아니라 우연으로 읽는다(QA).
  it('그룹 전환 차단과 같은 alert 와 같은 문구를 쓴다', async () => {
    await openOnEmptyGroup()

    await footerCancel().trigger('click')
    await flushPromises()

    expect(mocks.alert.mock.calls[0][0]).toBe(
      '진료항목이 없는 그룹: 빈그룹\n진료항목을 등록하거나 그룹을 삭제하세요.',
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('ESC 도 같은 안내를 받고 닫히지 않는다 — 닫기 경로마다 규칙이 갈리지 않는다', async () => {
    const wrapper = await openOnEmptyGroup()

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // ESC 는 취소다 — 취소 버튼·X·바깥 클릭은 blur 가 먼저 등록하지만 ESC 는 입력을 등록하지 않는다.
  it('ESC 는 입력만 해둔 항목을 등록하지 않는다', async () => {
    const wrapper = await openOnEmptyGroup()

    await draftInputs()[0].setValue('스케일링')
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    await flushPromises()

    expect(mocks.createItem).not.toHaveBeenCalled()
    expect(mocks.alert.mock.calls[0][0]).toContain('진료항목이 없는 그룹: 빈그룹')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // 닫기 전 등록과 뒤따르는 blur 가 같은 중복명을 각각 시도해 토스트가 두 번 뜨던 회귀.
  it('중복 항목명을 입력한 채 바깥을 클릭하면 중복 안내는 한 번만 뜬다', async () => {
    await openPopup()

    await groupRows()[1].trigger('click') // 보철(크라운 보유) 선택
    await flushPromises()
    await draftInputs()[0].setValue('크라운')
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
    await draftInputs()[0].trigger('blur') // 브라우저는 바깥 mousedown 뒤에 입력칸 blur 를 보낸다
    await flushPromises()

    expect(mocks.createItem).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledTimes(1)
  })

  // 회귀: 빈 그룹의 삭제 확인이 떠 있을 때 ESC 를 누르면 닫기 확인까지 겹쳐 떴다.
  // ESC 핸들러가 capture 라 자기가 띄운 다이얼로그 위의 ESC 까지 가로챈 것이 원인.
  it('삭제 확인이 떠 있을 때의 ESC 는 닫기 확인을 띄우지 않는다', async () => {
    let resolveDelete: (v: boolean) => void = () => {}
    mocks.confirm.mockImplementation(() => new Promise((r) => { resolveDelete = r }))
    const wrapper = await openPopup()

    // 빈그룹 행의 삭제 → 삭제 확인이 열린 채로 대기
    await groupRows()[2].find('.tisp-rowAction--danger').trigger('click')
    await flushPromises()
    expect(mocks.confirm).toHaveBeenCalledTimes(1)

    const esc = new KeyboardEvent('keydown', {key: 'Escape', cancelable: true})
    document.dispatchEvent(esc)
    await flushPromises()

    // 두 번째 다이얼로그가 뜨지 않고, 팝업도 닫히지 않는다
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeUndefined()
    // ESC 를 삼키지 않는다 — 삼키면 삭제 확인을 ESC 로 닫을 수 없다
    expect(esc.defaultPrevented).toBe(false)

    resolveDelete(false) // 삭제 취소
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // 위 결함의 일반형 — "이 팝업이 띄운 다이얼로그 위의 ESC 를 팝업이 가로챈다".
  // 삭제 확인 하나만 막으면 나머지 다이얼로그에서 같은 버그가 그대로 재발한다.
  // withDialog() 로 감싼 네 곳 중 나머지 둘을 여기서 덮는다(그룹 삭제·닫기 확인은 위에서).
  it('항목 삭제 확인 위의 ESC 도 가로채지 않는다', async () => {
    mocks.confirm.mockImplementation(() => new Promise(() => {})) // 열린 채로 대기
    const wrapper = await openPopup()

    await itemDeleteButtons()[0].trigger('click')
    await flushPromises()
    expect(mocks.confirm).toHaveBeenCalledTimes(1)

    const esc = new KeyboardEvent('keydown', {key: 'Escape', cancelable: true})
    document.dispatchEvent(esc)
    await flushPromises()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(esc.defaultPrevented).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('빈 그룹 이탈 안내 위의 ESC 도 가로채지 않는다', async () => {
    mocks.alert.mockImplementation(() => new Promise(() => {})) // 열린 채로 대기
    const wrapper = await openPopup()

    await groupRows()[2].trigger('click') // 빈그룹 선택
    await flushPromises()
    await groupRows()[0].trigger('click') // 이탈 시도 → 안내가 열린 채 대기
    await flushPromises()
    expect(mocks.alert).toHaveBeenCalledTimes(1)

    const esc = new KeyboardEvent('keydown', {key: 'Escape', cancelable: true})
    document.dispatchEvent(esc)
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1) // 닫기 안내가 겹쳐 뜨지 않는다
    expect(esc.defaultPrevented).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // 위 테스트들의 대조군 — 다이얼로그가 없을 때는 ESC 를 팝업이 소비한다(DxPopup 으로 새면
  // 예약 팝업까지 함께 닫힌다). 이 대비가 없으면 위 단언은 항상 참일 수도 있다.
  it('다이얼로그가 없을 때의 ESC 는 팝업이 소비한다', async () => {
    const groups = await storeGroups()
    groups.value = seedGroups().filter((g) => g.items.length) // 확인창이 끼어들지 않게
    const wrapper = await openPopup()

    const esc = new KeyboardEvent('keydown', {key: 'Escape', cancelable: true})
    document.dispatchEvent(esc)
    await flushPromises()

    expect(esc.defaultPrevented).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  // ESC 는 onKeydown 가드가 먼저 막지만, 버튼은 그 경로를 타지 않는다 — handleCancel 자신의
  // 가드가 지키는 유일한 경로라 여기서 고정한다.
  it('안내가 떠 있는 동안 취소 버튼을 다시 눌러도 안내가 겹치지 않는다', async () => {
    mocks.alert.mockImplementation(() => new Promise(() => {})) // 열린 채로 대기
    await openOnEmptyGroup()

    await footerCancel().trigger('click')
    await flushPromises()
    await footerCancel().trigger('click')
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
  })

  it('안내가 떠 있는 동안의 ESC 연타는 안내를 겹쳐 띄우지 않고, 닫은 뒤에도 팝업은 남는다', async () => {
    let resolveAlert: (_v: boolean) => void = () => {}
    mocks.alert.mockImplementation(() => new Promise((r) => { resolveAlert = r }))
    const wrapper = await openOnEmptyGroup()

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)

    resolveAlert(true)
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

describe('진료항목 삭제', () => {
  it('확인을 받고 지운다', async () => {
    await openPopup()

    await itemDeleteButtons()[0].trigger('click')
    await flushPromises()

    expect(mocks.confirm).toHaveBeenCalledWith('삭제하시겠습니까?', expect.anything())
    expect(mocks.deleteItem).toHaveBeenCalled()
  })

  it('확인창에서 취소하면 지우지 않는다', async () => {
    mocks.confirm.mockResolvedValue(false)
    await openPopup()

    await itemDeleteButtons()[0].trigger('click')
    await flushPromises()

    expect(mocks.deleteItem).not.toHaveBeenCalled()
  })
})

describe('진료항목 동일명 차단', () => {
  it('같은 그룹에 이미 있는 이름은 등록하지 않는다', async () => {
    const wrapper = await openPopup()

    const input = draftInputs()[0]
    await input.setValue('교정상담')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(mocks.createItem).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith('이미 동일한 이름의 진료항목이 존재합니다.')
  })

  it('공백만 다른 이름도 같은 이름으로 본다', async () => {
    const wrapper = await openPopup()

    const input = draftInputs()[0]
    await input.setValue('교정 상담')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(mocks.createItem).not.toHaveBeenCalled()
  })

  it('다른 이름이면 등록한다', async () => {
    const wrapper = await openPopup()

    const input = draftInputs()[0]
    await input.setValue('장치조정')
    await input.trigger('keydown.enter')
    await flushPromises()

    expect(mocks.createItem).toHaveBeenCalledWith(
      expect.objectContaining({serviceGroupId: GROUP_A, serviceItemName: '장치조정'}),
    )
  })
})

// 등록 경로의 동일명 차단은 위에서 고정했지만 이름 **변경**(commitEditItem)은 별도 경로다 —
// 자기 자신은 excludeId 로 빼야 하고, 그걸 빼먹으면 공백만 고친 자기 이름이 "중복"으로 막힌다.
// 기대값 출처: isDuplicateItemNm(name, excludeId) 계약 + 등록 경로와 같은 문구.
describe('진료항목 이름 변경 시 동일명 차단', () => {
  /** 우측 항목 행(입력 draft 행 제외) */
  const itemRows = () => q('.tisp-col:not(.tisp-col--group) .tisp-list .tisp-row')
      .filter((r) => r.find('.tisp-rowText').exists() || r.find('input.tisp-input').exists())

  async function renameFirstItemTo(name: string) {
    const row = itemRows()[0] // 교정상담
    await row.trigger('click') // startEditItem → 그 행이 input 으로 바뀐다
    await flushPromises()
    const input = row.find('input.tisp-input')
    expect(input.exists()).toBe(true)
    await input.setValue(name)
    await input.trigger('keydown.enter')
    await flushPromises()
  }

  it('같은 그룹의 다른 항목 이름으로는 바꿀 수 없다', async () => {
    await openPopup()

    await renameFirstItemTo('교정검진')

    expect(mocks.updateItem).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith('이미 동일한 이름의 진료항목이 존재합니다.')
  })

  it('공백만 다른 다른 항목 이름도 같은 이름으로 본다', async () => {
    await openPopup()

    await renameFirstItemTo('교정 검진')

    expect(mocks.updateItem).not.toHaveBeenCalled()
  })

  it('자기 이름에서 공백만 고친 것은 자기 자신이라 통과한다 — excludeId', async () => {
    await openPopup()

    await renameFirstItemTo('교정 상담')

    expect(mocks.updateItem).toHaveBeenCalledWith(11, {serviceItemName: '교정 상담'})
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('새 이름이면 바꾼다', async () => {
    await openPopup()

    await renameFirstItemTo('교정재상담')

    expect(mocks.updateItem).toHaveBeenCalledWith(11, {serviceItemName: '교정재상담'})
  })
})

// 닫기 4경로(ESC·취소·우상단 X·바깥 클릭)가 handleCancel 한 곳으로 모인다 — ESC·취소는 위에서
// 고정했고 나머지 둘을 여기서 덮는다. 한 경로라도 따로 닫으면 빈 그룹 확인이 그 경로에서만 빠진다.
describe('닫기 — 우상단 X 버튼과 바깥 클릭도 같은 안내로 막는다', () => {
  const closeButton = () => q('.tisp-closeBtn')[0]

  it('X 버튼은 빈 그룹 안내를 띄우고 닫지 않는다', async () => {
    const wrapper = await openOnEmptyGroup()

    await closeButton().trigger('click')
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(mocks.alert.mock.calls[0][0]).toContain('진료항목이 없는 그룹: 빈그룹')
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('X 버튼은 선택한 그룹에 항목이 있으면 바로 닫는다', async () => {
    const wrapper = await openPopup() // 첫 그룹(교정, 항목 있음)

    await closeButton().trigger('click')
    await flushPromises()

    expect(mocks.alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('바깥 클릭(document mousedown)도 같은 안내를 띄우고 닫지 않는다', async () => {
    const wrapper = await openOnEmptyGroup()

    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // 이 팝업은 예약 팝업 위에 뜬다 — 예약 팝업 안을 누르는 것은 바깥이 아니다(예약 팝업이 자기 닫힘을 갖는다)
  it('예약 팝업(.schedulePopup) 안쪽 클릭은 바깥으로 보지 않는다', async () => {
    const wrapper = await openPopup()
    const host = document.createElement('div')
    host.className = 'schedulePopup'
    document.body.appendChild(host)

    host.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
    await flushPromises()

    expect(mocks.alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  // handleCancel 자신의 가드 — 안내가 떠 있는 동안의 바깥 클릭이 안내를 겹쳐 띄우지 않는다
  it('안내가 떠 있는 동안의 바깥 클릭은 안내를 겹치지 않는다', async () => {
    mocks.alert.mockImplementation(() => new Promise(() => {})) // 열린 채로 대기
    await openOnEmptyGroup()

    await closeButton().trigger('click')
    await flushPromises()
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
    await flushPromises()

    expect(mocks.alert).toHaveBeenCalledTimes(1)
  })
})
