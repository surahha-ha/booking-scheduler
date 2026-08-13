/**
 * @vitest-environment happy-dom
 *
 * UiSearchInput — 장부 상단 검색창. 한 컴포넌트가 두 개의 다른 물건이다.
 *
 *  · recent=false (기본) : 그냥 입력칸. 값은 v-model 로 부모에게 넘기고,
 *                          Enter/돋보기는 filterStore.triggerSearch() 로 보드 재조회를 건다.
 *  · recent=true         : PatientAutocomplete 를 얹은 "최근 예약 검색" 드롭다운.
 *
 * ★recent 모드의 핵심 규약: 입력값은 localKeyword(로컬 ref)에만 담기고
 *   filterStore.keyword 는 건드리지 않는다. 드롭다운은 getRecent 라는 별도 API 로
 *   전 기간을 뒤지는 독립 기능이라, 이 입력이 보드 예약목록까지 걸러버리면 안 되기 때문이다.
 *
 * ★검색 발사는 PatientAutocomplete 의 @search 가 아니라 localKeyword watch 로 건다.
 *   (한글 조합 중 compositionend 를 기다리면 드롭다운이 안 뜨는 문제가 있었다)
 *   그래서 조합 여부와 무관하게 "값이 바뀌면 300ms 뒤 조회"가 이 컴포넌트의 실제 동작이다.
 *
 * 나이 계산이 들어 있어 시스템 시각을 2026-03-11 로 고정한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({ getRecent: vi.fn() }))
// bookApi 를 통째로 갈아끼운다 — useApi 까지 딸려 오는 것을 막는 목적도 있다.
vi.mock('@/api/bookApi', () => ({ getRecent: mocks.getRecent }))

import { useSchedulerFilterStore } from '@/stores/useSchedulerFilterStore'
import UiSearchInput from '@/components/ui/UiSearchInput.vue'

const NOW = new Date(2026, 2, 11, 10, 0, 0) // 2026-03-11
const DEBOUNCE_MS = 300
const LIMIT = 10

/**
 * ★trigger('keydown.enter') 를 쓰면 안 된다 — VTU 가 key 를 소문자 'enter' 로 만들어
 * `e.key === 'Enter'` 로 판정하는 PatientAutocomplete 를 그냥 지나쳐 버린다(실브라우저와 다름).
 * 실제 이벤트대로 key 를 직접 준다.
 */
const ENTER = { key: 'Enter' }

/** 최근 예약 한 건 — 필요한 필드만 채우고 나머지는 인자로 덮어쓴다 */
function recentItem(over: Record<string, unknown> = {}) {
  return {
    customerName         : '김고객',
    customerPhone       : '01012345678',
    startAt: '2026-03-10T14:30:00',
    staffName         : '홍의사',
    statusCode  : '00',
    ...over,
  }
}

/** length 개짜리 응답 페이지 */
function page(length: number) {
  return { data: { payload: Array.from({ length }, (_, i) => recentItem({ customerName: `고객${i}` })) } }
}

let wrapper: any = null
let store: ReturnType<typeof useSchedulerFilterStore>

function mountInput(props: Record<string, unknown> = {}) {
  wrapper = mount(UiSearchInput, {
    props   : { modelValue: '', ...props },
    attachTo: document.body,
  })
  return wrapper
}

/** recent 모드 입력칸에 값을 넣고 디바운스가 끝날 때까지 시간을 흘린다 */
async function typeAndSettle(w: any, value: string) {
  await w.find('.patientAutocomplete__input').setValue(value)
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  await w.vm.$nextTick()
}

