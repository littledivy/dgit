import type { Registry } from "./registry";

export interface Env {
  REPO: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace<Registry>;
  /** shared secret required for git push (Basic auth password) */
  GIT_TOKEN?: string;
  /** optional comma-separated extra tokens (multiple users) */
  GIT_TOKENS?: string;
  /** max accepted push size in MB (default 512) */
  MAX_PUSH_MB?: string;
  SITE_NAME?: string;
  SITE_DESC?: string;
  SITE_OWNER?: string;
}
