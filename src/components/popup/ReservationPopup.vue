<script setup>
import {VueDatePicker} from '@vuepic/vue-datepicker';
import '@vuepic/vue-datepicker/dist/main.css';

import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import PatientAutocomplete from '@/components/popup/PatientAutocomplete.vue';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import {useStaffStore} from '@/stores/staffStore';
import {storeToRefs} from 'pinia';
import UiModal from '@/components/ui/UiModal.vue';
import {useCustomerStore} from '@/stores/customerStore';
import {isPastSlot} from '@/utils/dateUtils';
import {formatPhoneNumber, isValidPhoneNumber, labelBlockedReason, onlyNumber} from '@/utils/formatStringUtils';
import UiTimeSelect from '@/components/ui/UiTimeSelect.vue';
import {datePickerYearRange, toDisplayStatus, toStatusClassName, toType} from '@/utils/schedulerSearchFilterUtils';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {resolveVisibleDoctors} from '@/utils/schedulerSearchFilterUtils';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_LOCAL_DATE_TIME,
  DEFAULT_TIME_FORMAT,
  IS_END_TIME_FIX,
  PAGE_SIZE_DOCTOR_ADD_FILTER,
  PATIENT_SEARCH_DEBOUNCE_MS,
  STEP_MIN
} from '@/constants/componentConstants';
import {hasBlockedHtmlTag} from '@/utils/hasHtmlTagUtils';
import {useDialog} from '@/lib/useDialog';
import TreatmentContentSelector from '@/components/popup/TreatmentContentSelector.vue';
import TreatmentItemSettingPopup from '@/components/popup/TreatmentItemSettingPopup.vue';
import {useServiceItemStore} from '@/stores/serviceItemStore';
import {hasSelectableItems, isTreatmentItemSelectionValid} from '@/components/popup/treatmentItemRules';
import {
  addMinutes,
  buildTimeOptions,
  clampToOptions,
  filterOptionsFromMinute,
  getEndOptionsByStart as getEndOptions,
  normalizeTimeStrings,
  parseTimeToMinutes,
} from '@/components/popup/reservationTimeRules';
import {floorToStep} from '@/scheduler-engine/schedulerSnapGrid';
import {useDialogGuard} from '@/composables/useDialogGuard';

dayjs.extend(isSameOrAfter);

const dialog = useDialog();

const staffStore = useStaffStore();
const {doctors, teams} = storeToRefs(staffStore);

const customerStore = useCustomerStore();
const {patients} = storeToRefs(customerStore);

const schedulerFilterStore = useSchedulerFilterStore();
const {dataType, viewMode} = storeToRefs(schedulerFilterStore);

const props = defineProps({
  visible         : {type: Boolean, required: true},
  payload         : {type: Object, default: null},
  minTime         : {type: String, default: '00:00'},
  maxTime         : {type: String, default: '23:30'},
  width           : {type: Number, default: 460},
  /**
   * 호출처에서 height 미명시 시 'auto' — 콘텐츠가 높이를 결정한다.
   * (고정 px 추정은 입력 조합마다 어긋나 하단 버튼이 잘렸다 — effectiveHeight 참고)
   */
  height          : {type: Number, default: null},
  getBlockedReason: {type: Function, default: null},
  isDayOff        : {type: Boolean, default: false},
  /** 호출처의 저장 요청이 진행 중인지. 진행 중에는 등록·수정 버튼을 잠가 연타로 두 번 나가는 것을 막는다. */
  saving          : {type: Boolean, default: false},
  /**
   * V1 호환 모드. true 면 서비스 내용을 자유 텍스트 textarea 로 표시한다.
   * 기본값(false) 은 V2 의 서비스 항목 그룹+상세 선택 UI(TreatmentContentSelector) 사용.
   * V1 (`/scheduler`) 화면이 제거되면 이 prop 과 v-if 분기를 함께 삭제하여
   * 단일 컴포넌트로 환원한다.
   */
  legacyMemoMode  : {type: Boolean, default: false}
});

const serviceItemStore = useServiceItemStore();
const settingPopupVisible = ref(false);

// 호출처 명시값이 우선. 없으면 'auto' = 콘텐츠 주도.
//
// 과거에는 진료내용 칩 행 수로 420/500/540/580 을 추정해 내려줬는데, 높이를 바꾸는 요소가
// 칩 행 말고도 여럿(폼 grid gap × 행수, 담당의사 뱃지 유무, 진료내용 형식오류 안내줄, 진료항목 선택 영역)이라
// 조합에 따라 콘텐츠가 고정 높이를 넘겼고, 문서 순서상 마지막인 .schedulePopupActions(취소/등록)가 잘렸다.
// 상수를 키우는 방식은 다른 조합에서 재발하므로 높이 산정 자체를 콘텐츠에 맡긴다.
const effectiveHeight = computed(() => props.height ?? 'auto');

const emit = defineEmits(['close', 'save', 'modify']);
const MEMO_MAX_LENGTH = 1000;
// 항목이 있는 그룹을 고르고 항목을 비워 둔 경우의 안내.
const TREATMENT_ITEM_REQUIRED_MSG = '선택한 그룹의 진료항목을 선택해주세요.';

// ============================================================================
// mode / title
// ============================================================================
const mode = computed(() => (props.payload?.mode === 'EDIT' ? 'EDIT' : 'ADD'));
const isEditMode = computed(() => mode.value === 'EDIT');
const computedDateType = computed(() => dataType.value);
const isDayViewMode = computed(() => viewMode.value === 'DAY');
const isTreatmentMode = computed(() => computedDateType.value === 'TREATMENT');

const readOnlyMode = computed(() => {
  // 진료모드 EDIT: 과거 예약만 readOnly (현재 이후는 수정 가능)
  if (isTreatmentMode.value && isEditMode.value) {
    const s = props.payload?.startDateTime;
    return s ? isPastSlot(s) : false;
  }

  // 예약모드 EDIT: 상태가 00이 아니면 readOnly
  if (isEditMode.value && props?.payload?.status !== '00') return true;

  // end 기준 시간 경과
  const e = props.payload?.endDateTime;
  return isPastSlot(e);
});
const popupTitle = computed(() => {
  const isTreatment = computedDateType.value === 'TREATMENT';

  if (readOnlyMode.value) {
    return isTreatment ? '진료 보기' : '예약 보기';
  }

  if (isEditMode.value) {
    return isTreatment ? '진료 수정' : '예약 수정';
  }

  return isTreatment ? '진료 등록' : '예약 등록';
});
// 일시(날짜·시작·종료)는 readOnlyMode 와 별개로 판정한다.
// EDIT 이면 대상 예약이 과거·현재이든 상태가 무엇이든 시간 재지정을 허용 — 지난 예약의
// 실제 진료 시각 보정이 필요하다. BE(BookLockService.modifyWithLock)에 과거시간 금지 검증 없음.
const dateTimeReadOnly = computed(() => !isEditMode.value && readOnlyMode.value);
const uiModeClassName = computed(() => ({
  'ui--readonly': readOnlyMode.value,
  'ui--disabled': false
}));
const dateTimeUiClassName = computed(() => ({
  'ui--readonly': dateTimeReadOnly.value,
  'ui--disabled': false
}));
// 예약 화면에서는 예약(00)·취소(03)만 상태 뱃지로 구분한다(진료완료·미이행은 예약처럼 표기). 규칙 SSOT = toDisplayStatus.
const displayStatus = computed(() => toDisplayStatus(props?.payload?.status, dataType.value));
const headerBadgeText = computed(() => {
  if (displayStatus.value === '01') return '완료';
  if (displayStatus.value === '02') return '예약미이행';
  if (displayStatus.value === '03') return '예약취소';
  if (displayStatus.value === '05') return '대기';
  return '';
});
/* 외부 시스템 연동 예약 — 'EXT' 뱃지 표시 여부 */
const isExternalSyncBadge = computed(() => props?.payload?.isExternalSync === true);
const datePickerRef = ref(null);
const innerVisible = ref(false);
// ============================================================================
// state
// ============================================================================
const createInitialForm = () => ({
  id              : null,
  externalStaffNo     : '',
  doctorName      : '',
  addDoctorName   : '',
  memberYn: 'N',
  memberNo: null,
  customerRefId    : null,
  patientName     : '',
  patientPhone    : '',
  memo            : '',
  serviceGroupId   : null,
  serviceItemId      : null,
  dateStr         : '',
  startTimeStr    : '',
  endTimeStr      : '',
  startDate       : '',
  endDate         : ''
});