/** 드롭다운은 teleport 로 body 에 붙으므로 wrapper 밖에서 찾는다 */
function dropdownRows() {
  return Array.from(document.body.querySelectorAll('.patientAutocomplete__row'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  store = useSchedulerFilterStore()
  mocks.getRecent.mockReset()
  mocks.getRecent.mockResolvedValue({ data: { payload: [] } })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ============================================================================
describe('UiSearchInput — 기본 모드 (recent=false)', () => {
  it('입력칸 하나와 검색 버튼을 보여준다 (자동완성은 없다)', () => {
    const w = mountInput()

    expect(w.find('.scheduleSearchInput__field').exists()).toBe(true)
    expect(w.find('.patientAutocomplete__input').exists()).toBe(false)
    expect(w.find('.scheduleSearchInput__iconBtn').exists()).toBe(true)
  })

  it('modelValue 를 그대로 표시하고, 부모가 바꾸면 따라간다 (v-model 계약)', async () => {
    const w = mountInput({ modelValue: '김고객' })
    const input = w.find('.scheduleSearchInput__field')
    expect((input.element as HTMLInputElement).value).toBe('김고객')

    await w.setProps({ modelValue: '박고객' })
    expect((input.element as HTMLInputElement).value).toBe('박고객')
  })

  it('placeholder 는 기본 문구를 쓰고, 넘기면 바뀐다', async () => {
    const w = mountInput()
    expect(w.find('.scheduleSearchInput__field').attributes('placeholder')).toBe('고객명, 전화번호 검색')

    await w.setProps({ placeholder: '이름으로 검색' })
    expect(w.find('.scheduleSearchInput__field').attributes('placeholder')).toBe('이름으로 검색')
  })

  it('타이핑한 값을 그대로 emit 한다 (자체 보관하지 않는다)', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__field').setValue('010')

    expect(w.emitted('update:modelValue')).toEqual([['010']])
  })

  it('입력만으로는 조회가 걸리지 않는다 — 검색은 Enter/버튼으로만', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__field').setValue('김')

    expect(store.searchVersion).toBe(0)
  })

  it('Enter 를 치면 보드 재조회가 걸린다', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__field').trigger('keydown.enter')

    expect(store.searchVersion).toBe(1)
  })

  it('돋보기 버튼도 같은 재조회를 건다', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__iconBtn').trigger('click')
    await w.find('.scheduleSearchInput__iconBtn').trigger('click')

    expect(store.searchVersion).toBe(2)
  })

  it('검색 키워드 자체는 이 컴포넌트가 스토어에 넣지 않는다 (부모 몫)', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__field').setValue('김고객')
    await w.find('.scheduleSearchInput__iconBtn').trigger('click')

    expect(store.keyword).toBe('')
  })
})

// ============================================================================
describe('UiSearchInput — recent 모드: 조회 시점', () => {
  it('recent=true 면 자동완성 입력칸으로 바뀐다', () => {
    const w = mountInput({ recent: true })

    expect(w.find('.patientAutocomplete__input').exists()).toBe(true)
    expect(w.find('.scheduleSearchInput__field').exists()).toBe(false)
  })

  it('입력 직후에는 조회하지 않고 300ms 를 기다린다', async () => {
    const w = mountInput({ recent: true })

    await w.find('.patientAutocomplete__input').setValue('김')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(mocks.getRecent).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.getRecent).toHaveBeenCalledWith({ keyword: '김', limit: LIMIT, offset: 0 })
  })

  it('연달아 치면 마지막 값 한 번만 조회한다', async () => {
    const w = mountInput({ recent: true })
    const input = w.find('.patientAutocomplete__input')

    await input.setValue('김')
    await vi.advanceTimersByTimeAsync(100)
    await input.setValue('김환')
    await vi.advanceTimersByTimeAsync(100)
    await input.setValue('김고객')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(mocks.getRecent).toHaveBeenCalledTimes(1)
    expect(mocks.getRecent).toHaveBeenCalledWith({ keyword: '김고객', limit: LIMIT, offset: 0 })
  })

  it('앞뒤 공백은 떼고 조회한다', async () => {
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '  김고객  ')

    expect(mocks.getRecent).toHaveBeenCalledWith({ keyword: '김고객', limit: LIMIT, offset: 0 })
  })

  it('입력을 지우면 예약된 조회가 취소되고 결과도 비워진다', async () => {
    mocks.getRecent.mockResolvedValue(page(3))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')
    expect(dropdownRows()).toHaveLength(3)

    await w.find('.patientAutocomplete__input').setValue('')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(mocks.getRecent).toHaveBeenCalledTimes(1) // 빈 값으로는 조회하지 않는다
    expect(dropdownRows()).toHaveLength(0)
  })

  it('공백만 친 것도 지운 것으로 본다', async () => {
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '   ')

    expect(mocks.getRecent).not.toHaveBeenCalled()
  })

  it('★검색어를 쳐도 보드 조회 조건은 건드리지 않는다 (예약목록이 걸러지면 안 된다)', async () => {
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '김고객')

    expect(store.keyword).toBe('')
    expect(store.searchVersion).toBe(0)
  })

  // ★돋보기/Enter 는 모드에 따라 다른 물건을 조회한다.
  //   recent 입력은 filterStore.keyword 를 안 건드리므로, 여기서 보드 재조회를 걸면
  //   입력한 고객명과 무관한 "이전 조건" 그대로 도는 헛조회가 된다.
  it('★recent 모드의 돋보기는 보드가 아니라 최근검색을 다시 조회한다', async () => {
    mocks.getRecent.mockResolvedValue(page(2))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김고객')
    mocks.getRecent.mockClear()

    await w.find('.scheduleSearchInput__iconBtn').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.getRecent).toHaveBeenCalledWith({ keyword: '김고객', limit: LIMIT, offset: 0 })
    expect(store.searchVersion).toBe(0) // 보드는 건드리지 않는다
  })

  it('recent 모드에서 입력이 비어 있으면 돋보기를 눌러도 아무 일도 없다', async () => {
    const w = mountInput({ recent: true })

    await w.find('.scheduleSearchInput__iconBtn').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.getRecent).not.toHaveBeenCalled()
    expect(store.searchVersion).toBe(0)
  })

  it('★결과가 없어 드롭다운이 닫힌 상태의 Enter 는 최근검색을 다시 조회한다', async () => {
    // 자동완성은 "드롭다운이 열려 있고 결과가 있을 때"만 Enter 를 pick 으로 소비한다.
    // 그 밖의 Enter 는 여기까지 올라오므로 재조회로 연결한다.
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김고객') // 결과 0건 → 드롭다운 안 열림
    mocks.getRecent.mockClear()

    await w.find('.patientAutocomplete__input').trigger('keydown', ENTER)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.getRecent).toHaveBeenCalledWith({ keyword: '김고객', limit: LIMIT, offset: 0 })
    expect(store.searchVersion).toBe(0)
  })
})

