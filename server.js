const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const multer = require('multer');
const yts = require('yt-search');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const ROOT_DIR = __dirname;
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const IMAGES_DIR = path.resolve(ROOT_DIR, 'images');
const SONGS_DIR = path.resolve(ROOT_DIR, 'songs');

const FAMILY_FILE = path.resolve(DATA_DIR, 'family.json');
const SONGS_FILE = path.resolve(DATA_DIR, 'songs.json');
const YOUTUBE_FILE = path.resolve(DATA_DIR, 'youtube.json');
const REPORTS_FILE = path.resolve(DATA_DIR, 'reports.json');
const ADMIN_AUTH_FILE = path.resolve(DATA_DIR, 'admin-auth.json');

const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(32);

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac']);
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'application/octet-stream',
]);

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const ALLOWED_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
  await fsp.mkdir(SONGS_DIR, { recursive: true });
}

function isInsideDir(baseDir, targetPath) {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(baseDir + path.sep);
}

function sanitizeFilename(originalName, fallbackBase) {
  const ext = path.extname(originalName || '').toLowerCase();
  const rawBase = path.basename(originalName || fallbackBase, ext);
  const cleanBase = rawBase
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${cleanBase || fallbackBase}${ext}`;
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

function hashPasscode(passcode, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return { salt, hash: derived };
}

function verifyPasscodeHash(passcode, saltHex, expectedHashHex) {
  const { hash } = hashPasscode(passcode, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.admin = payload;
  next();
}

async function getAuthConfig() {
  const envPass = process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim();
  if (envPass) {
    return { configured: true, source: 'env', envPass };
  }
  const saved = await readJsonFile(ADMIN_AUTH_FILE, null);
  if (saved && saved.hash && saved.salt) {
    return { configured: true, source: 'claimed', saved };
  }
  return { configured: false, source: 'unclaimed' };
}

async function syncSongsCatalog() {
  await ensureDirs();
  const saved = await readJsonFile(SONGS_FILE, []);
  const entries = await fsp.readdir(SONGS_DIR, { withFileTypes: true });
  const diskFiles = entries
    .filter((e) => e.isFile() && ALLOWED_AUDIO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);

  const diskSet = new Set(diskFiles);
  const kept = (Array.isArray(saved) ? saved : []).filter(
    (s) => s && typeof s.filename === 'string' && diskSet.has(s.filename)
  );
  const trackedSet = new Set(kept.map((s) => s.filename));

  for (const filename of diskFiles) {
    if (!trackedSet.has(filename)) {
      const baseTitle = path.basename(filename, path.extname(filename)).replace(/[-_]+/g, ' ');
      kept.push({
        id: crypto.randomUUID(),
        title: baseTitle,
        artist: 'Family Archive',
        filename,
        url: `/songs/${encodeURIComponent(filename)}`,
        uploadedAt: new Date().toISOString(),
      });
    }
  }
  if (kept.length !== (Array.isArray(saved) ? saved.length : 0)) {
    await writeJsonFile(SONGS_FILE, kept);
  }
  return kept;
}

const songUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SONGS_DIR),
    filename: (_req, file, cb) => {
      const clean = sanitizeFilename(file.originalname, 'track');
      const unique = `${Date.now()}-${clean}`;
      cb(null, unique);
    },
  }),
  limits: { fileSize: 35 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_AUDIO_EXTS.has(ext) || !ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
      return cb(new Error('Only MP3, WAV, OGG, M4A, or AAC audio files are allowed.'));
    }
    cb(null, true);
  },
});

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMAGES_DIR),
    filename: (_req, file, cb) => {
      const clean = sanitizeFilename(file.originalname, 'portrait');
      const target = path.resolve(IMAGES_DIR, clean);
      if (fs.existsSync(target)) {
        const ext = path.extname(clean);
        const base = path.basename(clean, ext);
        cb(null, `${base}-${Date.now()}${ext}`);
      } else {
        cb(null, clean);
      }
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext) || !ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WebP, or GIF image files are allowed.'));
    }
    cb(null, true);
  },
});

app.use(express.json({ limit: '1mb' }));

// Explicit static assets only (never expose server.js, package.json, .env, or data/admin-auth.json)
app.use('/images', express.static(IMAGES_DIR, { dotfiles: 'ignore' }));
app.use('/songs', express.static(SONGS_DIR, { dotfiles: 'ignore' }));

app.get('/', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'style.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(ROOT_DIR, 'app.js')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Auth endpoints
app.get('/api/auth/status', async (req, res) => {
  const cfg = await getAuthConfig();
  const payload = verifyToken(getBearerToken(req));
  res.json({
    authenticated: Boolean(payload && payload.role === 'admin'),
    configured: cfg.configured,
    source: cfg.source,
  });
});

app.post('/api/auth/setup', async (req, res) => {
  const cfg = await getAuthConfig();
  if (cfg.configured) {
    return res.status(409).json({ error: 'Admin passcode is already configured.' });
  }
  const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
  if (passcode.length < 4 || passcode.length > 64) {
    return res.status(400).json({ error: 'Passcode must be between 4 and 64 characters.' });
  }
  const { salt, hash } = hashPasscode(passcode);
  try {
    await fsp.writeFile(
      ADMIN_AUTH_FILE,
      JSON.stringify({ salt, hash, createdAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf-8', flag: 'wx' }
    );
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return res.status(409).json({ error: 'Admin passcode is already configured.' });
    }
    return res.status(500).json({ error: 'Failed to save admin passcode.' });
  }
  const token = createToken({ role: 'admin', exp: Date.now() + 1000 * 60 * 60 * 12 });
  res.status(201).json({ token, configured: true });
});

app.post('/api/auth/login', async (req, res) => {
  const cfg = await getAuthConfig();
  if (!cfg.configured) {
    return res.status(400).json({ error: 'Admin passcode not set up yet.' });
  }
  const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
  let valid = false;
  if (cfg.source === 'env') {
    const a = Buffer.from(passcode);
    const b = Buffer.from(cfg.envPass);
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } else {
    valid = verifyPasscodeHash(passcode, cfg.saved.salt, cfg.saved.hash);
  }
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect admin passcode.' });
  }
  const token = createToken({ role: 'admin', exp: Date.now() + 1000 * 60 * 60 * 12 });
  res.json({ token });
});

// Family catalog endpoints
app.get('/api/family', async (_req, res) => {
  const people = await readJsonFile(FAMILY_FILE, []);
  res.json(Array.isArray(people) ? people : []);
});

app.get('/api/images', async (_req, res) => {
  try {
    const entries = await fsp.readdir(IMAGES_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && ALLOWED_IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    res.json(files);
  } catch {
    res.json([]);
  }
});

function cleanPersonInput(body, existingId) {
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) return { error: 'Name is required.' };
  const rawPhotos = Array.isArray(body?.photos)
    ? body.photos
    : typeof body?.photos === 'string'
    ? body.photos.split(',')
    : [];
  const photos = [...new Set(
    rawPhotos
      .map((s) => path.basename(String(s || '').trim()))
      .filter((s) => s && ALLOWED_IMAGE_EXTS.has(path.extname(s).toLowerCase()))
  )];
  const id =
    existingId ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    `member-${Date.now()}`;

  return {
    person: {
      id,
      name,
      relation: typeof body?.relation === 'string' ? body.relation.trim().slice(0, 140) : '',
      desc: typeof body?.desc === 'string' ? body.desc.trim().slice(0, 600) : '',
      father: typeof body?.father === 'string' ? body.father.trim().slice(0, 120) : '',
      mother: typeof body?.mother === 'string' ? body.mother.trim().slice(0, 120) : '',
      spouse: typeof body?.spouse === 'string' ? body.spouse.trim().slice(0, 120) : '',
      birthYear: typeof body?.birthYear === 'string' ? body.birthYear.trim().slice(0, 20) : '',
      photos,
    },
  };
}

app.post('/api/family', requireAdmin, async (req, res) => {
  const parsed = cleanPersonInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const people = await readJsonFile(FAMILY_FILE, []);
  let id = parsed.person.id;
  if (people.some((p) => p.id === id)) {
    id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  }
  const created = { ...parsed.person, id };
  people.push(created);

  if (created.spouse) {
    const partner = people.find((p) => p.id === created.spouse);
    if (partner && !partner.spouse) partner.spouse = created.id;
  }

  await writeJsonFile(FAMILY_FILE, people);
  res.status(201).json(created);
});

app.put('/api/family/:id', requireAdmin, async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  const people = await readJsonFile(FAMILY_FILE, []);
  const idx = people.findIndex((p) => p.id === targetId);
  if (idx === -1) return res.status(404).json({ error: 'Person not found.' });

  const parsed = cleanPersonInput(req.body, targetId);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const updated = parsed.person;
  people[idx] = updated;

  if (updated.spouse) {
    const partner = people.find((p) => p.id === updated.spouse);
    if (partner && !partner.spouse) partner.spouse = updated.id;
  }

  await writeJsonFile(FAMILY_FILE, people);
  res.json(updated);
});

app.delete('/api/family/:id', requireAdmin, async (req, res) => {
  const targetId = String(req.params.id || '').trim();
  const people = await readJsonFile(FAMILY_FILE, []);
  const next = people
    .filter((p) => p.id !== targetId)
    .map((p) => ({
      ...p,
      father: p.father === targetId ? '' : p.father,
      mother: p.mother === targetId ? '' : p.mother,
      spouse: p.spouse === targetId ? '' : p.spouse,
    }));
  if (next.length === people.length) return res.status(404).json({ error: 'Person not found.' });
  await writeJsonFile(FAMILY_FILE, next);
  res.json({ ok: true });
});

app.post('/api/photos', requireAdmin, photoUpload.array('photos', 8), async (req, res) => {
  const uploaded = (req.files || []).map((f) => f.filename);
  if (!uploaded.length) return res.status(400).json({ error: 'No valid image files uploaded.' });
  res.status(201).json({ files: uploaded });
});

// MP3 / Audio endpoints
app.get('/api/songs', async (_req, res) => {
  const list = await syncSongsCatalog();
  res.json(list);
});

app.post('/api/songs', songUpload.array('tracks', 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No valid audio files uploaded.' });

  const list = await syncSongsCatalog();
  if (list.length + files.length > 120) {
    for (const f of files) {
      if (isInsideDir(SONGS_DIR, f.path)) await fsp.unlink(f.path).catch(() => {});
    }
    return res.status(400).json({ error: 'Playlist limit reached (120 tracks).' });
  }

  const customArtist =
    typeof req.body?.artist === 'string' && req.body.artist.trim()
      ? req.body.artist.trim().slice(0, 100)
      : 'Uploaded MP3';

  const added = files.map((f) => {
    const rawName = path.basename(f.originalname, path.extname(f.originalname));
    const cleanTitle = rawName.replace(/[-_]+/g, ' ').trim().slice(0, 140) || 'Untitled Track';
    return {
      id: crypto.randomUUID(),
      title: cleanTitle,
      artist: customArtist,
      filename: f.filename,
      size: f.size,
      url: `/songs/${encodeURIComponent(f.filename)}`,
      uploadedAt: new Date().toISOString(),
    };
  });

  const next = [...added, ...list];
  await writeJsonFile(SONGS_FILE, next);
  res.status(201).json(added);
});

app.patch('/api/songs/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const list = await syncSongsCatalog();
  const track = list.find((s) => s.id === id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    track.title = req.body.title.trim().slice(0, 140);
  }
  if (typeof req.body?.artist === 'string') {
    track.artist = req.body.artist.trim().slice(0, 100) || 'Family Archive';
  }
  await writeJsonFile(SONGS_FILE, list);
  res.json(track);
});

app.delete('/api/songs/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const list = await syncSongsCatalog();
  const track = list.find((s) => s.id === id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const filePath = path.resolve(SONGS_DIR, path.basename(track.filename));
  if (isInsideDir(SONGS_DIR, filePath)) {
    await fsp.unlink(filePath).catch(() => {});
  }
  const next = list.filter((s) => s.id !== id);
  await writeJsonFile(SONGS_FILE, next);
  res.json({ ok: true });
});

// YouTube Search, oEmbed & Queue endpoints
app.get('/api/youtube/search', async (req, res) => {
  const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  if (!q) return res.status(400).json({ error: 'Search query is required.' });
  try {
    const result = await yts(q);
    const videos = (result?.videos || []).slice(0, 8).map((v) => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author?.name || 'YouTube',
      duration: v.timestamp || '',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    }));
    res.json({ videos });
  } catch (err) {
    res.status(502).json({ error: 'YouTube search unavailable right now.' });
  }
});

app.get('/api/youtube/oembed', async (req, res) => {
  const rawUrl = typeof req.query?.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) return res.status(400).json({ error: 'URL is required.' });
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_YT_HOSTS.has(parsed.hostname.toLowerCase())) {
    return res.status(400).json({ error: 'Only YouTube URLs are permitted.' });
  }
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.toString())}&format=json`;
    const r = await fetch(oembedUrl);
    if (!r.ok) return res.status(404).json({ error: 'Video details not found.' });
    const data = await r.json();
    res.json({
      title: data.title || 'YouTube Video',
      author: data.author_name || 'YouTube',
      thumbnail: data.thumbnail_url || '',
    });
  } catch {
    res.status(502).json({ error: 'Unable to fetch video metadata.' });
  }
});