const createInitialTried = () => ({
  formSubmit: false,
});

const createInitialValidationState = () => ({
  formSubmit: {
    doctorName  : {ok: true, message: '', placeholder: '담당의사명을 입력해주세요.'},
    patientName : {ok: true, message: '', placeholder: '고객명을 입력해주세요.'},
    patientPhone: {ok: true, message: '', placeholder: '고객 전화번호를 입력해주세요. 예) 01012345678'},
    dateStr     : {ok: true, message: ''},
    startTimeStr: {ok: true, message: ''},
    endTimeStr  : {ok: true, message: ''},
    memo        : {ok: true, message: '', placeholder: '서비스 내용을 입력해주세요. 예) 첫 방문 상담'},
  },
});

const form = ref(createInitialForm());
const tried = ref(createInitialTried());
const invalidFields = ref({});
const validationState = ref(createInitialValidationState());

// ============================================================================
// 일시 관련 이벤트
// ============================================================================
const baseDateStr = ref('');
const baseTimeStr = ref('');

/* 팝업을 연 순간의 슬롯(일자·시작시각·의사) — 저장 시 운영시간 재검사의 기준점. */
const openedSlot = ref(null);

/* 이 팝업이 띄운 다이얼로그(alert/confirm)가 떠 있는 동안 true — 호출은 전부 withDialog 를 지난다.
 * ★이 팝업은 hide-on-outside-click 이라, 확인 대화상자의 버튼 클릭이 "바깥 클릭"으로 잡혀
 *   @hiding → handleClose → resetFormState 가 돌아버린다. 그러면 [확인]을 눌러도 form 이
 *   비워진 뒤 payload 가 만들어져 저장이 실패하고, [취소]를 눌러도 수정 화면이 사라진다.
 *   다이얼로그가 떠 있는 동안에는 바깥 클릭 닫힘을 끈다(진료항목 설정 팝업과 같은 useDialogGuard). */
const {dialogOpen, withDialog} = useDialogGuard();

const startDate = computed(() => mergeDateTime(form.value.dateStr, form.value.startTimeStr));
const endDate = computed(() => mergeDateTime(form.value.dateStr, form.value.endTimeStr));

// EDIT 은 과거 날짜도 선택 가능(지난 예약의 일자 보정). ADD 만 오늘 이후로 제한.
const minSelectableDate = computed(() => isEditMode.value ? null : dayjs().startOf('day').toDate());
// 진료 화면: 오늘까지만 선택 가능
const maxSelectableDate = computed(() => isTreatmentMode.value ? dayjs().endOf('day').toDate() : null);
const yearRange = computed(() => {
  return datePickerYearRange(0, 11);
});

function nowFloorMinutes() {
  const now = dayjs();
  const m = now.hour() * 60 + now.minute();
  return Math.floor(m / STEP_MIN) * STEP_MIN;
}

// 시간 문자열 연산·옵션 규칙은 reservationTimeRules(순수함수) — 보드 저장 경로와 계약 테스트로 묶인다.

function isTodayDate(dateStr) {
  return dateStr && dayjs(dateStr, DEFAULT_DATE_FORMAT).isSame(dayjs(), 'day');
}

function isLastStartSlot(value) {
  return IS_END_TIME_FIX && value === '23:30';
}

function toEndMinutes(value) {
  return value === '23:59' ? 24 * 60 - 1 : parseTimeToMinutes(value);
}

function applyBaseTimeLimit(minMinute) {
  if (baseDateStr.value && baseTimeStr.value) {
    if (form.value.dateStr === baseDateStr.value) {
      return Math.max(minMinute, parseTimeToMinutes(baseTimeStr.value));
    }
  }
  return minMinute;
}

const allTimeOptions = computed(() => buildTimeOptions(props.minTime, props.maxTime, STEP_MIN));

const startOptions = computed(() => {
  const opts = allTimeOptions.value;
  if (!opts.length) return opts;

  // 보기 모드
  if (readOnlyMode.value) return opts;

  // 공통 최소(병원 운영 minTime)
  let minMinute = parseTimeToMinutes(props.minTime);

  // =========================
  // EDIT: 현재시각 제한 없음 — 지난 예약을 과거 시각으로 재지정하는 보정을 허용한다.
  //       기존 예약 start(baseTimeStr) 제한도 적용하지 않음.
  // =========================
  if (isEditMode.value) return opts;

  // =========================
  // ADD: 오늘만 제한, 미래는 전체 노출
  // =========================
  const isToday = isTodayDate(form.value.dateStr);

  if (isToday) {
    minMinute = Math.max(minMinute, nowFloorMinutes());
    minMinute = applyBaseTimeLimit(minMinute); // ADD에서만 클릭 셀 기준 제한 유지
  }

  return filterOptionsFromMinute(opts, minMinute);
});

// 시작에 따른 종료 옵션 — 마지막 칸 예외(23:59)까지 reservationTimeRules 의 규칙 그대로.
function getEndOptionsByStart(startStr) {
  return getEndOptions(startStr, allTimeOptions.value, {maxTime: props.maxTime, step: STEP_MIN, isEndTimeFix: IS_END_TIME_FIX});
}

const endOptions = computed(() => {
  const s = form.value.startTimeStr;
  if (!s) return allTimeOptions.value;

  const out = getEndOptionsByStart(s);

  // start가 23:30이면 end는 무조건 23:59 (기존 정책 유지)
  if (isLastStartSlot(s)) return ['23:59'];

  return out;
});

function onChangeStart(value) {
  if (!value) return;
  form.value.startTimeStr = value;

  // start가 23:30이면 end는 무조건 23:59
  if (isLastStartSlot(value)) {
    form.value.endTimeStr = '23:59';
    return;
  }

  const endOpts = getEndOptionsByStart(value);
  const nextEnd = clampToOptions(addMinutes(value, STEP_MIN), endOpts);
  form.value.endTimeStr = nextEnd;
}

function onChangeEnd(value) {
  if (!value) return;

  form.value.endTimeStr = value;

  const s = form.value.startTimeStr;
  if (!s) return;

  const sMin = parseTimeToMinutes(s);
  const eMin = toEndMinutes(value);

  if (eMin < sMin + STEP_MIN) {
    const startOpts = startOptions.value;
    form.value.startTimeStr = clampToOptions(addMinutes(value, -STEP_MIN), startOpts);
  }
}

function mergeDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  return dayjs(`${dateStr} ${timeStr}`, `${DEFAULT_DATE_FORMAT} ${DEFAULT_TIME_FORMAT}`)
      .format(DEFAULT_LOCAL_DATE_TIME);
}

