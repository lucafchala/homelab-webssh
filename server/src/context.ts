import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Vault } from './security/crypto.js';
import type { Audit } from './audit.js';
import type { AppSettingsStore } from './appSettings.js';
import type { SessionStore } from './auth/sessions.js';
import type { FailureThrottle } from './security/throttle.js';
import type { CidrList } from './security/cidr.js';
import type { CfAccessVerifier } from './security/cfaccess.js';
import type { SshManager } from './ssh/manager.js';
import type { TerminalManager } from './ssh/terminals.js';
import type { Recorder } from './recorder.js';

export interface AppContext {
  config: Config;
  db: Db;
  vault: Vault;
  log: FastifyBaseLogger;
  audit: Audit;
  settings: AppSettingsStore;
  sessions: SessionStore;
  ipThrottle: FailureThrottle;
  ipAllowlist: CidrList;
  cfAccess: CfAccessVerifier | null;
  ssh: SshManager;
  terminals: TerminalManager;
  recorder: Recorder;
  /** One-time token required to create the first admin (null once set up). */
  setupToken: string | null;
}
