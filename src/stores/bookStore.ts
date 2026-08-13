import {defineStore} from 'pinia';
import {reactive, ref, watch} from 'vue';
import {
    add,
    type ApiResponse,
    type BookDayGroupResponse,
    type BookItem,
    type BookItemRequest,
    get,
    getMemberStatistics,
    getStateStatistics,
    type MemberStatisticsResponse,
    modify,
    remove,
    type StateStatisticsResponse,
    updateStatus,
} from '@/api/bookApi';
import {toBookApiParams} from '@/mappers/schedulerSearchFilterToApiParams';
import {useSchedulerFilterStore} from '@/stores/useSchedulerFilterStore';
import {useStaffStore} from '@/stores/staffStore';
import dayjs from 'dayjs';
import {toErrorBody} from '@/utils/apiErrorUtils';
import {extractFirstChars} from '@/utils/formatStringUtils';
import {resolveStatisticsDoctorNames, toStatusClassName, toType} from '@/utils/schedulerSearchFilterUtils';
import {sanitizePersonName} from '@/composables/useAppointmentFormatter';

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
    uiDoctor1: string;        // 의사 1글자
    uiPatient: string;        // 고객명(기본값 포함)
    uiPhone: string;          // 전화번호 포맷
    uiJoin: boolean;          // join 여부
    uiStatusClass: string;    // status class
    isExternalSync: boolean;      // 외부 시스템 연동 여부 — 의사 뱃지 색상 분기에 사용
    createdAt?: Date;       // 예약 등록일시 — '당일'(오늘 등록) 뱃지 판정

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
    if (code === 'M') return '남';
    if (code === 'F') return '여';
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
    target.uiJoin = !!target.memberNo || target.memberYn === 'Y';
    target.uiStatusClass = toStatusClassName(target.status);
    target.isExternalSync = it.externalYn === 'Y';
    target.createdAt = it.createdAt ? dayjs(it.createdAt).toDate() : undefined;
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
    const stateStatisticsData = ref<StateStatisticsResponse[]>([]);
    const memberStatisticsData = ref<MemberStatisticsResponse[]>([]);

    const appointments = ref<SchedulerAppointment[]>([]);
    const apptById = new Map<string, SchedulerAppointment>();

    function unwrapBody<T>(res: any): ApiResponse<T> {
        return (res as any).data ?? res;
    }


    // 응답 payload를 appointments로 동기화 (객체 참조 최대한 재사용)
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
                    const created = reactive<SchedulerAppointment>({
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

        // 배열 참조 유지 (스크롤 보호)
        appointments.value.splice(0, appointments.value.length, ...nextList);
    }

    async function load() {
        pending.value = true;
        try {
            const params = toBookApiParams(schedulerFilterStore.$state);
            const res = await get(params);
            const body: ApiResponse<BookDayGroupResponse[]> = unwrapBody<BookDayGroupResponse[]>(res);

            const payload = body.payload ?? [];
            responseData.value = payload;

            upsertAppointments(payload);

            return body;
        } catch (e) {
            console.error('[장부] 조회 실패', e);
        } finally {
            pending.value = false;
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

    // 현재 화면 구분(reservation|treatment). 상태변경·삭제가 예약/진료 구분값을 뭉개지 않도록 함께 보낸다.
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

    async function loadMemberStatistics() {
        try {
            const params = toBookApiParams(schedulerFilterStore.$state, true);
            // 통계는 BE 집계라 FE 에서 못 거른다 → 화면 표시 의사(팀/미지정)와 정합되게 doctorName 보강.
            params.doctorName = resolveStatisticsDoctorNames(
                schedulerFilterStore.doctors,
                schedulerFilterStore.selectedTeamName,
                staffStore.doctors,
                staffStore.teams,
            );
            // 화면 표시 의사 0명(빈 팀/전원 팀소속 미지정)이면 doctorName=[] → BE 가 '전체'로 오인해 전체집계 폴백.
            // 보드는 컬럼 0(카드 0)이라 통계만 전체가 되어 불일치 → 표시 의사가 없으면 통계도 0.
            if (params.doctorName.length === 0) {
                memberStatisticsData.value = [];
                return;
            }
            const res = await getMemberStatistics(params);
            const body: ApiResponse<MemberStatisticsResponse[]> =
                unwrapBody<MemberStatisticsResponse[]>(res);
            memberStatisticsData.value = body.payload ?? [];
            return body;
        } catch (e) {
            console.error('[장부 > 회원 통계 조회] 실패', e);
        }
    }

    async function loadStateStatistics() {
        try {
            const params = toBookApiParams(schedulerFilterStore.$state, true);
            // 통계는 BE 집계라 FE 에서 못 거른다 → 화면 표시 의사(팀/미지정)와 정합되게 doctorName 보강.
            params.doctorName = resolveStatisticsDoctorNames(
                schedulerFilterStore.doctors,
                schedulerFilterStore.selectedTeamName,
                staffStore.doctors,
                staffStore.teams,
            );
            // 화면 표시 의사 0명(빈 팀/전원 팀소속 미지정)이면 doctorName=[] → BE 가 '전체'로 오인해 전체집계 폴백.
            // 보드는 컬럼 0(카드 0)이라 통계만 전체가 되어 불일치 → 표시 의사가 없으면 통계도 0.
            if (params.doctorName.length === 0) {
                stateStatisticsData.value = [];
                return;
            }
            const res = await getStateStatistics(params);
            const body: ApiResponse<StateStatisticsResponse[]> =
                unwrapBody<StateStatisticsResponse[]>(res);
            stateStatisticsData.value = body.payload ?? [];
            return body;
        } catch (e) {
            console.error('[장부 > 장부 통계 조회] 실패', e);
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

            if (!initialized.value) {
                // 최초 성공 로딩 1회 셋업. 진입 즉시 마킹 — 기존 `v < 1` 게이트와 동일하게 "최초 1회만" 수행.
                // (일시 실패로 loadDoctor 가 위에서 return 되면 여기 못 와 flag=false 유지 → 재시도 시 정상 수행.
                //  redirect/설정저장 경로의 재게이트 여부 등 그 외 동작은 기존과 동일하게 보존.)
                initialized.value = true;
                await staffStore.loadSchedule();

                // 운영시간 게이트.
                //  - 운영시간 있음 → 정상
                //  - 없음 → 배너로 등록 권장(비블로킹). 보드는 그대로 쓰고 예약도 등록할 수 있다.
                const weekly = staffStore.hospitalRules?.weekly;
                const hasInstitutionHours = !!weekly && Object.keys(weekly).length > 0;
                noTreatmentTime.value = !hasInstitutionHours;
            }

            // 장부 + 통계 (독립 API이므로 병렬 호출)
            await Promise.all([load(), loadMemberStatistics(), loadStateStatistics()]);
        },
        {immediate: true},
    );

    return {
        responseData,
        memberStatisticsData,
        stateStatisticsData,
        appointments,
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
        loadMemberStatistics,
        loadStateStatistics,
    };
});