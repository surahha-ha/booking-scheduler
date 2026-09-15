import { computed, inject, ref, type Ref } from 'vue'
import { minuteToBandOffsetPx } from '@/scheduler-engine/schedulerHitTest'

type NowBands = Parameters<typeof minuteToBandOffsetPx>[1]

/**
 * 현재 시각선 계산 — 본문 가로선(NowIndicator)과 시간축 라벨(SchedulerTimeAxis)이 함께 쓴다.
 *
 * 두 컴포넌트가 같은 계산을 각자 들고 있다가 "보이는가" 판정의 부등호가 갈렸다(본문 `<`, 축 `<=`).
 * 진료 종료 정각 1분 동안 본문 선은 사라지고 축 라벨만 남았다. 한 벌로 두면 갈릴 자리가 없다.
 *
 * 보이는 구간은 band 와 같은 반개구간 [첫 band 시작, 마지막 band 끝) 이다 — 끝 분(예: 18:00)은
 * 마지막 band 밖이라 선을 그리지 않는다.
 *
 * '지금'은 부모가 provide 하는 nowTick 기준이다 — 자정을 넘긴 화면에서 시스템 시각이 아니라 tick 이
 * 바뀌어야 선이 옮겨가므로, 테스트도 nowTick 을 고정한다.
 */
export function useNowIndicator(bandInfos: Ref<NowBands>) {
  const nowTick = inject('nowTick', ref(Date.now()))

  const nowMinute = computed(() => {
    const d = new Date(nowTick.value)
    return d.getHours() * 60 + d.getMinutes()
  })

  /** 'YYYY-MM-DD' — column 의 오늘 판정에 쓴다 */
  const todayStr = computed(() => {
    const d = new Date(nowTick.value)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
  })

  const visible = computed(() => {
    const bands = bandInfos.value
    if (!bands.length) return false
    const first = bands[0]
    const last = bands[bands.length - 1]
    return nowMinute.value >= first.startMinute && nowMinute.value < last.endMinute
  })

  const topPx = computed(() => {
    if (!visible.value) return 0
    return minuteToBandOffsetPx(nowMinute.value, bandInfos.value)
  })

  /** 'H:mm' — 시간축 라벨 문구 */
  const timeLabel = computed(() => {
    const h = Math.floor(nowMinute.value / 60)
    const m = nowMinute.value % 60
    return `${h}:${String(m).padStart(2, '0')}`
  })

  return { nowMinute, todayStr, visible, topPx, timeLabel }
}
