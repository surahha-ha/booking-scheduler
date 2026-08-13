// Build URL path with :vars replacement
export function httpBuildPathUtils(
    path: string,
    pathVars?: Record<string, string | number>
) {
    if (!pathVars) return path;

    return path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
        const v = pathVars[key];
        if (v === undefined || v === null) {
            throw new Error(`Missing path var: ${key}`);
        }
        return encodeURIComponent(String(v));
    });
}
