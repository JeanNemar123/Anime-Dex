// Serveur AnimeDex : zéro dépendance (Node >= 22.13, SQLite intégré)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(crypto.scrypt);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "./data/animedex.db";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ORIGINS = (process.env.CORS_ORIGINS || "https://localhost,capacitor://localhost,http://localhost").split(",");
const MAX_BODY = 5 * 1024 * 1024, SESSION_MS = 90 * 864e5;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, pseudo TEXT UNIQUE COLLATE NOCASE NOT NULL, salt BLOB NOT NULL, hash BLOB NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS data(user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0);`);
const st = {
  user: db.prepare("SELECT * FROM users WHERE pseudo = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  addUser: db.prepare("INSERT INTO users(pseudo,salt,hash,created) VALUES(?,?,?,?)"),
  addSess: db.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)"),
  sess: db.prepare("SELECT user_id, expires FROM sessions WHERE token = ?"),
  delSess: db.prepare("DELETE FROM sessions WHERE token = ?"),
  purge: db.prepare("DELETE FROM sessions WHERE expires < ?"),
  getData: db.prepare("SELECT json, rev FROM data WHERE user_id = ?"),
  putData: db.prepare("INSERT INTO data(user_id,json,rev) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, rev=excluded.rev"),
  delData: db.prepare("DELETE FROM data WHERE user_id = ?"),
  delUserSess: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  delUser: db.prepare("DELETE FROM users WHERE id = ?"),
};
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const DUMMY = crypto.randomBytes(16);
const validPseudo = (p) => typeof p === "string" && /^[A-Za-z0-9_.-]{3,20}$/.test(p);

const hits = new Map();
const limited = (ip) => { const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 6e5); a.push(now); hits.set(ip, a); return a.length > 20; };
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 6e5)) hits.delete(k); st.purge.run(now); }, 6e5).unref();
st.purge.run(Date.now());

function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(b); }
async function readJson(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error("big"), { status: 413 }); chunks.push(c); }
  if (!n) return {};
  try { const j = JSON.parse(Buffer.concat(chunks).toString()); return j && typeof j === "object" ? j : {}; } catch { throw Object.assign(new Error("json"), { status: 400 }); }
}
function authed(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/); if (!m) return null;
  const h = sha(m[1]), s = st.sess.get(h);
  return s && s.expires > Date.now() ? { userId: s.user_id, tokenHash: h } : null;
}
function newSession(userId) { const t = crypto.randomBytes(32).toString("base64url"); st.addSess.run(sha(t), userId, Date.now() + SESSION_MS); return t; }
async function checkPw(user, password) {
  const h = await scrypt(String(password ?? ""), user ? Buffer.from(user.salt) : DUMMY, 64);
  return !!user && crypto.timingSafeEqual(h, Buffer.from(user.hash));
}

async function api(req, res, url) {
  const ip = (TRUST_PROXY && (req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/health": return send(res, 200, { ok: true });
    case "POST /api/register": {
      if (limited(ip)) return send(res, 429, { error: "Trop de tentatives, réessaie dans quelques minutes." });
      const { pseudo, password } = await readJson(req);
      if (!validPseudo(pseudo)) return send(res, 400, { error: "Pseudo : 3 à 20 caractères (lettres, chiffres, _ . -)." });
      if (typeof password !== "string" || password.length < 8 || password.length > 200) return send(res, 400, { error: "Mot de passe : 8 caractères minimum." });
      if (st.user.get(pseudo)) return send(res, 409, { error: "Ce pseudo est déjà pris." });
      const salt = crypto.randomBytes(16), hash = await scrypt(password, salt, 64);
      let id; try { id = Number(st.addUser.run(pseudo, salt, hash, Date.now()).lastInsertRowid); } catch { return send(res, 409, { error: "Ce pseudo est déjà pris." }); }
      return send(res, 201, { token: newSession(id), pseudo });
    }
    case "POST /api/login": {
      if (limited(ip)) return send(res, 429, { error: "Trop de tentatives, réessaie dans quelques minutes." });
      const { pseudo, password } = await readJson(req);
      const u = st.user.get(String(pseudo ?? ""));
      if (!(await checkPw(u, password))) return send(res, 401, { error: "Pseudo ou mot de passe incorrect." });
      return send(res, 200, { token: newSession(u.id), pseudo: u.pseudo });
    }
  }
  const a = authed(req);
  if (!a) return send(res, 401, { error: "Non connecté." });
  switch (`${req.method} ${url.pathname}`) {
    case "POST /api/logout": st.delSess.run(a.tokenHash); return send(res, 200, { ok: true });
    case "GET /api/data": { const r = st.getData.get(a.userId); return send(res, 200, { rev: r ? r.rev : 0, data: r ? JSON.parse(r.json) : null }); }
    case "PUT /api/data": {
      const { baseRev, data } = await readJson(req);
      if (!data || typeof data !== "object" || !data.lib || typeof data.lib !== "object") return send(res, 400, { error: "Données invalides." });
      const cur = st.getData.get(a.userId), rev = cur ? cur.rev : 0;
      if (baseRev !== rev) return send(res, 409, { rev, data: cur ? JSON.parse(cur.json) : null });
      st.putData.run(a.userId, JSON.stringify(data), rev + 1);
      return send(res, 200, { rev: rev + 1 });
    }
    case "DELETE /api/account": {
      const { password } = await readJson(req);
      if (!(await checkPw(st.userById.get(a.userId), password))) return send(res, 401, { error: "Mot de passe incorrect." });
      st.delData.run(a.userId); st.delUserSess.run(a.userId); st.delUser.run(a.userId);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "Introuvable." });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith("/")) p += "index.html";
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Introuvable"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.anilist.co; connect-src 'self' https://graphql.anilist.co https://api.mymemory.translated.net; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      const o = req.headers.origin;
      if (o && ORIGINS.includes(o)) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS"); res.setHeader("Access-Control-Max-Age", "86400"); }
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      return await api(req, res, url);
    }
    serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.status === 413 ? "Données trop volumineuses." : "Requête invalide." });
    console.error(e); send(res, 500, { error: "Erreur serveur." });
  }
}).listen(PORT, () => console.log(`AnimeDex sur http://localhost:${PORT}`));
