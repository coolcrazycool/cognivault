import { readFileSync } from 'node:fs';
import tls from 'node:tls';

/**
 * TLS for the connection to an EXTERNAL Qdrant.
 *
 * `QdrantClientParams` exposes no TLS knobs, and there is no seam to reach the
 * transport either: `@qdrant/js-client-rest` builds its OWN undici `Agent`
 * (`dist/esm/dispatcher.js` — no `connect` options at all) and passes it to every
 * request as `init.dispatcher`, which overrides undici's global dispatcher. So
 * `setGlobalDispatcher` is useless here, and the client's own transitive `undici@6`
 * is what actually opens the sockets.
 *
 * What every undici version does have in common is `lib/core/connect.js`: it
 * resolves `node:tls` lazily and calls `tls.connect({...})` as a live property
 * lookup on the module object. Patching that property therefore works regardless of
 * which undici (or which HTTP client) sits in front of it.
 *
 * The patch is SCOPED BY HOST AND PORT on purpose:
 *   - a custom `ca` REPLACES the system root store, so applying it to every TLS
 *     connection would break everything else the process talks to;
 *   - a client certificate must not be presented to hosts that did not ask for it;
 *   - GigaChat goes out over `node:https`, which funnels through the very same
 *     `tls.connect` — it must pass through completely untouched.
 *
 * Anything that is not the Qdrant host:port is delegated to the original
 * `tls.connect` with the arguments exactly as they came in.
 */

/** Config slice this module needs — `Config` from `../config.js` satisfies it. */
export interface QdrantTlsConfig {
  QDRANT_URL: string;
  QDRANT_CA_PATH?: string;
  QDRANT_CERT_PATH?: string;
  QDRANT_KEY_PATH?: string;
  QDRANT_KEY_PASSPHRASE?: string;
  QDRANT_VERIFY_SSL: boolean;
}

/** Minimal pino-shaped logger; `FastifyBaseLogger` satisfies it. */
export interface QdrantTlsLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * TLS material mixed into the connect options of matching sockets. Buffers, never
 * paths. NEVER log it: it carries the private key and its passphrase.
 */
export interface QdrantTlsMaterial {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  rejectUnauthorized: boolean;
}

/** Startup-fatal misconfiguration: unreadable PEM, unparseable URL. */
export class QdrantTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QdrantTlsConfigError';
  }
}

/** What the plugin may log: modes only, never paths or secrets. */
export interface QdrantTlsSummary {
  /** `custom` — TLS interception is (or would be) active for the Qdrant host. */
  qdrantTls: 'custom' | 'system';
  qdrantClientCert: boolean;
  qdrantVerifySsl: boolean;
}

/**
 * The single method of `node:tls` this module touches. Deliberately loose: it has to
 * accommodate every `tls.connect` overload — `(options, cb)`, `(port, host, …)`,
 * `(path, …)` — because only the first is ours to rewrite.
 */
export interface TlsModuleLike {
  connect(...args: unknown[]): unknown;
}

/** Seams for tests: a fake tls module and a fake reader, so nothing global is touched. */
export interface QdrantTlsDeps {
  tlsModule?: TlsModuleLike;
  readFile?: (path: string) => Buffer;
}

/** Reads a PEM file, surfacing the PATH but never the bytes. */
function readPem(read: (path: string) => Buffer, path: string, envName: string): Buffer {
  try {
    return read(path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code ?? (err instanceof Error ? err.message : String(err));
    throw new QdrantTlsConfigError(`Cannot read ${envName} "${path}": ${reason}`);
  }
}

/** Lowercases and strips IPv6 brackets so `[::1]` and `::1` compare equal. */
function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/** Default TLS port when the connect options omit it (undici fills 443 itself). */
const DEFAULT_TLS_PORT = 443;

/** The Qdrant endpoint we are allowed to touch. */
interface QdrantEndpoint {
  host: string;
  port: number;
}

function parseEndpoint(url: string): QdrantEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new QdrantTlsConfigError(`QDRANT_URL "${url}" is not a valid absolute URL`);
  }
  const port =
    parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : DEFAULT_TLS_PORT;
  return { host: normalizeHost(parsed.hostname), port };
}

/**
 * Loads the TLS material, or `undefined` when nothing is configured (no CA, no
 * cert/key pair, verification left on) — in that case `tls.connect` is not patched
 * at all and every connection in the process behaves exactly as before.
 *
 * Reads the files eagerly and synchronously so a bad path fails at startup with a
 * clear message instead of surfacing later as an opaque TLS error.
 */
