import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';
import { WebSocket, WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'worship_session';
const SESSION_DAYS = 30;
const JSON_LIMIT = 2 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml; charset=utf-8']]
]);

async function loadLocalEnv() {
  try {
    const text = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* Local-only mode is still available without a .env file. */ }
}

await loadLocalEnv();

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

let database = null;
let mongoClient = null;
const activeSockets = new Set();
const authAttempts = new Map();
const wss = new WebSocketServer({ noServer: true });

function requireDatabase() {
  if (!database) throw new HttpError(503, 'MongoDB is not configured. Set MONGODB_URI in .env.');
}

function requireSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, 'Set SESSION_SECRET to at least 32 characters in .env.');
  return secret;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function cookieOptions(maxAge = SESSION_DAYS * 24 * 60 * 60) {
  const secure = process.env.SESSION_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function signToken(userId) {
  const secret = requireSessionSecret();
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function userIdFromToken(token) {
  if (!token || !token.includes('.')) return null;
  try {
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', requireSessionSecret()).update(payload).digest();
    const provided = Buffer.from(signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session.sub : null;
  } catch { return null; }
}

function setSession(res, userId) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(signToken(userId))}; ${cookieOptions()}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
}

async function getUser(req, required = true) {
  requireDatabase();
  const id = userIdFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!id || !ObjectId.isValid(id)) {
    if (required) throw new HttpError(401, 'Sign in required.');
    return null;
  }
  const user = await database.collection('users').findOne({ _id: new ObjectId(id) });
  if (!user && required) throw new HttpError(401, 'Session expired. Sign in again.');
  return user || null;
}

function publicUser(user) {
  return { id: user._id.toString(), publicId: user.publicId, email: user.email, displayName: user.displayName || user.email.split('@')[0] };
}

function makePublicId() { return `WC-${randomBytes(5).toString('hex').toUpperCase()}`; }
function normalizeRecoveryCode(value) { return String(value || '').replace(/[\s-]/g, '').toUpperCase(); }

function publicSong(song) {
  if (!song) return null;
  const { _id, groupId, updatedBy, ownerId, userId, duplicateKey, ...fields } = song;
  return { ...fields, revision: Number(fields.revision || 1), id: _id.toString(), groupId: groupId?.toString(), updatedBy: updatedBy?.toString() };
}

function publicGroup(group) {
  const { _id, ownerId, members, songIds, librarySongIds, weeklySets = [], activeSetId, ...fields } = group;
  return { ...fields, id: _id.toString(), ownerId: ownerId.toString(), songIds: (songIds || []).map((id) => id.toString()), librarySongIds: (librarySongIds || []).map((id) => id.toString()), weeklySets: weeklySets.map((set) => ({ ...set, id: set.id, songIds: (set.songIds || []).map((id) => id.toString()) })), activeSetId, members: (members || []).map((member) => ({ ...member, userId: member.userId.toString() })) };
}

function currentWeekRange(date = new Date()) {
  const bangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const start = new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate()));
  const weekday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - weekday);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  const iso = (value) => value.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request rejected.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, 'Cross-origin request rejected.');
  }
}

function authRateLimit(req) {
  const now = Date.now();
  const key = req.socket.remoteAddress || 'unknown';
  const recent = (authAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 12) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
  recent.push(now);
  authAttempts.set(key, recent);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requireGroup(groupId, userId) {
  if (!ObjectId.isValid(groupId)) throw new HttpError(400, 'Invalid group id.');
  const group = await database.collection('groups').findOne({ _id: new ObjectId(groupId) });
  if (!group) throw new HttpError(404, 'Group not found.');
  const member = group.members.find((item) => item.userId.equals(userId));
  if (!member) throw new HttpError(403, 'Group access denied.');
  const now = new Date();
  for (const set of group.weeklySets || []) {
    if (set.deletedAt && !set.expiresAt) {
      set.expiresAt = new Date(new Date(set.deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      await database.collection('groups').updateOne({ _id: group._id, 'weeklySets.id': set.id }, { $set: { 'weeklySets.$.expiresAt': set.expiresAt } });
    }
  }
  const expiredSetIds = (group.weeklySets || []).filter((set) => {
    if (!set.deletedAt) return false;
    const expiresAt = set.expiresAt ? new Date(set.expiresAt) : new Date(new Date(set.deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    return expiresAt <= now;
  }).map((set) => set.id);
  if (expiredSetIds.length) {
    await database.collection('groups').updateOne({ _id: group._id }, { $pull: { weeklySets: { id: { $in: expiredSetIds } } }, $set: { updatedAt: now } });
    group.weeklySets = (group.weeklySets || []).filter((set) => !expiredSetIds.includes(set.id));
    notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'trash_expired', setIds: expiredSetIds });
  }
  return { group, member };
}

async function purgeExpiredGroupTrash() {
  if (!database) return 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const condition = { deletedAt: { $exists: true }, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false }, deletedAt: { $lte: cutoff } }] };
  const groups = await database.collection('groups').find({ weeklySets: { $elemMatch: condition } }).toArray();
  let removed = 0;
  for (const group of groups) {
    const expiredIds = (group.weeklySets || []).filter((set) => set.deletedAt && (set.expiresAt ? new Date(set.expiresAt) <= now : new Date(set.deletedAt) <= cutoff)).map((set) => set.id);
    if (!expiredIds.length) continue;
    const result = await database.collection('groups').updateOne({ _id: group._id }, { $pull: { weeklySets: { id: { $in: expiredIds } } }, $set: { updatedAt: now } });
    if (!result.modifiedCount) continue;
    removed += expiredIds.length;
    group.weeklySets = group.weeklySets.filter((set) => !expiredIds.includes(set.id));
    notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'trash_expired', setIds: expiredIds });
  }
  return removed;
}

function requireEditor(member) {
  if (!['owner', 'editor'].includes(member.role)) throw new HttpError(403, 'This account can view but not edit.');
}

