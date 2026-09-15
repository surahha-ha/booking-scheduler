import {defineStore} from 'pinia';
import {markRaw, ref, watch} from 'vue';
import {
    add,
    type ApiResponse,
    type BookDayGroupResponse,
    type BookItem,
    type BookItemRequest,
    get,
    modify,
    remove,
    updateStatus,
} from '@/api/bookApi';
import {toBookApiParams} from '@/mappers/schedulerSearchFilterToApiParams';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {useStaffStore} from '@/stores/staffStore';
import dayjs from 'dayjs';
import {toErrorBody} from '@/utils/apiErrorUtils';
import {extractFirstChars} from '@/utils/formatStringUtils';
import {toStatusClassName, toType} from '@/utils/schedulerSearchFilterUtils';
import {sanitizePersonName} from '@/composables/useAppointmentFormatter';
import {isIntegratedMember} from '@/utils/memberRules';

const returnMessage = '서비스를 이용하기 위해서는\n[운영시간]과 [담당자] 등록이 필요합니다.\n사업장 설정의 등록 화면으로 이동하시겠습니까?';
// 담당자 조회 자체가 실패(일시적 네트워크/서비스 장애)한 경우 — redirect(사업장 설정) 가 아니라 재시도 안내.
const serviceUnavailableMessage = '일시적인 서비스 접근 불가입니다.\n잠시 후에 다시 시도해주세요.';

// 스케줄러 장부 store
export type SchedulerAppointment = {
    id: string;
    tenantId: string;
    startDateTime: Date;
    endDateTime: Date;
    doctorId?: string;
    doctorName: string;
    customerRefId: number;
    memberYn: string;
    memberNo?: number;
    patientName?: string;
    patientPhone?: string;
    status?: string;
    memo?: string;
    /** 서비스 항목 그룹 ID */
    serviceGroupId?: number;
    /** 서비스 항목 ID (직접입력 그룹은 undefined) */
    serviceItemId?: number;
    delYn?: string;
    dayCd?: string;
    dayNm?: string;
    raw: BookItem;

    // 성능용
    startMs: number;
    endMs: number;

    // UI용
    uiDoctor1: string;        // 담당자 1글자
    uiPatient: string;        // 고객명(기본값 포함)
    uiPhone: string;          // 전화번호 포맷
    uiJoin: boolean;          // join 여부
    uiStatusClass: string;    // status class
    isExternalSync: boolean;      // 외부 시스템 연동 여부 — 담당자 뱃지 색상 분기에 사용
    createdAt?: Date;       // 예약 등록일시 — '당일'(오늘 등록) 뱃지 판정
    isTreatmentRegistered: boolean; // 방문장부에서 등록된 건(RESERVATION_USE_TYPE='WORK') — '당일' 뱃지는 이 건에만

    // 카드 표시정보(displayInfo) — 통합회원만 birth/sex, 비회원 빈값
    birthDate?: string | null;       // 생년월일 원본 'yyyy-MM-dd'
    sexDivisionCode?: string | null; // 성별코드 M/F/U
    serviceGroupName?: string | null;   // 서비스 항목 그룹명
    serviceItemName?: string | null;      // 서비스 항목명
    uiBirth: string;          // 생년월일 표시(yyyy-MM-dd, 없으면 '')
    uiAge: string;            // 만나이(없으면 '')
    uiGender: string;         // 성별 라벨(남/여, 없으면 '')
    uiTreatment: string;      // 서비스 항목 표시('그룹 > 항목' 또는 항목명, 없으면 '')
};

// 표시정보 파생 헬퍼
function calcAgeFromBirth(birth?: string | null): string {
    if (!birth) return '';
    const b = dayjs(birth);
    if (!b.isValid()) return '';
    const age = dayjs().diff(b, 'year');
    return age >= 0 ? String(age) : '';
}
function sexCodeToLabel(code?: string | null): string {
    // ITF 성별코드 표기 흔들림(M/MALE/1) 흡수 — UiSearchInput.formatAgeGender 와 인식 범위를 맞춘다.
    const c = String(code ?? '').toUpperCase();
    if (c === 'M' || c === 'MALE' || c === '1') return '남';
    if (c === 'F' || c === 'FEMALE' || c === '2') return '여';
    return '';
}
function buildTreatmentLabel(groupName?: string | null, articleName?: string | null): string {
    if (articleName && groupName) return `${groupName} > ${articleName}`;
    return articleName || groupName || '';
}

