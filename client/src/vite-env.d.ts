/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** `worker` points the client at the new Worker backend (see src/backend.ts). */
  readonly VITE_BACKEND?: string;
}