function normalizeTimeRange() {
  if (!allTimeOptions.value.length) return;
  const {start, end} = normalizeTimeStrings(
      form.value.startTimeStr, form.value.endTimeStr, startOptions.value, getEndOptionsByStart,
  );
  form.value.startTimeStr = start;
  form.value.endTimeStr = end;
}

// ============================================================================
// 고객명 관련 이벤트
// ============================================================================
const patientAcRef = ref(null);
const phoneInputRef = ref(null);
const patientSuggestions = ref([]);
const patientDropdownOpen = ref(false);

let patientSearchTimer = null;
const isPickingPatient = ref(false);
const isPickedPatient = ref(false);

// PatientAutocomplete 의 modelValue 변경 → @input → search emit 으로 들어오는 핸들러.
//  - 컴포넌트가 trim 후 minLength 검사 통과한 keyword 만 emit ('' 면 비움 의도).
//  - 빈 keyword: 결과 비우고 dropdown 닫음.
//  - 그 외: 기존 선택(고객 매핑) 해제 + debounce 후 fetch.
// 사양: 이전에 pick 된 고객(isPickedPatient=true) 가 있는 상태에서 고객명을 수정하려는
// 이벤트가 들어오면 전화번호도 함께 비워 새 고객 선택/입력을 유도한다. (pick 으로
// 자동 채워진 phone 이 다른 고객명과 섞이는 회귀 방지)
function onPatientSearch(keyword) {
  if (isPickingPatient.value) return;

  const wasPicked = isPickedPatient.value;

  if (!keyword) {
    form.value.customerRefId = null;
    form.value.memberYn = 'N';
    form.value.memberNo = null;
    if (wasPicked) {
      form.value.patientPhone = '';
      clearFieldError('formSubmit', 'patientPhone');
    }
    patientSuggestions.value = [];
    patientDropdownOpen.value = false;
    clearFieldError('formSubmit', 'patientName');
    if (patientSearchTimer) {
      clearTimeout(patientSearchTimer);
      patientSearchTimer = null;
    }
    return;
  }

  form.value.customerRefId = null;
  form.value.memberYn = 'N';
  form.value.memberNo = null;
  if (wasPicked) {
    form.value.patientPhone = '';
    clearFieldError('formSubmit', 'patientPhone');
  }
  clearFieldError('formSubmit', 'patientName');

  if (patientSearchTimer) clearTimeout(patientSearchTimer);
  patientSearchTimer = setTimeout(async () => {
    await fetchPatientSuggestions(keyword);
    patientDropdownOpen.value = true;
  }, PATIENT_SEARCH_DEBOUNCE_MS);
}

function onPatientBlur() {
  if (patientSearchTimer) {
    clearTimeout(patientSearchTimer);
    patientSearchTimer = null;
  }
}

function onPatientPickItem(p) {
  isPickingPatient.value = true;

  form.value.patientName = String(p.patientName ?? '');
  form.value.customerRefId = p.customerRefId ?? null;
  form.value.memberNo = p.memberNo ?? null;
  form.value.memberYn = form.value.memberNo ? 'Y' : 'N';
  form.value.patientPhone = formatPhoneNumber(p.patientPhone ?? '');

  clearFieldError('formSubmit', 'patientName');
  clearFieldError('formSubmit', 'patientPhone');
  queueMicrotask(() => (isPickingPatient.value = false));

  patientDropdownOpen.value = false;
  patientSuggestions.value = [];

  // Tab 자동선택 후 다음 입력 흐름: 전화번호 input 으로 focus 이동.
  // (자동완성으로 phone 이 채워지면 readonly 가 되어도 focus 가능 → 사용자가
  //  의식적으로 다음 Tab 으로 의사 선택까지 진행하기에 자연스러움)
  nextTick(() => {
    phoneInputRef.value?.focus?.();
  });
}

async function fetchPatientSuggestions(q) {
  const keyword = String(q ?? "").trim();
  if (!keyword) {
    patientSuggestions.value = [];
    return;
  }

  await customerStore.loadCustomer({keyword});
  patientSuggestions.value = (patients.value || []).filter((p) =>
      String(p.patientName ?? '').includes(keyword)
  );
}

// ============================================================================
// 전화번호 관련 이벤트
// ============================================================================
function maxDigitsByPrefix(digits) {
  if (/^(15|16|18)/.test(digits)) return 8;
  if (digits.startsWith('02')) return 10;
  if (/^01[016789]/.test(digits)) return 11;
  if (digits.startsWith('0')) return 11;
  return 11;
}

function normalizePhone(text) {
  let digits = (text ?? '').replace(/\D/g, '');
  const max = maxDigitsByPrefix(digits);
  if (digits.length > max) digits = digits.slice(0, max);
  return formatPhoneNumber(digits);
}

function applyPatientPhone(text) {
  const next = normalizePhone(text);
  form.value.patientPhone = next;
  clearFieldError('formSubmit', 'patientPhone');
}

function onInputPatientPhone(e) {
  if (readOnlyMode.value || isPickedPatient.value) return;
  applyPatientPhone(e.target?.value ?? '');
}

function onPastePatientPhone(e) {
  if (readOnlyMode.value || isPickedPatient.value) return;
  e.preventDefault();

  const input = e.target || null;
  if (!input) return;

  const pasted = e.clipboardData?.getData('text') ?? '';
  const before = input.value ?? '';

  const start = input.selectionStart ?? before.length;
  const end = input.selectionEnd ?? before.length;
  const merged = before.slice(0, start) + pasted + before.slice(end);

  applyPatientPhone(merged, input);
}

function onKeydownPatientPhone(e) {
  if (readOnlyMode.value || isPickedPatient.value) return;
  if (e.ctrlKey || e.metaKey) return;
  if (e.isComposing) return;
  if (e.key === 'Unidentified') return;

  const allowedKeys = [
    'Backspace', 'Delete',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Tab', 'Home', 'End',
    'Enter',
  ];
  if (allowedKeys.includes(e.key)) return;
  if (/^\d$/.test(e.key)) return;

  e.preventDefault();
}

// ============================================================================
// 담당의사 관련 이벤트
// ============================================================================
// 진료 팀 표시 필터 (검색필터와 동일 — 선택 팀 담당자만 담당의사 후보). 이름 통일 key (SF-3c).
const teamDoctors = computed(() => resolveVisibleDoctors(schedulerFilterStore.selectedTeamName, doctors.value, teams.value));
const doctorPage = ref(0);

const showDoctorPager = computed(() => {
  return teamDoctors.value.length > PAGE_SIZE_DOCTOR_ADD_FILTER;
});

const maxDoctorPage = computed(() => {
  return Math.max(0, Math.ceil(teamDoctors.value.length / PAGE_SIZE_DOCTOR_ADD_FILTER) - 1);
});

const visibleDoctors = computed(() => {
  const start = doctorPage.value * PAGE_SIZE_DOCTOR_ADD_FILTER;
  return teamDoctors.value.slice(start, start + PAGE_SIZE_DOCTOR_ADD_FILTER);
});

// 선택 날짜 기준 "휴무"(의사별 휴무/휴무) 의사 id 집합 — getBlockedReason(정오, 의사id) 재사용.
// 의사 옆 "휴무" 라벨용. getBlockedReason 미전달 시 빈 집합(라벨 안 뜸).
const closedDoctorSet = computed(() => {
  const set = new Set();
  if (typeof props.getBlockedReason !== 'function' || !form.value.dateStr) return set;
  const noon = dayjs(form.value.dateStr).hour(12).minute(0).second(0).toDate();
  for (const d of teamDoctors.value) {
    const key = d.id ?? d.text;
    const reason = props.getBlockedReason(noon, key)?.reason;
    if (reason === 'closedDate' || reason === 'closedWeekday') set.add(key);
  }
  return set;
});

