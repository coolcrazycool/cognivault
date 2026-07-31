import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildQdrantTlsMaterial,
  describeQdrantTls,
  installQdrantTls,
  type QdrantTlsConfig,
  QdrantTlsConfigError,
  type QdrantTlsLogger,
  type QdrantTlsMaterial,
  resetQdrantTlsForTests,
  type TlsModuleLike,
} from '../qdrant-tls.js';

// Any bytes will do: nothing here reaches a real TLS handshake — the tls module is
// swapped for a fake, so the PEMs are never parsed.
const CA_PEM = '-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n';
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nfake-client\n-----END CERTIFICATE-----\n';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nsuper-secret-key-bytes\n-----END PRIVATE KEY-----\n';

const QDRANT_HOST = 'tsled-oasis0001.esrt.sber.ru';
const QDRANT_PORT = 6433;
const GIGACHAT_HOST = 'gigachat-ift.sberdevices.delta.sbrf.ru';

let dir: string;
let caPath: string;
let certPath: string;
let keyPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qdrant-tls-'));
  caPath = join(dir, 'cacert.pem');
  certPath = join(dir, 'client_crt.crt');
  keyPath = join(dir, 'client_key.key');
  writeFileSync(caPath, CA_PEM);
  writeFileSync(certPath, CERT_PEM);
  writeFileSync(keyPath, KEY_PEM);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<QdrantTlsConfig> = {}): QdrantTlsConfig {
  return {
    QDRANT_URL: `https://${QDRANT_HOST}:${QDRANT_PORT}`,
    QDRANT_VERIFY_SSL: true,
    ...overrides,
  };
}

const silentLog: QdrantTlsLogger = { info: () => undefined, warn: () => undefined };

interface FakeTls {
  module: TlsModuleLike;
  calls: unknown[][];
  original: TlsModuleLike['connect'];
}

/** Stand-in for `node:tls`: records every call, never opens a socket. */
function fakeTls(): FakeTls {
  const calls: unknown[][] = [];
  const original = (...args: unknown[]): unknown => {
    calls.push(args);
    return 'socket';
  };
  return { module: { connect: original }, calls, original };
}

