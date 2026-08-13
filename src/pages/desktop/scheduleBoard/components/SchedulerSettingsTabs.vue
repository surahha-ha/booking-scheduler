<script setup>
import {computed} from 'vue';

const SETTINGS_TAB_TYPE = {
  TREATMENT_VIEW     : '운영일정 보기',
  TREATMENT_SETTING  : '운영일정 설정',
  RESERVATION_SETTING: '예약장부 설정',
};

const props = defineProps({
  modelValue: {type: String, default: 'TREATMENT_VIEW'},
});

const emit = defineEmits(['update:modelValue']);

const tabs = Object.entries(SETTINGS_TAB_TYPE).map(([value, label]) => ({value, label}));

const activeTab = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});
</script>

<template>
  <div class="scheduleSettingsPopup__tabs">
    <button
        v-for="tab in tabs"
        :key="tab.value"
        :class="{ 'is-active': activeTab === tab.value }"
        class="scheduleSettingsPopup__tab"
        type="button"
        @click="activeTab = tab.value"
    >
      {{ tab.label }}
    </button>
  </div>
</template>
