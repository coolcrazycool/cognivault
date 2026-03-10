import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

function gracefulShutdown(signal: string): void {
  app.log.info(`Received ${signal}, shutting down gracefully`);
  app.close().then(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
