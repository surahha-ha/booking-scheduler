<script setup>
import {onBeforeUnmount, ref, watch} from 'vue';
import dayjs from 'dayjs';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {getRecent} from '@/api/bookApi';
import {formatPhoneNumber} from '@/utils/formatStringUtils';
import PatientAutocomplete from '@/components/popup/PatientAutocomplete.vue';

const props = defineProps({
  /**
   * ★recent=false 전용. recent=true 에서는 **사용하지 않는다** —
   * 최근 예약 검색은 filterStore.keyword 와 분리된 localKeyword 로만 돌아가므로
   * 이 값을 읽지도, update:modelValue 를 emit 하지도 않는다(아래 localKeyword 주석 참고).
   * recent 모드에 v-model 을 걸면 개발 모드에서 경고한다.
   */
  modelValue : {
    type   : String,
    default: '',
  },
  placeholder: {
    type   : String,
    default: '고객명, 전화번호 검색',
  },
  /**
   * 최근 예약 검색 드롭다운 활성화 — 입력 시 전 기간 최근 10건 표시,
   * 항목 pick 시 'pick-recent' emit(부모가 날짜 이동 + 하이라이트 처리).
   * 기본 false = 기존 동작 그대로(드롭다운 없음).
   */
  recent     : {
    type   : Boolean,
    default: false,
  },
});

const emit = defineEmits(['update:modelValue', 'pick-recent']);
const schedulerFilterStore = useSchedulerFilterStore();

function readInputValue(e) {
  return (e.target).value;
}

function onInput(e) {
  const v = readInputValue(e);
  emit('update:modelValue', v);
}

function onKeywordSearch() {
  schedulerFilterStore.triggerSearch();
}

// ============================================================================
// 최근 예약 검색 드롭다운 (recent=true 전용)
// ============================================================================
const RECENT_SEARCH_DEBOUNCE_MS = 300;
const RECENT_LIMIT = 10;

const recentItems = ref([]);
const recentDropdownOpen = ref(false);
// 무한 스크롤 페이징 상태 — 드롭다운 하단 도달 시 다음 페이지(offset += LIMIT) append.
const recentHasMore = ref(false);
const recentLoading = ref(false);
let recentFetchedKeyword = ''; // 현재 결과셋의 키워드(페이징 중 입력 변화와 분리)
/**
 * recent 모드 입력 — filterStore.keyword 와 분리된 로컬 상태.
 * 검색 드롭다운은 getRecent(별도 API)로 목록만 채우는 독립 기능이며,
 * 입력 고객명이 메인 보드 조회(toBookApiParams 의 keyword)에 반영되어
 * 예약목록이 그 고객로 filter 되면 안 된다. → filterStore.keyword 미접촉.
 */
const localKeyword = ref('');
let recentSearchTimer = null;

const STATUS_LABEL = {
  '00': '예약',
  '01': '완료',
  '02': '미이행',
  '03': '취소',
  '05': '접수대기',
};

function formatRecentDateTime(dtm) {
  const d = dayjs(dtm);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '';
}

/** 회원정보 보강 표기 — 통합회원만 birthDate/sexDivisionCode 존재. 없으면 빈 문자열. */
function formatAgeGender(item) {
  const parts = [];
  if (item.birthDate) {
    const birth = dayjs(item.birthDate);
    if (birth.isValid()) parts.push(`${dayjs().diff(birth, 'year')}세`);
  }
  const sex = String(item.sexDivisionCode ?? '').toUpperCase();
  if (sex === 'M' || sex === 'MALE' || sex === '1') parts.push('남');
  else if (sex === 'F' || sex === 'FEMALE' || sex === '2') parts.push('여');
  return parts.join('/');
}

// append=false: 새 검색(첫 페이지). append=true: 무한스크롤 다음 페이지.
async function fetchRecent(keyword, append = false) {
  if (recentLoading.value) return;
  if (append && !recentHasMore.value) return;
  recentLoading.value = true;
  try {
    const offset = append ? recentItems.value.length : 0;
    const res = await getRecent({keyword, limit: RECENT_LIMIT, offset});
    const page = res?.data?.payload ?? [];
    recentItems.value = append ? [...recentItems.value, ...page] : page;
    recentHasMore.value = page.length === RECENT_LIMIT; // 꽉 찬 페이지면 더 있을 수 있음
    recentFetchedKeyword = keyword;
  } catch (e) {
    console.error('[book > 최근 예약 검색] 실패', e);
    if (!append) recentItems.value = [];
    recentHasMore.value = false;
  } finally {
    recentLoading.value = false;
  }
}

