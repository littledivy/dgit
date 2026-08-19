import type { Registry } from "./registry";
import type { RepoCell } from "./repo";

export interface Env {
  REPO: DurableObjectNamespace<RepoCell>;
  REGISTRY: DurableObjectNamespace<Registry>;
  /** optional R2 bucket that offloads full-clone packs (absent on celld) */
  PACK_CACHE?: R2Bucket;
  /** shared secret required for git push (Basic auth password) */
  GIT_TOKEN?: string;
  /** optional comma-separated extra tokens (multiple users) */
  GIT_TOKENS?: string;
  /** max accepted push size in MB (default 512) */
  MAX_PUSH_MB?: string;
  /** "1" screens every pushed object with SHA-1DC collision detection; default
   * hashes with native crypto.subtle (identical oid, far faster) */
  SHA1DC?: string;
  SITE_NAME?: string;
  SITE_DESC?: string;
  SITE_OWNER?: string;
}
