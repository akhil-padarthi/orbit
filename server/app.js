import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDatabase, closeDatabase } from './db/database.js';
import { seedDatabase, isSeeded } from './db/seed.js';
import { createRouter, handleError } from './lib/router.js';
import { applySecurityHeaders, sendJson } from './lib/http.js';
import { logger } from './lib/logger.js';
import { attachRealtime, closeRealtime } from './realtime/hub.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { setInternalOrigin } from './integrations/client.js';
import { registerMockProviders } from './integrations/mock/providers.js';

import { registerAuthRoutes } from './modules/auth.js';
import { registerUserRoutes } from './modules/users.js';
import { registerCampusRoutes } from './modules/campuses.js';
import { registerScheduleRoutes } from './modules/schedule.js';
import { registerAttendanceRoutes } from './modules/attendance.js';
import { registerRequestRoutes } from './modules/requests.js';
import { registerMessageRoutes } from './modules/messages.js';
import { registerAnnouncementRoutes } from './modules/announcements.js';
import { registerNotificationRoutes } from './modules/notifications.js';
import { registerIntegrationRoutes } from './modules/integrations.js';
import { registerDashboardRoutes } from './modules/dashboard.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function buildRouter() {
  const router = createRouter();
  registerDashboardRoutes(router);
  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerCampusRoutes(router);
  registerScheduleRoutes(router);
  registerAttendanceRoutes(router);
  registerRequestRoutes(router);
  registerMessageRoutes(router);
  registerAnnouncementRoutes(router);
  registerNotificationRoutes(router);
  registerIntegrationRoutes(router);
  if (config.demoMode) registerMockProviders(router);
  return router;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url, 'http://localhost');
  const root = config.clientDir;
  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) return false; // path traversal guard
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend not built yet. Run `npm run build`, then reload.');
    return true;
  }
  const ext = path.extname(file);
  const immutable = url.pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

/** Start Orbit. Returns { server, port, url, close }. */
export async function startServer({ port = config.port, host = config.host, dbFile = config.dbFile, seed = true } = {}) {
  openDatabase(dbFile);
  // Demo data is only loaded automatically in demo mode; production starts empty (see scripts/create-tenant.js).
  if (seed && config.demoMode && !isSeeded()) {
    await seedDatabase();
    logger.info('Seeded demo data');
  }
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    const started = Date.now();
    res.on('finish', () => {
      if (req.url.startsWith('/api')) logger.debug('request', { method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started });
    });
    try {
      if (await router.handle(req, res)) return;
      if (req.url.startsWith('/api/')) return sendJson(res, 404, { error: { code: 'not_found', message: 'No such endpoint' } });
      if (!serveStatic(req, res)) sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    } catch (err) {
      handleError(res, err, req);
    }
  });
  attachRealtime(server);

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  setInternalOrigin(config.publicUrl ?? `http://127.0.0.1:${actualPort}`);
  startWorker();
  logger.info(`${config.appName} listening`, { url: `http://localhost:${actualPort}`, demoMode: config.demoMode });

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    async close() {
      await stopWorker();
      await closeRealtime();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      closeDatabase();
    },
  };
}