// 현재 페이지에 뱃지(비공개/휴무)가 하나라도 있으면 모든 항목에 뱃지 줄을 확보한다.
// 뱃지가 붙은 항목만 높아지면 나머지 이름칸이 세로 중앙 정렬에 밀려 한 줄로 안 맞는다.
const hasDoctorBadgeRow = computed(() =>
    visibleDoctors.value.some(
        (d) => d.openYn === 'N' || closedDoctorSet.value.has(d.id ?? d.text),
    ),
);

function prevDoctor() {
  if (doctorPage.value > 0) doctorPage.value--;
}

function nextDoctor() {
  if (doctorPage.value < maxDoctorPage.value) doctorPage.value++;
}

// ============================================================================
// action handle 관련 이벤트
// ============================================================================
function resetFormState() {
  form.value = createInitialForm();
  tried.value = createInitialTried();
  invalidFields.value = {};
  validationState.value = createInitialValidationState();

  patientSuggestions.value = [];
  patientDropdownOpen.value = false;
  isPickingPatient.value = false;
  isPickedPatient.value = false;
}

function buildSubmitPayload() {
  const start = startDate.value;
  const end = endDate.value;

  // 고를 항목이 하나도 없는 그룹(칩이 disabled)은 저장하지 않는다 — 화면에서 선택할 수 없는 값이
  // DB 에 남는다. 설정에서 항목을 지운 직후처럼 form 에 남아 있을 수 있어 저장 직전에 한 번 더 막는다.
  const grp = serviceItemStore.groups.find((g) => g.serviceGroupId === form.value.serviceGroupId);
  const keepAtcl = form.value.serviceGroupId != null && hasSelectableItems(grp);

  return {
    ...form.value,
    serviceGroupId: keepAtcl ? form.value.serviceGroupId : null,
    serviceItemId   : keepAtcl ? form.value.serviceItemId : null,
    startDate   : start,
    endDate     : end,
    patientPhone: onlyNumber(form.value.patientPhone),
    type        : toType(dataType.value),
  };
}

/* 저장 직전 운영시간 재검사 — 휴무·휴게시간·운영종료면 확인을 받는다.
 *
 * 위 진입 확인(팝업 열 때)은 '클릭한 슬롯'만 본다. 그래서 팝업 안에서 시간을 옮기면
 * 그 안내를 빠져나간다. 편집(EDIT)은 진입 확인 자체가 없어 어떤 시각으로 옮겨도 무안내였다.
 * 드래그·⋮변경 모드는 이미 같은 확인을 하므로(SchedulerV3Page.confirmBlockedMove),
 * 세 경로 중 이 경로만 조용히 나가는 상태였다.
 *
 * 연 시점과 (일자·시작시각·의사)가 같으면 묻지 않는다 — 진입 확인과 겹쳐 두 번 묻게 된다.
 * @returns 저장을 진행해도 되면 true
 */
async function confirmBlockedIfChanged() {
  const snap = openedSlot.value;
  const doctorName = form.value.doctorName?.trim() ?? '';
  const unchanged = snap
      && snap.dateStr === form.value.dateStr
      && snap.startTimeStr === form.value.startTimeStr
      && snap.doctorName === doctorName;
  if (unchanged) return true;

  const start = startDate.value;
  if (!start) return true;

  const reason = props.getBlockedReason?.(dayjs(start), doctorName)?.reason;
  if (!reason || reason === 'none') return true;

  const label = labelBlockedReason(reason) || '운영종료 시간';
  const text = isDayViewMode.value
      ? `해당 시간에 ${doctorName}님은 ${label}입니다.\n예약을 등록하시겠습니까?`
      : `해당 시간은 ${label}입니다.\n예약을 등록하시겠습니까?`;

  return await withDialog(() => dialog.confirm(text, {title: '예약 확인'}));
}

function handleClose() {
  innerVisible.value = false;
  handleCloseDatePickerMenu();
  resetFormState();
  settingPopupVisible.value = false; // D-1: 설정 popup 도 함께 닫힘
  emit('close');
}

// 설정 popup 닫힐 때 form 의 서비스 항목 ID 가 store 에 유효한지 검증.
// 삭제된 경우 해당 선택만 해제(null). memo 는 서비스 항목과 독립이라 항상 보존.
async function onSettingPopupClosed() {
  settingPopupVisible.value = false;
  try {
    await serviceItemStore.load(true);
  } catch (e) {
    // 실패해도 form 상태는 유지
    return;
  }
  const grpId = form.value.serviceGroupId;
  const itemId = form.value.serviceItemId;
  if (grpId == null) return;

  const grp = serviceItemStore.groups.find((g) => g.serviceGroupId === grpId);
  // 그룹이 지워졌거나 고를 항목이 하나도 남지 않았으면 그룹까지 해제.
  // 항목 삭제 시 BE 도 참조 예약의 그룹·항목을 함께 지운다(clearBookItemRef) — 화면도 같은 규칙을 따른다.
  if (!grp || !hasSelectableItems(grp)) {
    form.value.serviceGroupId = null;
    form.value.serviceItemId = null;
    return;
  }
  // 고른 항목이 지워졌으면 남은 첫 항목으로 채운다(그룹 선택 시 첫 항목 기본 선택과 같은 규칙).
  if (itemId == null || !grp.items.some((i) => i.serviceItemId === itemId)) {
    form.value.serviceItemId = grp.items[0].serviceItemId;
  }
}

async function handleSave() {
  tried.value.formSubmit = true;

  const ok = await validateFormSubmit();
  if (!ok) return;

  // payload 는 확인을 받기 전에 확정한다 — await 사이에 form 이 초기화돼도 빈 값이 나가지 않게.
  let payload = buildSubmitPayload();

  if (!await confirmBlockedIfChanged()) return;

  tried.value.formSubmit = false;
  emit('save', payload);
}

async function handleModify() {
  tried.value.formSubmit = true;

  const ok = await validateFormSubmit();
  if (!ok) return;

  // payload 는 확인을 받기 전에 확정한다 — await 사이에 form 이 초기화돼도 빈 값이 나가지 않게.
  let payload = buildSubmitPayload();

  if (!await confirmBlockedIfChanged()) return;

  tried.value.formSubmit = false;
  emit('modify', payload);
}

function handleCloseDatePickerMenu() {
  datePickerRef.value?.closeMenu?.();
}

function handleOpenDatePickerMenu(e) {
  if (dateTimeReadOnly.value) return;

  clearFieldError('formSubmit', 'dateStr');
  queueMicrotask(() => e?.toggleMenu?.());
}

// ============================================================================
// validation 관련 이벤트
// ============================================================================
const hasInValidHtmlTag = computed(() => hasBlockedHtmlTag(form.value.memo?.trim()));
const memoLength = computed(() => String(form.value.memo ?? '').length);

// height:'auto' 라 열려 있는 동안 콘텐츠가 늘거나 줄어도 UiModal 은 flex 중앙 정렬이라 다시 잡을 위치가 없다.
// 버튼 색(canSubmit)과 저장 게이트(validateFormSubmit)가 같은 판정을 보게 한다 — 갈리면 회색인데 저장된다.
const isTreatmentItemSelected = computed(() => isTreatmentItemSelectionValid(
    serviceItemStore.groups,
    form.value.serviceGroupId,
    form.value.serviceItemId,
));