function sendSocket(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function notifyUser(userId, payload) {
  const id = userId.toString();
  for (const socket of activeSockets) if (socket.userId === id) sendSocket(socket, payload);
}

function notifyGroup(group, payload) {
  const groupId = group._id.toString();
  for (const socket of activeSockets) if (socket.groupIds.has(groupId)) sendSocket(socket, payload);
}

function safeSongInput(input = {}) {
  const key = String(input.key || 'C').slice(0, 4);
  return {
    title: String(input.title || '').trim().slice(0, 160),
    artist: String(input.artist || '').trim().slice(0, 160),
    youtubeUrl: String(input.youtubeUrl || '').trim().slice(0, 500),
    chordUrl: String(input.chordUrl || '').trim().slice(0, 500),
    key,
    sourceKeyConfirmed: input.sourceKeyConfirmed === true,
    text: String(input.text || '').slice(0, 120000)
  };
}

function normalizeDuplicateField(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('th-TH');
}

function duplicateSongKey(title, artist) {
  return JSON.stringify([normalizeDuplicateField(title), normalizeDuplicateField(artist)]);
}

function sameSongContent(left, right) {
  const a = safeSongInput(left);
  const b = safeSongInput(right);
  return ['title', 'artist', 'key', 'text'].every((field) => a[field] === b[field]);
}

async function readUserLibrary(user) {
  const personalSongs = await database.collection('personalSongs').find({ ownerId: user._id }).sort({ order: 1, _id: 1 }).toArray();
  const today = await database.collection('personalSetlists').findOne({ ownerId: user._id, id: 'today' });
  return {
    songs: personalSongs.map(publicSong),
    todaySetlist: { id: 'today', name: today?.name || 'เพลงวันนี้', songIds: (today?.songIds || []).map((id) => id.toString()), revision: Number(today?.revision || 0) },
    songOrderRevision: Number(user.songOrderRevision || 0)
  };
}

async function handleApi(req, res, url) {
  const pathParts = url.pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);
  if (pathParts[0] !== 'api') throw new HttpError(404, 'Not found.');
  requireDatabase();

  if (pathParts[1] === 'auth' && method === 'POST') {
    if (pathParts[2] !== 'logout') {
      requireSessionSecret();
      authRateLimit(req);
    }
    const body = await readJson(req);
    if (pathParts[2] === 'register') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim().slice(0, 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
      const recoveryCode = randomBytes(12).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
      const user = { email, publicId: makePublicId(), passwordHash: await hashPassword(password), recoveryCodeHash: await hashPassword(normalizeRecoveryCode(recoveryCode)), displayName, createdAt: new Date() };
      try { await database.collection('users').insertOne(user); }
      catch (error) {
        if (error.code === 11000 && error.keyPattern?.email) throw new HttpError(409, 'อีเมลนี้มีบัญชีแล้ว กรุณาเข้าสู่ระบบ');
        if (error.code === 11000 && error.keyPattern?.publicId) throw new HttpError(409, 'ระบบสร้าง ID ไม่สำเร็จ กรุณาลองใหม่');
        throw error;
      }
      const pending = await database.collection('invitations').find({ inviteeEmail: email, status: 'pending' }).toArray();
      for (const invitation of pending) {
        await database.collection('notifications').insertOne({ userId: user._id, type: 'group_invite', invitationId: invitation._id, groupId: invitation.groupId, groupName: invitation.groupName, inviterName: invitation.inviterName, role: invitation.role, readAt: null, createdAt: invitation.createdAt });
      }
      setSession(res, user._id.toString());
      return json(res, 201, { user: publicUser(user), recoveryCode });
    }
    if (pathParts[2] === 'reset-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
      const password = String(body.password || '');
      if (password.length < 10) throw new HttpError(400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 10 ตัวอักษร');
      const user = await database.collection('users').findOne({ email });
      if (!user?.recoveryCodeHash || !await verifyPassword(recoveryCode, user.recoveryCodeHash)) throw new HttpError(400, 'อีเมลหรือ recovery code ไม่ถูกต้อง หรือ code นี้ถูกใช้แล้ว');
      const changed = await database.collection('users').updateOne({ _id: user._id, recoveryCodeHash: user.recoveryCodeHash }, { $set: { passwordHash: await hashPassword(password), recoveryCodeHash: null, updatedAt: new Date() } });
      if (!changed.modifiedCount) throw new HttpError(409, 'Recovery code นี้ถูกใช้ไปแล้ว กรุณาเข้าสู่ระบบหรือขอความช่วยเหลือ');
      return json(res, 200, { ok: true });
    }
    if (pathParts[2] === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const user = await database.collection('users').findOne({ email });
      if (!user || !await verifyPassword(String(body.password || ''), user.passwordHash)) throw new HttpError(401, 'Email or password is incorrect.');
      setSession(res, user._id.toString());
      return json(res, 200, { user: publicUser(user) });
    }
    if (pathParts[2] === 'logout') {
      clearSession(res);
      return json(res, 200, { ok: true });
    }
  }

  const user = await getUser(req);
  if (pathParts[1] === 'me' && method === 'GET') return json(res, 200, { user: publicUser(user) });
  if (pathParts[1] === 'me' && pathParts[2] === 'recovery-code' && method === 'POST') {
    const recoveryCode = randomBytes(12).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
    await database.collection('users').updateOne({ _id: user._id }, { $set: { recoveryCodeHash: await hashPassword(normalizeRecoveryCode(recoveryCode)), updatedAt: new Date() } });
    return json(res, 200, { recoveryCode });
  }
  if (pathParts[1] === 'users' && pathParts[2] === 'search' && method === 'GET') {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (query.length < 2) return json(res, 200, { users: [] });
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await database.collection('users').find({ _id: { $ne: user._id }, $or: [
      { publicId: query.toUpperCase() }, { displayName: { $regex: escaped, $options: 'i' } }
    ] }, { projection: { publicId: 1, displayName: 1 } }).limit(10).toArray();
    return json(res, 200, { users: found.map((item) => ({ publicId: item.publicId, displayName: item.displayName || 'สมาชิก WorshipChord' })) });
  }

  if (pathParts[1] === 'library' && pathParts.length === 2 && method === 'GET') {
    return json(res, 200, await readUserLibrary(user));
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'import' && method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.songs) || body.songs.length > 500) throw new HttpError(400, 'Invalid song import.');
    const collection = database.collection('personalSongs');
    const existingSongs = await collection.find({ ownerId: user._id }).sort({ order: 1, _id: 1 }).toArray();
    const orderStart = existingSongs.length;
    const idMap = new Map();
    const canonicalByKey = new Map(existingSongs.map((song) => [duplicateSongKey(song.title, song.artist), song._id]));
    const documents = [];
    let duplicatesSkipped = 0;
    body.songs.forEach((source, index) => {
      const fields = safeSongInput(source);
      if (!fields.title) return;
      const duplicateKey = duplicateSongKey(fields.title, fields.artist);
      const duplicateId = canonicalByKey.get(duplicateKey);
      if (duplicateId) {
        if (source.id) idMap.set(String(source.id), duplicateId);
        duplicatesSkipped += 1;
        return;
      }
      const _id = new ObjectId();
      if (source.id) idMap.set(String(source.id), _id);
      canonicalByKey.set(duplicateKey, _id);
      documents.push({ _id, ...fields, duplicateKey, ownerId: user._id, order: orderStart + documents.length, revision: 1, createdAt: new Date(), updatedAt: new Date() });
    });
    if (documents.length) await collection.insertMany(documents);
    const importedSetlist = Array.isArray(body.todaySetlist?.songIds)
      ? body.todaySetlist.songIds.map((id) => idMap.get(String(id))).filter(Boolean)
      : [];
    let setlistDuplicatesSkipped = 0;
    if (importedSetlist.length) {
      const previous = await database.collection('personalSetlists').findOne({ ownerId: user._id, id: 'today' });
      const currentIds = previous?.songIds || [];
      const currentIdSet = new Set(currentIds.map((id) => id.toString()));
      const currentSongs = currentIds.length ? await collection.find({ ownerId: user._id, _id: { $in: currentIds } }, { projection: { title: 1, artist: 1 } }).toArray() : [];
      const seenTodayKeys = new Set(currentSongs.map((song) => duplicateSongKey(song.title, song.artist)));
      const importedSongs = await collection.find({ ownerId: user._id, _id: { $in: importedSetlist } }, { projection: { title: 1, artist: 1 } }).toArray();
      const importedSongById = new Map(importedSongs.map((song) => [song._id.toString(), song]));
      const importedIds = [];
      const importedIdSet = new Set();
      for (const songId of importedSetlist) {
        const id = songId.toString();
        if (currentIdSet.has(id) || importedIdSet.has(id)) continue;
        const song = importedSongById.get(id);
        if (!song) continue;
        const key = duplicateSongKey(song.title, song.artist);
        if (seenTodayKeys.has(key)) { setlistDuplicatesSkipped += 1; continue; }
        seenTodayKeys.add(key);
        importedIdSet.add(id);
        importedIds.push(songId);
      }
      if (importedIds.length) {
        await database.collection('personalSetlists').updateOne(
          { ownerId: user._id, id: 'today' },
          { $set: { ownerId: user._id, id: 'today', name: 'เพลงวันนี้', songIds: [...currentIds, ...importedIds], updatedAt: new Date() }, $inc: { revision: 1 } },
          { upsert: true }
        );
      }
    }
    notifyUser(user._id, { type: 'library.changed' });
    return json(res, 200, { library: await readUserLibrary(user), imported: documents.length, duplicatesSkipped, setlistDuplicatesSkipped });
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'songs' && pathParts.length === 3 && method === 'POST') {
    const body = await readJson(req);
    const fields = safeSongInput(body.song);
    if (!fields.title) throw new HttpError(400, 'Song title is required.');
    const collection = database.collection('personalSongs');
    const requestedId = ObjectId.isValid(body.song?.id) ? new ObjectId(body.song.id) : new ObjectId();
    const existing = await collection.findOne({ _id: requestedId, ownerId: user._id });
    if (existing) {
      if (sameSongContent(existing, fields)) return json(res, 200, { song: publicSong(existing), alreadyCreated: true });
      throw new HttpError(409, 'เพลงนี้ถูกสร้างบนคลาวด์แล้วและมีเนื้อหาไม่ตรงกับฉบับในเครื่อง', { song: publicSong(existing) });
    }
    const librarySongs = await collection.find({ ownerId: user._id }, { projection: { title: 1, artist: 1 } }).toArray();
    const duplicate = librarySongs.find((item) => duplicateSongKey(item.title, item.artist) === duplicateSongKey(fields.title, fields.artist));
    if (duplicate) throw new HttpError(409, `เพลง “${duplicate.title}” ของศิลปินคนนี้มีอยู่ในเพลงของฉันแล้ว`, { duplicateSongId: duplicate._id.toString(), duplicateTitle: duplicate.title });
    const song = { _id: requestedId, ...fields, duplicateKey: duplicateSongKey(fields.title, fields.artist), ownerId: user._id, order: await collection.countDocuments({ ownerId: user._id }), revision: 1, createdAt: new Date(), updatedAt: new Date() };
    try { await collection.insertOne(song); }
    catch (error) {
      if (error.code === 11000) {
        const latestDuplicate = await collection.findOne({ ownerId: user._id, duplicateKey: song.duplicateKey });
        throw new HttpError(409, `เพลง “${latestDuplicate?.title || fields.title}” ของศิลปินคนนี้มีอยู่ในเพลงของฉันแล้ว`, { duplicateSongId: latestDuplicate?._id.toString(), duplicateTitle: latestDuplicate?.title || fields.title });
      }
      throw error;
    }
    notifyUser(user._id, { type: 'library.changed' });
    return json(res, 201, { song: publicSong(song) });
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'songs' && pathParts.length === 3 && method === 'DELETE') {
    const body = await readJson(req);
    if (!Array.isArray(body.songIds) || body.songIds.length > 500) throw new HttpError(400, 'Invalid song selection.');
    const uniqueIds = [...new Set(body.songIds.map(String))];
    if (uniqueIds.some((id) => !ObjectId.isValid(id))) throw new HttpError(400, 'Invalid song id.');
    const ids = uniqueIds.map((id) => new ObjectId(id));
    const collection = database.collection('personalSongs');
    const selected = ids.length ? await collection.find({ ownerId: user._id, _id: { $in: ids } }).toArray() : [];
    if (selected.length !== ids.length) throw new HttpError(400, 'Selection contains a song outside this account.');
    if (ids.length) {
      await collection.deleteMany({ ownerId: user._id, _id: { $in: ids } });
      const todaySetlist = await database.collection('personalSetlists').findOne({ ownerId: user._id, id: 'today' }, { projection: { songIds: 1 } });
      if (todaySetlist?.songIds?.some((id) => ids.some((selectedId) => selectedId.equals(id)))) {
        await database.collection('personalSetlists').updateOne({ ownerId: user._id, id: 'today' }, { $pull: { songIds: { $in: ids } }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } });
      }
      const remaining = await collection.find({ ownerId: user._id }).sort({ order: 1, _id: 1 }).toArray();
      if (remaining.length) await collection.bulkWrite(remaining.map((song, order) => ({ updateOne: { filter: { _id: song._id, ownerId: user._id }, update: { $set: { order } } } })));
      user.songOrderRevision = Number(user.songOrderRevision || 0) + 1;
      await database.collection('users').updateOne({ _id: user._id }, { $set: { songOrderRevision: user.songOrderRevision } });
      notifyUser(user._id, { type: 'library.changed' });
    }
    return json(res, 200, { ok: true, deleted: ids.length, songOrderRevision: Number(user.songOrderRevision || 0) });
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'songs' && pathParts[3] && (method === 'PUT' || method === 'DELETE')) {
    if (!ObjectId.isValid(pathParts[3])) throw new HttpError(400, 'Invalid song id.');
    const songId = new ObjectId(pathParts[3]);
    const collection = database.collection('personalSongs');
    const existing = await collection.findOne({ _id: songId, ownerId: user._id });
    if (!existing) throw new HttpError(404, 'Song not found in this account.');
    if (method === 'DELETE') {
      const body = await readJson(req);
      const revision = Number(existing.revision || 1);
      if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== revision) throw new HttpError(409, 'This song changed on another device. Reload it before deleting.', { song: publicSong(existing) });
      const deleteFilter = { _id: songId, ownerId: user._id, ...(existing.revision === undefined ? { revision: { $exists: false } } : { revision: existing.revision }) };
      const deleteResult = await collection.deleteOne(deleteFilter);
      if (!deleteResult.deletedCount) {
        const latest = await collection.findOne({ _id: songId, ownerId: user._id });
        throw new HttpError(409, 'This song changed on another device. Reload it before deleting.', { song: publicSong(latest) });
      }
      await collection.updateMany({ ownerId: user._id, order: { $gt: existing.order } }, { $inc: { order: -1 } });
      await database.collection('personalSetlists').updateOne(
        { ownerId: user._id, id: 'today', songIds: songId },
        { $pull: { songIds: songId }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } }
      );
      notifyUser(user._id, { type: 'library.changed' });
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const revision = Number(existing.revision || 1);
    if (Number(body.expectedRevision) !== revision) throw new HttpError(409, 'This song changed on another device. Reload it before saving.', { song: publicSong(existing) });
    const fields = safeSongInput(body.song);
    if (!fields.title) throw new HttpError(400, 'Song title is required.');
    const personalSongs = await collection.find({ ownerId: user._id, _id: { $ne: songId } }, { projection: { title: 1, artist: 1 } }).toArray();
    const duplicate = personalSongs.find((item) => duplicateSongKey(item.title, item.artist) === duplicateSongKey(fields.title, fields.artist));
    if (duplicate) throw new HttpError(409, `เพลง “${duplicate.title}” ของศิลปินคนนี้มีอยู่ในเพลงของฉันแล้ว`, { duplicateSongId: duplicate._id.toString(), duplicateTitle: duplicate.title });
    const updated = { ...existing, ...fields, duplicateKey: duplicateSongKey(fields.title, fields.artist), revision: revision + 1, updatedAt: new Date() };
    const expectedSongRevisionFilter = existing.revision === undefined ? { revision: { $exists: false } } : { revision: existing.revision };
    let result;
    try { result = await collection.replaceOne({ _id: songId, ownerId: user._id, ...expectedSongRevisionFilter }, updated); }
    catch (error) {
      if (error.code === 11000) {
        const latestDuplicate = await collection.findOne({ ownerId: user._id, duplicateKey: updated.duplicateKey, _id: { $ne: songId } });
        throw new HttpError(409, `เพลง “${latestDuplicate?.title || fields.title}” ของศิลปินคนนี้มีอยู่ในเพลงของฉันแล้ว`, { duplicateSongId: latestDuplicate?._id.toString(), duplicateTitle: latestDuplicate?.title || fields.title });
      }
      throw error;
    }
    if (!result.matchedCount) throw new HttpError(409, 'This song changed on another device. Reload it before saving.');
    notifyUser(user._id, { type: 'library.changed' });
    return json(res, 200, { song: publicSong(updated) });
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'order' && method === 'PATCH') {
    const body = await readJson(req);
    if (!Array.isArray(body.songIds) || body.songIds.length > 500 || new Set(body.songIds.map(String)).size !== body.songIds.length) throw new HttpError(400, 'Invalid song order.');
    const ids = body.songIds.map((id) => { if (!ObjectId.isValid(id)) throw new HttpError(400, 'Invalid song id.'); return new ObjectId(id); });
    const collection = database.collection('personalSongs');
    const owned = ids.length ? await collection.countDocuments({ ownerId: user._id, _id: { $in: ids } }) : 0;
    const total = await collection.countDocuments({ ownerId: user._id });
    if (owned !== ids.length) throw new HttpError(400, 'Song order contains a song outside this account.');
    const revision = Number(user.songOrderRevision || 0);
    if (ids.length !== total) {
      const latest = await readUserLibrary(user);
      throw new HttpError(409, 'มีเพลงเพิ่มหรือลบจากอุปกรณ์อื่น เลือกลำดับที่จะเก็บ', { songOrderRevision: latest.songOrderRevision, songIds: latest.songs.map((song) => song.id) });
    }
    if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== revision) {
      const latest = await readUserLibrary(user);
      throw new HttpError(409, 'ลำดับเพลงเปลี่ยนจากอุปกรณ์อื่นแล้ว เลือกว่าจะใช้ลำดับใด', { songOrderRevision: latest.songOrderRevision, songIds: latest.songs.map((song) => song.id) });
    }
    const revisionFilter = revision === 0
      ? { _id: user._id, $or: [{ songOrderRevision: { $exists: false } }, { songOrderRevision: 0 }] }
      : { _id: user._id, songOrderRevision: revision };
    const revisionWrite = await database.collection('users').updateOne(revisionFilter, { $set: { songOrderRevision: revision + 1 } });
    if (!revisionWrite.matchedCount) {
      const latest = await readUserLibrary(await database.collection('users').findOne({ _id: user._id }));
      throw new HttpError(409, 'ลำดับเพลงเปลี่ยนจากอุปกรณ์อื่นแล้ว เลือกว่าจะใช้ลำดับใด', { songOrderRevision: latest.songOrderRevision, songIds: latest.songs.map((song) => song.id) });
    }
    if (ids.length) await collection.bulkWrite(ids.map((_id, order) => ({ updateOne: { filter: { _id, ownerId: user._id }, update: { $set: { order, updatedAt: new Date() } } } })));
    notifyUser(user._id, { type: 'library.changed' });
    return json(res, 200, { ok: true, songOrderRevision: revision + 1 });
  }
  if (pathParts[1] === 'library' && pathParts[2] === 'setlist' && method === 'PATCH') {
    const body = await readJson(req);
    if (!Array.isArray(body.songIds) || body.songIds.length > 500 || new Set(body.songIds.map(String)).size !== body.songIds.length) throw new HttpError(400, 'Invalid setlist.');
    const ids = body.songIds.map((id) => { if (!ObjectId.isValid(id)) throw new HttpError(400, 'Invalid song id.'); return new ObjectId(id); });
    const owned = ids.length ? await database.collection('personalSongs').countDocuments({ ownerId: user._id, _id: { $in: ids } }) : 0;
    if (owned !== ids.length) throw new HttpError(400, 'Setlist contains a song outside this account.');
    const collection = database.collection('personalSetlists');
    const existing = await collection.findOne({ ownerId: user._id, id: 'today' });
    const revision = Number(existing?.revision || 0);
    if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== revision) {
      throw new HttpError(409, 'เพลงวันนี้เปลี่ยนจากอุปกรณ์อื่นแล้ว เลือกว่าจะใช้ลำดับใด', {
        todaySetlist: { id: 'today', name: existing?.name || 'เพลงวันนี้', songIds: (existing?.songIds || []).map((id) => id.toString()), revision }
      });
    }
    const currentIds = existing?.songIds || [];
    const currentIdSet = new Set(currentIds.map((id) => id.toString()));
    const currentSongs = currentIds.length ? await database.collection('personalSongs').find({ ownerId: user._id, _id: { $in: currentIds } }, { projection: { title: 1, artist: 1 } }).toArray() : [];
    const existingCounts = new Map();
    for (const song of currentSongs) {
      const key = duplicateSongKey(song.title, song.artist);
      existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
    }
    const selectedSongs = ids.length ? await database.collection('personalSongs').find({ ownerId: user._id, _id: { $in: ids } }, { projection: { title: 1, artist: 1 } }).toArray() : [];
    const selectedById = new Map(selectedSongs.map((song) => [song._id.toString(), song]));
    const selectedCounts = new Map();
    for (const id of ids) {
      const song = selectedById.get(id.toString());
      const key = duplicateSongKey(song?.title, song?.artist);
      const count = (selectedCounts.get(key) || 0) + 1;
      selectedCounts.set(key, count);
      const isNewToToday = !currentIdSet.has(id.toString());
      const existingCount = existingCounts.get(key) || 0;
      if (count > 1 && (count > existingCount || isNewToToday)) {
        throw new HttpError(409, `เพลง “${song?.title || 'เพลงไม่มีชื่อ'}” ของศิลปินคนนี้มีอยู่ในเพลงวันนี้แล้ว`, { duplicateSongId: song?._id.toString(), duplicateTitle: song?.title || 'เพลงไม่มีชื่อ' });
      }
    }
    const setlist = { ownerId: user._id, id: 'today', name: 'เพลงวันนี้', songIds: ids, revision: revision + 1, updatedAt: new Date() };
    if (!existing) {
      try { await collection.insertOne(setlist); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const latest = await collection.findOne({ ownerId: user._id, id: 'today' });
        throw new HttpError(409, 'เพลงวันนี้เปลี่ยนจากอุปกรณ์อื่นแล้ว เลือกว่าจะใช้ลำดับใด', { todaySetlist: { id: 'today', name: latest?.name || 'เพลงวันนี้', songIds: (latest?.songIds || []).map((id) => id.toString()), revision: Number(latest?.revision || 0) } });
      }
    } else {
      const expectedRevisionFilter = existing.revision === undefined ? { revision: { $exists: false } } : { revision: existing.revision };
      const result = await collection.replaceOne({ ownerId: user._id, id: 'today', ...expectedRevisionFilter }, setlist);
      if (!result.matchedCount) {
        const latest = await collection.findOne({ ownerId: user._id, id: 'today' });
        throw new HttpError(409, 'เพลงวันนี้เปลี่ยนจากอุปกรณ์อื่นแล้ว เลือกว่าจะใช้ลำดับใด', { todaySetlist: { id: 'today', name: latest?.name || 'เพลงวันนี้', songIds: (latest?.songIds || []).map((id) => id.toString()), revision: Number(latest?.revision || 0) } });
      }
    }
    notifyUser(user._id, { type: 'library.changed' });
    return json(res, 200, { ok: true, todaySetlist: { id: 'today', name: 'เพลงวันนี้', songIds: ids.map((id) => id.toString()), revision: revision + 1 } });
  }

  if (pathParts[1] === 'notifications' && method === 'GET' && pathParts.length === 2) {
    const notifications = await database.collection('notifications').find({ userId: user._id }).sort({ createdAt: -1 }).limit(100).toArray();
    const invitationIds = notifications.map((item) => item.invitationId).filter(Boolean);
    const invitations = invitationIds.length ? await database.collection('invitations').find({ _id: { $in: invitationIds } }, { projection: { status: 1 } }).toArray() : [];
    const invitationStatus = new Map(invitations.map((item) => [item._id.toString(), item.status]));
    return json(res, 200, { notifications: notifications.map((item) => ({ id: item._id.toString(), type: item.type, invitationId: item.invitationId?.toString(), invitationStatus: item.invitationId ? invitationStatus.get(item.invitationId.toString()) : undefined, suggestionId: item.suggestionId?.toString(), suggestionStatus: item.suggestionStatus, songTitle: item.songTitle, requesterName: item.requesterName, groupId: item.groupId?.toString(), groupName: item.groupName, inviterName: item.inviterName, recipientEmail: item.recipientEmail, decision: item.decision, role: item.role, readAt: item.readAt, createdAt: item.createdAt })) });
  }
  if (pathParts[1] === 'notifications' && method === 'PATCH' && pathParts[2]) {
    if (!ObjectId.isValid(pathParts[2])) throw new HttpError(400, 'Invalid notification id.');
    await database.collection('notifications').updateOne({ _id: new ObjectId(pathParts[2]), userId: user._id }, { $set: { readAt: new Date() } });
    return json(res, 200, { ok: true });
  }

  if (pathParts[1] === 'groups' && pathParts.length === 2 && method === 'GET') {
    const groups = await database.collection('groups').find({ 'members.userId': user._id }).sort({ name: 1 }).toArray();
    return json(res, 200, { groups: groups.map(publicGroup) });
  }
  if (pathParts[1] === 'groups' && pathParts.length === 2 && method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 80);
    if (name.length < 2) throw new HttpError(400, 'Group name must have at least 2 characters.');
    const range = currentWeekRange();
    const firstSet = { id: randomBytes(8).toString('hex'), ...range, name: `สัปดาห์ ${range.start}–${range.end}`, songIds: [], createdAt: new Date(), updatedAt: new Date() };
    const group = { name, ownerId: user._id, members: [{ userId: user._id, email: user.email, displayName: user.displayName || user.email.split('@')[0], role: 'owner', joinedAt: new Date() }], songIds: [], librarySongIds: [], weeklySets: [firstSet], activeSetId: firstSet.id, createdAt: new Date(), updatedAt: new Date() };
    await database.collection('groups').insertOne(group);
    notifyUser(user._id, { type: 'groups.changed' });
    return json(res, 201, { group: publicGroup(group) });
  }

  if (pathParts[1] === 'invitations' && method === 'POST' && pathParts[2] && pathParts[3] === 'respond') {
    const invitationId = pathParts[2];
    if (!ObjectId.isValid(invitationId)) throw new HttpError(400, 'Invalid invitation id.');
    const body = await readJson(req);
    const decision = body.decision === 'accept' ? 'accepted' : body.decision === 'decline' ? 'declined' : null;
    if (!decision) throw new HttpError(400, 'Choose accept or decline.');
    const invitation = await database.collection('invitations').findOne({ _id: new ObjectId(invitationId), inviteeEmail: user.email, status: 'pending' });
    if (!invitation) throw new HttpError(404, 'Invitation is no longer available.');
    if (decision === 'accepted') {
      const group = await database.collection('groups').findOne({ _id: invitation.groupId });
      if (!group) throw new HttpError(404, 'The group no longer exists.');
      if (!group.members.some((member) => member.userId.equals(user._id))) {
        await database.collection('groups').updateOne({ _id: group._id }, { $push: { members: { userId: user._id, email: user.email, displayName: user.displayName || user.email.split('@')[0], role: invitation.role, joinedAt: new Date() } }, $set: { updatedAt: new Date() } });
      }
      notifyUser(user._id, { type: 'groups.changed' });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'member_joined' });
    }
    await database.collection('invitations').updateOne({ _id: invitation._id }, { $set: { status: decision, respondedAt: new Date() } });
    await database.collection('notifications').updateMany({ userId: user._id, invitationId: invitation._id }, { $set: { readAt: new Date(), decision } });
    await database.collection('notifications').insertOne({ userId: invitation.inviterId, type: 'invitation_response', invitationId: invitation._id, groupId: invitation.groupId, groupName: invitation.groupName, recipientEmail: user.email, decision, readAt: null, createdAt: new Date() });
    notifyUser(invitation.inviterId, { type: 'notification.created' });
    return json(res, 200, { ok: true, decision });
  }

  if (pathParts[1] === 'groups' && pathParts[2]) {
    const groupId = pathParts[2];
    const { group, member } = await requireGroup(groupId, user._id);
    if (pathParts.length === 3 && method === 'PATCH') {
      if (member.role !== 'owner') throw new HttpError(403, 'Only the group owner can rename this group.');
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 80);
      if (name.length < 2) throw new HttpError(400, 'Group name must have at least 2 characters.');
      const updated = { ...group, name, updatedAt: new Date() };
      await database.collection('groups').updateOne({ _id: group._id }, { $set: { name, updatedAt: updated.updatedAt } });
      await database.collection('invitations').updateMany({ groupId: group._id, status: 'pending' }, { $set: { groupName: name } });
      await database.collection('notifications').updateMany({ groupId: group._id, type: { $in: ['group_invite', 'group_song_suggestion'] } }, { $set: { groupName: name } });
      notifyGroup(updated, { type: 'group.changed', groupId: group._id.toString(), change: 'group_renamed' });
      for (const item of group.members) notifyUser(item.userId, { type: 'groups.changed' });
      return json(res, 200, { group: publicGroup(updated) });
    }
    if (pathParts.length === 3 && method === 'DELETE') {
      if (member.role !== 'owner') throw new HttpError(403, 'Only the group owner can delete this group.');
      await database.collection('groupSongs').deleteMany({ groupId: group._id });
      await database.collection('invitations').deleteMany({ groupId: group._id });
      await database.collection('groups').deleteOne({ _id: group._id });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'group_deleted' });
      for (const item of group.members) notifyUser(item.userId, { type: 'groups.changed' });
      return json(res, 200, { ok: true });
    }
    if (pathParts[3] === 'members' && method === 'GET') {
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 80).toLocaleLowerCase('th-TH');
      const requestedRole = String(url.searchParams.get('role') || '');
      const role = ['owner', 'editor', 'viewer'].includes(requestedRole) ? requestedRole : '';
      const offset = Math.max(0, Math.min(100000, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
      const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25));
      const filtered = (group.members || []).filter((item) => {
        const name = String(item.displayName || '').toLocaleLowerCase('th-TH');
        return (!role || item.role === role) && (!query || name.includes(query));
      });
      const members = filtered.slice(offset, offset + limit).map((item) => ({
        userId: item.userId.toString(),
        displayName: item.displayName || 'สมาชิก WorshipChord',
        role: item.role,
        joinedAt: item.joinedAt
      }));
      return json(res, 200, { members, total: filtered.length, offset, limit });
    }
    if (pathParts[3] === 'suggestions' && pathParts.length === 4 && method === 'POST') {
      const body = await readJson(req);
      const fields = safeSongInput(body.song);
      if (!fields.title) throw new HttpError(400, 'ใส่ชื่อเพลงก่อนเสนอ');
      const pendingCount = await database.collection('groupSongSuggestions').countDocuments({ groupId: group._id, status: 'pending' });
      if (pendingCount >= 500) throw new HttpError(409, 'คิวเสนอเพลงเต็มแล้ว แจ้งเจ้าของหรือผู้แก้ไขให้ตรวจรายการก่อน');
      const pendingSuggestions = await database.collection('groupSongSuggestions').find({ groupId: group._id, status: 'pending' }, { projection: { song: 1 } }).toArray();
      const duplicate = pendingSuggestions.find((item) => normalizeDuplicateField(item.song?.title) === normalizeDuplicateField(fields.title) && normalizeDuplicateField(item.song?.artist) === normalizeDuplicateField(fields.artist));
      if (duplicate) throw new HttpError(409, 'มีเพลงนี้อยู่ในคิวเสนอแล้ว');
      const suggestion = { groupId: group._id, song: { ...fields, sourceKeyConfirmed: false }, suggestedBy: user._id, suggestedByName: user.displayName || user.email.split('@')[0], status: 'pending', createdAt: new Date() };
      await database.collection('groupSongSuggestions').insertOne(suggestion);
      const reviewers = (group.members || []).filter((item) => ['owner', 'editor'].includes(item.role));
      if (reviewers.length) {
        const createdNotifications = reviewers.map((reviewer) => ({ userId: reviewer.userId, type: 'group_song_suggestion', suggestionId: suggestion._id, groupId: group._id, groupName: group.name, songTitle: fields.title, requesterName: suggestion.suggestedByName, suggestionStatus: 'pending', readAt: null, createdAt: suggestion.createdAt }));
        await database.collection('notifications').insertMany(createdNotifications);
        for (const reviewer of reviewers) notifyUser(reviewer.userId, { type: 'notification.created', notificationType: 'group_song_suggestion', songTitle: fields.title, groupId: group._id.toString() });
      }
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_suggestion' });
      return json(res, 201, { ok: true });
    }
    if (pathParts[3] === 'suggestions' && pathParts.length === 4 && method === 'GET') {
      requireEditor(member);
      const suggestions = await database.collection('groupSongSuggestions').find({ groupId: group._id, status: 'pending' }).sort({ createdAt: 1 }).limit(100).toArray();
      return json(res, 200, { suggestions: suggestions.map(({ _id, groupId, suggestedBy, ...item }) => ({ ...item, id: _id.toString(), suggestedBy: suggestedBy.toString() })) });
    }
    if (pathParts[3] === 'suggestions' && pathParts[4] && method === 'PATCH') {
      requireEditor(member);
      if (!ObjectId.isValid(pathParts[4])) throw new HttpError(400, 'Invalid suggestion id.');
      const suggestionId = new ObjectId(pathParts[4]);
      const body = await readJson(req);
      const suggestion = await database.collection('groupSongSuggestions').findOne({ _id: suggestionId, groupId: group._id, status: 'pending' });
      if (!suggestion) throw new HttpError(404, 'ไม่พบรายการเสนอเพลงนี้ หรือรายการถูกจัดการไปแล้ว');
      if (body.action === 'reject') {
        await database.collection('groupSongSuggestions').updateOne({ _id: suggestionId, groupId: group._id, status: 'pending' }, { $set: { status: 'rejected', reviewedBy: user._id, reviewedAt: new Date() } });
        await database.collection('notifications').updateMany({ suggestionId, type: 'group_song_suggestion' }, { $set: { suggestionStatus: 'rejected', readAt: new Date() } });
        notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_suggestion' });
        return json(res, 200, { ok: true });
      }
      if (body.action !== 'approve') throw new HttpError(400, 'เลือกว่าจะเพิ่มเพลงหรือปฏิเสธรายการ');
      const allowedKeys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      if (!allowedKeys.includes(body.key) || body.confirmSourceKey !== true) throw new HttpError(400, 'ตรวจและยืนยันคีย์ต้นฉบับก่อนเพิ่มเพลง');
      const fields = { ...safeSongInput(suggestion.song), key: body.key, sourceKeyConfirmed: true };
      const groupSongs = await database.collection('groupSongs').find({ groupId: group._id }).toArray();
      const duplicate = groupSongs.find((item) => normalizeDuplicateField(item.title) === normalizeDuplicateField(fields.title) && normalizeDuplicateField(item.artist) === normalizeDuplicateField(fields.artist));
      let song = duplicate;
      if (song) {
        const corrected = { ...song, key: fields.key, displayKey: fields.key === song.key ? (song.displayKey || fields.key) : fields.key, sourceKeyConfirmed: true, revision: Number(song.revision || 1) + 1, updatedBy: user._id, updatedAt: new Date() };
        const expectedRevision = song.revision === undefined ? { revision: { $exists: false } } : { revision: song.revision };
        const result = await database.collection('groupSongs').replaceOne({ _id: song._id, groupId: group._id, ...expectedRevision }, corrected);
        if (!result.matchedCount) throw new HttpError(409, 'เพลงในคลังถูกแก้จากอุปกรณ์อื่นแล้ว กรุณาโหลดใหม่');
        song = corrected;
      } else {
        song = { ...fields, displayKey: fields.key, duplicateKey: duplicateSongKey(fields.title, fields.artist), groupId: group._id, revision: 1, updatedBy: user._id, updatedAt: new Date() };
        try { await database.collection('groupSongs').insertOne(song); }
        catch (error) {
          if (error.code !== 11000) throw error;
          song = await database.collection('groupSongs').findOne({ groupId: group._id, duplicateKey: duplicateSongKey(fields.title, fields.artist) });
          if (!song) throw error;
        }
      }
      await database.collection('groups').updateOne({ _id: group._id }, { $addToSet: { librarySongIds: song._id }, $set: { updatedAt: new Date() } });
      const reviewed = await database.collection('groupSongSuggestions').updateOne({ _id: suggestionId, groupId: group._id, status: 'pending' }, { $set: { status: 'approved', linkedSongId: song._id, reviewedBy: user._id, reviewedAt: new Date(), reviewedKey: fields.key } });
      if (!reviewed.modifiedCount) throw new HttpError(409, 'รายการนี้ถูกจัดการจากอุปกรณ์อื่นแล้ว');
      await database.collection('notifications').updateMany({ suggestionId, type: 'group_song_suggestion' }, { $set: { suggestionStatus: 'approved', readAt: new Date() } });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_suggestion' });
      return json(res, 200, { ok: true, song: publicSong(song) });
    }
    if (pathParts.length === 3 && method === 'GET') {
      const querySetId = url.searchParams.get('setId');
      const legacyIds = group.songIds || [];
      const sets = group.weeklySets?.length ? group.weeklySets : [{ id: 'legacy', ...currentWeekRange(), name: 'ชุดปัจจุบัน', songIds: legacyIds }];
      if (!group.weeklySets?.length) await database.collection('groups').updateOne({ _id: group._id, weeklySets: { $exists: false } }, { $set: { weeklySets: sets, activeSetId: 'legacy', librarySongIds: legacyIds } });
      const availableSets = sets.filter((set) => !set.deletedAt);
      const selectedSet = availableSets.find((set) => set.id === querySetId) || availableSets.find((set) => set.id === group.activeSetId) || availableSets.at(-1);
      if (!selectedSet) throw new HttpError(404, 'ไม่พบชุดเพลงที่ใช้งานได้');
      const songIds = selectedSet.songIds || [];
      let songSnapshots = { ...(selectedSet.songSnapshots || {}) };
      const libraryIds = group.librarySongIds || legacyIds;
      const songs = await database.collection('groupSongs').find({ groupId: group._id, _id: { $in: [...new Map([...libraryIds, ...songIds].map((id) => [id.toString(), id])).values()] } }).toArray();
      const ordered = new Map(songs.map((song) => [song._id.toString(), publicSong(song)]));
      let snapshotsChanged = false;
      for (const id of songIds) {
        const idString = id.toString();
        if (!songSnapshots[idString] && ordered.has(idString)) {
          songSnapshots[idString] = ordered.get(idString);
          snapshotsChanged = true;
        }
      }
      if (snapshotsChanged) await database.collection('groups').updateOne({ _id: group._id, 'weeklySets.id': selectedSet.id }, { $set: { 'weeklySets.$.songSnapshots': songSnapshots } });
      const setSongs = songIds.map((id) => {
        const idString = id.toString();
        const base = ordered.get(idString) || songSnapshots[idString];
        return base ? { ...base, ...(songSnapshots[idString] || {}), id: idString } : null;
      }).filter(Boolean);
      return json(res, 200, { group: publicGroup(group), activeSet: { ...selectedSet, songSnapshots }, librarySongs: libraryIds.map((id) => ordered.get(id.toString())).filter(Boolean), songs: setSongs });
    }
    if (pathParts[3] === 'sets' && pathParts.length === 5 && method === 'DELETE') {
      requireEditor(member);
      const setId = pathParts[4];
      const set = group.weeklySets?.find((item) => item.id === setId && !item.deletedAt);
      if (!set) throw new HttpError(404, 'ไม่พบชุดเพลงนี้');
      const remaining = (group.weeklySets || []).filter((item) => item.id !== setId && !item.deletedAt);
      if (!remaining.length) throw new HttpError(409, 'ต้องเหลือชุดที่ใช้งานได้อย่างน้อย 1 ชุด');
      const now = new Date();
      const nextSet = group.activeSetId === setId ? remaining.slice().sort((a, b) => String(b.serviceDate || b.end || b.start).localeCompare(String(a.serviceDate || a.end || a.start)))[0] : null;
      const filter = { _id: group._id, weeklySets: { $elemMatch: { id: setId, deletedAt: { $exists: false } } }, ...(nextSet ? { activeSetId: setId } : {}) };
      const update = { $set: { 'weeklySets.$.deletedAt': now, 'weeklySets.$.expiresAt': new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), 'weeklySets.$.deletedBy': user._id, updatedAt: now, ...(nextSet ? { activeSetId: nextSet.id, songIds: nextSet.songIds || [] } : {}) } };
      const result = await database.collection('groups').updateOne(filter, update);
      if (!result.modifiedCount) throw new HttpError(409, 'ชุดนี้เปลี่ยนจากอุปกรณ์อื่นแล้ว กรุณาโหลดใหม่');
      const updatedGroup = { ...group, weeklySets: group.weeklySets.map((item) => item.id === setId ? { ...item, deletedAt: now, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), deletedBy: user._id.toString() } : item), ...(nextSet ? { activeSetId: nextSet.id, songIds: nextSet.songIds || [] } : {}), updatedAt: now };
      notifyGroup(updatedGroup, { type: 'group.changed', groupId: group._id.toString(), change: 'set_trashed', setId });
      return json(res, 200, { group: publicGroup(updatedGroup) });
    }
    if (pathParts[3] === 'sets' && pathParts.length === 6 && pathParts[5] === 'restore' && method === 'PATCH') {
      requireEditor(member);
      const setId = pathParts[4];
      const set = group.weeklySets?.find((item) => item.id === setId && item.deletedAt);
      if (!set) throw new HttpError(404, 'ไม่พบชุดนี้ในถังขยะ');
      const now = new Date();
      const result = await database.collection('groups').updateOne({ _id: group._id, weeklySets: { $elemMatch: { id: setId, deletedAt: { $exists: true } } } }, { $unset: { 'weeklySets.$.deletedAt': '', 'weeklySets.$.deletedBy': '', 'weeklySets.$.expiresAt': '' }, $set: { updatedAt: now } });
      if (!result.modifiedCount) throw new HttpError(409, 'ชุดนี้เปลี่ยนจากอุปกรณ์อื่นแล้ว กรุณาโหลดใหม่');
      const updatedGroup = { ...group, weeklySets: group.weeklySets.map((item) => {
        if (item.id !== setId) return item;
        const { deletedAt, deletedBy, expiresAt, ...rest } = item;
        return rest;
      }), updatedAt: now };
      notifyGroup(updatedGroup, { type: 'group.changed', groupId: group._id.toString(), change: 'set_restored', setId });
      return json(res, 200, { group: publicGroup(updatedGroup) });
    }
    if (pathParts[3] === 'sets' && pathParts.length === 5 && method === 'PATCH') {
      requireEditor(member);
      const setId = pathParts[4];
      const set = group.weeklySets?.find((item) => item.id === setId);
      if (!set) throw new HttpError(404, 'ไม่พบชุดเพลงนี้');
      const body = await readJson(req);
      const serviceDate = String(body.serviceDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || Number.isNaN(Date.parse(`${serviceDate}T12:00:00Z`)) || new Date(`${serviceDate}T12:00:00Z`).toISOString().slice(0, 10) !== serviceDate) throw new HttpError(400, 'เลือกวันที่เล่นให้ถูกต้อง');
      const range = currentWeekRange(new Date(`${serviceDate}T12:00:00Z`));
      const defaultName = /^ชุดวันที่ \d{4}-\d{2}-\d{2}(?: · ชุด \d+)?$/.test(set.name || '');
      const requestedName = body.name === undefined ? null : String(body.name || '').trim().slice(0, 80);
      const updatedName = requestedName || (defaultName ? `ชุดวันที่ ${serviceDate}` : set.name);
      const updatedSet = { ...set, ...range, serviceDate, name: updatedName, updatedAt: new Date() };
      const result = await database.collection('groups').updateOne({ _id: group._id, weeklySets: { $elemMatch: { id: setId, deletedAt: { $exists: false } } } }, { $set: { 'weeklySets.$.start': range.start, 'weeklySets.$.end': range.end, 'weeklySets.$.serviceDate': serviceDate, 'weeklySets.$.name': updatedSet.name, 'weeklySets.$.updatedAt': updatedSet.updatedAt, updatedAt: updatedSet.updatedAt } });
      if (!result.matchedCount) throw new HttpError(404, 'ไม่พบชุดเพลงนี้');
      const updatedGroup = { ...group, weeklySets: group.weeklySets.map((item) => item.id === setId ? updatedSet : item) };
      notifyGroup(updatedGroup, { type: 'group.changed', groupId: group._id.toString(), change: 'set_date_changed', setId });
      return json(res, 200, { activeSet: updatedSet, group: publicGroup(updatedGroup) });
    }
    if (pathParts[3] === 'sets' && pathParts.length === 4 && method === 'POST') {
      requireEditor(member);
      const body = await readJson(req);
      const serviceDate = String(body.serviceDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || Number.isNaN(Date.parse(`${serviceDate}T12:00:00Z`))) throw new HttpError(400, 'เลือกวันที่เล่นให้ถูกต้อง');
      const range = currentWeekRange(new Date(`${serviceDate}T12:00:00Z`));
      const sets = group.weeklySets || [];
      const requestedDate = new Date(`${serviceDate}T12:00:00Z`);
      if (requestedDate.toISOString().slice(0, 10) !== serviceDate) throw new HttpError(400, 'วันที่เล่นไม่ถูกต้อง');
      const source = sets.find((set) => set.id === body.copyFrom && !set.deletedAt) || sets.find((set) => set.id === group.activeSetId && !set.deletedAt);
      let songSnapshots = {};
      if (body.copyPrevious && source) {
        songSnapshots = structuredClone(source.songSnapshots || {});
        if (!Object.keys(songSnapshots).length && source.songIds?.length) {
          const sourceSongs = await database.collection('groupSongs').find({ groupId: group._id, _id: { $in: source.songIds } }).toArray();
          songSnapshots = Object.fromEntries(sourceSongs.map((song) => [song._id.toString(), publicSong(song)]));
        }
      }
      const sameDateCount = sets.filter((set) => !set.deletedAt && set.serviceDate === serviceDate).length;
      const requestedName = String(body.name || '').trim().slice(0, 80);
      const generatedName = sameDateCount ? `ชุดวันที่ ${serviceDate} · ชุด ${sameDateCount + 1}` : `ชุดวันที่ ${serviceDate}`;
      const newSet = { id: randomBytes(8).toString('hex'), ...range, serviceDate, name: requestedName || generatedName, songIds: body.copyPrevious && source ? [...source.songIds] : [], songSnapshots, createdAt: new Date(), updatedAt: new Date() };
      await database.collection('groups').updateOne({ _id: group._id }, { $push: { weeklySets: newSet }, $set: { activeSetId: newSet.id, songIds: newSet.songIds, updatedAt: new Date() } });
      const updated = { ...group, weeklySets: [...sets, newSet], activeSetId: newSet.id, songIds: newSet.songIds };
      notifyGroup(updated, { type: 'group.changed', groupId: group._id.toString(), change: 'setlist' });
      return json(res, 201, { group: publicGroup(updated), activeSet: newSet });
    }
    if (pathParts[3] === 'invitations' && method === 'POST') {
      const body = await readJson(req);
      const target = body.publicId
        ? await database.collection('users').findOne({ publicId: String(body.publicId).trim().toUpperCase() }, { projection: { email: 1, publicId: 1, displayName: 1 } })
        : null;
      const email = target?.email || String(body.email || '').trim().toLowerCase();
      const role = body.role === 'editor' ? 'editor' : body.role === 'viewer' ? 'viewer' : null;
      if (!target && body.publicId) throw new HttpError(404, 'ไม่พบบัญชีนี้ ลองค้นหาด้วยชื่อหรือ ID อีกครั้ง');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'เลือกบัญชีจากผลการค้นหาก่อนส่งคำเชิญ');
      if (!role) throw new HttpError(400, 'Choose editor or viewer access.');
      if (member.role === 'viewer' && role !== 'viewer') throw new HttpError(403, 'สมาชิกที่มีสิทธิ์ดูเชิญได้เฉพาะผู้ดู');
      if (email === user.email || group.members.some((item) => item.email === email)) throw new HttpError(409, 'That account is already in the group.');
      const existing = await database.collection('invitations').findOne({ groupId: group._id, inviteeEmail: email, status: 'pending' });
      if (existing) throw new HttpError(409, 'There is already a pending invitation for that email.');
      const invitation = { groupId: group._id, groupName: group.name, inviterId: user._id, inviterName: user.displayName || user.email, inviteeEmail: email, role, status: 'pending', createdAt: new Date() };
      await database.collection('invitations').insertOne(invitation);
      const invitee = await database.collection('users').findOne({ email }, { projection: { _id: 1 } });
      if (invitee) {
        await database.collection('notifications').insertOne({ userId: invitee._id, type: 'group_invite', invitationId: invitation._id, groupId: group._id, groupName: group.name, inviterName: invitation.inviterName, role, readAt: null, createdAt: invitation.createdAt });
        notifyUser(invitee._id, { type: 'notification.created' });
      }
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'invitation_created' });
      return json(res, 201, { ok: true, invitationId: invitation._id.toString(), registered: Boolean(invitee) });
    }
    if (pathParts[3] === 'setlist' && method === 'PATCH') {
      requireEditor(member);
      const body = await readJson(req);
      if (!Array.isArray(body.songIds) || body.songIds.length > 500) throw new HttpError(400, 'Invalid setlist.');
      const ids = body.songIds.map((id) => { if (!ObjectId.isValid(id)) throw new HttpError(400, 'Invalid song id.'); return new ObjectId(id); });
      const uniqueIds = [...new Map(ids.map((id) => [id.toString(), id])).values()];
      const owned = uniqueIds.length ? await database.collection('groupSongs').countDocuments({ groupId: group._id, _id: { $in: uniqueIds } }) : 0;
      if (owned !== uniqueIds.length) throw new HttpError(400, 'Setlist contains a song outside this group.');
      const setId = String(body.setId || group.activeSetId || 'legacy');
      const sets = group.weeklySets?.length ? group.weeklySets : [{ id: 'legacy', ...currentWeekRange(), name: 'ชุดปัจจุบัน', songIds: group.songIds || [] }];
      const selected = sets.find((set) => set.id === setId && !set.deletedAt);
      if (!selected) throw new HttpError(404, 'ไม่พบชุดเพลงสัปดาห์นี้');
      const existingSnapshots = selected.songSnapshots || {};
      const newIds = uniqueIds.filter((id) => !existingSnapshots[id.toString()]);
      const newSongs = newIds.length ? await database.collection('groupSongs').find({ groupId: group._id, _id: { $in: newIds } }).toArray() : [];
      const songSnapshots = Object.fromEntries(uniqueIds.map((id) => {
        const idString = id.toString();
        const song = existingSnapshots[idString] || newSongs.find((item) => item._id.equals(id));
        return [idString, existingSnapshots[idString] || (song ? publicSong(song) : null)];
      }).filter(([, song]) => song));
      const updatedAt = new Date();
      const setVersion = selected.updatedAt === undefined ? { updatedAt: { $exists: false } } : { updatedAt: selected.updatedAt };
      const result = await database.collection('groups').updateOne({ _id: group._id, weeklySets: { $elemMatch: { id: setId, ...setVersion } } }, { $set: { 'weeklySets.$.songIds': uniqueIds, 'weeklySets.$.songSnapshots': songSnapshots, 'weeklySets.$.updatedAt': updatedAt, updatedAt, ...(group.activeSetId === setId ? { songIds: uniqueIds } : {}) } });
      if (!result.modifiedCount) throw new HttpError(409, 'ชุดนี้มีการเปลี่ยนแปลงจากอุปกรณ์อื่น กรุณาโหลดชุดใหม่แล้วลองอีกครั้ง');
      const updatedSets = sets.map((set) => set.id === setId ? { ...set, songIds: uniqueIds, songSnapshots, updatedAt } : set);
      const updated = { ...group, weeklySets: updatedSets, songIds: group.activeSetId === setId ? uniqueIds : group.songIds, updatedAt: new Date() };
      notifyGroup(updated, { type: 'group.changed', groupId: group._id.toString(), change: 'setlist' });
      return json(res, 200, { group: publicGroup(updated) });
    }
    if (pathParts[3] === 'members' && pathParts[4] && method === 'PATCH') {
      if (member.role !== 'owner') throw new HttpError(403, 'Only the group owner can change access.');
      const memberId = pathParts[4];
      const body = await readJson(req);
      if (!ObjectId.isValid(memberId) || !['editor', 'viewer'].includes(body.role)) throw new HttpError(400, 'Invalid member or role.');
      const targetId = new ObjectId(memberId);
      if (targetId.equals(group.ownerId)) throw new HttpError(400, 'The owner role cannot be changed.');
      const result = await database.collection('groups').updateOne({ _id: group._id, 'members.userId': targetId }, { $set: { 'members.$.role': body.role, updatedAt: new Date() } });
      if (!result.modifiedCount) throw new HttpError(404, 'Member not found.');
      const updated = await database.collection('groups').findOne({ _id: group._id });
      notifyGroup(updated, { type: 'group.changed', groupId: group._id.toString(), change: 'member_role' });
      return json(res, 200, { group: publicGroup(updated) });
    }
    if (pathParts[3] === 'songs' && pathParts.length === 4 && method === 'DELETE') {
      requireEditor(member);
      const body = await readJson(req);
      if (!Array.isArray(body.songIds) || body.songIds.length > 500) throw new HttpError(400, 'Invalid song selection.');
      const uniqueIds = [...new Set(body.songIds.map(String))];
      if (uniqueIds.some((id) => !ObjectId.isValid(id))) throw new HttpError(400, 'Invalid song id.');
      const ids = uniqueIds.map((id) => new ObjectId(id));
      const selected = ids.length ? await database.collection('groupSongs').find({ groupId: group._id, _id: { $in: ids } }).toArray() : [];
      if (selected.length !== ids.length) throw new HttpError(400, 'Selection contains a song outside this group.');
      if (ids.length) {
        await database.collection('groupSongs').deleteMany({ groupId: group._id, _id: { $in: ids } });
        await database.collection('groups').updateOne({ _id: group._id }, { $pull: { librarySongIds: { $in: ids }, songIds: { $in: ids } }, $set: { updatedAt: new Date() } });
        notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'songs_removed', songIds: uniqueIds });
      }
      return json(res, 200, { ok: true, deleted: ids.length });
    }
    if (pathParts[3] === 'import' && pathParts.length === 4 && method === 'POST') {
      requireEditor(member);
      const body = await readJson(req);
      if (!Array.isArray(body.songs) || body.songs.length > 500) throw new HttpError(400, 'ไฟล์ต้องมีเพลงไม่เกิน 500 รายการ');
      const collection = database.collection('groupSongs');
      const existingSongs = await collection.find({ groupId: group._id }).toArray();
      const canonicalByKey = new Map(existingSongs.map((song) => [duplicateSongKey(song.title, song.artist), song]));
      const importedIds = [];
      let duplicatesSkipped = 0;
      let invalidSkipped = 0;
      let imported = 0;
      for (const source of body.songs) {
        const fields = safeSongInput(source);
        if (!fields.title) { invalidSkipped += 1; continue; }
        const duplicateKey = duplicateSongKey(fields.title, fields.artist);
        const existing = canonicalByKey.get(duplicateKey);
        if (existing) {
          duplicatesSkipped += 1;
          importedIds.push(existing._id);
          continue;
        }
        const song = { ...fields, displayKey: fields.key, duplicateKey, groupId: group._id, revision: 1, updatedBy: user._id, updatedAt: new Date() };
        try {
          await collection.insertOne(song);
          canonicalByKey.set(duplicateKey, song);
          importedIds.push(song._id);
          imported += 1;
        } catch (error) {
          if (error.code !== 11000) throw error;
          const raced = await collection.findOne({ groupId: group._id, duplicateKey });
          if (!raced) throw error;
          canonicalByKey.set(duplicateKey, raced);
          importedIds.push(raced._id);
          duplicatesSkipped += 1;
        }
      }
      if (importedIds.length) await database.collection('groups').updateOne({ _id: group._id }, { $addToSet: { librarySongIds: { $each: importedIds } }, $set: { updatedAt: new Date() } });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'songs_imported', imported });
      return json(res, 200, { imported, duplicatesSkipped, invalidSkipped });
    }
    if (pathParts[3] === 'songs' && method === 'POST') {
      requireEditor(member);
      const body = await readJson(req);
      const songFields = safeSongInput(body.song);
      if (!songFields.title) throw new HttpError(400, 'Song title is required.');
      const normalizedTitle = normalizeDuplicateField(songFields.title);
      const normalizedArtist = normalizeDuplicateField(songFields.artist);
      const existingSongs = await database.collection('groupSongs').find({ groupId: group._id }, { projection: { title: 1, artist: 1 } }).toArray();
      const duplicate = existingSongs.find((item) => normalizeDuplicateField(item.title) === normalizedTitle && normalizeDuplicateField(item.artist) === normalizedArtist);
      if (duplicate) throw new HttpError(409, `มีเพลง “${duplicate.title}” ของศิลปินคนนี้อยู่ในกลุ่มแล้ว กรุณาตรวจสอบเพลงเดิมก่อนแชร์`, { duplicateSongId: duplicate._id.toString() });
      const song = { ...songFields, displayKey: songFields.key, duplicateKey: duplicateSongKey(songFields.title, songFields.artist), groupId: group._id, revision: 1, updatedBy: user._id, updatedAt: new Date() };
      try { await database.collection('groupSongs').insertOne(song); }
      catch (error) {
        if (error.code === 11000) throw new HttpError(409, `มีเพลง “${songFields.title}” ของศิลปินคนนี้อยู่ในกลุ่มแล้ว กรุณาตรวจสอบเพลงเดิมก่อนแชร์`);
        throw error;
      }
      await database.collection('groups').updateOne({ _id: group._id }, { $addToSet: { librarySongIds: song._id }, $set: { updatedAt: new Date() } });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_added' });
      return json(res, 201, { song: publicSong(song) });
    }
    if (pathParts[3] === 'sets' && pathParts.length === 7 && pathParts[5] === 'songs' && pathParts[6] === 'import' && method === 'POST') {
      requireEditor(member);
      const setId = pathParts[4];
      const selectedSet = group.weeklySets?.find((item) => item.id === setId);
      if (!selectedSet || selectedSet.deletedAt) throw new HttpError(404, 'ไม่พบชุดเพลงนี้');
      const body = await readJson(req);
      const fields = safeSongInput(body.song);
      if (!fields.title) throw new HttpError(400, 'Song title is required.');
      const catalogSongs = await database.collection('groupSongs').find({ groupId: group._id }).toArray();
      const duplicate = catalogSongs.find((item) => normalizeDuplicateField(item.title) === normalizeDuplicateField(fields.title) && normalizeDuplicateField(item.artist) === normalizeDuplicateField(fields.artist));
      const now = new Date();
      let song = duplicate;
      let created = false;
      if (!song) {
        song = { ...fields, displayKey: fields.key, duplicateKey: duplicateSongKey(fields.title, fields.artist), groupId: group._id, revision: 1, updatedBy: user._id, updatedAt: now };
        try { await database.collection('groupSongs').insertOne(song); created = true; }
        catch (error) {
          if (error.code !== 11000) throw error;
          song = await database.collection('groupSongs').findOne({ groupId: group._id, duplicateKey: duplicateSongKey(fields.title, fields.artist) });
          if (!song) throw error;
        }
      }
      const songId = song._id;
      const songIdString = songId.toString();
      if ((selectedSet.songIds || []).some((id) => id.toString() === songIdString)) {
        if (created) await database.collection('groupSongs').deleteOne({ _id: songId, groupId: group._id });
        throw new HttpError(409, `“${song.title}” อยู่ในชุดนี้แล้ว`, { alreadyInSet: true });
      }
      const songIds = [...(selectedSet.songIds || []), songId];
      const storedSnapshot = publicSong(song);
      delete storedSnapshot.id;
      delete storedSnapshot.groupId;
      const setVersion = selectedSet.updatedAt === undefined ? { updatedAt: { $exists: false } } : { updatedAt: selectedSet.updatedAt };
      const result = await database.collection('groups').updateOne(
        { _id: group._id, weeklySets: { $elemMatch: { id: setId, ...setVersion } } },
        { $addToSet: { librarySongIds: songId }, $set: { 'weeklySets.$.songIds': songIds, [`weeklySets.$.songSnapshots.${songIdString}`]: storedSnapshot, 'weeklySets.$.updatedAt': now, updatedAt: now, ...(group.activeSetId === setId ? { songIds } : {}) } }
      );
      if (!result.modifiedCount) {
        if (created) await database.collection('groupSongs').deleteOne({ _id: songId, groupId: group._id });
        throw new HttpError(409, 'ชุดนี้มีการเปลี่ยนแปลงจากอุปกรณ์อื่น กรุณาโหลดชุดใหม่แล้วลองอีกครั้ง');
      }
      const updatedGroup = { ...group, weeklySets: group.weeklySets.map((item) => item.id === setId ? { ...item, songIds, songSnapshots: { ...(item.songSnapshots || {}), [songIdString]: storedSnapshot }, updatedAt: now } : item), librarySongIds: [...new Map([...(group.librarySongIds || []), songId].map((id) => [id.toString(), id])).values()], ...(group.activeSetId === setId ? { songIds } : {}), updatedAt: now };
      notifyGroup(updatedGroup, { type: 'group.changed', groupId: group._id.toString(), change: 'setlist', setId });
      return json(res, created ? 201 : 200, { song: publicSong(song), imported: created, activeSet: { id: setId, songIds: songIds.map((id) => id.toString()) } });
    }
    if (pathParts[3] === 'sets' && pathParts[5] === 'songs' && pathParts[6] && ['PUT', 'PATCH'].includes(method)) {
      requireEditor(member);
      const setId = pathParts[4];
      if (!ObjectId.isValid(pathParts[6])) throw new HttpError(400, 'Invalid song id.');
      const songId = new ObjectId(pathParts[6]);
      const selectedSet = group.weeklySets?.find((item) => item.id === setId);
      if (!selectedSet || selectedSet.deletedAt || !(selectedSet.songIds || []).some((id) => id.toString() === songId.toString())) throw new HttpError(404, 'Song not found in this set.');
      const snapshotKey = songId.toString();
      const currentSnapshot = selectedSet.songSnapshots?.[snapshotKey];
      if (!currentSnapshot) throw new HttpError(409, 'This set song has not been loaded yet. Reload the set and try again.');
      const expectedRevision = Number(currentSnapshot.revision || 1);
      const body = await readJson(req);
      if (Number(body.expectedRevision) !== expectedRevision) throw new HttpError(409, 'This set song changed on another device. Reload it before saving.', { song: { ...currentSnapshot, id: snapshotKey } });
      let updatedSnapshot;
      if (method === 'PATCH' && pathParts[7] === 'display-key') {
        const allowedKeys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        if (!allowedKeys.includes(body.key)) throw new HttpError(400, 'Invalid display key.');
        updatedSnapshot = { ...currentSnapshot, displayKey: body.key, revision: expectedRevision + 1, updatedBy: user._id.toString(), updatedAt: new Date() };
      } else {
        const fields = safeSongInput(body.song);
        if (!fields.title) throw new HttpError(400, 'Song title is required.');
        updatedSnapshot = { ...currentSnapshot, ...fields, id: snapshotKey, displayKey: fields.key === currentSnapshot.key ? (currentSnapshot.displayKey || fields.key) : fields.key, revision: expectedRevision + 1, updatedBy: user._id.toString(), updatedAt: new Date() };
      }
      const revisionPath = `weeklySets.$.songSnapshots.${snapshotKey}.revision`;
      const filter = { _id: group._id, weeklySets: { $elemMatch: { id: setId, [revisionPath.replace('weeklySets.$.', '')]: currentSnapshot.revision === undefined ? { $exists: false } : expectedRevision } } };
      const storedSnapshot = { ...updatedSnapshot };
      delete storedSnapshot.id;
      delete storedSnapshot.groupId;
      const result = await database.collection('groups').updateOne(filter, { $set: { [`weeklySets.$.songSnapshots.${snapshotKey}`]: storedSnapshot, 'weeklySets.$.updatedAt': updatedSnapshot.updatedAt, updatedAt: updatedSnapshot.updatedAt } });
      if (!result.modifiedCount) throw new HttpError(409, 'This set song changed on another device. Reload it before saving.', { song: { ...currentSnapshot, id: snapshotKey } });
      const updatedGroup = { ...group, weeklySets: group.weeklySets.map((item) => item.id === setId ? { ...item, songSnapshots: { ...(item.songSnapshots || {}), [snapshotKey]: storedSnapshot }, updatedAt: updatedSnapshot.updatedAt } : item) };
      notifyGroup(updatedGroup, { type: 'group.changed', groupId: group._id.toString(), change: 'set_song_updated', setId, songId: snapshotKey, updatedBy: user._id.toString() });
      return json(res, 200, { song: updatedSnapshot, activeSet: { id: setId, songSnapshots: updatedGroup.weeklySets.find((item) => item.id === setId).songSnapshots } });
    }
    if (pathParts[3] === 'songs' && pathParts[4] && method === 'PUT') {
      requireEditor(member);
      if (!ObjectId.isValid(pathParts[4])) throw new HttpError(400, 'Invalid song id.');
      const songId = new ObjectId(pathParts[4]);
      const body = await readJson(req);
      const song = await database.collection('groupSongs').findOne({ _id: songId, groupId: group._id });
      if (!song) throw new HttpError(404, 'Song not found in this group.');
      if (Number(body.expectedRevision) !== Number(song.revision || 1)) throw new HttpError(409, 'This song changed on another device. Reload it before saving.', { song: publicSong(song) });
      const fields = safeSongInput(body.song);
      if (!fields.title) throw new HttpError(400, 'Song title is required.');
      const existingSongs = await database.collection('groupSongs').find({ groupId: group._id, _id: { $ne: songId } }, { projection: { title: 1, artist: 1 } }).toArray();
      const duplicate = existingSongs.find((item) => normalizeDuplicateField(item.title) === normalizeDuplicateField(fields.title) && normalizeDuplicateField(item.artist) === normalizeDuplicateField(fields.artist));
      if (duplicate) throw new HttpError(409, `มีเพลง “${duplicate.title}” ของศิลปินคนนี้อยู่ในกลุ่มแล้ว กรุณาตรวจสอบเพลงเดิมก่อนบันทึก`);
      const updated = { ...song, ...fields, displayKey: fields.key === song.key ? (song.displayKey || fields.key) : fields.key, duplicateKey: duplicateSongKey(fields.title, fields.artist), revision: Number(song.revision || 1) + 1, updatedBy: user._id, updatedAt: new Date() };
      let writeResult;
      const expectedGroupRevision = song.revision === undefined ? { revision: { $exists: false } } : { revision: song.revision };
      try { writeResult = await database.collection('groupSongs').replaceOne({ _id: songId, groupId: group._id, ...expectedGroupRevision }, updated); }
      catch (error) {
        if (error.code === 11000) throw new HttpError(409, `มีเพลง “${fields.title}” ของศิลปินคนนี้อยู่ในกลุ่มแล้ว กรุณาตรวจสอบเพลงเดิมก่อนบันทึก`);
        throw error;
      }
      if (!writeResult.matchedCount) throw new HttpError(409, 'This song changed on another device. Reload it before saving.');
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_updated', songId: songId.toString(), updatedBy: user._id.toString() });
      return json(res, 200, { song: publicSong(updated) });
    }
    if (pathParts[3] === 'songs' && pathParts[4] && pathParts[5] === 'display-key' && method === 'PATCH') {
      requireEditor(member);
      if (!ObjectId.isValid(pathParts[4])) throw new HttpError(400, 'Invalid song id.');
      const songId = new ObjectId(pathParts[4]);
      const body = await readJson(req);
      const allowedKeys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      if (!allowedKeys.includes(body.key)) throw new HttpError(400, 'Invalid display key.');
      const song = await database.collection('groupSongs').findOne({ _id: songId, groupId: group._id });
      if (!song) throw new HttpError(404, 'Song not found in this group.');
      const revision = Number(song.revision || 1);
      if (Number(body.expectedRevision) !== revision) throw new HttpError(409, 'This song changed on another device. Reload it before saving.', { song: publicSong(song) });
      const updated = { ...song, displayKey: body.key, revision: revision + 1, updatedBy: user._id, updatedAt: new Date() };
      const expectedGroupRevision = song.revision === undefined ? { revision: { $exists: false } } : { revision: song.revision };
      const result = await database.collection('groupSongs').replaceOne({ _id: songId, groupId: group._id, ...expectedGroupRevision }, updated);
      if (!result.matchedCount) throw new HttpError(409, 'This song changed on another device. Reload it before saving.');
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_key_changed', songId: songId.toString(), updatedBy: user._id.toString() });
      return json(res, 200, { song: publicSong(updated) });
    }
    if (pathParts[3] === 'songs' && pathParts[4] && method === 'DELETE') {
      requireEditor(member);
      if (!ObjectId.isValid(pathParts[4])) throw new HttpError(400, 'Invalid song id.');
      const songId = new ObjectId(pathParts[4]);
      const result = await database.collection('groupSongs').deleteOne({ _id: songId, groupId: group._id });
      if (!result.deletedCount) throw new HttpError(404, 'Song not found in this group.');
      await database.collection('groups').updateOne({ _id: group._id }, { $pull: { songIds: songId, librarySongIds: songId }, $set: { updatedAt: new Date() } });
      notifyGroup(group, { type: 'group.changed', groupId: group._id.toString(), change: 'song_removed', songId: songId.toString() });
      return json(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

function mimeType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' })[path.extname(file)] || 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  const entry = staticFiles.get(pathname);
  if (!entry || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return;
  }
  const [fileName, type] = entry;
  const body = await readFile(path.join(ROOT, fileName));
  res.writeHead(200, { 'Content-Type': type || mimeType(fileName), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname === '/api') throw new HttpError(404, 'Not found.');
    else await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!(error instanceof HttpError)) console.error('Request failed', error);
    json(res, status, { error: error.message || 'Internal server error.', ...error.extra });
  }
});

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/realtime') { socket.destroy(); return; }
  try {
    requireDatabase();
    assertSameOrigin(req);
    const user = await getUser(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user._id.toString();
      ws.groupIds = new Set();
      activeSockets.add(ws);
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (socket) => {
  sendSocket(socket, { type: 'ready' });
  socket.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'subscribe' && ObjectId.isValid(message.groupId)) {
        const group = await database.collection('groups').findOne({ _id: new ObjectId(message.groupId), 'members.userId': new ObjectId(socket.userId) }, { projection: { _id: 1 } });
        if (group) socket.groupIds.add(group._id.toString());
      }
      if (message.type === 'unsubscribe' && message.groupId) socket.groupIds.delete(String(message.groupId));
    } catch { /* Ignore malformed client messages. */ }
  });
  socket.on('close', () => activeSockets.delete(socket));
  socket.on('error', () => activeSockets.delete(socket));
});

