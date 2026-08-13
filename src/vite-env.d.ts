/// <reference types="vite/client" />
/// <reference types="vitest" />

/**
 * https://ko.vitejs.dev/guide/env-and-mode
 */
interface ImportMetaEnv {
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
