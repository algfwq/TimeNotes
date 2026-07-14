import { NotebookService } from '../../bindings/changeme';
import { isMobile } from './platform';

const BRIDGE = 'http://127.0.0.1:54088';
const LS_CONN = 'timenotes.blog.connection';
const LS_SYNC = 'timenotes.blog.sync';

export type BlogConnection = {
  url: string;
  username: string;
  token: string;
  expiresAt: number;
  rememberPassword: boolean;
  password?: string;
  updatedAt?: string;
};

export type BlogSyncEntry = {
  remoteId: string;
  filename: string;
  updatedAt: string;
};

type Envelope = {
  v: number;
  type: string;
  id?: string;
  payload?: unknown;
  error?: { code: string; message: string };
};

function normalizeBlogURL(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url;
}

function toWS(url: string): string {
  const u = new URL(normalizeBlogURL(url));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const b of bytes) {
    if (b === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((b & (1 << bit)) !== 0) {
        return count;
      }
      count += 1;
    }
  }
  return count;
}

async function solvePow(salt: string, difficulty: number): Promise<string> {
  // Match Blog server: SHA-256(salt + nonce) with leading-zero bit difficulty.
  const encoder = new TextEncoder();
  for (let i = 0; i < 50_000_000; i++) {
    const nonce = String(i);
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(salt + nonce));
    if (leadingZeroBits(new Uint8Array(hash)) >= difficulty) {
      return nonce;
    }
  }
  throw new Error('PoW 计算超时');
}

class BlogSocket {
  private ws: WebSocket | null = null;
  private blogURL = '';
  /** 移动端 Go 代理鉴权用 JWT；登录成功后写入。 */
  private authToken = '';
  private pending = new Map<string, {
    resolve: (env: Envelope) => void;
    reject: (err: Error) => void;
    timer: number;
  }>();

  async connect(blogURL: string): Promise<void> {
    this.blogURL = normalizeBlogURL(blogURL);
    // Android WebView 页面是 https://wails.localhost，浏览器禁止从 HTTPS 发起 ws://。
    // 移动端改走 Go 原生 WebSocket 代理，不构造浏览器 WebSocket。
    if (isMobile()) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    const wsURL = toWS(blogURL);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsURL);
      this.ws = ws;
      const timer = window.setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`连接超时：${wsURL}（请确认 Blog 服务已启动）`));
      }, 8000);
      ws.onopen = () => {
        window.clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error(`无法连接 Blog WebSocket：${wsURL}`));
      };
      ws.onclose = () => {
        this.ws = null;
        for (const [, p] of this.pending) {
          window.clearTimeout(p.timer);
          p.reject(new Error('连接已关闭'));
        }
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        try {
          const env = JSON.parse(String(ev.data)) as Envelope;
          if (!env.id || !this.pending.has(env.id)) {
            return;
          }
          const p = this.pending.get(env.id)!;
          this.pending.delete(env.id);
          window.clearTimeout(p.timer);
          if (env.error) {
            p.reject(new Error(env.error.message || env.error.code));
          } else {
            p.resolve(env);
          }
        } catch {
          // ignore
        }
      };
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.authToken = '';
  }

  async request<T>(type: string, payload?: unknown, timeoutMs = 60000): Promise<T> {
    if (isMobile()) {
      if (!this.blogURL) {
        throw new Error('未连接');
      }
      // 登录成功后把 token 交给后续请求，Go 侧同连接先鉴权再发业务消息。
      let authToken = this.authToken;
      if (type === 'auth.login' && payload && typeof payload === 'object' && 'token' in (payload as object)) {
        authToken = '';
      }
      const raw = await NotebookService.BlogWSRequest(
        this.blogURL,
        authToken,
        type,
        JSON.stringify(payload ?? null),
        timeoutMs,
      );
      const parsed = raw === 'null' || raw === '' ? null : JSON.parse(raw);
      if (type === 'auth.login' && parsed && typeof parsed === 'object' && parsed !== null && 'token' in (parsed as object)) {
        this.authToken = String((parsed as { token: string }).token || '');
      }
      return parsed as T;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('未连接');
    }
    const id = crypto.randomUUID();
    const env: Envelope = { v: 1, type, id, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('请求超时'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (resp) => resolve((resp.payload ?? null) as T),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(env));
    });
  }
}