// ============================================================================
describe('UiSearchInput — recent 모드: 결과 표시', () => {
  it('조회 결과가 드롭다운으로 뜬다', async () => {
    mocks.getRecent.mockResolvedValue(page(2))
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '고객')

    expect(dropdownRows()).toHaveLength(2)
  })

  it('결과가 없으면 안내 문구가 뜬다', async () => {
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '없는사람')

    expect(document.body.querySelector('.patientAutocomplete__empty')?.textContent?.trim())
      .toBe('검색조건 결과가 존재하지 않습니다.')
  })

  it('한 행에 고객명·나이/성별·전화·예약일시·담당자·상태를 함께 보여준다', async () => {
    mocks.getRecent.mockResolvedValue({
      data: {
        payload: [recentItem({ birthDate: '1990-05-05', sexDivisionCode: 'M', statusCode: '01' })],
      },
    })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')

    const row = dropdownRows()[0]
    const text = (sel: string) => row.querySelector(sel)?.textContent?.trim()

    expect(text('.recentRow__name')).toBe('김고객')
    expect(text('.recentRow__ageGender')).toBe('35세/남') // 생일 전이라 만 35세
    expect(text('.recentRow__phone')).toBe('010-1234-5678')
    expect(text('.recentRow__datetime')).toBe('2026-03-10 14:30')
    expect(text('.recentRow__doctor')).toBe('홍의사')
    expect(text('.recentRow__status')).toBe('완료')
  })

  it('입력한 글자는 고객명에서 강조된다', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem()] } })
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '고객')

    expect(dropdownRows()[0].querySelector('.recentRow__name')?.innerHTML)
      .toBe('김<span class="highlight">고객</span>')
  })

  it('상태코드를 한글 이름으로 바꿔 보여준다', async () => {
    mocks.getRecent.mockResolvedValue({
      data: {
        payload: ['00', '01', '02', '03', '05'].map(code => recentItem({ statusCode: code })),
      },
    })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')

    const labels = dropdownRows().map(r => r.querySelector('.recentRow__status')?.textContent?.trim())
    expect(labels).toEqual(['예약', '완료', '미이행', '취소', '접수대기'])
  })

  it('모르는 상태코드는 코드 그대로 내보인다 (빈칸으로 삼키지 않는다)', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem({ statusCode: '99' })] } })
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '김')

    expect(dropdownRows()[0].querySelector('.recentRow__status')?.textContent?.trim()).toBe('99')
  })

  it('통합회원이 아니면 나이/성별 칸 자체가 없다', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem()] } })
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '김')

    expect(dropdownRows()[0].querySelector('.recentRow__ageGender')).toBeNull()
  })

  it('성별만 알면 성별만, 생년월일만 알면 나이만 보여준다', async () => {
    mocks.getRecent.mockResolvedValue({
      data: {
        payload: [
          recentItem({ sexDivisionCode: 'F' }),
          recentItem({ birthDate: '2000-01-01' }),
        ],
      },
    })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')

    const ages = dropdownRows().map(r => r.querySelector('.recentRow__ageGender')?.textContent?.trim())
    expect(ages).toEqual(['여', '26세'])
  })

  it('예약일시를 못 읽으면 빈칸으로 둔다 (Invalid Date 노출 방지)', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem({ startAt: null })] } })
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '김')

    expect(dropdownRows()[0].querySelector('.recentRow__datetime')?.textContent?.trim()).toBe('')
  })
})

