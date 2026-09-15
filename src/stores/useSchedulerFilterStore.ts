import {defineStore} from 'pinia';
import dayjs from 'dayjs';
import {
    AppointmentStatusType,
    TreatmentStatusType,
    DataType,
    MemberType,
    TreatmentStateType,
    ViewMode
} from '@/constants/schedulerSearchFilter';
import {normalizeId} from '@/utils/formatStringUtils';
import {IS_RESET_TO_TODAY} from '@/constants/componentConstants';

export interface SchedulerFilterState {
    periodDate: Date;
    viewMode: ViewMode;
    dataType: DataType;
    memberType: MemberType;
    treatmentStateType: TreatmentStateType;
    keyword?: string;
    doctors: string[];
    selectedTeamName: string | null;
    status: (AppointmentStatusType | TreatmentStatusType)[];
    searchVersion: number;
    isResetToToday: boolean;
    // V3 전용 조회 윈도우 (가산). 설정 시 toBookApiParams 가 viewMode/periodDate 대신
    // [windowAnchorDate, +windowDays) 범위로 조회. V2 는 미설정(null/0)이라 기존 경로 유지(무영향).
    windowAnchorDate: Date | null;
    windowDays: number;
}

// 뷰 모드에 맞춰 기준 날짜 정규화
function normalizePeriodDate(date: Date, viewMode: ViewMode) {
    const base = dayjs(date);
    return viewMode === 'WEEK'
        ? base.startOf('week').startOf('day').toDate()
        : base.startOf('day').toDate();
}