function readLocalConnection(): BlogConnection | null {
  try {
    const raw = localStorage.getItem(LS_CONN);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as BlogConnection;
    return cfg?.url ? cfg : null;
  } catch {
    return null;
  }
}

function writeLocalConnection(cfg: BlogConnection) {
  // Never persist plaintext passwords in browser storage. Prefer the local bridge
  // encrypted store; localStorage only keeps non-secret connection metadata/token.
  const safe: BlogConnection = {
    ...cfg,
    password: '',
  };
  localStorage.setItem(LS_CONN, JSON.stringify(safe));
}

function readLocalSync(): Record<string, BlogSyncEntry> {
  try {
    const raw = localStorage.getItem(LS_SYNC);
    if (!raw) return {};
    const data = JSON.parse(raw) as { entries?: Record<string, BlogSyncEntry> };
    return data.entries || {};
  } catch {
    return {};
  }
}

function writeLocalSync(entries: Record<string, BlogSyncEntry>) {
  localStorage.setItem(LS_SYNC, JSON.stringify({ entries }));
}

export async function loadBlogConnection(): Promise<BlogConnection | null> {
  // Android：无 54088 桥，走 Wails 持久化（含加密密码）。
  if (isMobile()) {
    try {
      const cfg = (await NotebookService.GetBlogConnection()) as BlogConnection;
      if (cfg?.url) {
        writeLocalConnection(cfg);
        return cfg;
      }
    } catch {
      // fall through to localStorage
    }
    return readLocalConnection();
  }
  try {
    const resp = await fetch(`${BRIDGE}/api/blog-bridge/connection`);
    if (resp.ok) {
      const cfg = (await resp.json()) as BlogConnection;
      if (cfg?.url) {
        writeLocalConnection(cfg);
        return cfg;
      }
    }
  } catch {
    // bridge unavailable — fall back to localStorage
  }
  return readLocalConnection();
}

export async function saveBlogConnection(cfg: BlogConnection): Promise<void> {
  writeLocalConnection(cfg);
  if (isMobile()) {
    try {
      await NotebookService.SaveBlogConnectionConfig(cfg as any);
    } catch (err) {
      console.warn('mobile blog connection save failed', err);
    }
    return;
  }
  try {
    const resp = await fetch(`${BRIDGE}/api/blog-bridge/connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!resp.ok) {
      // local save already done; bridge optional
      console.warn('blog bridge save failed', await resp.text());
    }
  } catch (err) {
    console.warn('blog bridge unreachable while saving connection', err);
  }
}

export async function loadBlogSyncMap(): Promise<Record<string, BlogSyncEntry>> {
  if (isMobile()) {
    try {
      const data = (await NotebookService.GetBlogSyncMap()) as { entries?: Record<string, BlogSyncEntry> };
      const entries = data.entries || {};
      writeLocalSync(entries);
      return entries;
    } catch {
      return readLocalSync();
    }
  }
  try {
    const resp = await fetch(`${BRIDGE}/api/blog-bridge/sync`);
    if (resp.ok) {
      const data = (await resp.json()) as { entries?: Record<string, BlogSyncEntry> };
      const entries = data.entries || {};
      writeLocalSync(entries);
      return entries;
    }
  } catch {
    // fall through
  }
  return readLocalSync();
}

export async function saveBlogSyncEntry(notebookId: string, remoteId: string, filename: string): Promise<void> {
  const entries = readLocalSync();
  entries[notebookId] = {
    remoteId,
    filename,
    updatedAt: new Date().toISOString(),
  };
  writeLocalSync(entries);
  if (isMobile()) {
    try {
      await NotebookService.PutBlogSyncEntry(notebookId, remoteId, filename);
    } catch {
      // local already saved
    }
    return;
  }
  try {
    await fetch(`${BRIDGE}/api/blog-bridge/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebookId, remoteId, filename }),
    });
  } catch {
    // local already saved
  }
}

