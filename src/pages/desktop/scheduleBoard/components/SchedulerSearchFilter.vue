<script setup>
import {computed, nextTick, onMounted, ref, watch} from 'vue';
import {storeToRefs} from 'pinia';
import {push} from 'notivue';
import UiModal from '@/components/ui/UiModal.vue';
import {useStaffStore} from '@/stores/staffStore';
import {useReservationSettingStore} from '@/stores/reservationSettingStore';
import {useBookStore} from '@/stores/bookStore';
import '@vuepic/vue-datepicker/dist/main.css';

import {
  APPOINTMENT_STATUS_TYPE,
  TREATMENT_STATUS_TYPE,
  DATA_TYPE,
  MEMBER_TYPE,
  toButtons,
  VIEW_MODE,
} from '@/constants/schedulerSearchFilter';

import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {resolveVisibleDoctors} from '@/utils/schedulerSearchFilterUtils';

import UiSwitchButton from '@/components/ui/UiSwitchButton.vue';
import UiSegmentedControl from '@/components/ui/UiSegmentedControl.vue';

import UiDateNavigator from '@/components/ui/UiDateNavigator.vue';
import UiDoctorFilter from '@/components/ui/UiDoctorFilter.vue';
import UiMemberTypeToggle from '@/components/ui/UiMemberTypeToggle.vue';
import UiStatusFilter from '@/components/ui/UiStatusFilter.vue';
import UiSearchInput from '@/components/ui/UiSearchInput.vue';

import SchedulerSettingsTabs from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTabs.vue';
import SchedulerSettingsTreatmentView from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentView.vue';
import SchedulerSettingsTreatmentSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsTreatmentSetting.vue';
import SchedulerDoctorOrderPopup from '@/pages/desktop/scheduleBoard/components/SchedulerDoctorOrderPopup.vue';
import SchedulerSettingsReservationSetting from '@/pages/desktop/scheduleBoard/components/SchedulerSettingsReservationSetting.vue';

// V3: 일별/주별 토글 숨김(날짜 폭 = zoom 이 대체). 기본 false = 기존(V2 표시) → 가산, V2 무영향.
// recentSearch: 키워드 입력 시 최근 예약 검색 드롭다운 — V3 만 활성, pick 은 그대로 relay.
defineProps({
  hideViewMode: {type: Boolean, default: false},
  recentSearch: {type: Boolean, default: false},
});

const emit = defineEmits(['pick-recent']);

const staffStore = useStaffStore();
const reservationSettingStore = useReservationSettingStore();
const {doctors, teams} = storeToRefs(staffStore);

const bookStore = useBookStore();
const {memberStatisticsData, stateStatisticsData} = storeToRefs(bookStore);
const schedulerFilterStore = useSchedulerFilterStore();

const {
  treatmentStateType: selectedTreatmentStateType,
  dataType          : selectedDataType,
  viewMode          : selectedViewMode,
  keyword           : selectedKeyword,
  memberType        : selectedMemberType,
  selectedTeamName,
  // UiDoctorFilter 가 v-model 로 받는다 — 이 화면의 선택 상태 원천은 여전히 이 스토어다.
  doctors           : selectedDoctors,
} = storeToRefs(schedulerFilterStore);

/* 버튼 데이터 (상수는 computed 불필요) */
const dataTypeButtons = toButtons(DATA_TYPE);
const viewModeButtons = toButtons(VIEW_MODE);
const memberTypeButtons = toButtons(MEMBER_TYPE);
const appointmentStatusButtons = toButtons(APPOINTMENT_STATUS_TYPE);
const treatmentStatusButtons = toButtons(TREATMENT_STATUS_TYPE);
const activeStatusButtons = computed(() =>
    selectedDataType.value === 'TREATMENT' ? treatmentStatusButtons : appointmentStatusButtons
);
// 진료 팀 표시 필터 (이름 통일): 미지정 = 담당자 목록 − 팀멤버 / 특정팀 = 그 팀멤버 (SF-3b)
// #1 비공개(openYn='N') 의사도 목록 포함 — isPrivate 플래그 동반(UiDoctorFilter '비공개' 뱃지).
const doctorButtons = computed(() => {
  const visible = resolveVisibleDoctors(selectedTeamName.value, doctors.value, teams.value);
  return visible.map((d) => ({ value: d.id, label: d.text, isPrivate: d.openYn === 'N' }));
});

