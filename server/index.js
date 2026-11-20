import { startServer } from './app.js';
import { logger } from './lib/logger.js';

const app = await startServer();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  });
}