app.get('/api/youtube/queue', async (_req, res) => {
  const queue = await readJsonFile(YOUTUBE_FILE, []);
  res.json(Array.isArray(queue) ? queue : []);
});

app.post('/api/youtube/queue', async (req, res) => {
  const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
  const playlistId = typeof req.body?.playlistId === 'string' ? req.body.playlistId.trim() : '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) && !/^[A-Za-z0-9_-]{10,64}$/.test(playlistId)) {
    return res.status(400).json({ error: 'Valid YouTube video ID or playlist ID is required.' });
  }
  const queue = await readJsonFile(YOUTUBE_FILE, []);
  if (queue.length >= 60) {
    return res.status(400).json({ error: 'YouTube queue limit reached.' });
  }
  const key = videoId || `pl:${playlistId}`;
  const existing = queue.find((item) => item.id === key);
  if (existing) return res.json(existing);

  const item = {
    id: key,
    videoId: videoId || '',
    playlistId: playlistId || '',
    title:
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 140)
        : videoId
        ? `YouTube Video (${videoId})`
        : `YouTube Playlist (${playlistId})`,
    author:
      typeof req.body?.author === 'string' && req.body.author.trim()
        ? req.body.author.trim().slice(0, 100)
        : 'YouTube',
    duration: typeof req.body?.duration === 'string' ? req.body.duration.trim().slice(0, 20) : '',
    thumbnail:
      videoId
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : '',
    addedAt: new Date().toISOString(),
  };
  queue.unshift(item);
  await writeJsonFile(YOUTUBE_FILE, queue);
  res.status(201).json(item);
});

