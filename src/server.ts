import { buildApp } from './app.js';
import { config } from './config.js';
import { shutdownTracing } from './lib/tracing.js';

if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { initTracing } = await import('./lib/tracing.js');
  initTracing(config.OTEL_EXPORTER_OTLP_ENDPOINT);
}

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function gracefulShutdown(signal: string): void {
  app.log.info(`Received ${signal}, shutting down gracefully`);
  app.close().then(async () => {
    await shutdownTracing();
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