// 드롭다운 하단 근처 도달(PatientAutocomplete @load-more) → 다음 페이지 append.
function onRecentLoadMore() {
  if (!recentFetchedKeyword) return;
  fetchRecent(recentFetchedKeyword, true);
}

// PatientAutocomplete @search — trim/minLength 통과 keyword 만 들어옴('' = 비움 의도).
function onRecentSearch(keyword) {
  if (recentSearchTimer) {
    clearTimeout(recentSearchTimer);
    recentSearchTimer = null;
  }
  if (!keyword) {
    recentItems.value = [];
    recentHasMore.value = false;
    recentFetchedKeyword = '';
    recentDropdownOpen.value = false;
    return;
  }
  recentSearchTimer = setTimeout(async () => {
    await fetchRecent(keyword);
    recentDropdownOpen.value = true;
  }, RECENT_SEARCH_DEBOUNCE_MS);
}

function onRecentPick(item) {
  recentDropdownOpen.value = false;
  emit('pick-recent', item);
}

// localKeyword 변경마다 fetch — @search(compositionend 후) 대신 값 변경 기준이라
// 한글 마지막 글자 조합 유지 등으로 드롭다운이 안 뜨는 포커스/타이밍 이슈 회피.
// localKeyword 라 filterStore.keyword 미반영 = 보드 예약목록 filter 안 됨.
watch(localKeyword, (v) => {
  onRecentSearch(String(v ?? '').trim());
});

function onRecentPickInternal(item) {
  // pick 후 입력칸/드롭다운 정리. filterStore.keyword 는 애초에 안 건드렸으므로 보드 영향 없음.
  localKeyword.value = '';
  onRecentPick(item);
}

/**
 * recent 모드의 돋보기/Enter — 보드 재조회(triggerSearch)가 아니라 최근검색을 다시 띄운다.
 * 이 입력은 filterStore.keyword 를 건드리지 않으므로, 여기서 보드 재조회를 걸면
 * 입력한 고객명과 무관한 "이전 조건" 그대로 도는 헛조회가 된다.
 */
async function onRecentReSearch() {
  const keyword = String(localKeyword.value ?? '').trim();
  if (!keyword) return;
  await fetchRecent(keyword);
  recentDropdownOpen.value = true;
}

// 돋보기 버튼은 모드에 따라 다른 물건을 조회한다 — 기본은 보드, recent 는 최근검색.
function onSearchButtonClick() {
  if (props.recent) {
    onRecentReSearch();
    return;
  }
  onKeywordSearch();
}

// recent 모드에 v-model 을 걸면 조용히 무시되는 대신 개발 중에 드러나게 한다.
// (PatientAutocomplete 로 갈아끼워지면서 modelValue 를 읽을 곳 자체가 없다)
if (import.meta.env.DEV) {
  watch(
      () => [props.recent, props.modelValue],
      ([isRecent, value]) => {
        if (isRecent && value) {
          console.warn('[UiSearchInput] recent=true 에서는 modelValue 를 사용하지 않습니다. 입력값은 pick-recent 로만 나갑니다.');
        }
      },
      {immediate: true}
  );
}

onBeforeUnmount(() => {
  if (recentSearchTimer) {
    clearTimeout(recentSearchTimer);
    recentSearchTimer = null;
  }
});
</script>

