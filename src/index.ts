import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type RequestHandler } from 'express';
import { config } from './config.js';
import { NativeHarness } from './harness/native.js';
import { buildMcpServer } from './mcp.js';
import { TaskStore } from './store.js';
import { Worker } from './worker.js';

for (const dir of [config.home, config.reposDir, config.worktreesDir, config.logsDir]) mkdirSync(dir, { recursive: true });

const store = new TaskStore(config.dbPath);
const requeued = store.requeueInterrupted();
if (requeued) console.log(`[delegate] requeued ${requeued} interrupted task(s)`);

const worker = new Worker(store, new NativeHarness());
worker.start();

const expected = Buffer.from(`Bearer ${config.token}`);
const requireToken: RequestHandler = (req, res, next) => {
  const got = Buffer.from(req.get('authorization') ?? '');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/healthz', (_req, res) => { res.json({ ok: true, model: config.model.name }); });

app.post('/mcp', requireToken, async (req, res) => {
  const server = buildMcpServer(store, worker);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`[delegate] listening on http://${config.host}:${config.port}/mcp — model ${config.model.name} @ ${config.model.baseUrl}`);
});

const shutdown = () => {
  console.log('[delegate] shutting down');
  worker.stop();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
