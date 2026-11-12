// 로컬 개발용 서버 (배포 시에는 사용하지 않음 — Vercel 이 정적 파일과 /api 를 직접 처리)
// 실행: node dev-server.js   →  http://localhost:5500
const http = require("http");
const fs = require("fs");
const path = require("path");

// .env.local / .env 읽기 (GEMINI_API_KEY 등)
for (const f of [".env.local", ".env"]) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const chat = require("./api/chat");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PORT = process.env.PORT || 5500;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/chat") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      req.body = raw;
      res.status = (c) => ((res.statusCode = c), res);
      res.json = (o) => (res.setHeader("Content-Type", "application/json; charset=utf-8"), res.end(JSON.stringify(o)));
      return chat(req, res);
    }
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(__dirname, rel);
    if (!file.startsWith(__dirname) || rel.startsWith("/api/") || rel.startsWith("/.env")) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end("Not found"); }
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}  (GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? "설정됨" : "없음"})`));