export async function testBlogConnection(input: {
  url: string;
  username: string;
  password: string;
  rememberPassword: boolean;
}): Promise<BlogConnection> {
  const url = normalizeBlogURL(input.url);

  // 移动端：PoW 与 login 必须在同一 WebSocket 会话；用 Go 一次完成。
  if (isMobile()) {
    try {
      const login = await NotebookService.BlogLogin(url, input.username, input.password, 120_000);
      const cfg: BlogConnection = {
        url,
        username: login.username || input.username,
        token: login.token,
        expiresAt: Number(login.expiresAt) || 0,
        rememberPassword: input.rememberPassword,
        password: input.rememberPassword ? input.password : '',
        updatedAt: new Date().toISOString(),
      };
      await saveBlogConnection(cfg);
      return cfg;
    } catch (e) {
      const msg = String(e);
      throw new Error(
        `${msg}。请确认 Blog 地址正确且服务已启动（手机请填电脑局域网 IP，例如 http://192.168.x.x:8090，不要用 127.0.0.1）`,
      );
    }
  }

  const sock = new BlogSocket();
  try {
    await sock.connect(url);
  } catch (e) {
    const msg = String(e);
    throw new Error(
      `${msg}。请确认 Blog 地址正确且服务已启动（默认 http://127.0.0.1:8090）`,
    );
  }
  try {
    const challenge = await sock.request<{ id: string; salt: string; difficulty: number }>('auth.pow.challenge', {});
    const nonce = await solvePow(challenge.salt, challenge.difficulty);
    const login = await sock.request<{
      token: string;
      username: string;
      role: string;
      expiresAt: number;
      canUpload?: boolean;
    }>('auth.login', {
      username: input.username,
      password: input.password,
      challengeId: challenge.id,
      nonce,
    });
    await sock.request('auth.session', { token: login.token });
    await sock.request('auth.ping', {});

    const cfg: BlogConnection = {
      url,
      username: login.username || input.username,
      token: login.token,
      expiresAt: login.expiresAt,
      rememberPassword: input.rememberPassword,
      password: input.rememberPassword ? input.password : '',
      updatedAt: new Date().toISOString(),
    };
    await saveBlogConnection(cfg);
    return cfg;
  } finally {
    sock.close();
  }
}

async function ensureAuthedSocket(conn: BlogConnection): Promise<BlogSocket> {
  const sock = new BlogSocket();
  await sock.connect(conn.url);
  try {
    if (conn.token) {
      await sock.request('auth.login', { token: conn.token });
      return sock;
    }
  } catch {
    // fall through to password login
  }
  if (!conn.password) {
    sock.close();
    throw new Error('登录已过期，请重新连接 Blog 并输入密码');
  }

  // 移动端密码重登同样必须同连接 PoW。
  if (isMobile()) {
    const login = await NotebookService.BlogLogin(conn.url, conn.username, conn.password, 120_000);
    conn.token = login.token;
    conn.expiresAt = Number(login.expiresAt) || 0;
    if (login.username) {
      conn.username = login.username;
    }
    await saveBlogConnection(conn);
    // 后续上传用 token 鉴权；再 connect 一次让 sock 记住 URL + token。
    const authed = new BlogSocket();
    await authed.connect(conn.url);
    await authed.request('auth.login', { token: conn.token });
    return authed;
  }

  const challenge = await sock.request<{ id: string; salt: string; difficulty: number }>('auth.pow.challenge', {});
  const nonce = await solvePow(challenge.salt, challenge.difficulty);
  const login = await sock.request<{ token: string; expiresAt: number; username: string }>('auth.login', {
    username: conn.username,
    password: conn.password,
    challengeId: challenge.id,
    nonce,
  });
  conn.token = login.token;
  conn.expiresAt = login.expiresAt;
  await saveBlogConnection(conn);
  await sock.request('auth.session', { token: login.token });
  return sock;
}