export function buildQdrantTlsMaterial(
  cfg: QdrantTlsConfig,
  read: (path: string) => Buffer = readFileSync,
): QdrantTlsMaterial | undefined {
  const hasCa = cfg.QDRANT_CA_PATH !== undefined && cfg.QDRANT_CA_PATH !== '';
  const hasClientCert =
    cfg.QDRANT_CERT_PATH !== undefined &&
    cfg.QDRANT_CERT_PATH !== '' &&
    cfg.QDRANT_KEY_PATH !== undefined &&
    cfg.QDRANT_KEY_PATH !== '';

  if (!hasCa && !hasClientCert && cfg.QDRANT_VERIFY_SSL) {
    return undefined;
  }

  const material: QdrantTlsMaterial = { rejectUnauthorized: cfg.QDRANT_VERIFY_SSL };

  if (hasCa && cfg.QDRANT_CA_PATH !== undefined) {
    material.ca = readPem(read, cfg.QDRANT_CA_PATH, 'QDRANT_CA_PATH');
  }
  if (hasClientCert && cfg.QDRANT_CERT_PATH !== undefined && cfg.QDRANT_KEY_PATH !== undefined) {
    material.cert = readPem(read, cfg.QDRANT_CERT_PATH, 'QDRANT_CERT_PATH');
    material.key = readPem(read, cfg.QDRANT_KEY_PATH, 'QDRANT_KEY_PATH');
    if (cfg.QDRANT_KEY_PASSPHRASE !== undefined && cfg.QDRANT_KEY_PASSPHRASE !== '') {
      material.passphrase = cfg.QDRANT_KEY_PASSPHRASE;
    }
  }

  return material;
}

/** Log-safe description of the TLS mode. Touches no files. */
export function describeQdrantTls(cfg: QdrantTlsConfig): QdrantTlsSummary {
  const hasCa = cfg.QDRANT_CA_PATH !== undefined && cfg.QDRANT_CA_PATH !== '';
  const hasClientCert =
    cfg.QDRANT_CERT_PATH !== undefined &&
    cfg.QDRANT_CERT_PATH !== '' &&
    cfg.QDRANT_KEY_PATH !== undefined &&
    cfg.QDRANT_KEY_PATH !== '';
  const custom = hasCa || hasClientCert || !cfg.QDRANT_VERIFY_SSL;

  return {
    qdrantTls: custom ? 'custom' : 'system',
    qdrantClientCert: hasClientCert,
    qdrantVerifySsl: cfg.QDRANT_VERIFY_SSL,
  };
}

/** Reads `host` / `servername` off the connect options; either may identify the peer. */
function optionHosts(options: Record<string, unknown>): string[] {
  const hosts: string[] = [];
  for (const key of ['host', 'servername'] as const) {
    const value = options[key];
    if (typeof value === 'string' && value !== '') {
      hosts.push(normalizeHost(value));
    }
  }
  return hosts;
}

/** Connect options carry the port as a number or a string; absent means the TLS default. */
function optionPort(options: Record<string, unknown>): number | undefined {
  const value = options.port;
  if (value === undefined || value === null || value === '') {
    return DEFAULT_TLS_PORT;
  }
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(port) ? port : undefined;
}

/** True only for a connection to the exact Qdrant host:port. */
function matchesEndpoint(options: Record<string, unknown>, endpoint: QdrantEndpoint): boolean {
  if (!optionHosts(options).includes(endpoint.host)) {
    return false;
  }
  return optionPort(options) === endpoint.port;
}

/** Patch state. Module-level so a second install is a no-op (tests re-register plugins). */
let patchedModule: TlsModuleLike | undefined;
let originalConnect: TlsModuleLike['connect'] | undefined;

/**
 * Patches `tls.connect` so that connections to the Qdrant host:port — and only those —
 * carry the configured CA / client certificate. No-op when nothing is configured.
 * Idempotent: a second call while the patch is live does nothing.
 *
 * Must run BEFORE the first connection to Qdrant, i.e. before the client is used.
 */
export function installQdrantTls(
  cfg: QdrantTlsConfig,
  log: QdrantTlsLogger,
  deps: QdrantTlsDeps = {},
): void {
  if (patchedModule !== undefined) {
    return;
  }

  const material = buildQdrantTlsMaterial(cfg, deps.readFile ?? readFileSync);
  if (material === undefined) {
    return;
  }

  const endpoint = parseEndpoint(cfg.QDRANT_URL);
  // The ESM default export of a builtin IS the object `require()` returns, so this
  // patch is visible to undici's `require('node:tls')`. The cast keeps the loose
  // overload-agnostic shape this module works with.
  const tlsModule = deps.tlsModule ?? (tls as unknown as TlsModuleLike);
  // Kept unbound so `resetQdrantTlsForTests` restores the very same reference.
  const original = tlsModule.connect;

  tlsModule.connect = (...args: unknown[]): unknown => {
    const [first] = args;
    // Only the `(options, callback?)` overload is ours. `(port, host, …)` and
    // `(path, …)` pass straight through.
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      return original.apply(tlsModule, args);
    }

    const options = first as Record<string, unknown>;
    if (!matchesEndpoint(options, endpoint)) {
      return original.apply(tlsModule, args);
    }

    // Copy — never mutate the caller's options object.
    const patched: Record<string, unknown> = { ...options, ...material };
    return original.apply(tlsModule, [patched, ...args.slice(1)]);
  };

  patchedModule = tlsModule;
  originalConnect = original;

  log.info(
    { qdrantHost: endpoint.host, qdrantPort: endpoint.port, ...describeQdrantTls(cfg) },
    'Intercepting TLS connections to the Qdrant host',
  );
}

/** Test-only: restores the original `tls.connect` and clears the install guard. */
export function resetQdrantTlsForTests(): void {
  if (patchedModule !== undefined && originalConnect !== undefined) {
    patchedModule.connect = originalConnect;
  }
  patchedModule = undefined;
  originalConnect = undefined;
}
