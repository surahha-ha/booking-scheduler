// 화면 라벨은 전부 TERMS(= messages/ko.json 의 terms) 에서 온다.
// 업종을 바꾸려면 그 JSON 만 고치면 되고, 여기 키·타입은 그대로 둔다.
import {TERMS} from '@/constants/terms';

// API response codes
export const API_RESPONSE_CODE = {
    SUCCESS: 'succeed',
    FAILED: 'failed'
}
export type ApiResponseCode = keyof typeof API_RESPONSE_CODE;

// 운영 상태 (운영중 / 운영종료)
export const TREATMENT_STATE_TYPE = {
    Y: TERMS.openState.on,
    N: TERMS.openState.off,
} as const;
export type TreatmentStateType = keyof typeof TREATMENT_STATE_TYPE;

// 보기 모드 (방문 / 예약)
export const DATA_TYPE = {
    TREATMENT: TERMS.visit,
    APPOINTMENT: TERMS.booking,
} as const;
export type DataType = keyof typeof DATA_TYPE;

// View mode labels
export const VIEW_MODE = {
    WEEK: TERMS.viewMode.week,
    DAY: TERMS.viewMode.day,
} as const;
export type ViewMode = keyof typeof VIEW_MODE;

// Member type
export const MEMBER_TYPE = {
    Y: TERMS.memberType.member,
    N: TERMS.memberType.guest,
} as const;
export type MemberType = keyof typeof MEMBER_TYPE;

// 예약 보기 상태 필터
export const APPOINTMENT_STATUS_TYPE = {
    APPOINTMENT: TERMS.status.booked, // 00
    CANCEL: TERMS.status.cancel // 03
} as const;
export type AppointmentStatusType = keyof typeof APPOINTMENT_STATUS_TYPE;

// 방문 보기 상태 필터
export const TREATMENT_STATUS_TYPE = {
    WAITING: TERMS.status.waiting, // 05
    COMPLETE: TERMS.status.complete, // 01
    UNDONE: TERMS.status.undone, // 02
    CANCEL: TERMS.status.cancel // 03
} as const;
export type TreatmentStatusType = keyof typeof TREATMENT_STATUS_TYPE;

// 카드 ⋮ 메뉴 정의는 스케줄러 UI 전용이라 pages/desktop/scheduler/appointmentCardMenu.ts 가 소유한다.

// Status keys
export const APPOINTMENT_STATUS_KEYS =
    Object.keys(APPOINTMENT_STATUS_TYPE) as (keyof typeof APPOINTMENT_STATUS_TYPE)[];

// Button helpers
export function toButtons<T extends Record<string, string>>(enumObj: T) {
    return Object.entries(enumObj).map(([value, label]) => ({value, label}));
}

export function toButtonsFromArray<T, V extends string | number>(
    items: T[],
    getValue: (item: T) => V,
    getLabel: (item: T) => string
) {
    return (items ?? []).map((it) => ({
        value: getValue(it),
        label: getLabel(it),
    }));
}