describe('buildQdrantTlsMaterial', () => {
  it('returns undefined when nothing TLS-related is configured', () => {
    expect(buildQdrantTlsMaterial(baseConfig())).toBeUndefined();
  });

  it('ignores empty-string paths (unset ConfigMap keys)', () => {
    expect(
      buildQdrantTlsMaterial(baseConfig({ QDRANT_CA_PATH: '', QDRANT_CERT_PATH: '' })),
    ).toBeUndefined();
  });

  it('loads only the CA when just QDRANT_CA_PATH is set', () => {
    const material = buildQdrantTlsMaterial(baseConfig({ QDRANT_CA_PATH: caPath }));

    expect(material?.ca?.toString()).toBe(CA_PEM);
    expect(material?.cert).toBeUndefined();
    expect(material?.key).toBeUndefined();
    expect(material?.rejectUnauthorized).toBe(true);
  });

  it('loads cert and key together and forwards the passphrase', () => {
    const material = buildQdrantTlsMaterial(
      baseConfig({
        QDRANT_CERT_PATH: certPath,
        QDRANT_KEY_PATH: keyPath,
        QDRANT_KEY_PASSPHRASE: 'hunter2',
      }),
    );

    expect(material?.cert?.toString()).toBe(CERT_PEM);
    expect(material?.key?.toString()).toBe(KEY_PEM);
    expect(material?.passphrase).toBe('hunter2');
  });

  it('omits the passphrase when it is not set', () => {
    const material = buildQdrantTlsMaterial(
      baseConfig({ QDRANT_CERT_PATH: certPath, QDRANT_KEY_PATH: keyPath }),
    );

    expect(material?.passphrase).toBeUndefined();
  });

  it('combines CA and client certificate', () => {
    const material = buildQdrantTlsMaterial(
      baseConfig({
        QDRANT_CA_PATH: caPath,
        QDRANT_CERT_PATH: certPath,
        QDRANT_KEY_PATH: keyPath,
      }),
    );

    expect(material?.ca?.toString()).toBe(CA_PEM);
    expect(material?.cert?.toString()).toBe(CERT_PEM);
  });

  it('turns verification off for QDRANT_VERIFY_SSL=false, even with no files', () => {
    const material = buildQdrantTlsMaterial(baseConfig({ QDRANT_VERIFY_SSL: false }));

    expect(material).toEqual<QdrantTlsMaterial>({ rejectUnauthorized: false });
  });

  it('fails with the path but never the file contents when a PEM is missing', () => {
    const missing = join(dir, 'nope.pem');

    let caught: unknown;
    try {
      buildQdrantTlsMaterial(baseConfig({ QDRANT_CA_PATH: missing }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(QdrantTlsConfigError);
    const message = (caught as Error).message;
    expect(message).toContain('QDRANT_CA_PATH');
    expect(message).toContain(missing);
    expect(message).toContain('ENOENT');
  });

  it('never leaks key bytes or the passphrase when the cert is unreadable', () => {
    const missing = join(dir, 'absent_crt.crt');
    const cfg = baseConfig({
      QDRANT_CERT_PATH: missing,
      QDRANT_KEY_PATH: keyPath,
      QDRANT_KEY_PASSPHRASE: 'hunter2',
    });

    expect(() => buildQdrantTlsMaterial(cfg)).toThrow(QdrantTlsConfigError);

    try {
      buildQdrantTlsMaterial(cfg);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('super-secret-key-bytes');
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('describeQdrantTls', () => {
  it('reports the system store when nothing is configured', () => {
    expect(describeQdrantTls(baseConfig())).toEqual({
      qdrantTls: 'system',
      qdrantClientCert: false,
      qdrantVerifySsl: true,
    });
  });

  it('reports a custom store and a client certificate, without any path', () => {
    const summary = describeQdrantTls(
      baseConfig({
        QDRANT_CA_PATH: caPath,
        QDRANT_CERT_PATH: certPath,
        QDRANT_KEY_PATH: keyPath,
        QDRANT_KEY_PASSPHRASE: 'hunter2',
      }),
    );

    expect(summary).toEqual({
      qdrantTls: 'custom',
      qdrantClientCert: true,
      qdrantVerifySsl: true,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(caPath);
    expect(serialized).not.toContain(keyPath);
    expect(serialized).not.toContain('hunter2');
  });

  it('counts disabled verification as a custom setup', () => {
    expect(describeQdrantTls(baseConfig({ QDRANT_VERIFY_SSL: false })).qdrantTls).toBe('custom');
  });
});

describe('installQdrantTls', () => {
  afterEach(() => {
    resetQdrantTlsForTests();
  });

  /** Installs against a fake tls module; returns it plus the recorded calls. */
  function install(cfg: QdrantTlsConfig, log: QdrantTlsLogger = silentLog): FakeTls {
    const fake = fakeTls();
    installQdrantTls(cfg, log, { tlsModule: fake.module });
    return fake;
  }

  /** The options object the patched `connect` forwarded to the original. */
  function forwardedOptions(calls: unknown[][], index = 0): Record<string, unknown> {
    return calls[index]?.[0] as Record<string, unknown>;
  }

  it('does not patch tls.connect when nothing is configured', () => {
    const fake = install(baseConfig());

    expect(fake.module.connect).toBe(fake.original);
  });

  it('patches tls.connect once something is configured', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));

    expect(fake.module.connect).not.toBe(fake.original);
  });

  it('adds only the CA for a Qdrant connection when just the CA is configured', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));

    fake.module.connect({ host: QDRANT_HOST, port: QDRANT_PORT, servername: QDRANT_HOST });

    const options = forwardedOptions(fake.calls);
    expect((options.ca as Buffer).toString()).toBe(CA_PEM);
    expect(options.cert).toBeUndefined();
    expect(options.key).toBeUndefined();
    expect(options.rejectUnauthorized).toBe(true);
  });

  it('adds cert, key and passphrase for a Qdrant connection', () => {
    const fake = install(
      baseConfig({
        QDRANT_CERT_PATH: certPath,
        QDRANT_KEY_PATH: keyPath,
        QDRANT_KEY_PASSPHRASE: 'hunter2',
      }),
    );

    fake.module.connect({ host: QDRANT_HOST, port: QDRANT_PORT });

    const options = forwardedOptions(fake.calls);
    expect((options.cert as Buffer).toString()).toBe(CERT_PEM);
    expect((options.key as Buffer).toString()).toBe(KEY_PEM);
    expect(options.passphrase).toBe('hunter2');
  });

  it('turns off verification for the Qdrant host when QDRANT_VERIFY_SSL=false', () => {
    const fake = install(baseConfig({ QDRANT_VERIFY_SSL: false }));

    fake.module.connect({ host: QDRANT_HOST, port: QDRANT_PORT });

    expect(forwardedOptions(fake.calls).rejectUnauthorized).toBe(false);
  });

  it('leaves a foreign host completely alone (GigaChat over node:https)', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath, QDRANT_VERIFY_SSL: false }));
    const gigachat = { host: GIGACHAT_HOST, servername: GIGACHAT_HOST, port: 443 };

    fake.module.connect(gigachat);

    const options = forwardedOptions(fake.calls);
    expect(options).toBe(gigachat);
    expect(options.ca).toBeUndefined();
    expect(options.rejectUnauthorized).toBeUndefined();
  });

  it('leaves the same host on a different port alone', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));
    const other = { host: QDRANT_HOST, port: 443 };

    fake.module.connect(other);

    expect(forwardedOptions(fake.calls)).toBe(other);
  });

  it('matches the default port 443 when QDRANT_URL omits it', () => {
    const fake = install(
      baseConfig({ QDRANT_URL: `https://${QDRANT_HOST}`, QDRANT_CA_PATH: caPath }),
    );

    // undici fills in port 443 itself; a caller that omits it must match too.
    fake.module.connect({ host: QDRANT_HOST, port: 443 });
    fake.module.connect({ host: QDRANT_HOST });

    expect(forwardedOptions(fake.calls, 0).ca).toBeDefined();
    expect(forwardedOptions(fake.calls, 1).ca).toBeDefined();
  });

  it('compares the host case-insensitively', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));

    fake.module.connect({ host: QDRANT_HOST.toUpperCase(), port: QDRANT_PORT });

    expect(forwardedOptions(fake.calls).ca).toBeDefined();
  });

  it('matches on servername when host is absent, and on a string port', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));

    fake.module.connect({ servername: QDRANT_HOST, port: `${QDRANT_PORT}` });

    expect(forwardedOptions(fake.calls).ca).toBeDefined();
  });

  it('never mutates the options object it was given', () => {
    const fake = install(
      baseConfig({ QDRANT_CA_PATH: caPath, QDRANT_CERT_PATH: certPath, QDRANT_KEY_PATH: keyPath }),
    );
    const original = { host: QDRANT_HOST, port: QDRANT_PORT, ALPNProtocols: ['http/1.1'] };
    const snapshot = { ...original };

    fake.module.connect(original);

    expect(original).toEqual(snapshot);
    expect(forwardedOptions(fake.calls)).not.toBe(original);
    // Caller-supplied fields survive the copy.
    expect(forwardedOptions(fake.calls).ALPNProtocols).toEqual(['http/1.1']);
  });

  it('delegates the (port, host, …) overload untouched', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));
    const callback = () => undefined;

    fake.module.connect(QDRANT_PORT, QDRANT_HOST, callback);

    expect(fake.calls[0]).toEqual([QDRANT_PORT, QDRANT_HOST, callback]);
  });

  it('forwards the callback alongside the patched options', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));
    const callback = () => undefined;

    fake.module.connect({ host: QDRANT_HOST, port: QDRANT_PORT }, callback);

    expect(fake.calls[0]?.[1]).toBe(callback);
  });

  it('returns whatever the original tls.connect returns', () => {
    const fake = install(baseConfig({ QDRANT_CA_PATH: caPath }));

    expect(fake.module.connect({ host: QDRANT_HOST, port: QDRANT_PORT })).toBe('socket');
    expect(fake.module.connect({ host: GIGACHAT_HOST, port: 443 })).toBe('socket');
  });

  it('is idempotent — a second install does not wrap twice', () => {
    const cfg = baseConfig({ QDRANT_CA_PATH: caPath });
    const first = install(cfg);
    const wrapper = first.module.connect;

    const second = fakeTls();
    installQdrantTls(cfg, silentLog, { tlsModule: second.module });

    expect(first.module.connect).toBe(wrapper);
    expect(second.module.connect).toBe(second.original);
  });

  it('restores the original connect on reset and can install again', () => {
    const cfg = baseConfig({ QDRANT_CA_PATH: caPath });
    const fake = install(cfg);
    expect(fake.module.connect).not.toBe(fake.original);

    resetQdrantTlsForTests();
    expect(fake.module.connect).toBe(fake.original);

    const again = install(cfg);
    expect(again.module.connect).not.toBe(again.original);
  });

  it('rejects an unparseable QDRANT_URL instead of failing later on TLS', () => {
    expect(() =>
      installQdrantTls({ QDRANT_URL: 'not-a-url', QDRANT_VERIFY_SSL: false }, silentLog, {
        tlsModule: fakeTls().module,
      }),
    ).toThrow(QdrantTlsConfigError);
  });

  it('reads PEMs through the injected reader', () => {
    const readFile = vi.fn<(path: string) => Buffer>(() => Buffer.from(CA_PEM));
    const fake = fakeTls();

    installQdrantTls(baseConfig({ QDRANT_CA_PATH: '/certs/cacert.pem' }), silentLog, {
      tlsModule: fake.module,
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith('/certs/cacert.pem');
  });

  it('logs modes only — no paths, no passphrase', () => {
    const entries: Array<[object, string]> = [];
    const log: QdrantTlsLogger = {
      info: (obj, msg) => entries.push([obj, msg]),
      warn: () => undefined,
    };

    install(
      baseConfig({
        QDRANT_CA_PATH: caPath,
        QDRANT_CERT_PATH: certPath,
        QDRANT_KEY_PATH: keyPath,
        QDRANT_KEY_PASSPHRASE: 'hunter2',
      }),
      log,
    );

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain('"qdrantClientCert":true');
    expect(serialized).not.toContain(keyPath);
    expect(serialized).not.toContain(caPath);
    expect(serialized).not.toContain('hunter2');
  });

  it('leaves the real node:tls module untouched when tests inject a fake', () => {
    const realConnect = tls.connect;

    install(baseConfig({ QDRANT_CA_PATH: caPath }));

    expect(tls.connect).toBe(realConnect);
  });
});