// 스케줄러 필터 store
export const useSchedulerFilterStore = defineStore('useSchedulerFilterStore', {
    state: (): SchedulerFilterState => ({
        periodDate: normalizePeriodDate(new Date(), 'WEEK'),
        viewMode: 'WEEK',
        dataType: 'APPOINTMENT',
        memberType: 'N',
        treatmentStateType: 'Y',
        doctors: [],
        selectedTeamName: null,
        status: [],
        keyword: '',
        searchVersion: 0,
        isResetToToday: IS_RESET_TO_TODAY,
        windowAnchorDate: null,
        windowDays: 0,
    }),

    actions: {
        triggerSearch() {
            this.searchVersion += 1;
        },

        patch(patch: Partial<SchedulerFilterState>, trigger = true) {
            // V3 조회 창(windowAnchorDate)은 표시 날짜를 따른다(페이지가 selectedDate 로 setWindow).
            // 날짜와 함께 재조회가 나갈 때는 창을 같은 patch 로 옮긴다 — 안 그러면 첫 조회가 옛 창 범위로
            // 나가고 150ms 뒤 창 경로(applyDataWindow→setWindow)가 새 창으로 한 번 더 조회한다(이동 1회 = 조회 2회).
            // 창을 먼저 옮겨 두면 뒤따르는 setWindow 는 dedup(anchor·days 동일)으로 잦아든다.
            // trigger=false(페이지→store 동기화)는 창 경로가 재조회를 맡으므로 창을 건드리지 않는다.
            if (trigger && patch.periodDate && this.windowDays > 0 && patch.windowAnchorDate === undefined) {
                patch = {...patch, windowAnchorDate: dayjs(patch.periodDate).startOf('day').toDate()};
            }
            Object.assign(this, patch);
            if (trigger) this.triggerSearch();
        },

        setDataType(value: DataType, trigger = true) {
            if (this.dataType === value) return;
            // 상태 필터는 장부를 옮길 때마다 '전체'(빈 배열)로 초기화한다.
            // 상태 키 집합이 화면마다 달라(예약: APPOINTMENT/CANCEL, 방문: WAITING/COMPLETE/UNDONE/CANCEL)
            // 이전 선택이 남으면 어떤 버튼도 켜져 보이지 않는데 목록만 걸러진 상태가 된다.
            // 고객명 검색어도 같은 이유로 비운다 — 전환 전 장부에서 찾던 고객가 새 장부 목록을 계속 거르면 안 된다.
            // (recent 모드의 입력칸·드롭다운은 store 밖 로컬 상태라 UiSearchInput 이 dataType 을 보고 스스로 비운다.)
            const patch: Partial<SchedulerFilterState> = {dataType: value, status: [], keyword: ''};
            const today = normalizePeriodDate(new Date(), this.viewMode);
            if (value === 'TREATMENT') {
                // 방문 장부는 미래 날짜 표기 불가 → 미래를 보던 중 방문으로 전환 시 오늘로 클램프.
                // (과거~오늘을 보던 중이면 그대로 유지) viewMode 기준 정규화한 오늘과 비교.
                if (dayjs(this.periodDate).isAfter(today)) {
                    patch.periodDate = today;
                }
            } else {
                // 예약장부로 전환 시: 운영에서 보던 과거 날짜 잔류 방지 → 항상 오늘로 이동.
                patch.periodDate = today;
            }
            this.patch(patch, trigger);
        },

        setViewMode(value: ViewMode, trigger = true) {
            if (this.viewMode === value) return;

            const baseDate = this.isResetToToday
                ? new Date()
                : this.periodDate;
            const normalized = normalizePeriodDate(baseDate, value);
            this.patch({viewMode: value, periodDate: normalized}, trigger);
        },

        setMemberType(value: MemberType, trigger = true) {
            if (this.memberType === value) return;
            this.patch({memberType: value}, trigger);
        },

        // 팀 선택 (SF-3a/b). 팀 = 표시 필터 오버레이(이름 통일 key, 데이터 KEY 아님).
        // 팀 id 도 저장마다 재발급(deactivate+insert)되어 불안정 → 팀명을 키로(저장 후 선택 유지).
        // 전환 시 담당자선택 초기화(전원 표시) → doctors 변경 동반이라 재조회(trigger).
        // null = '미지정'(팀 미설정 담당자). 특정 팀명 = 그 팀 멤버 이름만 표시.
        setTeam(value: string | null, trigger = true) {
            if (this.selectedTeamName === value) return;
            // 팀명은 장부 조회 payload 에 없다(표시 오버레이). 재조회는 담당자 선택 초기화가 payload 를 실제로
            // 바꿀 때(선택이 있었을 때)만 — 비어 있었다면 payload 가 같아 다시 받을 것이 없다.
            // 상태·회원 카운트는 화면 카드에서 세므로(페이지 boardStatistics) 팀 전환에 재조회가 필요하지 않다.
            const payloadChanges = this.doctors.length > 0;
            this.patch({selectedTeamName: value, doctors: []}, trigger && payloadChanges);
        },

        setTreatmentStateType(value: TreatmentStateType, trigger = false) {
            if (this.treatmentStateType === value) return;
            this.patch({treatmentStateType: value}, trigger);
        },

        setPeriodDate(date: Date, trigger = true) {
            const normalized = normalizePeriodDate(date, this.viewMode);
            this.patch({periodDate: normalized}, trigger);
        },

        movePeriod(step: number, trigger = true) {
            const days = this.viewMode === 'WEEK' ? 7 : 1;
            const next = dayjs(this.periodDate).add(step * days, 'day').toDate();
            this.setPeriodDate(next, trigger);
        },

        setDoctors(ids: Array<string | number>, trigger = true) {
            const norm = Array.from(new Set(ids.map(normalizeId).filter(Boolean)));
            this.patch({doctors: norm}, trigger);
        },

        // 상태 필터는 조회 payload 에 들어가지 않는다(목록은 모든 상태를 받고 화면에서 거른다) → 기본 재조회 없음.
        setStatusKeys(keys: (AppointmentStatusType | TreatmentStatusType)[], trigger = false) {
            this.patch({status: keys}, trigger);
        },

        setKeyword(value: string, trigger = false) {
            this.patch({keyword: value}, trigger);
        },

        setResetToTodayOnViewModeChange(value: boolean) {
            this.isResetToToday = value;
        },

        // V3 데이터 조회 윈도우 설정 (forward N일). 표시(horizon)가 조회를 주도 — 그릴 컬럼만큼 조회.
        // load 직접호출 금지 → patch 의 searchVersion watch chain 으로 재조회. V2 는 호출 안 함.
        setWindow(anchorDate: Date | null, days: number, trigger = true) {
            const prevTime = this.windowAnchorDate?.getTime() ?? null;
            const nextTime = anchorDate?.getTime() ?? null;
            if (prevTime === nextTime && this.windowDays === days) return;
            this.patch({windowAnchorDate: anchorDate, windowDays: days}, trigger);
        }
    },
})
