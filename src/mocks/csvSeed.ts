// ============================================================================
// 시드 데이터 로더 — 스냅샷(reservations.json)을 오늘 기준으로 시프트해 전개한다
// ----------------------------------------------------------------------------
// 데모용 생성 데이터(담당자·고객·전화 전량 가명)를 reservations.json 스냅샷으로 커밋했다.
//   - 날짜는 "앵커(최밀집일)로부터의 offset(일)"로 저장 → 런타임에 오늘 기준 시프트.
//   - 시프트는 7일 배수(요일 보존) → 일요일 휴무 등 요일 정합 유지, 앵커가 오늘 근처로 온다.
//   - 담당자명은 staffStore.replaceDoctorName 과 동일 규칙으로 정제(정합) → name 모드 컬럼 매칭 보장.
// ============================================================================
import type {BookItem} from '@/api/bookApi';
import type {DoctorPayload} from '@/api/staffApi';
import raw from './data/reservations.json';

interface RawItem {
    o: number;      // 앵커로부터 offset(일)
    t: string;      // 시작 "HH:MM"
    e: string;      // 종료 "HH:MM"
    d: string;      // 의사명(정제됨)
    p: string;      // 고객명
    h: string;      // 전화
    i: string;      // 통합회원 Y/N
    s: string;      // 상태코드
    g: number | null; // 서비스 항목 그룹
    a: number | null; // 서비스 항목
    m: string;      // 메모
}
interface RawSeed {
    anchorDate: string;
    anchorCount: number;
    doctors: string[];
    items: RawItem[];
}
const seed = raw as RawSeed;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 요일 보존 시프트: 앵커(월)→ 오늘 근처의 같은 요일. delta = round((today-anchor)/7)*7 일.
function computeShiftDays(): number {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const anchor = new Date(`${seed.anchorDate}T00:00:00`);
    const rawDays = Math.round((today.getTime() - anchor.getTime()) / 86400000);
    return Math.round(rawDays / 7) * 7;
}

function dateFromOffset(shiftDays: number, offset: number): Date {
    const anchor = new Date(`${seed.anchorDate}T00:00:00`);
    const d = new Date(anchor);
    d.setDate(d.getDate() + shiftDays + offset);
    d.setHours(0, 0, 0, 0);
    return d;
}

/** 의사(컬럼) — 빈도순. name 모드 컬럼 id = 이름. */
export const csvDoctors: DoctorPayload[] = seed.doctors.map((name, idx) => ({
    staffId: idx + 1,
    staffName: name,
    openYn: 'Y',
}));

/** 예약 — 오늘 기준 시프트된 BookItem[]. externalStaffNo=0(이름 매칭). */
export const csvReservations: BookItem[] = (() => {
    const shift = computeShiftDays();
    return seed.items.map((it, idx) => {
        const date = dateFromOffset(shift, it.o);
        const day = ymd(date);
        const no = idx + 1;
        const customerId = 400000 + no;
        const member = it.i === 'Y';
        return {
            reservationId: no,
            tenantId: 'TENANT_MOCK',
            statusCode: it.s,
            startAt: `${day}T${it.t}:00`,
            endAt: `${day}T${it.e}:00`,
            externalStaffNo: 0, // name 모드 매칭 — staffName 로만 컬럼 배정
            staffName: it.d,
            customerId,
            memberYn: it.i,
            memberNo: member ? customerId + 100000 : undefined,
            customerPhone: it.h,
            customerName: it.p,
            delYn: 'N',
            memo: it.m,
            serviceGroupId: it.g ?? undefined,
            serviceItemId: it.a ?? undefined,
            serviceGroupName: null, // CSV 는 항목 ID 만 — 마스터명 미조인(카드 서비스 항목 미표시)
            serviceItemName: null,
            birthDate: member ? '1988-05-20' : null,
            sexDivisionCode: member ? (no % 2 === 0 ? 'M' : 'F') : null,
            createdAt: `${day}T08:00:00`,
            externalYn: 'N',
        } as BookItem;
    });
})();