const treatmentStateYesOrNo = computed({
  get: () => selectedTreatmentStateType.value === 'Y',
  set: (v) => {
    schedulerFilterStore.setTreatmentStateType(v ? 'Y' : 'N');
  },
});

function reduceStatisticsData(data, key, defaultKeys = []) {
  const defaults = Object.fromEntries(defaultKeys.map(k => [k, 0]));
  return (data ?? []).reduce((acc, cur) => {
    acc[cur[key]] = cur.cnt ?? 0;
    return acc;
  }, defaults);
}

// 빈 배열도 그대로 반영(= 0) — reduceStatisticsData 가 defaultKeys 로 0 baseline 을 채운다.
//   store 는 값을 한 번만 할당(로딩 중 transient 빈 배열 없음)하므로 이전값 유지가 불필요하고,
//   빈 배열은 "표시 의사 0명(B6)·조회결과 0건" = 실제 0 이라 0 으로 보여야 정합.
const memberStatistics = ref({});
watch(memberStatisticsData, (data) => {
  memberStatistics.value = reduceStatisticsData(data, 'memberYn', ['Y', 'N']);
});

const stateStatistics = ref({});
watch([stateStatisticsData, selectedDataType], ([data]) => {
  const statusValues = selectedDataType.value === 'TREATMENT'
    ? Object.values(TREATMENT_STATUS_TYPE)
    : Object.values(APPOINTMENT_STATUS_TYPE);
  stateStatistics.value = reduceStatisticsData(data, 'name', statusValues);
});

// ============================================================================
// 설정 팝업
// ============================================================================
const settingsPopupVisible = ref(false);
// 담당자 순서 변경 팝업 (검색필터 ⇄)
const doctorOrderPopupVisible = ref(false);
const activeSettingsTab = ref('TREATMENT_VIEW');
const treatmentSettingRef = ref(null);
const reservationSettingRef = ref(null);

/* 현재 활성 탭에 대응되는 dirty-aware 자식 ref. 새 dirty 탭이 추가되면 여기만 확장 */
function getActiveDirtyRef() {
  if (activeSettingsTab.value === 'TREATMENT_SETTING') return treatmentSettingRef.value;
  if (activeSettingsTab.value === 'RESERVATION_SETTING') return reservationSettingRef.value;
  return null;
}

/* 팝업 열 때마다 증가 — 자식 컴포넌트를 강제 remount해서 origin 상태로 리셋 */
const settingsPopupOpenKey = ref(0);

/* 자식 askConfirm 통과 후 cancel/save emit 시점에는 hiding 인터셉트를 건너뛰기 위한 플래그 */
const closingConfirmed = ref(false);

function openSettingsPopup() {
  activeSettingsTab.value = 'TREATMENT_VIEW';
  settingsPopupOpenKey.value += 1;
  settingsPopupVisible.value = true;

  /* 담당자 마스터 동기화 — 팝업 열림과 무관하게 백그라운드로 갱신 (picker는 reactive) */
  staffStore.syncDoctor();
}

/* #2 담당자 on-demand 동기화 (↻) — 외부 담당자 추가/삭제를 즉시 로컬 목록에 반영(설정팝업·진입 1회 외 수동 갱신).
 * 진행 중 중복 클릭 차단 + 완료 토스트. picker(doctors)는 reactive 라 자동 갱신. */
const doctorSyncing = ref(false);
async function onDoctorSync() {
  if (doctorSyncing.value) return;
  doctorSyncing.value = true;
  try {
    const ok = await staffStore.syncDoctor();
    if (ok) push.success('담당자 목록을 동기화했습니다.');
    else push.error('담당자 동기화에 실패했습니다.');
  } finally {
    doctorSyncing.value = false;
  }
}

