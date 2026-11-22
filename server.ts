import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';
import { buildZipBuffer, type ZipEntryInput } from './src/utils/zipBuilder.ts';

const PORT = 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const AUDIO_DIR = path.resolve(DATA_DIR, 'audio-objects');
const SHARES_FILE = path.resolve(DATA_DIR, 'shares.json');
const ROOMS_FILE = path.resolve(DATA_DIR, 'rooms.json');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{3,120}$/;
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/midi',
  'audio/x-midi',
]);

interface StoredAudioMeta {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  projectId: string;
  uploader: string;
  createdAt: string;
}

interface StoredShareRecord {
  token: string;
  kind: 'project' | 'mix' | 'recording' | 'midi' | 'chordchart' | 'invitation' | 'songbook' | 'session';
  title: string;
  isPrivate: boolean;
  passcodeHash?: string;
  passcodeSalt?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

interface CollabRoomState {
  roomId: string;
  title: string;
  bpm: number;
  musicalKey: string;
  status: 'live' | 'rehearsal' | 'paused';
  chordChart: Array<{ id: string; section: string; chords: string[]; lyrics: string; bars: number }>;
  comments: Array<{ id: string; author: string; role: string; body: string; createdAt: string }>;
  sharedAssets: Array<{ id: string; name: string; uploader: string; mimeType: string; sizeBytes: number; url: string; createdAt: string }>;
  updatedAt: string;
}

interface TempLocationShare {
  token: string;
  lat: number;
  lng: number;
  accuracy?: number;
  label: string;
  collaboratorName: string;
  createdAt: string;
  expiresAtMs: number;
}

function readJsonMap<T>(filePath: string): Record<string, T> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, T>;
  } catch {
    return {};
  }
}

