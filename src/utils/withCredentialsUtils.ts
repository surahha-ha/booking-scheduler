import type {AxiosRequestConfig} from 'axios';

export function withCredentialsUtils(
    config: AxiosRequestConfig = {}
): AxiosRequestConfig {
    return {
        ...config,
        withCredentials: true,
        headers: {
            ...(config.headers ?? {}),
        },
    };
}