const canSubmit = computed(() => {
  if (readOnlyMode.value) return true;
  if (!form.value.dateStr) return false;
  if (!form.value.startTimeStr) return false;
  if (!form.value.endTimeStr) return false;

  if (!form.value.patientName?.trim()) return false;

  const phone = form.value.patientPhone?.trim();
  if (!phone) return false;
  if (!isValidPhoneNumber(phone)) return false;

  if (!form.value.doctorName?.trim()) return false;
  if (form.value.memo?.trim() && hasInValidHtmlTag.value) return false;

  if (!isTreatmentItemSelected.value) return false;

  return true;
});

function onFormPointerDown(e) {
  if (readOnlyMode.value) return;
  const current = e.target?.closest?.('[data-scope][data-field]');
  if (!current) return;

  const scope = current.getAttribute('data-scope');
  const field = current.getAttribute('data-field');
  if (!scope || !field) return;

  clearFieldError(scope, field);
}

function setFieldError(scope, field, ok, message = '') {
  const st = validationState.value?.[scope]?.[field];
  if (!st) return;

  st.ok = ok;
  st.message = message;

  const key = `${scope}.${field}`;
  if (!ok) {
    invalidFields.value[key] = true;
  } else {
    delete invalidFields.value[key];
  }
}

function clearFieldError(scope, field) {
  const st = validationState.value?.[scope]?.[field];
  if (!st) return;

  st.ok = true;
  st.message = '';

  delete invalidFields.value[`${scope}.${field}`];
}

function validateDateStr() {
  // 날짜
  if (!form.value.dateStr) {
    setFieldError('formSubmit', 'dateStr', false, '예약 날짜를 선택해주세요.');
    return false;
  }
  setFieldError('formSubmit', 'dateStr', true, '');
  return true;
}

function validateStartTimeStr() {
  // 시작시간
  if (!form.value.startTimeStr) {
    setFieldError('formSubmit', 'startTimeStr', false, '시작 시간을 선택해주세요.');
    return false;
  }
  setFieldError('formSubmit', 'startTimeStr', true, '');
  return true;
}

function validateEndTimeStr() {
  // 종료시간
  if (!form.value.endTimeStr) {
    setFieldError('formSubmit', 'endTimeStr', false, '종료 시간을 선택해주세요.');
    return false;
  }
  setFieldError('formSubmit', 'endTimeStr', true, '');
  return true;
}

function validatePatientName() {
  // 고객명
  const patientName = form.value.patientName?.trim();
  if (!patientName) {
    setFieldError('formSubmit', 'patientName', false, '고객명을 입력해주세요.');
    return false;
  }
  setFieldError('formSubmit', 'patientName', true, '');
  return true;
}

function validatePatientPhone() {
  if (readOnlyMode.value) return true;
  if (isPickedPatient.value) return true;

  // 전화번호
  const patientPhone = form.value.patientPhone?.trim();
  if (!patientPhone) {
    setFieldError('formSubmit', 'patientPhone', false, '전화번호를 입력해주세요.');
    return false;
  } else if (!isValidPhoneNumber(patientPhone)) {
    setFieldError('formSubmit', 'patientPhone', false, '전화번호 형식이 올바르지 않습니다.');
    return false;
  }
  setFieldError('formSubmit', 'patientPhone', true, '');
  return true;
}

function validateDoctorName() {
  // 담당의사
  const doctorName = form.value.doctorName?.trim();
  if (!doctorName) {
    setFieldError('formSubmit', 'doctorName', false, '담당의사를 선택해주세요.');
    return false;
  }
  setFieldError('formSubmit', 'doctorName', true, '');
  return true;
}

async function validateFormSubmit() {
  let ok = true;
  ok = validateDateStr() && ok;
  ok = validateStartTimeStr() && ok;
  ok = validateEndTimeStr() && ok;
  ok = validatePatientName() && ok;
  ok = validatePatientPhone() && ok;
  ok = validateDoctorName() && ok;
  // 진료항목은 입력칸이 없어 다른 필드처럼 테두리로 알릴 수 없다 → alert 로 안내.
  if (!isTreatmentItemSelected.value) {
    await withDialog(() => dialog.alert(TREATMENT_ITEM_REQUIRED_MSG, {title: '진료항목 선택'}));
    ok = false;
  }
  return ok;
}

watch(
    () => props.visible,
    (v) => {
      if (!v) handleClose();
    }
);