/* 닫기 요청 인터셉트 — 외부클릭·ESC 가 UiModal 의 hiding 으로 들어온다.
 * dirty-aware 탭(운영일정/예약장부) + dirty면 e.cancel=true로 막고 자식 askConfirm 띄움.
 * nextTick 의 true 복원은 취소 경로에서 visible 이 절대 내려가지 않게 하는 방어다. */
function onSettingsPopupHiding(e) {
  if (closingConfirmed.value) {
    closingConfirmed.value = false;
    return;
  }
  const dirtyRef = getActiveDirtyRef();
  /* #1 실제 원인: 연동 confirm 등 전역 다이얼로그는 설정 팝업 바깥(body)에 렌더되므로,
   * 그 위 클릭(예: 확인 버튼)이 hide-on-outside-click 으로 잡혀 설정 팝업이 닫힌다.
   * → 자식이 다이얼로그 대기 중(isDialogBusy)이면 외부클릭 닫힘 취소(팝업 유지). 다이얼로그 종료 후 정상 닫힘만 허용.
   *   (DOM `.modal` 가시성 판정은 position:fixed→offsetParent null 등으로 불안정 → 앱 상태 플래그로 판정.) */
  if (dirtyRef?.isDialogBusy?.()) {
    e.cancel = true;
    nextTick(() => {
      settingsPopupVisible.value = true;
    });
    return;
  }
  if (dirtyRef?.isDirty()) {
    e.cancel = true;
    nextTick(() => {
      settingsPopupVisible.value = true;
    });
    dirtyRef.attemptClose();
  }
}

/* 닫기 버튼(×) 핸들러 — visible을 직접 끄지 않고 dirty 체크 우선. */
function onCloseButtonClick() {
  const dirtyRef = getActiveDirtyRef();
  if (dirtyRef?.isDirty()) {
    dirtyRef.attemptClose();
    return;
  }
  closeSettingsPopupConfirmed();
}

/* 자식 cancel/save emit 시 — 이미 confirm을 거쳤거나 정상 저장이므로 dirty 체크 우회.
 * (연동 confirm 위 외부클릭으로 팝업이 먼저 닫히던 #1 은 onSettingsPopupHiding 의 isDialogBusy 가드로 처리.) */
function closeSettingsPopupConfirmed() {
  closingConfirmed.value = true;
  settingsPopupVisible.value = false;
}

/* 설정 변경 → 스케줄러 반영: 담당자 마스터(담당자/팀/운영시간·휴무) reload + 예약 재조회.
   triggerSearch(searchVersion watch chain)로 처리 — bookStore.load() 직접호출 금지 준수. */
function reloadSchedulerData() {
  staffStore.loadDoctor();
  staffStore.loadTeams();
  staffStore.loadSchedule();
  // 예약장부 설정(전체칸/시간단위/표시정보/카드높이) 저장 즉시 반영 — 캐시(loaded) 무시하고 강제 재조회.
  reservationSettingStore.load(true);
  // 운영시간 미설정으로 redirect latch 가 걸렸던 경우(운영시간 설정 저장 시) 해제 → triggerSearch 가 재조회되게.
  bookStore.clearRedirect();
  schedulerFilterStore.triggerSearch();
}

/* 메인 저장(운영시간/휴무일/팀 등) → 팝업 닫고 reload. */
function onSettingsSaved() {
  closeSettingsPopupConfirmed();
  reloadSchedulerData();
}

// ============================================================================
// 진료 팀 필터 (SF-3a)
// ============================================================================
/* 팀 마스터 로딩 — 팀 미설정이면 빈 배열 → 셀렉트박스 숨김(AS-IS 전체 의사) */
onMounted(() => {
  staffStore.loadTeams();
});

/* 팀 로드 후 첫 번째 팀을 기본 선택(미지정 default 대신). 사용자가 이미 선택했으면 유지. */
watch(teams, (list) => {
  if (selectedTeamName.value == null && list.length > 0) {
    schedulerFilterStore.setTeam(list[0].name);
  }
}, { immediate: true });

/* 셀렉트박스: '' = 미지정(null), 그 외 = 팀명(이름 키 — id 불안정 회피) */
function onTeamChange(e) {
  const v = e.target.value;
  schedulerFilterStore.setTeam(v === '' ? null : v);
}
</script>

