import { createServer } from 'node:http';
import { env, isPushConfigured, isS3Configured, isStripeConfigured } from './env.js';
import { createApp } from './app.js';
import { initGateway } from './realtime/gateway.js';
import { disconnect, prisma } from './prisma.js';

async function main(): Promise<void> {
  await prisma.$connect();

  const app = createApp();
  const server = createServer(app);
  initGateway(server);

  server.listen(env.PORT, () => {
    const flag = (on: boolean) => (on ? 'on' : 'not configured');
    // eslint-disable-next-line no-console
    console.log(
      `\nLogicClass+ server\n` +
      `  api        http://localhost:${env.PORT}/api\n` +
      `  socket.io  ws://localhost:${env.PORT}\n` +
      `  origins    ${env.WEB_ORIGIN}\n` +
      `  stripe     ${flag(isStripeConfigured())}\n` +
      `  web push   ${flag(isPushConfigured())}\n` +
      `  s3         ${flag(isS3Configured())} (falls back to ${env.LOCAL_UPLOAD_DIR})\n`,
    );
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => { void disconnect().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', err);
  process.exit(1);
});
