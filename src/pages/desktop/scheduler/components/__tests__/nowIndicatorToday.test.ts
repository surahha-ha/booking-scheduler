/**
 * @vitest-environment happy-dom
 *
 * 현재 시각선 — 오늘 날짜 column 만 실선(is-today), 다른 날짜 column 은 점선.
 *
 * 판정 함수(isColumnToday)는 컴포넌트 안에 있어 import 할 수 없다. 그래서 마운트해 실물을 돌린다.
 * 예전에는 엔진 테스트 파일 안에 같은 모양의 함수를 다시 써서 검증했는데, 그 사본은 프로덕션 코드를
 * 한 줄도 실행하지 않아 컴포넌트가 무엇을 하든 그린이었다.
 *
 * '오늘'은 nowTick(부모가 provide) 기준이다 — 자정을 넘긴 화면에서 시스템 시각이 아니라 tick 이
 * 바뀌어야 선이 옮겨가므로, 테스트도 시스템 시각이 아니라 nowTick 을 고정한다.
 */

import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import NowIndicator from '../NowIndicator.vue'

/** 09:00~18:00 한 band — 11:03 이 안에 있어 선이 보인다. */
const BANDS = [{ startMinute: 540, endMinute: 1080, topPx: 0, heightPx: 540, time: '09:00' }]

const COLUMNS = [
  { key: 'yesterday', date: '2026-09-01', leftPx: 0, widthPx: 100 },
  { key: 'today', date: '2026-09-02', leftPx: 100, widthPx: 100 },
  { key: 'tomorrow', date: '2026-09-03', leftPx: 200, widthPx: 100 },
]

/** 2026-09-02 11:03 */
const AT_11_03 = new Date(2026, 8, 2, 11, 3).getTime()

function mountAt(tick: number) {
  return mount(NowIndicator, {
    props: { bandInfos: BANDS, columns: COLUMNS },
    global: { provide: { nowTick: ref(tick) } },
  })
}

describe('NowIndicator — column 별 오늘 판정', () => {
  it('🔑 오늘 날짜 column 만 실선(is-today) 이고 어제·내일은 아니다', () => {
    const segments = mountAt(AT_11_03).findAll('.now-indicator__segment')

    expect(segments).toHaveLength(3)
    expect(segments.map(s => s.classes('is-today'))).toEqual([false, true, false])
  })

  it('tick 이 다음 날로 넘어가면 실선도 다음 column 으로 옮겨간다', () => {
    const nextDay = new Date(2026, 8, 3, 11, 3).getTime()
    const segments = mountAt(nextDay).findAll('.now-indicator__segment')

    expect(segments.map(s => s.classes('is-today'))).toEqual([false, false, true])
  })

  it('어느 column 도 오늘이 아니면 전부 점선이다', () => {
    const farAway = new Date(2026, 8, 10, 11, 3).getTime()
    const segments = mountAt(farAway).findAll('.now-indicator__segment')

    expect(segments.map(s => s.classes('is-today'))).toEqual([false, false, false])
  })
})