<template>
  <div aria-label="예약 및 진료 검색 필터" class="scheduleSearchFilter" role="group">
    <UiSwitchButton
        v-model="treatmentStateYesOrNo"
        :width="80"
        off-label="운영종료"
        on-label="운영중"
    />

    <!-- 예약 | 진료 -->
    <div class="scheduleSearchFilter__item">
      <UiSegmentedControl
          :items="dataTypeButtons"
          :model-value="selectedDataType"
          @update:model-value="schedulerFilterStore.setDataType"
      />
    </div>

    <!-- 일별 | 주별 (V3 는 hideViewMode 로 숨김 — 날짜 폭은 zoom 이 대체) -->
    <div v-if="!hideViewMode" class="scheduleSearchFilter__item">
      <UiSegmentedControl
          :items="viewModeButtons"
          :model-value="selectedViewMode"
          @update:model-value="schedulerFilterStore.setViewMode"
      />
    </div>

    <!-- 4) 날짜 -->
    <div class="scheduleSearchFilter__item scheduleSearchFilter__item--divider">
      <UiDateNavigator/>
    </div>

    <!-- 5) 진료 팀 + 진료의사 -->
    <div class="scheduleSearchFilter__item scheduleSearchFilter__item--divider scheduleSearchFilter__doctorGroup">
      <!-- 팀 셀렉트박스 — 항상 노출. 기본 '미지정' = 기존 담당자 목록(이름키). 팀 있으면 옵션 추가 -->
      <select
          aria-label="진료 팀 선택"
          class="scheduleSearchFilter__teamSelect"
          :value="selectedTeamName ?? ''"
          @change="onTeamChange"
      >
        <option v-for="t in teams" :key="t.id" :value="t.name">{{ t.name }}</option>
        <!-- 미지정은 항상 목록 맨 아래(팀 우선 노출) -->
        <option value="">미지정</option>
      </select>
      <UiDoctorFilter
          :button-items="doctorButtons"
          :model-value="selectedDoctors"
          @update:model-value="schedulerFilterStore.setDoctors"
      />
      <!-- 담당자 동기화 (↻) — 외부 담당자 추가/삭제 즉시 반영. on-demand 수동 갱신(#2). -->
      <!-- <button
          class="scheduleSearchFilter__doctorSyncBtn"
          :class="{ 'is-syncing': doctorSyncing }"
          :disabled="doctorSyncing"
          title="담당자 동기화"
          type="button"
          @click="onDoctorSync"
      >↻</button> -->
      <!-- 담당자 순서 변경 트리거 (화면정의서 4-2) — 팀 설정이 있을 때만 노출 -->
      <button
          v-if="teams.length"
          aria-label="담당자 순서 변경"
          class="scheduleSearchFilter__doctorOrderBtn"
          title="담당자 순서 변경"
          type="button"
          @click="doctorOrderPopupVisible = true"
      >⇄</button>
    </div>

    <!-- 6) 검색 -->
    <div class="scheduleSearchFilter__item scheduleSearchFilter__item--divider">
      <UiSearchInput
          :model-value="selectedKeyword"
          :recent="recentSearch"
          @update:model-value="(value) => schedulerFilterStore.setKeyword(value, false)"
          @pick-recent="(item) => emit('pick-recent', item)"
      />
    </div>

    <!-- 회원 | 비회원 -->
    <UiMemberTypeToggle
        :button-items="memberTypeButtons"
        :model-value="selectedMemberType"
        :statistics="memberStatistics"
        class="scheduleSearchFilter__memberToggle"
        @update:model-value="schedulerFilterStore.setMemberType"
    />

    <!-- 예약 상태 -->
    <div class="scheduleSearchFilter__item">
      <UiStatusFilter
          :button-items="activeStatusButtons"
          :statistics="stateStatistics"
      />
    </div>

    <!-- 7) 설정 -->
    <div class="scheduleSearchFilter__item">
      <button
          class="scheduleSearchFilter__settingBtn"
          type="button"
          @click="openSettingsPopup"
      >
        설정
      </button>
    </div>

    <UiModal
        v-model:visible="settingsPopupVisible"
        :height="'calc(100vh - 64px)'"
        :hide-on-outside-click="true"
        :show-close-button="false"
        :top-offset="50"
        :width="'calc(100vw - 28px)'"
        position="top"
        wrapper-class="scheduleSettingsPopup"
        @hiding="onSettingsPopupHiding"
    >
      <template #title>
        <div class="scheduleSettingsPopup__toolbar">
          <SchedulerSettingsTabs v-model="activeSettingsTab"/>

          <button
              aria-label="닫기"
              class="scheduleSettingsPopup__close"
              type="button"
              @click="onCloseButtonClick"
          >
            ×
          </button>
        </div>
      </template>

      <template #content>
        <div v-if="activeSettingsTab === 'TREATMENT_VIEW'" class="scheduleSettingsPopup__panel">
          <SchedulerSettingsTreatmentView/>
        </div>

        <div v-else-if="activeSettingsTab === 'TREATMENT_SETTING'" class="scheduleSettingsPopup__panel">
          <SchedulerSettingsTreatmentSetting
              :key="settingsPopupOpenKey"
              ref="treatmentSettingRef"
              @cancel="closeSettingsPopupConfirmed"
              @save="onSettingsSaved"
          />
        </div>

        <div v-else-if="activeSettingsTab === 'RESERVATION_SETTING'" class="scheduleSettingsPopup__panel">
          <SchedulerSettingsReservationSetting
              :key="settingsPopupOpenKey"
              ref="reservationSettingRef"
              @cancel="closeSettingsPopupConfirmed"
              @save="onSettingsSaved"
          />
        </div>
      </template>
    </UiModal>

    <!-- 담당자 순서 변경 팝업 (검색필터 ⇄) -->
    <SchedulerDoctorOrderPopup
        :visible="doctorOrderPopupVisible"
        @close="doctorOrderPopupVisible = false"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleSearchFilter__item--divider::before {
  content: '|';
  margin: 0 $space-10 0 $space-8;
  color: rgba(0, 0, 0, 0.3);
}