<template>
  <div class="scheduleSearchInput" :class="{ 'scheduleSearchInput--recent': recent }">
    <!-- recent 모드: 최근 예약 검색 드롭다운. localKeyword(로컬)라 filterStore.keyword 미접촉 → 보드 예약목록 filter 안 됨. -->
    <PatientAutocomplete
        v-if="recent"
        v-model:open="recentDropdownOpen"
        :items="recentItems"
        :model-value="localKeyword"
        :placeholder="placeholder"
        :teleport="true"
        teleport-right-anchor=".scheduleSearchFilter"
        class="scheduleSearchInput__autocomplete"
        @update:model-value="(v) => localKeyword = v"
        @pick="onRecentPickInternal"
        @load-more="onRecentLoadMore"
        @keydown.enter="onRecentReSearch"
    >
      <template #row="{ item, highlightName }">
        <div class="recentRow">
          <div class="recentRow__line recentRow__line--primary">
            <span class="recentRow__name" v-html="highlightName(item.customerName)" />
            <span v-if="formatAgeGender(item)" class="recentRow__ageGender">{{ formatAgeGender(item) }}</span>
            <span class="recentRow__phone">{{ formatPhoneNumber(item.customerPhone) }}</span>
          </div>
          <div class="recentRow__line recentRow__line--secondary">
            <span class="recentRow__datetime">{{ formatRecentDateTime(item.startAt) }}</span>
            <span class="recentRow__doctor">{{ item.staffName }}</span>
            <span :class="`recentRow__status--${item.statusCode}`" class="recentRow__status">
              {{ STATUS_LABEL[item.statusCode] ?? item.statusCode }}
            </span>
          </div>
        </div>
      </template>
    </PatientAutocomplete>

    <!-- 기본 모드: 기존 동작 그대로 -->
    <input
        v-else
        aria-label="고객명 또는 전화번호 검색"
        :placeholder="placeholder"
        :value="modelValue"
        class="scheduleSearchInput__field"
        type="text"
        @input="onInput"
        @keydown.enter.prevent="onKeywordSearch"
    >
    <button
        class="scheduleSearchInput__iconBtn"
        type="button"
        @click="onSearchButtonClick"
    >
      검색
    </button>
  </div>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

.scheduleSearchInput {
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 260px;
  border: 1px solid #bbb;
  border-radius: $radius-4;
  transition: border-color 0.2s;

  &:hover {
    border-color: $color-primary;
  }

  // 아이콘 경로를 변수로 빼두면 재사용/교체가 쉬움
  --icon-size: 14px;
  --icon-url: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23424242' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E");

  &__field {
    flex: 1;
    min-width: 0;
    height: 24px;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 12px;
    padding: 0 8px;
  }

  &__autocomplete {
    flex: 1;
    min-width: 0;

    // PatientAutocomplete 의 기본 input(.scheduleField) 스타일을 검색 input 톤으로 정합
    :deep(.patientAutocomplete__input) {
      width: 100%;
      height: 24px;
      border: 0;
      outline: 0;
      background: transparent;
      font-size: $font-size-14;
      padding: 0 8px;
    }
    // 드롭다운 폭/위치는 teleport(body)+fixed 라 PatientAutocomplete inline style 이 담당
    // (scoped :deep 은 body 로 빠진 노드에 닿지 않음).
  }

  &__iconBtn {
    flex: 0 0 auto;
    width: 24px; // 클릭 영역
    height: 24px;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 0;

    // 텍스트 숨김
    font-size: 0;
    color: transparent;

    // 아이콘 표시
    background-image: var(--icon-url);
    background-repeat: no-repeat;
    background-position: center;
    background-size: var(--icon-size) var(--icon-size);

    &:hover {
      opacity: 0.9;
    }

    &:active {
      opacity: 1;
      transform: translateY(0.5px);
    }

    // 키보드 포커스 접근성
    &:focus-visible {
      outline: 2px solid rgba(0, 0, 0, 0.25);
      outline-offset: 2px;
    }
  }
}

// 최근 예약 검색 드롭다운 행 (2행: 고객정보 / 예약정보)
.recentRow {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  &__line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  &__name {
    font-weight: 500;
    color: #000;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    :deep(.highlight) {
      color: $color-primary;
    }
  }

  &__ageGender {
    flex: 0 0 auto;
    font-size: 12px;
    color: #666;
  }

  &__phone {
    flex: 0 0 auto;
    margin-left: auto;
    font-size: 12px;
    color: #999;
  }

  &__line--secondary {
    font-size: 12px;
    color: #666;
  }

  &__doctor {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__status {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 0 4px;
    border-radius: 2px;
    font-size: 11px;
    background: #E3F2FD;
    color: #1565C0;

    &--01 { background: rgba(46, 125, 50, 0.14); color: #2E7D32; }
    &--02 { background: #fff0f0; color: #C62828; }
    &--03 { background: #f0f0f0; color: #777; }
    &--05 { background: #FFF3E0; color: #B45309; }
  }
}
</style>
