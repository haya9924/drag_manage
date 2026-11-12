/**
 * 服薬管理サーバのエントリポイント。
 * 依存パッケージなし。Node 22.18+ の型剥がしで .ts を直接実行する。
 */
import { createServer } from 'node:http';
import { createApp } from './src/app.ts';

const port = Number(process.env.PORT ?? 8898);
// 既定ではローカルホストだけに待ち受ける。LAN などへ公開する場合は HOST を明示する。
const host = process.env.HOST?.trim() || '127.0.0.1';
const app = createApp();

const server = createServer((req, res) => {
    void app.handler(req, res);
});

server.listen(port, host, () => {
    const displayHost = host.includes(':') ? `[${host}]` : host;
    console.log(`服薬管理サーバ: http://${displayHost}:${port}`);
    const agentToken = process.env.HERMES_TOKEN?.trim() || process.env.INGEST_TOKEN?.trim();
    if (!agentToken) {
        console.warn('警告: HERMES_TOKEN が未設定のため /api/agent/* は無効です（fail closed）。');
    }
});

function shutdown(): void {
    server.close(() => {
        app.store.close();
        process.exit(0);
    });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