function applyBookItemToAppointment(
    target: SchedulerAppointment,
    g: BookDayGroupResponse,
    it: BookItem
) {
    target.tenantId = it.tenantId ?? '';
    target.status = it.statusCode ?? '';
    target.startDateTime = dayjs(it.startAt).toDate();
    target.endDateTime = dayjs(it.endAt).toDate();
    target.doctorId = it.externalStaffNo ? String(it.externalStaffNo) : '';
    target.doctorName = it.staffName ?? '';
    target.customerRefId = it.customerId;
    target.memberYn = it.memberYn ?? 'N';
    target.memberNo = it.memberNo;
    target.patientPhone = it.customerPhone;
    target.patientName = it.customerName;
    target.delYn = it.delYn ?? 'N';
    target.memo = it.memo ?? '';
    target.serviceGroupId = it.serviceGroupId;
    target.serviceItemId = it.serviceItemId;
    // 표시정보 원본(통합회원 birth/sex + 서비스 항목명, 비회원/미지정 null)
    target.birthDate = it.birthDate ?? null;
    target.sexDivisionCode = it.sexDivisionCode ?? null;
    target.serviceGroupName = it.serviceGroupName ?? null;
    target.serviceItemName = it.serviceItemName ?? null;
    target.raw = it;

    // 성능용
    target.startMs = target.startDateTime.getTime();
    target.endMs = target.endDateTime.getTime();

    // UI용
    const dName = sanitizePersonName(target.doctorName);
    target.uiDoctor1 = extractFirstChars(dName, 1); // 예: "김"
    const pName = target.patientName ?? '예약';
    const pDigits = (target.patientPhone ?? '').replace(/\D/g, '');
    const last4 = pDigits.length >= 4 ? pDigits.slice(-4) : '';
    target.uiPatient = last4 ? `${pName}(${last4})` : pName;
    // target.uiPhone = formatPhoneNumber(target.patientPhone ?? '');
    target.uiJoin = isIntegratedMember(target);
    target.uiStatusClass = toStatusClassName(target.status);
    target.isExternalSync = it.externalYn === 'Y';
    target.createdAt = it.createdAt ? dayjs(it.createdAt).toDate() : undefined;
    target.isTreatmentRegistered = it.registeredFrom === 'WORK';
    // 표시정보 파생(생년월일/만나이/성별/서비스 항목)
    target.uiBirth = it.birthDate ?? '';
    target.uiAge = calcAgeFromBirth(it.birthDate);
    target.uiGender = sexCodeToLabel(it.sexDivisionCode);
    target.uiTreatment = buildTreatmentLabel(it.serviceGroupName, it.serviceItemName);
}