// ============================================================================
describe('UiSearchInput — recent 모드: 항목 고르기', () => {
  it('항목을 누르면 그 예약을 pick-recent 로 넘긴다 (부모가 날짜 이동/하이라이트)', async () => {
    const picked = recentItem({ customerName: '고른고객', reservationId: 777 })
    mocks.getRecent.mockResolvedValue({ data: { payload: [picked] } })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '고른')

    dropdownRows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(w.emitted('pick-recent')).toHaveLength(1)
    expect(w.emitted('pick-recent')![0][0]).toMatchObject({ customerName: '고른고객', reservationId: 777 })
  })

  it('고르고 나면 입력칸이 비워지고 드롭다운이 닫힌다', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem()] } })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')

    dropdownRows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect((w.find('.patientAutocomplete__input').element as HTMLInputElement).value).toBe('')
    expect(dropdownRows()).toHaveLength(0)
  })

  it('고르는 것으로 보드 조회가 걸리지는 않는다 (부모가 판단할 몫)', async () => {
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem()] } })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')

    dropdownRows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(store.searchVersion).toBe(0)
    expect(store.keyword).toBe('')
  })

  it('★드롭다운이 열려 있을 때의 Enter 는 pick 으로만 쓰이고 재조회를 겹쳐 부르지 않는다', async () => {
    // 자동완성이 Enter 를 소비하며 stopPropagation 하므로 재조회 핸들러까지 내려오면 안 된다.
    mocks.getRecent.mockResolvedValue({ data: { payload: [recentItem({ customerName: '고른고객' })] } })
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '고른')
    mocks.getRecent.mockClear()

    await w.find('.patientAutocomplete__input').trigger('keydown', ENTER)
    await vi.advanceTimersByTimeAsync(0)

    expect(w.emitted('pick-recent')).toHaveLength(1)
    expect(mocks.getRecent).not.toHaveBeenCalled()
  })

  it('기본 모드에서는 pick-recent 가 나올 일이 없다', async () => {
    const w = mountInput()

    await w.find('.scheduleSearchInput__field').setValue('김')

    expect(w.emitted('pick-recent')).toBeFalsy()
  })
})

// ============================================================================
describe('UiSearchInput — recent 모드: 더 불러오기', () => {
  /** 드롭다운을 끝까지 스크롤한 것처럼 만든다 (happy-dom 은 레이아웃이 0 이라 스크롤만 쏘면 된다) */
  async function scrollToBottom(w: any) {
    document.body.querySelector('.patientAutocomplete__list')!
      .dispatchEvent(new Event('scroll', { bubbles: false }))
    await vi.advanceTimersByTimeAsync(0)
    await w.vm.$nextTick()
  }

  it('한 페이지가 꽉 찼으면 바닥에서 다음 페이지를 이어 붙인다', async () => {
    mocks.getRecent.mockResolvedValueOnce(page(LIMIT)).mockResolvedValueOnce(page(3))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '고객')
    expect(dropdownRows()).toHaveLength(LIMIT)

    await scrollToBottom(w)

    expect(mocks.getRecent).toHaveBeenLastCalledWith({ keyword: '고객', limit: LIMIT, offset: LIMIT })
    expect(dropdownRows()).toHaveLength(LIMIT + 3)
  })

  it('페이지가 덜 찼으면 더 부르지 않는다 (마지막 페이지)', async () => {
    mocks.getRecent.mockResolvedValue(page(LIMIT - 1))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '고객')

    await scrollToBottom(w)

    expect(mocks.getRecent).toHaveBeenCalledTimes(1)
  })

  it('이어붙이기는 그때 조회한 검색어를 계속 쓴다 (그 사이 입력이 바뀌어도)', async () => {
    mocks.getRecent.mockResolvedValueOnce(page(LIMIT)).mockResolvedValue(page(1))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '고객')

    // 디바운스가 끝나기 전에 바닥에 닿은 상황 — 결과셋의 주인은 아직 '고객'다
    await w.find('.patientAutocomplete__input').setValue('고객2')
    await scrollToBottom(w)

    expect(mocks.getRecent).toHaveBeenLastCalledWith({ keyword: '고객', limit: LIMIT, offset: LIMIT })
  })
})

// ============================================================================
describe('UiSearchInput — recent 모드: 조회 실패', () => {
  it('조회가 실패해도 화면은 살아 있고 목록만 비워진다', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getRecent.mockResolvedValueOnce(page(2)).mockRejectedValueOnce(new Error('네트워크 끊김'))
    const w = mountInput({ recent: true })
    await typeAndSettle(w, '김')
    expect(dropdownRows()).toHaveLength(2)

    await typeAndSettle(w, '김고객')

    expect(dropdownRows()).toHaveLength(0)
    expect(document.body.querySelector('.patientAutocomplete__empty')).not.toBeNull()
    expect(errorLog).toHaveBeenCalled()
  })

  it('실패 뒤 다시 치면 정상적으로 조회된다 (조회 중 잠금이 풀린다)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.getRecent.mockRejectedValueOnce(new Error('네트워크 끊김')).mockResolvedValue(page(1))
    const w = mountInput({ recent: true })

    await typeAndSettle(w, '김')
    await typeAndSettle(w, '김고객')

    expect(dropdownRows()).toHaveLength(1)
  })
})