if (process.env.MONGODB_URI) {
  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await mongoClient.connect();
    database = mongoClient.db(process.env.MONGODB_DB || 'worshipchord');
    await Promise.all([
      database.collection('users').createIndex({ email: 1 }, { unique: true }),
      database.collection('users').createIndex({ publicId: 1 }, { unique: true, sparse: true }),
      database.collection('groups').createIndex({ 'members.userId': 1 }),
      database.collection('invitations').createIndex({ groupId: 1, inviteeEmail: 1, status: 1 }),
      database.collection('notifications').createIndex({ userId: 1, createdAt: -1 }),
      database.collection('groupSongs').createIndex({ groupId: 1, updatedAt: -1 }),
      database.collection('groupSongs').createIndex({ groupId: 1, duplicateKey: 1 }, { unique: true, partialFilterExpression: { duplicateKey: { $type: 'string' } } }),
      database.collection('groupSongSuggestions').createIndex({ groupId: 1, status: 1, createdAt: 1 }),
      database.collection('personalSongs').createIndex({ ownerId: 1, order: 1 }),
      database.collection('personalSongs').createIndex({ ownerId: 1, duplicateKey: 1 }, { unique: true, partialFilterExpression: { duplicateKey: { $type: 'string' } } }),
      database.collection('personalSetlists').createIndex({ ownerId: 1, id: 1 }, { unique: true })
    ]);
    const usersMissingId = await database.collection('users').find({ $or: [{ publicId: { $exists: false } }, { publicId: null }] }, { projection: { _id: 1 } }).toArray();
    for (const legacyUser of usersMissingId) {
      let assigned = false;
      while (!assigned) {
        try {
          const result = await database.collection('users').updateOne({ _id: legacyUser._id, $or: [{ publicId: { $exists: false } }, { publicId: null }] }, { $set: { publicId: makePublicId() } });
          assigned = result.modifiedCount > 0 || result.matchedCount === 0;
        } catch (error) { if (error.code !== 11000) throw error; }
      }
    }
    if (usersMissingId.length) console.log(`Assigned public IDs to ${usersMissingId.length} existing account(s).`);
    console.log(`Connected to MongoDB database "${database.databaseName}".`);
    purgeExpiredGroupTrash().catch((error) => console.error('Could not purge expired group sets.', error.message));
    const trashCleanupTimer = setInterval(() => purgeExpiredGroupTrash().catch((error) => console.error('Could not purge expired group sets.', error.message)), 6 * 60 * 60 * 1000);
    trashCleanupTimer.unref();
  } catch (error) {
    console.error('Could not connect to MongoDB. Personal cloud libraries and group features are offline.', error.message);
  }
} else {
  console.warn('MONGODB_URI is missing. Account, personal cloud library, and group features will return 503 until .env is configured.');
}

server.listen(PORT, HOST, () => console.log(`WorshipChord listening on http://${HOST}:${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await mongoClient?.close();
    process.exit(0);
  });
}