app.delete('/api/youtube/queue/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const queue = await readJsonFile(YOUTUBE_FILE, []);
  const next = queue.filter((item) => item.id !== id);
  await writeJsonFile(YOUTUBE_FILE, next);
  res.json({ ok: true });
});

// Guest Correction Reports
app.get('/api/reports', requireAdmin, async (_req, res) => {
  const reports = await readJsonFile(REPORTS_FILE, []);
  res.json(Array.isArray(reports) ? reports : []);
});

app.post('/api/reports', async (req, res) => {
  const msg = typeof req.body?.msg === 'string' ? req.body.msg.trim().slice(0, 1000) : '';
  if (!msg) return res.status(400).json({ error: 'Description of correction is required.' });
  const reports = await readJsonFile(REPORTS_FILE, []);
  const entry = {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    name: typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) || 'Guest' : 'Guest',
    person: typeof req.body?.person === 'string' ? req.body.person.trim().slice(0, 120) || 'General' : 'General',
    msg,
    status: 'Open',
  };
  reports.unshift(entry);
  await writeJsonFile(REPORTS_FILE, reports.slice(0, 200));
  res.status(201).json(entry);
});

app.patch('/api/reports/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const reports = await readJsonFile(REPORTS_FILE, []);
  const item = reports.find((r) => r.id === id);
  if (!item) return res.status(404).json({ error: 'Report not found.' });
  item.status = req.body?.status === 'Open' ? 'Open' : 'Fixed';
  await writeJsonFile(REPORTS_FILE, reports);
  res.json(item);
});

// Upload & error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Request failed.' });
  }
  res.status(500).json({ error: 'Unexpected server error.' });
});

ensureDirs().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
});
