// 無相依的靜態伺服器（測試與本機預覽用）。只提供專案目錄內的檔案。
// 用法：node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

export const startServer = (port = 0) => new Promise((ok) => {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://x');
            let p = decodeURIComponent(url.pathname);
            if (p.endsWith('/')) p += 'index.html';
            const file = resolve(join(root, p));
            if (!file.startsWith(root + sep) || /[\\/](?:\.git|node_modules)[\\/]/.test(file)) { res.writeHead(403).end(); return; }
            if (!(await stat(file)).isFile()) throw new Error('not file');
            res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(await readFile(file));
        } catch { res.writeHead(404).end('not found'); }
    });
    server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` }));
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { server } = await startServer(Number(process.argv[2]) || 8765);
    // 印出 localhost（不是 127.0.0.1）：Google OAuth 的「已授權 JavaScript 來源」比對的是完整來源字串，
    // 本專案設定的是 http://localhost:8765；用 127.0.0.1 開啟會得到 origin_mismatch。
    console.log(`Serving ${root} at http://localhost:${server.address().port}/`);
}
