const path = require('node:path');

const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = process.env.STATIC_ROOT ? path.resolve(process.env.STATIC_ROOT) : path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || process.argv[2] || 4173);
const URL = `http://127.0.0.1:${PORT}`;

async function main() {
  const server = await startLocalStaticServer({ url: URL, cwd: ROOT, cacheControl: process.env.STATIC_CACHE_CONTROL || 'no-cache' });
  console.log(`Serving ${ROOT}`);
  console.log(`Local: ${server.url}`);
  console.log('Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(`Failed to start static server: ${error.message}`);
  process.exitCode = 1;
});
