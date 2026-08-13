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
import {datePickerYearRange, toStatusClassName, toType} from '@/utils/schedulerSearchFilterUtils';
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
   * 호출처에서 height 미명시 시 모드별 기본값 사용.
   * legacyMemoMode=true → 460 (textarea 기준)
   * legacyMemoMode=false → 580 (TreatmentContentSelector 추가분 반영)
   */
  height          : {type: Number, default: null},
  getBlockedReason: {type: Function, default: null},
  isDayOff        : {type: Boolean, default: false},
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

// V2 서비스 내용 영역의 항목 칩 행 수 (0/1/2)
//  - 그룹 미선택 또는 항목 0개  → 0행 (칩 영역 없음)
//  - 1~4개                     → 1행
//  - 5~8개 (페이지당 max 8)     → 2행
const v2ItemRows = computed(() => {
  if (props.legacyMemoMode) return 0;
  const grpId = form.value?.serviceGroupId;
  if (!grpId) return 0;
  const grp = serviceItemStore.groups.find((g) => g.serviceGroupId === grpId);
  if (!grp) return 0;
  const onPage = Math.min(grp.items?.length ?? 0, 8);
  if (onPage === 0) return 0;
  return onPage <= 4 ? 1 : 2;
});

// 호출처 명시값이 우선. 없으면 모드별 기본값.
// V2: 서비스 내용 칩 행 수에 따라 가변 (1행/2행/없음).
//   base 500 (그룹바 + memo + 푸터 등 — 의사 등록 row 제거 반영)
//   + 칩 행 1당 약 40px
const effectiveHeight = computed(() => {
  if (props.height != null) return props.height;
  if (props.legacyMemoMode) return 420;
  const rows = v2ItemRows.value;
  if (rows === 0) return 500;
  if (rows === 1) return 540;
  return 580;
});

const emit = defineEmits(['close', 'save', 'modify']);
const MEMO_MAX_LENGTH = 1000;

// ============================================================================
// mode / title
// ============================================================================
const mode = computed(() => (props.payload?.mode === 'EDIT' ? 'EDIT' : 'ADD'));
const isEditMode = computed(() => mode.value === 'EDIT');
const computedDateType = computed(() => dataType.value);
const isDayViewMode = computed(() => viewMode.value === 'DAY');
// 일시(날짜, 시작시간, 종료시간)만 readOnly 적용
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
const uiModeClassName = computed(() => ({
  'ui--readonly': readOnlyMode.value,
  'ui--disabled': false
}));
const headerBadgeText = computed(() => {
  if (props?.payload?.status === '01') return '완료';
  if (props?.payload?.status === '02') return '예약미이행';
  if (props?.payload?.status === '03') return '예약취소';
  return '';
});
/* 외부 시스템 연동 예약 — 'EXT' 뱃지 표시 여부 */
const isExternalSyncBadge = computed(() => props?.payload?.isExternalSync === true);
const datePickerRef = ref(null);
const isShowDoctorAddInput = ref(false);
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
  doctorAdd : false,
  formSubmit: false,
});

