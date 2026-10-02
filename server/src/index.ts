import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const { app, ctx } = await buildApp(config);

  if (ctx.setupToken) {
    const line = '='.repeat(72);
    app.log.warn(
      `\n${line}\n  FIRST RUN — no users exist yet.\n  Open ${config.publicUrl} and create the admin account with this one-time setup token:\n\n      ${ctx.setupToken}\n\n  (or run: npm run cli -- create-admin <username>)\n${line}`,
    );
  }
  if (!config.secureCookies && config.isProd) {
    app.log.warn(`PUBLIC_URL is not https (${config.publicUrl}). Cookies will not be marked Secure — only do this on a trusted LAN.`);
  }

  const maintenance = setInterval(() => {
    try {
      ctx.sessions.prune();
      ctx.ipThrottle.sweep();
      const rec = ctx.recorder.prune(config.recordingsRetentionDays);
      const aud = ctx.audit.prune(365);
      if (rec || aud) app.log.info({ recordings: rec, auditRows: aud }, 'retention cleanup');
    } catch (err) {
      app.log.error({ err }, 'maintenance failed');
    }
  }, 10 * 60_000);
  maintenance.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    clearInterval(maintenance);
    try {
      await app.close();
    } finally {
      ctx.db.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`WebSSH listening on ${config.host}:${config.port} — public URL ${config.publicUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