// ReservationPopup 노출 시 메인 컨텐츠(스케줄러 그리드)의 스크롤 차단.
// DxPopup shading 만으로는 wheel / space-bar 등 키 스크롤이 차단되지 않아
// 뒤쪽 컨텐츠가 움직이는 회귀(2026-05-26).
// ⚠️ html/body 에 overflow:hidden 을 걸지 않는다. body 가 스크롤 컨테이너가 되면
//   스케줄러 sticky 헤더의 scrollport 가 바뀌어 헤더가 static 위치(화면 밖 보드 최상단)로
//   돌아가 사라진다 — 팝업 여닫을 때 헤더가 깜빡이던 원인.
//   문서는 스크롤 가능한 채로 두고, 스크롤을 유발하는 이벤트만 막는다.
const SCROLL_KEYS = new Set([
  ' ', 'Spacebar', 'PageUp', 'PageDown', 'Home', 'End',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** target 에서 위로 올라가며 실제 스크롤 가능한 조상을 찾는다(문서 자신은 제외). 없으면 null. */
function findScrollableAncestor(start) {
  let el = start instanceof Element ? start : null;

  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el);

    if (['auto', 'scroll'].includes(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
    if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth) return el;
    el = el.parentElement;
  }
  return null;
}

function isEditableTarget(el) {
  if (!(el instanceof Element)) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

// 팝업 내부의 자체 스크롤 영역(셀렉트 목록 등)은 그대로 두고, 문서로 흘러가는 것만 막는다.
function onBlockScrollEvent(e) {
  if (findScrollableAncestor(e.target)) return;
  if (e.cancelable) e.preventDefault();
}

function onBlockScrollKey(e) {
  if (!SCROLL_KEYS.has(e.key)) return;
  if (isEditableTarget(e.target)) return;
  if (findScrollableAncestor(e.target)) return;
  if (e.cancelable) e.preventDefault();
}

function lockBodyScroll() {
  window.addEventListener('wheel', onBlockScrollEvent, {capture: true, passive: false});
  window.addEventListener('touchmove', onBlockScrollEvent, {capture: true, passive: false});
  window.addEventListener('keydown', onBlockScrollKey, {capture: true});
}
function unlockBodyScroll() {
  window.removeEventListener('wheel', onBlockScrollEvent, {capture: true});
  window.removeEventListener('touchmove', onBlockScrollEvent, {capture: true});
  window.removeEventListener('keydown', onBlockScrollKey, {capture: true});
}
watch(
    () => props.visible,
    (v) => {
      if (v) lockBodyScroll();
      else unlockBodyScroll();
    },
    {immediate: true},
);
onBeforeUnmount(unlockBodyScroll);

watch(
    () => [props.visible, props.payload, props.isDayOff],
    async ([visible, p, off]) => {
      if (!visible) return;

      const clickStart = p?.startDateTime ? dayjs(p.startDateTime) : null;
      const clickEnd = p?.endDateTime ? dayjs(p.endDateTime) : null;
      const isEditReservation = !!p?.id;
      // ⚠️ 반드시 의사 id(=doctorRules 키, name 모드에선 정규화 이름)를 함께 넘긴다.
      //   생략하면 getBlockedReason 이 의사룰을 못 찾아 기관(hospital)으로 fallback →
      //   기관이 그 요일 미설정이면 의사는 운영시간인데도 'outsideHours'(운영종료)로 오판.
      //   p.doctorName = 클릭한 컬럼의 resourceLabel = 의사키(그리드 getReason 이 넘기는 col.resourceId 와 동일).
      const blockReason = props.getBlockedReason?.(clickStart, p?.doctorName);

      if (!isEditReservation) {
        if (off) {
          const text = isDayViewMode.value
              ? `해당 시간에 ${p?.doctorName}님은 휴무입니다.\n예약을 등록하시겠습니까?`
              : `해당 시간은 휴무입니다.\n예약을 등록하시겠습니까?`;

          const ok = await withDialog(() => dialog.confirm(text, {title: '예약 확인'}));

          if (!ok) {
            handleClose();
            return;
          }
        } else if (['lunch', 'dinner', 'blockedTime', 'outsideHours'].includes(blockReason?.reason)) {
          const label = labelBlockedReason(blockReason?.reason);

          const text = isDayViewMode.value
              ? `해당 시간에 ${p?.doctorName}님은 ${label}입니다.\n예약을 등록하시겠습니까?`
              : `해당 시간은 ${label || '운영종료 시간'}입니다.\n예약을 등록하시겠습니까?`;

          const ok = await withDialog(() => dialog.confirm(text, {title: '예약 확인'}));

          if (!ok) {
            handleClose();
            return;
          }
        }
      }

      innerVisible.value = true;

      tried.value = createInitialTried();
      invalidFields.value = {};
      validationState.value = createInitialValidationState();


      // base는 clickStart 우선, 없으면 now 스냅
      const base = clickStart ?? dayjs();
      const baseMin = base.minute();
      const snapped = base.minute(floorToStep(baseMin, STEP_MIN)).second(0).millisecond(0);

      baseDateStr.value = snapped.format(DEFAULT_DATE_FORMAT);
      baseTimeStr.value = snapped.format(DEFAULT_TIME_FORMAT);

      const s = clickStart ?? snapped;
      const e = clickEnd ?? s.add(STEP_MIN, 'minute');

      /* 저장 시점 재검사의 기준점 — 팝업을 연 순간의 (일자, 시작시각, 의사).
       * 위 진입 확인은 '연 시각'만 보므로, 팝업 안에서 시간을 휴게시간대로 바꿔 저장하면
       * 아무 안내 없이 나간다. 저장 때 이 기준과 달라졌으면 다시 확인한다(confirmBlockedIfChanged). */
      openedSlot.value = {
        dateStr     : s.format(DEFAULT_DATE_FORMAT),
        startTimeStr: s.format(DEFAULT_TIME_FORMAT),
        doctorName  : p?.doctorName ?? '',
      };

      if (!isEditMode.value) {
        // ADD / VIEW
        form.value = {
          ...createInitialForm(),
          dateStr     : s.format(DEFAULT_DATE_FORMAT),
          startTimeStr: s.format(DEFAULT_TIME_FORMAT),
          endTimeStr  : e.format(DEFAULT_TIME_FORMAT),
          doctorName  : p?.doctorName ?? '',
        };
        normalizeTimeRange();
        return;
      }

      // EDIT
      form.value = {
        id              : p?.id ?? null,
        doctorName      : p?.doctorName ?? '',
        customerRefId    : p?.customerRefId ?? null,
        patientName     : p?.patientName ?? '',
        patientPhone    : formatPhoneNumber(p?.patientPhone),
        memo            : p?.memo ?? '',
        serviceGroupId   : p?.serviceGroupId ?? null,
        serviceItemId      : p?.serviceItemId ?? null,
        dateStr         : s.format(DEFAULT_DATE_FORMAT),
        startTimeStr    : s.format(DEFAULT_TIME_FORMAT),
        endTimeStr      : e.format(DEFAULT_TIME_FORMAT),
        memberYn: p?.memberYn ?? 'N',
        memberNo: p?.memberNo ?? null,
        startDate       : null,
        endDate         : null,
      };

      normalizeTimeRange();
    },
    {immediate: true}
);

watch(
    () => form.value.doctorName,
    (selected) => {
      if (!selected) {
        return;
      }

      const findDoctorId =
          doctors.value.find(x => x.text === selected)?.id ?? '';
      form.value.externalStaffNo = findDoctorId ? String(findDoctorId) : '';

      // 페이지 계산은 실제 노출 목록(teamDoctors=팀 표시 필터)을 기준으로 (SF-3c 정합)
      const idx = teamDoctors.value.findIndex(d => d.text === selected);
      if (idx < 0) return;

      const page = Math.floor(idx / PAGE_SIZE_DOCTOR_ADD_FILTER);
      doctorPage.value = page;
    },
    {immediate: true}
);

// patientSuggestions 갱신 → 결과 유무와 무관하게 dropdown 노출
//  - 결과 0건이어도 noDataText 노출용으로 열어둔다 (PatientAutocomplete 자체 처리).
//  - keyword 입력이 비어있으면 onPatientSearch 가 직접 닫는다.
watch(
    () => patientSuggestions.value.length,
    () => {
      const hasQuery = !!form.value.patientName?.trim();
      patientDropdownOpen.value = hasQuery;
    }
);

watch(
    () => form.value.customerRefId,
    (v) => {
      isPickedPatient.value = !!v;
    },
    {immediate: true}
);

watch(
    () => [form.value.dateStr, isEditMode.value],
    () => {
      if (!props.visible) return;
      // 현재 startTimeStr가 startOptions에 없으면만 보정
      if (form.value.startTimeStr && !startOptions.value.includes(form.value.startTimeStr)) {
        form.value.startTimeStr = startOptions.value[0] ?? '';
        form.value.endTimeStr = getEndOptionsByStart(form.value.startTimeStr)[0] ?? '';
      }
    },
    {deep: false}
);
</script>

<template>
  <UiModal
      :height="effectiveHeight"
      :hide-on-outside-click="!settingPopupVisible && !dialogOpen"
      :title="popupTitle"
      :visible="innerVisible"
      :width="width"
      wrapper-class="schedulePopup"
      @hiding="handleClose"
  >
    <template #titleExtra>
      <div class="popupTitleBadgeGroup">
        <span v-show="headerBadgeText" :class="toStatusClassName(displayStatus)"
              class="popupTitleBadge">{{ headerBadgeText }}</span>
        <span v-show="isExternalSyncBadge"
              class="popupTitleBadge popupTitleBadge--external-sync">EXT</span>
      </div>
    </template>
    <div class="schedulePopup__body">
      <div :data-readonly="readOnlyMode" class="schedulePopupForm" @pointerdown.capture="onFormPointerDown">
        <div class="schedulePopupForm__label">일시</div>
        <div class="schedulePopupForm__datetime">
          <VueDatePicker
              ref="datePickerRef"
              v-model="form.dateStr"
              :auto-apply="true"
              :class="dateTimeUiClassName"
              :clearable="false"
              :enable-time-picker="false"
              :formats="{ input: 'yyyy-MM-dd' }"
              :hide-input="false"
              :input-class-name="'scheduleField scheduleField--date'"
              :min-date="minSelectableDate"
              :max-date="maxSelectableDate"
              :teleport="true"
              :time-config="{ enableTimePicker: false }"
              :year-range="yearRange"
              model-type="yyyy-MM-dd"
          >
            <template #dp-input="slotProps">

              <div
                  :class="dateTimeUiClassName"
                  :data-invalid="tried.formSubmit && !validationState?.formSubmit?.dateStr?.ok"
                  class="scheduleField scheduleField--date"
                  data-field="dateStr"
                  data-scope="formSubmit"
                  @click.stop="handleOpenDatePickerMenu(slotProps)">
                <span>{{ slotProps?.value || '예약날짜 선택' }}</span>
              </div>
            </template>
          </VueDatePicker>

          <UiTimeSelect
              v-model="form.startTimeStr"
              :invalid="tried.formSubmit && !validationState?.formSubmit?.startTimeStr?.ok"
              :max-height="210"
              :options="startOptions"
              :readonly="dateTimeReadOnly"
              data-field="startTimeStr"
              data-scope="formSubmit"
              @update:modelValue="(v) => { clearFieldError('formSubmit','startTimeStr'); onChangeStart(v); }"
          />

          <span class="schedulePopupForm__tilde">~</span>

          <UiTimeSelect
              v-model="form.endTimeStr"
              :invalid="tried.formSubmit && !validationState?.formSubmit?.endTimeStr?.ok"
              :max-height="210"
              :options="endOptions"
              :readonly="dateTimeReadOnly"
              data-field="endTimeStr"
              data-scope="formSubmit"
              @update:modelValue="(v) => { clearFieldError('formSubmit','endTimeStr'); onChangeEnd(v); }"
          />
        </div>

        <div class="schedulePopupForm__label">
          고객명<span class="is-required"> *</span>
        </div>
        <div class="schedulePatientSearch">
          <PatientAutocomplete
              ref="patientAcRef"
              v-model="form.patientName"
              v-model:open="patientDropdownOpen"
              :class="uiModeClassName"
              :data-field="'patientName'"
              :data-scope="'formSubmit'"
              :invalid="tried.formSubmit && !validationState?.formSubmit?.patientName?.ok"
              :is-picking="isPickingPatient"
              :items="patientSuggestions"
              :placeholder="validationState?.formSubmit?.patientName?.placeholder"
              :readonly="readOnlyMode"
              @blur="onPatientBlur"
              @pick="onPatientPickItem"
              @search="onPatientSearch"
          />
        </div>

        <!-- 전화번호 -->
        <div class="schedulePopupForm__label">
          전화번호<span class="is-required"> *</span>
        </div>
        <input
            ref="phoneInputRef"
            :data-invalid="tried.formSubmit && !validationState?.formSubmit?.patientPhone?.ok"
            :disabled="readOnlyMode"
            :placeholder="validationState?.formSubmit?.patientPhone?.placeholder"
            :readonly="readOnlyMode || isPickedPatient"
            :value="form.patientPhone"
            autocomplete="tel"
            class="scheduleField"
            data-field="patientPhone"
            data-scope="formSubmit"
            inputmode="numeric"
            type="tel"
            @input="onInputPatientPhone"
            @keydown="onKeydownPatientPhone"
            @paste="onPastePatientPhone"
            @blur.stop="validatePatientPhone"
        >

        <!-- 의사 -->
        <div class="schedulePopupForm__label">
          담당의사<span class="is-required"> *</span>
          <!-- 의사 추가 UI 는 제거했다 — 담당자 등록·수정은 사업장 설정가 소유한다. -->
        </div>
        <div class="doctorSection">

          <!-- 의사 목록 라디오 버튼 -->
          <div class="doctorRadioList doctorRadioList--inline" data-field="doctor">
            <!-- Prev Arrow -->
            <button
                :class="{ 'is-hidden': !showDoctorPager }"
                :disabled="!showDoctorPager || doctorPage === 0"
                class="doctorRadioList__arrow"
                type="button"
                @click="prevDoctor"
            >
              ‹
            </button>
            <label
                v-for="item in visibleDoctors"
                :key="item.id ?? item.text"
                class="doctorRadioItem"
            >
              <!-- 비공개/휴무 뱃지 — 가로 나열(1줄 고정). 2개여도 행 높이 불변 → 팝업 bottom margin 보존.
                   한 명이라도 뱃지가 있으면 모든 항목에 빈 뱃지 줄을 확보한다(이름칸 수평 유지). -->
              <span v-if="hasDoctorBadgeRow" class="doctorRadioItem__badges">
                <span v-if="item.openYn === 'N'" class="doctorRadioItem__private">비공개</span>
                <span v-if="closedDoctorSet.has(item.id ?? item.text)" class="doctorRadioItem__dayoff">휴무</span>
              </span>
              <span
                  :class="{ 'is-selected': form.doctorName === item.text }"
                  class="doctorRadioItem__main"
              >
                <input
                    v-model="form.doctorName"
                    :value="item.text"
                    name="doctorRadio"
                    type="radio"
                >
                <span class="doctorRadioItem__text">{{ item.text }}</span>
              </span>
            </label>
            <!-- Next Arrow -->
            <button
                :class="{ 'is-hidden': !showDoctorPager }"
                :disabled="!showDoctorPager || doctorPage === maxDoctorPage"
                class="doctorRadioList__arrow doctorRadioList__arrow--next"
                type="button"
                @click="nextDoctor"
            >
              ›
            </button>
          </div>
        </div>

        <!-- 서비스 내용 (Memo) -->
        <div class="schedulePopupForm__label schedule-popup-form__label--treatment">
          <span>서비스 내용</span>
          <!-- 디자인상 설정 버튼은 서비스 내용 라벨 아래에 배치한다. -->
          <button
              v-if="!legacyMemoMode"
              aria-label="서비스 항목 설정"
              class="tcs-settingBtn"
              type="button"
              @click="settingPopupVisible = true"
          >⚙</button>
          <div v-if="legacyMemoMode" class="schedulePopupForm__count">
            {{ memoLength }}/{{ MEMO_MAX_LENGTH }}
          </div>
        </div>
        <div v-if="legacyMemoMode">
          <textarea
              v-model="form.memo"
              :maxlength="MEMO_MAX_LENGTH"
              :placeholder="validationState?.formSubmit?.memo?.placeholder"
              class="scheduleField"
              data-field="memo"
              data-scope="formSubmit"
              style="height: 80px; resize: none; padding-top: 8px;"
          />
          <span v-if="hasInValidHtmlTag" class="schedulePopupForm__error">
            ⚠ 사용할 수 없는 형식이 포함되어 있습니다. (ex. '&lt;', '&gt;' 등)
          </span>
        </div>
        <TreatmentContentSelector
            v-else
            v-model="form.memo"
            v-model:group-id="form.serviceGroupId"
            v-model:item-id="form.serviceItemId"
            :active="innerVisible"
            :max-length="MEMO_MAX_LENGTH"
            :default-first-group="!isEditMode"
            @open-setting="settingPopupVisible = true"
        />
      </div>

      <TreatmentItemSettingPopup
          v-if="!legacyMemoMode"
          :visible="settingPopupVisible"
          anchor-selector=".schedulePopup .uiModal__content"
          @close="onSettingPopupClosed"
      />

      <div class="schedulePopupActions">
        <button class="btn-action" type="button" @click="handleClose">취소</button>

        <!-- 필수값 미입력이어도 클릭은 받는다 — handleSave/handleModify 가 tried 를 켜고
             validateFormSubmit 으로 "고객명을 입력해주세요" 등 안내를 띄운 뒤 저장을 중단한다.
             비활성이면 안내를 볼 방법이 없어 사용자가 무엇이 빠졌는지 알 수 없다.
             비활성은 저장 요청이 나가 있는 동안(saving)에만 건다 — 연타로 두 번 등록되는 것을 막는다. -->
        <button
            v-if="!isEditMode && !readOnlyMode"
            :class="{ 'is-incomplete': !canSubmit }"
            :disabled="saving"
            class="btn-action btn-primary"
            type="button"
            @click="handleSave"
        >
          등록
        </button>

        <button
            v-else
            :class="{ 'is-incomplete': !canSubmit }"
            :disabled="saving"
            class="btn-action btn-primary"
            type="button"
            @click="handleModify"
        >
          수정
        </button>
      </div>
      <!--      <div v-if="!readOnlyMode" class="schedulePopupActions">-->
      <!--        <button class="btn-action" type="button" @click="handleClose">닫기</button>-->
      <!--      </div>-->
    </div>
  </UiModal>
</template>

<style lang="scss" scoped>
@use '@/scss/variables' as *;

/* =========================
 * doctor pager
 * ========================= */
.doctorRadioList--inline {
  position: relative;
  display: flex;
  flex-wrap: nowrap !important;
  /* 화살표와 담당의사 항목을 같은 세로 중앙에 정렬한다. */
  align-items: center;
  /* 의사 버튼 간격은 6px, 좌우 화살표와의 간격은 개별 margin으로 12px을 유지한다. */
  gap: 6px;
}

.doctorRadioList--inline .doctorRadioList__arrow {
  flex: 0 0 auto;
  white-space: nowrap;
}

.doctorRadioList--inline .doctorRadioList__arrow:not(.doctorRadioList__arrow--next) {
  margin-right: 6px;
}

.doctorRadioList--inline .doctorRadioList__arrow--next {
  margin-left: 6px;
}
/* 의사 항목 — 콘텐츠 너비를 유지하고 항목 사이 간격만 고정한다. */
.doctorRadioList--inline .doctorRadioItem {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 담당의사 항목 — 휴무/비공개 라벨을 이름 위(세로)로 배치해 < > 화살표와 겹침 방지.
   align-items: flex-start = 균등 셀(flex:1) 안에서 내용을 좌측 정렬 → 1명만 있는 페이지도 중앙이 아니라 좌측순차로 표기. */
.doctorRadioItem {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.doctorRadioItem__main {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid #BCBCBC;
  border-radius: 4px;
  background: #fff;
  color: #565656;
  cursor: pointer;

  &.is-selected {
    border-color: var(--scheduler-brand, #2F6FED);
    color: var(--scheduler-brand, #2F6FED);
  }

  input[type="radio"] {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    opacity: 0;
  }
}
/* 뱃지 묶음 — 비공개/휴무를 가로로 나란히(1줄 고정). 2개여도 세로로 안 쌓여 행 높이 불변.
   min-height = 뱃지 높이(10px * 1.4). 뱃지 없는 항목도 같은 높이를 차지해 이름칸이 수평을 유지한다. */
.doctorRadioItem__badges {
  display: flex;
  align-items: center;
  gap: 3px;
  min-height: 14px;
}
/* 휴무 라벨 — 이름 위 표기 */
.doctorRadioItem__dayoff {
  padding: 0 5px;
  border-radius: 4px;
  background: #fdecea;
  color: #e53935;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
}
/* 비공개(openYn='N') 라벨 — 휴무와 동일 위치(이름 위), 중립 회색(#1) */
.doctorRadioItem__private {
  padding: 0 5px;
  border-radius: 4px;
  background: #eee;
  color: #888;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
}

.doctorRadioList {
  &__arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;

    width: 20px;
    min-width: 20px;
    height: 20px;

    border: 0;
    background: transparent;
    cursor: pointer;

    font-size: 0;
    color: transparent;

    --arrow-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239e9e9e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");

    background-image: var(--arrow-icon);
    background-repeat: no-repeat;
    background-position: center;
    background-size: 20px 20px;

    &:not(:disabled):hover {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='15 18 9 12 15 6'/%3E%3C/svg%3E");
    }

    &:disabled {
      opacity: 0.2;
      cursor: default;
    }

    &--next {
      /* in-flow flex 자식 — gap:12px 가 적용돼 마지막 항목(미지정)과 ‹ 처럼 대칭 간격. */
      transform: rotate(180deg);
    }

    &.is-hidden {
      visibility: hidden;
      pointer-events: none;
    }
  }
}

/* =========================
 * validation / label
 * ========================= */
/* .scheduleField[data-invalid="true"] 빨간 테두리는 src/scss/schedule/_reservation-popup.scss 의
   공통 필드 규약에 있다 (scoped 에 두면 자식 컴포넌트 내부 input 에 닿지 않는다). */

.schedulePopupForm__count {
  margin-top: 4px;
  font-size: 12px;
  color: #757575;
  text-align: left
}

.schedule-popup-form__label--treatment {
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.schedule-popup-form__label--treatment > span {
  align-self: start;
}

.tcs-settingBtn {
  align-self: start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 16px;
  padding: 0;
  border: 0;
  background-color: #fff;
  cursor: pointer;
  font-size: 0;
  color: transparent;

  --icon-size: 14px;
  --icon-url: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23424242' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3Cpath d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/%3E%3C/svg%3E");

  background-image: var(--icon-url);
  background-repeat: no-repeat;
  background-position: center;
  background-size: var(--icon-size) var(--icon-size);
}

.tcs-settingBtn:active {
  transform: translateY(0.5px);
}

.is-required {
  color: #2F6FED;
  font-weight: 600;
}

.schedulePopupForm__error {
  color: #dc3545;
  font-size: 12px;
  margin-top: 4px;
}

/* =========================
 * VueDatePicker
 * ========================= */
.schedulePopupForm__datetime {
  :deep(.dp__clear_btn),
  :deep(.dp__clear_icon),
  :deep(.dp--clear-btn) {
    display: none !important;
  }
}

/* =========================
 * readonly mode (form-level)
 * ========================= */
/* 기본: readonly면 폼 전체 막기 */
.schedulePopupForm[data-readonly="true"] {
  cursor: default;
  pointer-events: none;
}

/* 예외0: 일시(날짜·시작·종료)는 readonly 상태에서도 편집 가능.
 * 지난 예약·상태 확정 예약의 운영시간 보정을 허용한다(dateTimeReadOnly 참조). */
.schedulePopupForm[data-readonly="true"] .schedulePopupForm__datetime {
  pointer-events: auto;
  cursor: default;
}

/* 예외1: memo textarea만 열기 (V1 legacy 모드) */
.schedulePopupForm[data-readonly="true"] textarea[data-field="memo"] {
  pointer-events: auto;
  cursor: text;
}

/* 예외1-V2: 서비스 내용 영역(TreatmentContentSelector)도 readonly 상태에서 수정 가능.
 * V1 textarea 와 동일하게 그룹/항목 선택 + 직접입력 memo 편집 허용.
 * 진료모드에서 과거 예약 서비스 내용 보정 등의 흐름 지원. */
.schedulePopupForm[data-readonly="true"] .treatmentContentSelector {
  pointer-events: auto;
  cursor: default;
}

/* 진료보기에서도 진료항목 설정 팝업은 열 수 있도록 설정 아이콘만 허용한다. */
.schedulePopupForm[data-readonly="true"] .tcs-settingBtn {
  pointer-events: auto;
  cursor: pointer;
}

/* 예외2: 의사 영역(doctor)만 열기 */
.schedulePopupForm[data-readonly="true"] [data-field="doctor"] {
  pointer-events: auto;
  cursor: default;
}

/* =========================
 * input cursor
 * ========================= */
.scheduleField[readonly] {
  cursor: default;
}

.scheduleField:disabled {
  cursor: not-allowed;
}

/* =========================
 * ui states
 * ========================= */
.ui--disabled {
  opacity: 0.4;
  pointer-events: none;
}

.ui--readonly {
  opacity: 0.6;
}
</style>
