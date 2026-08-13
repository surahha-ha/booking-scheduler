import {formatPhoneNumber} from '@/utils/formatStringUtils';

export type AppointmentLike = {
    externalStaffNo?: string | number | null;
    doctorName?: string | null;
    patientName?: string | null;
    patientPhone?: string | null;
    memo?: string | null;
};

export function sanitizePersonName(value?: string | null) {
    const name = value ?? '';
    return name.replace(/[^가-힣a-zA-Z\s]/g, '');
}

export function useAppointmentFormatter() {
    function getDoctorName(appointment?: AppointmentLike) {
        return sanitizePersonName(appointment?.doctorName);
    }

    function getPatientName(appointment?: AppointmentLike) {
        return appointment?.patientName ?? '예약';
    }

    function getPhone(appointment?: AppointmentLike) {
        return formatPhoneNumber(appointment?.patientPhone ?? '');
    }

    function getContent(appointment?: AppointmentLike) {
        return appointment?.memo ?? '';
    }

    return {
        getDoctorName,
        getPatientName,
        getPhone,
        getContent,
    };
}