function writeJsonMap<T>(filePath: string, data: Record<string, T>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const audioIndexPath = path.resolve(DATA_DIR, 'audio-index.json');
const audioIndex = readJsonMap<StoredAudioMeta>(audioIndexPath);
const sharesStore = readJsonMap<StoredShareRecord>(SHARES_FILE);
const roomsStore = readJsonMap<CollabRoomState>(ROOMS_FILE);
const locationShares = new Map<string, TempLocationShare>();

function ensureDefaultRoom(roomId: string): CollabRoomState {
  if (!roomsStore[roomId]) {
    roomsStore[roomId] = {
      roomId,
      title: roomId === 'studio-main' ? 'Main Studio Session' : `Session ${roomId}`,
      bpm: 118,
      musicalKey: 'C Major',
      status: 'live',
      chordChart: [
        { id: 'c1', section: 'Intro', chords: ['C', 'G/B', 'Am7', 'Fmaj7'], lyrics: 'Warm synth pad swell & brushed kit', bars: 4 },
        { id: 'c2', section: 'Chorus', chords: ['F', 'C', 'G', 'Am7'], lyrics: 'Full band entrance on beat 1', bars: 4 },
      ],
      comments: [],
      sharedAssets: [],
      updatedAt: new Date().toISOString(),
    };
    writeJsonMap(ROOMS_FILE, roomsStore);
  }
  return roomsStore[roomId];
}

// Seed default studio room
ensureDefaultRoom('studio-main');

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const allowedOrigins = new Set<string>([
    'https://localhost',
    'capacitor://localhost',
    'http://localhost',
    'http://localhost:3000',
  ]);
  if (process.env.APP_URL) {
    try {
      allowedOrigins.add(new URL(process.env.APP_URL).origin);
    } catch {
      // Ignore placeholder APP_URL
    }
  }
  if (process.env.CORS_ALLOWED_ORIGINS) {
    for (const raw of process.env.CORS_ALLOWED_ORIGINS.split(',')) {
      const trimmed = raw.trim();
      if (trimmed) {
        try {
          allowedOrigins.add(new URL(trimmed).origin);
        } catch {
          // Ignore malformed origin
        }
      }
    }
  }

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'beat-labz-backend' });
  });

  // Public runtime configuration (never returns private server secrets)
  app.get('/api/config/public', (_req, res) => {
    const mapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
    const appUrl = process.env.APP_URL || '';
    res.json({ mapsApiKey, appUrl });
  });

  // C. BEAT LABZ AI ASSISTANT (Server-side @google/genai)
  app.post('/api/ai/assist', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured. Add your Gemini API key in Settings > Secrets to use BEAT LABZ AI Assistant.',
      });
      return;
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : 'general';
    const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};

    if (!prompt || prompt.length > 2000) {
      res.status(400).json({ error: 'Please provide a valid music question (1-2000 characters).' });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = `You are the BEAT LABZ Studio Music Assistant — an expert music producer, worship & contemporary arranger, mix/mastering engineer, vocal coach, guitarist, and pianist.
Provide practical, immediately playable advice tailored to the user's active DAW session.
Keep guidance clear, accurate, and musical. When suggesting chords, use standard chord symbols (e.g., Cmaj7, Am9, G/B, Fadd9). When suggesting EQ, specify exact Hz frequencies, Q, and +/- dB values.`;

      const contextText = `Active Session Context:
- Project: ${String((context as Record<string, unknown>).title ?? 'Untitled')}
- Key: ${String((context as Record<string, unknown>).musicalKey ?? 'C Major')}
- BPM: ${String((context as Record<string, unknown>).bpm ?? 120)}
- Time Signature: ${String((context as Record<string, unknown>).timeSignature ?? '4/4')}
- Focus Mode: ${category}

User Request:
${prompt}`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: contextText,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING, description: 'Clear, concise headline answer.' },
              detailedAdvice: { type: Type.STRING, description: 'Structured music theory, arrangement, mixing, vocal, or instrument guidance.' },
              recommendedChords: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Playable chord symbols relevant to the request.',
              },
              suggestedBpm: { type: Type.NUMBER, description: 'Recommended tempo in BPM if relevant.' },
              eqAndMixTips: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Specific EQ frequencies, compression, or vocal/instrument tips.',
              },
              voicingNotes: {
                type: Type.STRING,
                description: 'Specific piano voicing or guitar fret/capo notes when applicable.',
              },
            },
            required: ['summary', 'detailedAdvice', 'recommendedChords', 'eqAndMixTips'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({ result: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI Assistant request failed.';
      const status = message.includes('403') || message.includes('PERMISSION_DENIED')
        ? 403
        : message.includes('429') || message.includes('RESOURCE_EXHAUSTED')
          ? 429
          : 502;
      res.status(status).json({ error: message });
    }
  });

  // D & G. Object Storage for Large Audio Files (WAV, MP3, WebM, MIDI)
  app.get('/api/audio-objects', (_req, res) => {
    const items = Object.values(audioIndex).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    res.json({ items, totalBytes });
  });

  app.post('/api/audio-objects', (req, res) => {
    const fileNameRaw = typeof req.body?.fileName === 'string' ? req.body.fileName : 'audio-export.wav';
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.split(';')[0].trim().toLowerCase() : 'audio/wav';
    const base64Data = typeof req.body?.base64Data === 'string' ? req.body.base64Data : '';
    const projectId = typeof req.body?.projectId === 'string' && SAFE_ID_RE.test(req.body.projectId) ? req.body.projectId : 'local-project';
    const uploader = typeof req.body?.uploader === 'string' ? req.body.uploader.slice(0, 80) : 'Studio User';

    if (!ALLOWED_AUDIO_MIMES.has(mimeType)) {
      res.status(400).json({ error: `Unsupported audio MIME type: ${mimeType}` });
      return;
    }
    if (!base64Data) {
      res.status(400).json({ error: 'Missing base64 audio payload.' });
      return;
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.byteLength === 0 || buffer.byteLength > 20 * 1024 * 1024) {
      res.status(400).json({ error: 'Audio object size must be between 1 byte and 20 MB.' });
      return;
    }

    const id = `aud_${crypto.randomBytes(10).toString('hex')}`;
    const ext = mimeType.includes('mpeg') || mimeType.includes('mp3')
      ? '.mp3'
      : mimeType.includes('webm')
        ? '.webm'
        : mimeType.includes('ogg')
          ? '.ogg'
          : mimeType.includes('midi')
            ? '.mid'
            : '.wav';
    const targetPath = path.resolve(AUDIO_DIR, `${id}${ext}`);
    if (!targetPath.startsWith(AUDIO_DIR + path.sep)) {
      res.status(400).json({ error: 'Invalid audio file path.' });
      return;
    }

    fs.writeFileSync(targetPath, buffer);
    const cleanName = path.basename(fileNameRaw).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `${id}${ext}`;

    const meta: StoredAudioMeta = {
      id,
      fileName: cleanName,
      mimeType,
      sizeBytes: buffer.byteLength,
      projectId,
      uploader,
      createdAt: new Date().toISOString(),
    };
    audioIndex[id] = meta;
    writeJsonMap(audioIndexPath, audioIndex);

    res.status(201).json({
      ...meta,
      url: `/api/audio-objects/${id}`,
    });
  });

  app.get('/api/audio-objects/:id', (req, res) => {
    const id = req.params.id;
    if (!SAFE_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid audio ID.' });
      return;
    }
    const meta = audioIndex[id];
    if (!meta) {
      res.status(404).json({ error: 'Audio object not found.' });
      return;
    }
    const files = fs.readdirSync(AUDIO_DIR);
    const matched = files.find((f) => f.startsWith(`${id}.`));
    if (!matched) {
      res.status(404).json({ error: 'Audio binary missing from object storage.' });
      return;
    }
    const filePath = path.resolve(AUDIO_DIR, matched);
    if (!filePath.startsWith(AUDIO_DIR + path.sep)) {
      res.status(403).json({ error: 'Forbidden path.' });
      return;
    }
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${meta.fileName}"`);
    res.sendFile(filePath);
  });

  app.delete('/api/audio-objects/:id', (req, res) => {
    const id = req.params.id;
    if (!SAFE_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid audio ID.' });
      return;
    }
    if (!audioIndex[id]) {
      res.status(404).json({ error: 'Audio object not found.' });
      return;
    }
    const files = fs.readdirSync(AUDIO_DIR);
    const matched = files.find((f) => f.startsWith(`${id}.`));
    if (matched) {
      const filePath = path.resolve(AUDIO_DIR, matched);
      if (filePath.startsWith(AUDIO_DIR + path.sep) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    delete audioIndex[id];
    writeJsonMap(audioIndexPath, audioIndex);
    res.json({ deleted: true, id });
  });

  // A. BEAT LABZ CONNECT — Secure Share Links
  app.post('/api/shares', (req, res) => {
    const kind = req.body?.kind;
    const validKinds = new Set(['project', 'mix', 'recording', 'midi', 'chordchart', 'invitation', 'songbook', 'session']);
    if (!validKinds.has(kind)) {
      res.status(400).json({ error: 'Invalid share kind.' });
      return;
    }
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 120) : 'BEAT LABZ Share';
    const isPrivate = Boolean(req.body?.isPrivate);
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};

    const token = crypto.randomBytes(16).toString('base64url');
    let passcodeHash: string | undefined;
    let passcodeSalt: string | undefined;
    if (isPrivate && passcode.length > 0) {
      passcodeSalt = crypto.randomBytes(16).toString('hex');
      passcodeHash = crypto.scryptSync(passcode, passcodeSalt, 32).toString('hex');
    }

    const record: StoredShareRecord = {
      token,
      kind,
      title,
      isPrivate,
      passcodeHash,
      passcodeSalt,
      payload,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    sharesStore[token] = record;
    writeJsonMap(SHARES_FILE, sharesStore);

    res.status(201).json({
      token,
      kind,
      title,
      isPrivate,
      sharePath: `/?share=${token}`,
      expiresAt: record.expiresAt,
    });
  });

  app.get('/api/shares/:token', (req, res) => {
    const token = req.params.token;
    if (!SAFE_ID_RE.test(token)) {
      res.status(400).json({ error: 'Invalid share token.' });
      return;
    }
    const record = sharesStore[token];
    if (!record) {
      res.status(404).json({ error: 'Share link not found or expired.' });
      return;
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      res.status(410).json({ error: 'This share link has expired.' });
      return;
    }
    if (record.isPrivate && record.passcodeHash && record.passcodeSalt) {
      const supplied = typeof req.query.code === 'string' ? req.query.code : '';
      if (!supplied) {
        res.status(401).json({ error: 'Passcode required for private project share.', passcodeRequired: true });
        return;
      }
      const derived = crypto.scryptSync(supplied, record.passcodeSalt, 32);
      const stored = Buffer.from(record.passcodeHash, 'hex');
      if (derived.length !== stored.length || !crypto.timingSafeEqual(derived, stored)) {
        res.status(403).json({ error: 'Incorrect share passcode.', passcodeRequired: true });
        return;
      }
    }
    res.json({
      token: record.token,
      kind: record.kind,
      title: record.title,
      isPrivate: record.isPrivate,
      payload: record.payload,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    });
  });

  // B. LOCATION SHARING — Explicit Private Temporary Collaborator Share (Never Public)
  app.post('/api/location-shares', (req, res) => {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const accuracy = typeof req.body?.accuracy === 'number' ? req.body.accuracy : undefined;
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 100) : 'Studio Session Location';
    const collaboratorName = typeof req.body?.collaboratorName === 'string' ? req.body.collaboratorName.trim().slice(0, 80) : 'Invited Collaborator';
    const durationMinutes = Math.max(5, Math.min(120, Number(req.body?.durationMinutes) || 30));

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Valid latitude and longitude are required.' });
      return;
    }

    const token = `loc_${crypto.randomBytes(16).toString('base64url')}`;
    const expiresAtMs = Date.now() + durationMinutes * 60_000;
    const entry: TempLocationShare = {
      token,
      lat,
      lng,
      accuracy,
      label,
      collaboratorName,
      createdAt: new Date().toISOString(),
      expiresAtMs,
    };
    locationShares.set(token, entry);

    res.status(201).json({
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      shareUrlPath: `/?loc=${token}`,
    });
  });

  app.get('/api/location-shares/:token', (req, res) => {
    const token = req.params.token;
    const entry = locationShares.get(token);
    if (!entry) {
      res.status(404).json({ error: 'Location share stopped or not found.' });
      return;
    }
    if (entry.expiresAtMs <= Date.now()) {
      locationShares.delete(token);
      res.status(410).json({ error: 'Temporary location share has expired.' });
      return;
    }
    res.json({
      label: entry.label,
      collaboratorName: entry.collaboratorName,
      lat: entry.lat,
      lng: entry.lng,
      accuracy: entry.accuracy,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    });
  });

  app.delete('/api/location-shares/:token', (req, res) => {
    const token = req.params.token;
    const existed = locationShares.delete(token);
    res.json({ stopped: true, existed });
  });

  // G. Collaboration Rooms HTTP snapshot
  app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    if (!SAFE_ID_RE.test(roomId)) {
      res.status(400).json({ error: 'Invalid room ID.' });
      return;
    }
    res.json(ensureDefaultRoom(roomId));
  });

  // H. Downloadable Offline App Package (.zip) — strictly clean source & public assets (no secrets/runtime data)
  app.get('/api/download/bundle', (_req, res) => {
    try {
      const rootDir = process.cwd();
      const entries: ZipEntryInput[] = [];
      const rootFiles = [
        'package.json',
        'index.html',
        'vite.config.ts',
        'tsconfig.json',
        'capacitor.config.ts',
        'codemagic.yaml',
        'server.ts',
        '.env.example',
      ];
      for (const file of rootFiles) {
        const full = path.resolve(rootDir, file);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          entries.push({ name: `beat-labz-studio/${file}`, data: fs.readFileSync(full) });
        }
      }

      const walkSafeDir = (relDir: string) => {
        const absDir = path.resolve(rootDir, relDir);
        if (!fs.existsSync(absDir)) return;
        for (const dirent of fs.readdirSync(absDir, { withFileTypes: true })) {
          if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          const relChild = `${relDir}/${dirent.name}`;
          const absChild = path.resolve(absDir, dirent.name);
          if (!absChild.startsWith(absDir + path.sep)) continue;
          if (dirent.isDirectory()) {
            walkSafeDir(relChild);
          } else if (dirent.isFile()) {
            entries.push({ name: `beat-labz-studio/${relChild}`, data: fs.readFileSync(absChild) });
          }
        }
      };

      walkSafeDir('src');
      walkSafeDir('public');

      entries.push({
        name: 'beat-labz-studio/README-OFFLINE.md',
        data: [
          '# BEAT LABZ Studio — Local & Offline Bundle',
          '',
          '1. Install Node.js 20+',
          '2. Run `npm install`',
          '3. Run `npm run dev` and open `http://localhost:3000`',
          '4. Optional: set `GEMINI_API_KEY` in `.env` for AI Assistant.',
          '',
        ].join('\n'),
      });

      const zip = buildZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="beat-labz-studio.zip"');
      res.setHeader('Content-Length', String(zip.byteLength));
      res.send(zip);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to package download bundle.' });
    }
  });

  // Vite / Production static serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);

  // G. Real-time WebSocket Collaboration Server at /ws
  const wss = new WebSocketServer({ server, path: '/ws' });
  interface PeerInfo {
    ws: WebSocket;
    peerId: string;
    name: string;
    role: string;
    roomId: string;
  }
  const peers = new Set<PeerInfo>();

  function broadcastToRoom(roomId: string, payload: unknown) {
    const encoded = JSON.stringify(payload);
    for (const p of peers) {
      if (p.roomId === roomId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(encoded);
      }
    }
  }

  function getRoomPresence(roomId: string) {
    const list: Array<{ peerId: string; name: string; role: string }> = [];
    for (const p of peers) {
      if (p.roomId === roomId && p.ws.readyState === WebSocket.OPEN) {
        list.push({ peerId: p.peerId, name: p.name, role: p.role });
      }
    }
    return list;
  }

  wss.on('connection', (ws) => {
    let currentPeer: PeerInfo | null = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; roomId?: string; payload?: Record<string, unknown> };
        const roomId = typeof msg.roomId === 'string' && SAFE_ID_RE.test(msg.roomId) ? msg.roomId : 'studio-main';
        const room = ensureDefaultRoom(roomId);

        if (msg.type === 'session:join') {
          if (currentPeer) peers.delete(currentPeer);
          const peerId = typeof msg.payload?.peerId === 'string' ? msg.payload.peerId.slice(0, 64) : crypto.randomUUID();
          const name = typeof msg.payload?.name === 'string' ? msg.payload.name.slice(0, 64) : 'Musician';
          const role = typeof msg.payload?.role === 'string' ? msg.payload.role.slice(0, 32) : 'editor';
          currentPeer = { ws, peerId, name, role, roomId };
          peers.add(currentPeer);

          ws.send(JSON.stringify({
            type: 'session:init',
            roomId,
            room,
            presence: getRoomPresence(roomId),
          }));
          broadcastToRoom(roomId, {
            type: 'presence:update',
            roomId,
            presence: getRoomPresence(roomId),
          });
          return;
        }

        if (msg.type === 'chordchart:update' && Array.isArray(msg.payload?.chordChart)) {
          room.chordChart = msg.payload.chordChart.slice(0, 64);
          room.updatedAt = new Date().toISOString();
          writeJsonMap(ROOMS_FILE, roomsStore);
          broadcastToRoom(roomId, { type: 'chordchart:update', roomId, chordChart: room.chordChart });
          return;
        }

        if (msg.type === 'comment:add' && msg.payload?.comment) {
          const c = msg.payload.comment as { id: string; author: string; role: string; body: string; createdAt: string };
          if (c.id && c.body && !room.comments.some((existing) => existing.id === c.id)) {
            room.comments.push({
              id: String(c.id).slice(0, 64),
              author: String(c.author || 'Musician').slice(0, 64),
              role: String(c.role || 'editor').slice(0, 32),
              body: String(c.body).slice(0, 1000),
              createdAt: c.createdAt || new Date().toISOString(),
            });
            room.updatedAt = new Date().toISOString();
            writeJsonMap(ROOMS_FILE, roomsStore);
            broadcastToRoom(roomId, { type: 'comment:add', roomId, comment: room.comments[room.comments.length - 1] });
          }
          return;
        }

        if (msg.type === 'audio:shared' && msg.payload?.asset) {
          const a = msg.payload.asset as CollabRoomState['sharedAssets'][number];
          if (a.id && a.url && !room.sharedAssets.some((existing) => existing.id === a.id)) {
            room.sharedAssets.unshift(a);
            room.updatedAt = new Date().toISOString();
            writeJsonMap(ROOMS_FILE, roomsStore);
            broadcastToRoom(roomId, { type: 'audio:shared', roomId, asset: a });
          }
          return;
        }

        if (msg.type === 'session:status' && msg.payload) {
          if (typeof msg.payload.status === 'string' && ['live', 'rehearsal', 'paused'].includes(msg.payload.status)) {
            room.status = msg.payload.status as CollabRoomState['status'];
          }
          if (typeof msg.payload.bpm === 'number' && msg.payload.bpm >= 30 && msg.payload.bpm <= 300) {
            room.bpm = msg.payload.bpm;
          }
          if (typeof msg.payload.musicalKey === 'string') {
            room.musicalKey = msg.payload.musicalKey.slice(0, 24);
          }
          room.updatedAt = new Date().toISOString();
          writeJsonMap(ROOMS_FILE, roomsStore);
          broadcastToRoom(roomId, {
            type: 'session:status',
            roomId,
            status: room.status,
            bpm: room.bpm,
            musicalKey: room.musicalKey,
          });
        }
      } catch {
        // Ignore malformed socket frames
      }
    });

    ws.on('close', () => {
      if (currentPeer) {
        const { roomId } = currentPeer;
        peers.delete(currentPeer);
        broadcastToRoom(roomId, {
          type: 'presence:update',
          roomId,
          presence: getRoomPresence(roomId),
        });
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`BEAT LABZ server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