/* 진료 팀 셀렉트박스 + 의사 필터 묶음 */
.scheduleSearchFilter__doctorGroup {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 담당자 순서 변경 트리거 (⇄) */
.scheduleSearchFilter__doctorOrderBtn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: #fff;
  color: #565656;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #eef3ff;
  }

}
/* 담당자 동기화 트리거 (↻) — ⇄ 와 동일 형태, 진행 중 회전 + 비활성 */
.scheduleSearchFilter__doctorSyncBtn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: #fff;
  color: #565656;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #eef3ff;
  }
  &:disabled { cursor: default; opacity: 0.6; }

  &.is-syncing {
    animation: scheduleSearchFilter-spin 0.8s linear infinite;
  }
}
@keyframes scheduleSearchFilter-spin {
  to { transform: rotate(360deg); }
}
.scheduleSearchFilter__teamSelect {
  height: 24px;
  padding: 0 6px;
  border: 1px solid #bbb;
  border-radius: $radius-4;
  background: #fff;
  font-size: $font-size-14;
  cursor: pointer;

}

.scheduleSearchFilter__memberToggle {
  margin-left: auto;
}

.scheduleSearchFilter__settingBtn {
  width: 28px;
  height: 28px;
  border: 0;
  background: #fff;
  cursor: pointer;
  padding: 0;
  transition: border-color 0.2s;

  // 텍스트 숨김
  font-size: 0;
  color: transparent;

  // 톱니바퀴 아이콘
  --icon-size: 16px;
  --icon-url: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23424242' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Cpath d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/%3E%3C/svg%3E");

  background-image: var(--icon-url);
  background-repeat: no-repeat;
  background-position: center;
  background-size: var(--icon-size) var(--icon-size);

  &:hover {
    border-color: $color-primary;
  }

  &:active {
    transform: translateY(0.5px);
  }

  &:focus-visible {
    outline: 2px solid rgba(0, 0, 0, 0.25);
    outline-offset: 2px;
  }
}

</style>