export const useBookStore = defineStore('bookStore', () => {
    const schedulerFilterStore = useSchedulerFilterStore();
    const staffStore = useStaffStore();

    const pending = ref(false);

    const responseData = ref<BookDayGroupResponse[]>([]);

    const appointments = ref<SchedulerAppointment[]>([]);
    const apptById = new Map<string, SchedulerAppointment>();

    function unwrapBody<T>(res: any): ApiResponse<T> {
        return (res as any).data ?? res;
    }


    // 응답 payload를 appointments로 동기화 (객체 참조 최대한 재사용).
    // ⚠️ 예약 객체는 markRaw(비반응형) — 반응형 객체에 필드를 하나씩 대입하면 대입마다 반응성
    //    트리거가 발화한다. dev 에서 pinia devtools 가 스토어에 sync deep 구독을 걸므로
    //    트리거 1회 = $state 전체 재귀순회(traverse)가 되어 N건 × 30필드 = O(N²) 폭발,
    //    페이징 1회에 main 스레드가 90초+ 점유되는 실측 사고가 있었다. 전량 교체 + 전량
    //    재계산(layout) 구조라 필드 단위 반응성은 필요 없다 — 커밋은 아래 배열 교체 1회가 담당.
    function upsertAppointments(payload: BookDayGroupResponse[]) {
        const nextList: SchedulerAppointment[] = [];
        const nextIds = new Set<string>();

        for (const g of payload ?? []) {
            for (const it of g.items ?? []) {
                const id = String(it.reservationId);
                nextIds.add(id);

                const prev = apptById.get(id);
                if (prev) {
                    applyBookItemToAppointment(prev, g, it);
                    nextList.push(prev);
                } else {
                    const created = markRaw({
                        id,
                        tenantId: '',
                        startDateTime: new Date(),
                        endDateTime: new Date(),
                        doctorName: '',
                        customerRefId: 0,
                        raw: it,
                    } as SchedulerAppointment);

                    applyBookItemToAppointment(created, g, it);
                    apptById.set(id, created);
                    nextList.push(created);
                }
            }
        }

        // stale 제거
        for (const key of apptById.keys()) {
            if (!nextIds.has(key)) apptById.delete(key);
        }

        // 커밋 = 배열 교체 1회(유일한 반응성 트리거). 항목이 markRaw 라 재사용 경로의 필드
        // 변경은 스스로 알리지 못한다 — splice 는 같은 참조·같은 순서면 no-op 이 되어 화면이
        // 낡은 값으로 남으므로(SSE 재조회 등) 반드시 새 배열 대입이어야 한다.
        appointments.value = nextList;
    }

    // 응답 경합 가드 — 조회가 겹칠 때 늦게 도착한 옛 응답이 최신 화면을 덮어쓰지 않게 한다.
    // upsertAppointments 는 누적이 아니라 전량 교체(stale 제거)라, 순서가 뒤바뀌면 그 응답이 그대로 화면이 된다.
    let loadSeq = 0;

    // 마지막으로 화면에 반영된 조회의 파라미터. 다른 파라미터의 조회가 떠 있는 동안 appointments 는
    // 이전 조건의 데이터다(stale) — 상태 칩 숫자가 이전 조건의 값으로 잠시 보이던 원인. 같은 파라미터의
    // 재조회(SSE 갱신)는 stale 이 아니라서 숫자가 깜빡이지 않는다.
    let loadedParamsKey: string | null = null;
    const appointmentsStale = ref(false);

    async function load() {
        const seq = ++loadSeq;
        pending.value = true;
        try {
            const params = toBookApiParams(schedulerFilterStore.$state);
            const paramsKey = JSON.stringify(params);
            if (paramsKey !== loadedParamsKey) appointmentsStale.value = true;
            const res = await get(params);
            // 더 최신 조회가 시작됐다면 이 응답은 버린다.
            if (seq !== loadSeq) return;
            const body: ApiResponse<BookDayGroupResponse[]> = unwrapBody<BookDayGroupResponse[]>(res);

            // markRaw — 원본 payload 는 읽기 전용 스냅샷. 반응형 변환·devtools deep 순회 대상에서 제외.
            const payload = body.payload ?? [];
            responseData.value = markRaw(payload);

            upsertAppointments(payload);
            loadedParamsKey = paramsKey;
            appointmentsStale.value = false;

            return body;
        } catch (e) {
            console.error('[장부] 조회 실패', e);
            // 최신 조회가 실패하면 화면에는 이전 목록의 카드가 그대로 남는다 — stale 을 켜 둔 채 두면
            // 카드는 보이는데 숫자만 0 이 다음 성공 조회까지 고착된다. 카드와 숫자가 같은 것을 말하게 푼다.
            if (seq === loadSeq) appointmentsStale.value = false;
        } finally {
            // 최신 조회가 아직 떠 있으면 pending 을 내리지 않는다(스피너 조기 해제 방지).
            if (seq === loadSeq) pending.value = false;
        }
    }

    async function addAppointment(params: BookItemRequest) {
        try {
            const res = await add(params);
            const body: ApiResponse<BookItem> = unwrapBody<BookItem>(res);
            console.log('[장부 > 등록] 성공', body);
            return body;
        } catch (e) {
            console.error('[장부 > 등록] 실패', params, e);
            return toErrorBody(e);
        }
    }

    async function modifyAppointment(id: string, params: BookItemRequest) {
        try {
            const res = await modify(id, params);
            const body: ApiResponse<BookItem> = unwrapBody<BookItem>(res);
            console.log('[장부 > 수정] 성공', body);
            return body;
        } catch (e) {
            console.error('[장부 > 수정] 실패', id, params, e);
            return toErrorBody(e);
        }
    }

    // 현재 화면 구분(reservation|treatment). 상태변경·삭제가 예약/방문 구분값을 뭉개지 않도록 함께 보낸다.
    function currentBookType() {
        return toType(schedulerFilterStore.dataType);
    }

    async function modifyAppointmentState(id: string, state: string) {
        try {
            const res = await updateStatus(id, state, currentBookType());
            const body: ApiResponse<BookItem> = unwrapBody<BookItem>(res);
            console.log('[장부 > 상태 > 수정] 성공', body);
            return body;
        } catch (e) {
            console.error('[장부 > 상태 > 수정] 실패', e, id, state);
            return toErrorBody(e);
        }
    }

    async function removeAppointment(id: string) {
        try {
            const res = await remove(id, currentBookType());
            const body: ApiResponse<BookItem> = unwrapBody<BookItem>(res);
            console.log('[장부 > 삭제] 성공', body);
            return body;
        } catch (e) {
            console.error('[장부 > 삭제] 실패', e, id);
            return toErrorBody(e);
        }
    }

    // redirect 필요 시 사유를 저장 (컴포넌트에서 dialog + redirect 처리). = 하드 차단(담당자 미등록 등).
    const redirectReason = ref<string | null>(null);

    // 일시적 조회 실패 안내 — set 되면 컴포넌트가 alert 노출(사업장 설정 화면 이동 X). latch 아님 → 재시도 가능.
    const serviceUnavailable = ref<string | null>(null);

    // 운영시간 미등록(기관·담당자 모두 없음) — 차단하지 않고 안내 배너만(보드 로드+예약 등록 허용). 사용자 모델 1-1.
    const noTreatmentTime = ref(false);

    // 최초 성공 로딩 셋업(운영시간 게이트/상태코드) 완료 여부. searchVersion 값이 아닌 이 플래그로 게이트해
    // 일시 실패 후 재시도가 searchVersion>=1 에서 일어나도 초기 셋업이 정상 수행되게 한다.
    const initialized = ref(false);

    // latch 해제 — redirectReason 은 한 번 set 되면 watch 가 :309 early-return 으로 모든 재조회를 막는다.
    // 운영시간/휴무 설정 저장 후(reloadSchedulerData) 호출해 latch 를 풀고 재조회가 가능하게 한다.
    // + initialized 도 리셋해 운영시간 게이트(자체/외부 hours 판정 + noTreatmentTime 배너)를 재평가한다.
    //   (게이트는 !initialized 안에서 1회만 도는데, 설정으로 hours 가 채워져도 재평가 안 되면 배너가 안 꺼진다.)
    function clearRedirect() {
        redirectReason.value = null;
        initialized.value = false;
    }

    watch(
        () => schedulerFilterStore.searchVersion,
        async () => {
            if (redirectReason.value) return;

            // 담당자 조회 실패(일시적 장애)와 "성공했는데 0명" 을 구분 — 전자는 재시도 안내, 후자만 redirect latch.
            const doctorLoaded = await staffStore.loadDoctor();
            if (!doctorLoaded) {
                serviceUnavailable.value = serviceUnavailableMessage; // latch 아님 → 다음 searchVersion 에서 재시도.
                return;
            }
            serviceUnavailable.value = null; // 성공 → 이전 실패 안내 해제.

            if (!staffStore.doctors.length) {
                redirectReason.value = returnMessage;
                return;
            }

            // 최초 셋업(운영시간 게이트)은 장부 조회와 서로 필요로 하는 값이 없다.
            // 순차로 기다리면 운영시간 원천이 느릴 때 그만큼 카드가 안 그려진다. 병렬로 돌린다.
            const setup = initialized.value ? Promise.resolve() : runInitialSetup();

            // 상태·회원 카운트는 따로 조회하지 않는다 — 페이지가 화면에 그려진 카드에서 센다(boardStatistics).
            // BE 집계와 화면 카드는 모수가 달라(창 > 표시 범위, 경계 칸 일부) 숫자만 남는 예약이 생겼다.
            await Promise.all([setup, load()]);
        },
        {immediate: true},
    );

    /**
     * 최초 성공 로딩 1회 셋업 — 운영시간 게이트.
     * 진입 즉시 initialized 를 마킹한다(기존 `v < 1` 게이트와 동일하게 "최초 1회만").
     * 일시 실패로 loadDoctor 가 앞에서 return 되면 여기 못 오므로 flag=false 유지 → 재시도 시 정상 수행.
     */
    async function runInitialSetup() {
        initialized.value = true;
        await staffStore.loadSchedule();

        // 운영시간 게이트 — hospitalRules.weekly 가 곧 사업장 운영시간이다.
        //  - 운영시간 있음 → 정상
        //  - 없음 → 배너로 등록 권장(비블로킹). 보드는 그대로 쓰고 예약도 등록할 수 있다.
        const weekly = staffStore.hospitalRules?.weekly;
        const hasInstitutionHours = !!weekly && Object.keys(weekly).length > 0;
        noTreatmentTime.value = !hasInstitutionHours;
    }

    return {
        responseData,
        appointments,
        appointmentsStale,
        pending,
        redirectReason,
        serviceUnavailable,
        noTreatmentTime,
        clearRedirect,
        load,
        addAppointment,
        modifyAppointment,
        removeAppointment,
        modifyAppointmentState,
    };
});