const createInitialValidationState = () => ({
  doctorAdd : {
    addDoctorName: {ok: true, message: '', placeholder: '담당의사명을 입력해주세요.'},
  },
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

const startDate = computed(() => mergeDateTime(form.value.dateStr, form.value.startTimeStr));
const endDate = computed(() => mergeDateTime(form.value.dateStr, form.value.endTimeStr));

const minSelectableDate = computed(() => dayjs().startOf('day').toDate());
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

function parseTimeToMinutes(t) {
  const [hh, mm] = String(t).split(':').map(Number);
  return hh * 60 + mm;
}

function minutesToTime(min) {
  const hh = String(Math.floor(min / 60)).padStart(2, '0');
  const mm = String(min % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function addMinutes(timeStr, delta) {
  return minutesToTime(parseTimeToMinutes(timeStr) + delta);
}

function filterOptionsFromMinute(options, minMinute) {
  return options.filter(t => parseTimeToMinutes(t) >= minMinute);
}

function isTodayDate(dateStr) {
  return dateStr && dayjs(dateStr, DEFAULT_DATE_FORMAT).isSame(dayjs(), 'day');
}

function isLastStartSlot(value) {
  return IS_END_TIME_FIX && value === '23:30';
}

function toEndMinutes(value) {
  return value === '23:59' ? 24 * 60 - 1 : parseTimeToMinutes(value);
}

function clampToOptions(timeStr, options) {
  if (!options?.length) return '00:00';
  if (!timeStr) return options[0];

  // 30분 단위 내림(floor): target 이하에서 가장 가까운 옵션 선택
  const target = parseTimeToMinutes(timeStr);
  let best = options[0];

  for (const t of options) {
    const tMin = parseTimeToMinutes(t);
    if (tMin <= target) {
      best = t;
    } else {
      break; // options가 오름차순이므로 초과하면 중단
    }
  }
  return best;
}

function applyBaseTimeLimit(minMinute) {
  if (baseDateStr.value && baseTimeStr.value) {
    if (form.value.dateStr === baseDateStr.value) {
      return Math.max(minMinute, parseTimeToMinutes(baseTimeStr.value));
    }
  }
  return minMinute;
}

const allTimeOptions = computed(() => {
  const min = parseTimeToMinutes(props.minTime);
  const max = parseTimeToMinutes(props.maxTime);
  if (Number.isNaN(min) || Number.isNaN(max)) return [];
  if (min > max) return [];

  const out = [];
  for (let m = min; m <= max; m += STEP_MIN) out.push(minutesToTime(m));
  return out;
});

const startOptions = computed(() => {
  const opts = allTimeOptions.value;
  if (!opts.length) return opts;

  // 보기 모드
  if (readOnlyMode.value) return opts;

  // 공통 최소(병원 운영 minTime)
  let minMinute = parseTimeToMinutes(props.minTime);

  // =========================
  // EDIT: 오늘이면 현재시각 슬롯(nowFloor)부터만
  // =========================
  if (isEditMode.value) {
    const isToday = isTodayDate(form.value.dateStr);

    if (isToday) {
      // 16:09 -> nowFloorMinutes() = 16:00
      minMinute = Math.max(minMinute, nowFloorMinutes());
    }

    // 기존 예약 start(baseTimeStr) 제한은 적용하지 않음
    return filterOptionsFromMinute(opts, minMinute);
  }

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

function getEndOptionsByStart(startStr) {
  const opts = allTimeOptions.value;
  if (!startStr) return opts;

  const sMin = parseTimeToMinutes(startStr);

  // 기본: end >= start + STEP_MIN
  const base = filterOptionsFromMinute(opts, sMin + STEP_MIN);

  if (!IS_END_TIME_FIX) return base;

  // last slot 예외: (maxTime - STEP_MIN) 이상인 start면 23:59도 허용
  // ex) maxTime=23:30, STEP=30 -> threshold=23:00
  const maxMin = parseTimeToMinutes(props.maxTime);
  const threshold = maxMin - STEP_MIN;

  if (sMin >= threshold) {
    // 23:59 추가 (중복 방지)
    if (!base.includes('23:59')) base.push('23:59');
  }

  // 기존 정책 유지: 00:00 제거
  return base.filter(t => t !== '00:00');
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

  const sOpts = startOptions.value;
  if (!sOpts.length) {
    form.value.startTimeStr = '';
    form.value.endTimeStr = '';
    return;
  }

  form.value.startTimeStr = clampToOptions(form.value.startTimeStr, sOpts);

  const eOpts = getEndOptionsByStart(form.value.startTimeStr);
  if (!eOpts.length) {
    form.value.startTimeStr = sOpts[Math.max(0, sOpts.length - 2)];
    const eOpts2 = getEndOptionsByStart(form.value.startTimeStr);
    form.value.endTimeStr = eOpts2[0] ?? '';
    return;
  }

  form.value.endTimeStr = clampToOptions(form.value.endTimeStr, eOpts);

  const sMin = parseTimeToMinutes(form.value.startTimeStr);
  const eMin = parseTimeToMinutes(form.value.endTimeStr);
  if (eMin <= sMin) {
    form.value.endTimeStr = eOpts[0];
  }
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

function prevDoctor() {
  if (doctorPage.value > 0) doctorPage.value--;
}

function nextDoctor() {
  if (doctorPage.value < maxDoctorPage.value) doctorPage.value++;
}

function toggleDoctorAdd() {
  isShowDoctorAddInput.value = !isShowDoctorAddInput.value;
}

async function handleSaveDoctor() {
  tried.value.doctorAdd = true;
  if (!validateAddDoctorName()) return;
  tried.value.doctorAdd = false;

  await staffStore.addDoctorName(form.value.addDoctorName);
  form.value.doctorName = form.value.addDoctorName;
  form.value.addDoctorName = '';
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

  return {
    ...form.value,
    startDate   : start,
    endDate     : end,
    patientPhone: onlyNumber(form.value.patientPhone),
    type        : toType(dataType.value),
  };
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
  if (!grp) {
    // 그룹 삭제됨 → 그룹·항목 모두 해제
    form.value.serviceGroupId = null;
    form.value.serviceItemId = null;
    return;
  }
  if (itemId != null && !grp.items?.some((i) => i.serviceItemId === itemId)) {
    // 항목만 삭제됨 → 항목만 해제(그룹 유지)
    form.value.serviceItemId = null;
  }
}

async function handleSave() {
  tried.value.formSubmit = true;

  const ok = validateFormSubmit();
  if (!ok) return;

  let payload = buildSubmitPayload();

  tried.value.formSubmit = false;
  emit('save', payload);
}

async function handleModify() {
  tried.value.formSubmit = true;

  const ok = validateFormSubmit();
  if (!ok) return;

  let payload = buildSubmitPayload();

  tried.value.formSubmit = false;
  emit('modify', payload);
}

function handleCloseDatePickerMenu() {
  datePickerRef.value?.closeMenu?.();
}

function handleOpenDatePickerMenu(e) {
  if (readOnlyMode.value) return;

  clearFieldError('formSubmit', 'dateStr');
  queueMicrotask(() => e?.toggleMenu?.());
}

// ============================================================================
// validation 관련 이벤트
// ============================================================================
const hasInValidHtmlTag = computed(() => hasBlockedHtmlTag(form.value.memo?.trim()));
const memoLength = computed(() => String(form.value.memo ?? '').length);
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

  // 서비스 항목: 그룹↔상세는 필수 쌍 (둘 다 set 또는 둘 다 null). 한쪽만 set 이면 저장 불가.
  if ((form.value.serviceGroupId == null) !== (form.value.serviceItemId == null)) return false;

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

function validateAddDoctorName() {
  // 의사 추가
  const v = form.value.addDoctorName?.trim();
  if (!v) {
    setFieldError('doctorAdd', 'addDoctorName', false, '의사명을 입력해주세요.');
    return false;
  }
  setFieldError('doctorAdd', 'addDoctorName', true, '');
  return true;
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

function validateFormSubmit() {
  let ok = true;
  ok = validateDateStr() && ok;
  ok = validateStartTimeStr() && ok;
  ok = validateEndTimeStr() && ok;
  ok = validatePatientName() && ok;
  ok = validatePatientPhone() && ok;
  ok = validateDoctorName() && ok;
  return ok;
}

watch(
    () => props.visible,
    (v) => {
      if (!v) handleClose();
    }
);

// ReservationPopup 노출 시 메인 컨텐츠(스케줄러 그리드)의 스크롤 차단.
// 오버레이만으로는 wheel / space-bar 등 키 스크롤이 차단되지 않아
// 뒤쪽 컨텐츠가 움직이는 회귀(2026-05-26). body 와 html 모두 overflow:hidden.
const __popupScrollLockSaved = {bodyOverflow: '', htmlOverflow: ''};
function lockBodyScroll() {
  __popupScrollLockSaved.bodyOverflow = document.body.style.overflow;
  __popupScrollLockSaved.htmlOverflow = document.documentElement.style.overflow;
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  document.body.style.overflow = __popupScrollLockSaved.bodyOverflow;
  document.documentElement.style.overflow = __popupScrollLockSaved.htmlOverflow;
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

          const ok = await dialog.confirm(text, {title: '예약 확인'});

          if (!ok) {
            handleClose();
            return;
          }
        } else if (['lunch', 'dinner', 'blockedTime', 'outsideHours'].includes(blockReason?.reason)) {
          const label = labelBlockedReason(blockReason?.reason);

          const text = isDayViewMode.value
              ? `해당 시간에 ${p?.doctorName}님은 ${label}입니다.\n예약을 등록하시겠습니까?`
              : `해당 시간은 ${label || '운영종료 시간'}입니다.\n예약을 등록하시겠습니까?`;

          const ok = await dialog.confirm(text, {title: '예약 확인'});

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
      const snapped = base.minute(baseMin < 30 ? 0 : 30).second(0).millisecond(0);

      baseDateStr.value = snapped.format(DEFAULT_DATE_FORMAT);
      baseTimeStr.value = snapped.format(DEFAULT_TIME_FORMAT);

      const s = clickStart ?? snapped;
      const e = clickEnd ?? s.add(STEP_MIN, 'minute');

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
        addDoctorName   : '',
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

      isShowDoctorAddInput.value = false;
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

watch(() => isShowDoctorAddInput.value, (v) => {
  if (v === false) {
    form.value.addDoctorName = '';
    setFieldError('doctorAdd', 'addDoctorName', true, '');
  }
});

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
      :hide-on-outside-click="!settingPopupVisible"
      :title="popupTitle"
      :visible="innerVisible"
      :width="width"
      wrapper-class="schedulePopup"
      @hiding="handleClose"
  >
    <template #titleExtra>
      <div class="popupTitleBadgeGroup">
        <span v-show="headerBadgeText" :class="toStatusClassName(props?.payload?.status)"
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
              :class="uiModeClassName"
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
                  :class="uiModeClassName"
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
              :readonly="readOnlyMode"
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
              :readonly="readOnlyMode"
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
          <!-- 의사 추가 토글 버튼 — 사양 변경으로 UI 숨김. 로직(toggleDoctorAdd)은 추후
               기능 복귀 가능성 대비해 보존. -->
          <button
              v-if="false"
              class="btn-basic-micro"
              style="margin-top: 2px;"
              type="button"
              @click.stop="toggleDoctorAdd"
          >
            {{ isShowDoctorAddInput ? '- 등록닫기' : '+ 의사추가' }}
          </button>
        </div>
        <div class="doctorSection">

          <!-- 의사 등록 폼 (Input + Button) — 사양 변경으로 UI 숨김. -->
          <div v-if="false" class="doctorRegisterRow">
            <input
                v-model="form.addDoctorName"
                :data-invalid="tried.doctorAdd && !validationState?.doctorAdd?.addDoctorName?.ok"
                :disabled="!isShowDoctorAddInput"
                :placeholder="validationState?.doctorAdd?.addDoctorName?.placeholder"
                class="scheduleField"
                data-field="addDoctorName"
                data-scope="doctorAdd"
                @keydown.enter.prevent="handleSaveDoctor"
            >
            <button
                :disabled="!isShowDoctorAddInput"
                class="btn-basic"
                type="button"
                @click.stop="handleSaveDoctor"
            >
              등록
            </button>
          </div>

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
              <!-- 비공개/휴무 뱃지 — 가로 나열(1줄 고정). 2개여도 행 높이 불변 → 팝업 bottom margin 보존. -->
              <span
                  v-if="item.openYn === 'N' || closedDoctorSet.has(item.id ?? item.text)"
                  class="doctorRadioItem__badges"
              >
                <span v-if="item.openYn === 'N'" class="doctorRadioItem__private">비공개</span>
                <span v-if="closedDoctorSet.has(item.id ?? item.text)" class="doctorRadioItem__dayoff">휴무</span>
              </span>
              <span class="doctorRadioItem__main">
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
        <div class="schedulePopupForm__label">
          서비스 내용
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

        <button
            v-if="!isEditMode && !readOnlyMode"
            :disabled="!canSubmit"
            class="btn-action btn-primary"
            type="button"
            @click="handleSave"
        >
          등록
        </button>

        <button
            v-else
            :disabled="!canSubmit"
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
  /* 바닥 정렬 — 뱃지(비공개/휴무) 유무·개수와 무관하게 담당자명(main row) line 을 맞춤 */
  align-items: flex-end;
  /* prev ‹ · items · next › 모두 flex 자식 → gap 12px 가 양 끝 화살표에 동일 적용(대칭). next 는 in-flow. */
  gap: 12px;
}

.doctorRadioList--inline .doctorRadioList__arrow {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 의사 항목 — 남는 width 를 균등 분배해 채움(좌측 뭉침·우측 여백 방지) */
.doctorRadioList--inline .doctorRadioItem {
  flex: 1 1 0;
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
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
/* 뱃지 묶음 — 비공개/휴무를 가로로 나란히(1줄 고정). 2개여도 세로로 안 쌓여 행 높이 불변. */
.doctorRadioItem__badges {
  display: flex;
  align-items: center;
  gap: 3px;
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
.scheduleField[data-invalid="true"] {
  border-color: #e54848;
  box-shadow: 0 0 0 2px rgba(229, 72, 72, 0.15);
}

.formFieldError {
  font-size: 12px;
  color: #e54848;
  margin-top: 4px;
}

.schedulePopupForm__count {
  margin-top: 4px;
  font-size: 12px;
  color: #757575;
  text-align: left
}

.is-required {
  color: #e53935;
  margin-left: 2px;
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
