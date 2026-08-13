<script setup>
import { onMounted } from 'vue'
import dayjs from 'dayjs'
import { Notification, Notivue } from 'notivue'
import AppDialogHost from '@/components/frame/AppDialogHost.vue'

// 공휴일 프리로드 (전역 1회). 현재 연도 + 인접 연도(주간 뷰 연 경계 대비).
// 이후 연 이동 시엔 holidayStore.ensureYears 가 빠진 연도만 채움.
// ⚠️ 동적 import — App.vue 는 main.js 가 Pinia 설치 전에 import 하므로,
//    store/api 를 정적 import 하면 모듈 평가가 Pinia 설치 전에 터진다.
onMounted(async () => {
  const { useHolidayStore } = await import('@/stores/holidayStore')
  const holidayStore = useHolidayStore()
  const y = dayjs().year()
  holidayStore.ensureYears([y - 1, y, y + 1])
})
</script>

<template>
  <div class="app-root">
    <Teleport to="body">
      <Notivue v-slot="item">
        <Notification :item="item"/>
      </Notivue>
    </Teleport>
    <RouterView/>
    <AppDialogHost/>
  </div>
</template>