function decodeBase64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    data[i] = binary.charCodeAt(i);
  }
  return data;
}

async function readNotebookBytes(notebookId: string): Promise<{ filename: string; data: Uint8Array; name: string }> {
  // Android：通过 Go 绑定读取 .tnote（移动端不启动 54088 桥）。
  if (isMobile()) {
    const body = await NotebookService.GetNotebookBytesForBlog(notebookId);
    if (!body?.dataBase64) {
      throw new Error('读取手账包失败：空数据');
    }
    return {
      filename: body.filename || `${notebookId}.tnote`,
      name: body.name || body.filename || notebookId,
      data: decodeBase64ToBytes(body.dataBase64),
    };
  }
  let resp: Response;
  try {
    resp = await fetch(`${BRIDGE}/api/blog-bridge/notebook-bytes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: notebookId }),
    });
  } catch {
    throw new Error('无法连接本地桥 127.0.0.1:54088，请确认 TimeNotes 客户端已启动');
  }
  if (!resp.ok) {
    throw new Error(await resp.text());
  }
  const body = (await resp.json()) as { filename: string; dataBase64: string; name: string };
  return {
    filename: body.filename,
    name: body.name,
    data: decodeBase64ToBytes(body.dataBase64),
  };
}

async function uploadChunks(
  sock: BlogSocket,
  startType: string,
  chunkType: string,
  finishType: string,
  startPayload: Record<string, unknown>,
  data: Uint8Array,
) {
  const start = await sock.request<{ uploadId: string; chunkSize: number }>(startType, startPayload);
  const chunkSize = start.chunkSize || 256 * 1024;
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  const sha256 = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (let offset = 0, index = 0; offset < data.length; offset += chunkSize, index++) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    let binary = '';
    for (let i = 0; i < slice.length; i++) {
      binary += String.fromCharCode(slice[i]);
    }
    await sock.request(chunkType, {
      uploadId: start.uploadId,
      index,
      data: btoa(binary),
    }, 120000);
  }
  return sock.request<{ note: { id: string; filename: string } }>(finishType, {
    uploadId: start.uploadId,
    sha256,
  }, 120000);
}

export async function uploadNotebookToBlog(notebookId: string): Promise<{ remoteId: string; filename: string }> {
  const conn = await loadBlogConnection();
  if (!conn?.url) {
    throw new Error('尚未连接 Blog');
  }
  const file = await readNotebookBytes(notebookId);
  const sock = await ensureAuthedSocket(conn);
  try {
    const res = await uploadChunks(
      sock,
      'notes.upload.start',
      'notes.upload.chunk',
      'notes.upload.finish',
      {
        filename: file.filename,
        title: file.name || file.filename.replace(/\.tnote$/i, ''),
        size: file.data.length,
      },
      file.data,
    );
    await saveBlogSyncEntry(notebookId, res.note.id, res.note.filename || file.filename);
    return { remoteId: res.note.id, filename: res.note.filename || file.filename };
  } finally {
    sock.close();
  }
}

export async function updateNotebookOnBlog(notebookId: string, remoteId: string): Promise<{ remoteId: string; filename: string }> {
  const conn = await loadBlogConnection();
  if (!conn?.url) {
    throw new Error('尚未连接 Blog');
  }
  const file = await readNotebookBytes(notebookId);
  const sock = await ensureAuthedSocket(conn);
  try {
    const res = await uploadChunks(
      sock,
      'notes.update.start',
      'notes.update.chunk',
      'notes.update.finish',
      {
        noteId: remoteId,
        filename: file.filename,
        title: file.name || file.filename.replace(/\.tnote$/i, ''),
        size: file.data.length,
      },
      file.data,
    );
    await saveBlogSyncEntry(notebookId, res.note.id, res.note.filename || file.filename);
    return { remoteId: res.note.id, filename: res.note.filename || file.filename };
  } finally {
    sock.close();
  }
}
