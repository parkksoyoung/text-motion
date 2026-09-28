import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ffmpegStatic from 'ffmpeg-static';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
// HOSTED=1 → running on a server (Railway/Docker): downloads instead of Finder, password, no file watcher
const HOSTED = !!process.env.HOSTED;
const PUBLIC = path.join(__dirname, 'public');
const FONTS_DEFAULT = path.join(PUBLIC, 'fonts');
const FONTS = process.env.FONTS_DIR || FONTS_DEFAULT;
const EFFECTS = path.join(PUBLIC, 'effects');
// EXPORTS_DIR / LOGOS_DIR let a hosted deployment keep these on a persistent volume
const EXPORTS = process.env.EXPORTS_DIR || path.join(__dirname, 'exports');
const LOGOS_DEFAULT = path.join(PUBLIC, 'assets', 'logos');
const LOGOS = process.env.LOGOS_DIR || LOGOS_DEFAULT;
// ffmpeg-static downloads a binary at install time; if that failed, fall back to a system ffmpeg (brew install ffmpeg)
const FFMPEG = process.env.FFMPEG || (ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg');
fs.mkdirSync(EXPORTS, { recursive: true });
fs.mkdirSync(LOGOS, { recursive: true });
fs.mkdirSync(FONTS, { recursive: true });
// first start on a fresh volume: seed the logo/font folders with the files shipped in the repo
if (LOGOS !== LOGOS_DEFAULT && fs.existsSync(LOGOS_DEFAULT) && fs.readdirSync(LOGOS).length === 0) {
  for (const f of fs.readdirSync(LOGOS_DEFAULT)) if (f.toLowerCase().endsWith('.png')) fs.copyFileSync(path.join(LOGOS_DEFAULT, f), path.join(LOGOS, f));
}
if (FONTS !== FONTS_DEFAULT && fs.existsSync(FONTS_DEFAULT)) {
  for (const f of fs.readdirSync(FONTS_DEFAULT)) if (/\.(ttf|otf|woff2?)$/i.test(f) && !fs.existsSync(path.join(FONTS, f))) fs.copyFileSync(path.join(FONTS_DEFAULT, f), path.join(FONTS, f));
}

const app = express();
app.use(express.json({ limit: '40mb' }));

/* ---------- optional password (APP_PASSWORD env) ----------
 * Team-internal protection for a hosted deployment. Requests from the machine itself (the render Chromium
 * loading stage.html) always pass. Cookie = sha256(password), so changing the password logs everyone out. */
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const authToken = APP_PASSWORD ? crypto.createHash('sha256').update(APP_PASSWORD).digest('hex') : '';
const isLoopback = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
const LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Rollout Text Animation</title><meta name="viewport" content="width=device-width">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:15px system-ui,sans-serif}form{display:grid;gap:12px;width:280px}h1{font-size:18px;font-weight:600;margin:0 0 4px}input{padding:10px 12px;border:1px solid #333;border-radius:8px;background:#1a1a1a;color:#eee;font-size:15px}button{padding:10px;border:0;border-radius:8px;background:#eee;color:#111;font-weight:600;font-size:15px;cursor:pointer}p{margin:0;color:#f66;font-size:13px;min-height:1em}</style>
<form method="post" action="/api/login"><h1>Rollout Text Animation</h1><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button>Enter</button><p>__MSG__</p></form>`;
app.use(express.urlencoded({ extended: false }));
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  if (String(req.body && req.body.password) === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `tm_auth=${authToken}; Path=/; Max-Age=${60 * 60 * 24 * 90}; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  }
  res.status(401).type('html').send(LOGIN_HTML.replace('__MSG__', 'Wrong password'));
});
if (APP_PASSWORD) app.use((req, res, next) => {
  if (isLoopback(req)) return next();
  const ok = (req.headers.cookie || '').split(/;\s*/).some(c => c === `tm_auth=${authToken}`);
  if (ok) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.status(401).type('html').send(LOGIN_HTML.replace('__MSG__', ''));
});

// ALLOW_4K=0 hides the 4K / square presets and rejects >FHD exports (for small-RAM hosting plans). Unset = allowed.
const ALLOW_4K = process.env.ALLOW_4K !== '0';
app.get('/api/env', (req, res) => res.json({ hosted: HOSTED, allow4k: ALLOW_4K }));

/* ---------- fonts: drop any .ttf/.otf/.woff2 into public/fonts ----------
 * Family name = file name up to the first "-" or "[" (Archivo[wdth,wght].ttf → Archivo,
 * Archivo-Italic[...] → Archivo italic). Variable fonts get full weight/width ranges. */
function fontFiles() {
  const all = fs.readdirSync(FONTS).filter(f => /\.(ttf|otf|woff2?)$/i.test(f)).map(file => {
    const base = file.replace(/\.[^.]+$/, '');
    const family = base.split(/[-\[]/)[0];
    const italic = /italic/i.test(base);
    const variable = /\[.*\]/.test(base) || /variable/i.test(base);
    const weightMatch = base.match(/-(Thin|ExtraLight|Light|Regular|Medium|SemiBold|Bold|ExtraBold|Black)/i);
    const weights = { thin:100, extralight:200, light:300, regular:400, medium:500, semibold:600, bold:700, extrabold:800, black:900 };
    const weight = variable ? '100 900' : (weightMatch ? weights[weightMatch[1].toLowerCase()] : 400);
    return { file, family, italic, variable, weight };
  });
  // If a family has a variable font, ignore its static cuts: 18 overlapping @font-face rules for one family
  // make the browser pick unpredictably (this is what happens when someone uploads a whole Google Fonts zip).
  // Also prefer one file per (family, italic) among variables: a plain [wght] over the [wdth,wght,slnt] variants.
  const hasVar = new Set(all.filter(f => f.variable).map(f => f.family + '|' + f.italic));
  const kept = all.filter(f => f.variable || !hasVar.has(f.family + '|' + f.italic));
  const seen = new Map();
  for (const f of kept.filter(f => f.variable).sort((a, b) => a.file.length - b.file.length)) { const k = f.family + '|' + f.italic; if (!seen.has(k)) seen.set(k, f.file); }
  return kept.filter(f => !f.variable || seen.get(f.family + '|' + f.italic) === f.file);
}
app.get('/api/fonts.css', (req, res) => {
  const css = fontFiles().map(f => `@font-face{font-family:"${f.family}";src:url("/fonts/${encodeURIComponent(f.file)}");font-weight:${f.weight};${f.variable ? 'font-stretch:50% 200%;' : ''}font-style:${f.italic ? 'italic' : 'normal'};font-display:block;}`).join('\n');
  res.set('Cache-Control', 'no-store').type('text/css').send(css);   // a newly uploaded font must show up on reload
});
// upload a font file: { name: 'Inter-Bold.ttf', data: base64 }. Family name comes from the file name
// ("Inter-Bold.ttf" -> Inter Bold, "Inter[wght].ttf" -> Inter variable), same rule as the shipped fonts.
const fontFileName = s => String(s || '').normalize('NFC').replace(/[^\w\-\[\]., ]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
app.post('/api/fonts', (req, res) => {
  const name = fontFileName(req.body.name);
  const data = String(req.body.data || '').replace(/^data:[^;]*;base64,/, '');
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  if (!/\.(ttf|otf|woff2?)$/i.test(name)) return res.status(400).json({ error: 'only .ttf, .otf, .woff or .woff2 files' });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'font file is larger than 20 MB' });
  fs.writeFileSync(path.join(FONTS, name), buf);
  res.json({ file: name, family: name.replace(/\.[^.]+$/, '').split(/[-\[]/)[0] });
});
app.delete('/api/fonts/:file', (req, res) => {
  const name = fontFileName(req.params.file);
  const file = path.join(FONTS, name);
  if (path.dirname(file) !== FONTS) return res.status(400).json({ error: 'bad name' });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});
app.get('/api/fonts', (req, res) => {
  const fams = {};
  fontFiles().forEach(f => {
    fams[f.family] ??= { family: f.family, variable: false, italic: false, weights: new Set() };
    if (f.variable) { fams[f.family].variable = true; [100,200,300,400,500,600,700,800,900].forEach(w => fams[f.family].weights.add(w)); }
    else fams[f.family].weights.add(+f.weight);
    if (f.italic) fams[f.family].italic = true;
    (fams[f.family].files ??= []).push(f.file);
  });
  res.json(Object.values(fams).map(f => ({ ...f, weights: [...f.weights].sort((a, b) => a - b) })));
});

/* ---------- effects: every public/effects/*.js is concatenated in name order ---------- */
app.get('/api/effects.js', (req, res) => {
  const files = fs.readdirSync(EFFECTS).filter(f => f.endsWith('.js')).sort();
  res.type('application/javascript').send(files.map(f => `/* ${f} */\n{\n${fs.readFileSync(path.join(EFFECTS, f), 'utf8')}\n}`).join('\n\n'));
});

/* ---------- presets: one JSON file, shared by everyone using this server ---------- */
const PRESETS_FILE = process.env.PRESETS_FILE || path.join(path.dirname(LOGOS), 'presets.json');
const readPresets = () => { try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return []; } };
const writePresets = list => { fs.mkdirSync(path.dirname(PRESETS_FILE), { recursive: true }); fs.writeFileSync(PRESETS_FILE, JSON.stringify(list, null, 1)); };
const presetName = s => String(s || '').normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
app.get('/api/presets', (req, res) => res.json(readPresets().sort((a, b) => (b.updated || 0) - (a.updated || 0))));
app.post('/api/presets', (req, res) => {
  const name = presetName(req.body.name); const config = req.body.config;
  if (!name || !config || typeof config !== 'object') return res.status(400).json({ error: 'name and config required' });
  const list = readPresets(); const i = list.findIndex(p => p.name === name);
  if (i >= 0 && !req.body.overwrite) return res.status(409).json({ error: 'a preset with this name already exists' });
  const now = Date.now();
  if (i >= 0) list[i] = { ...list[i], config, updated: now }; else list.push({ name, config, created: now, updated: now });
  writePresets(list); res.json({ ok: true, name });
});
app.patch('/api/presets/:name', (req, res) => {
  const from = presetName(req.params.name), to = presetName(req.body.name);
  if (!from || !to) return res.status(400).json({ error: 'name required' });
  const list = readPresets(); const p = list.find(x => x.name === from);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (list.some(x => x.name === to && x !== p)) return res.status(409).json({ error: 'a preset with this name already exists' });
  p.name = to; p.updated = Date.now(); writePresets(list); res.json({ ok: true });
});
app.delete('/api/presets/:name', (req, res) => {
  const name = presetName(req.params.name); const list = readPresets();
  writePresets(list.filter(p => p.name !== name)); res.json({ ok: true });
});

/* ---------- logos (for the Logo roll effect): public/assets/logos/*.png (or LOGOS_DIR) ---------- */
if (LOGOS !== LOGOS_DEFAULT) app.use('/assets/logos', express.static(LOGOS));
if (FONTS !== FONTS_DEFAULT) app.use('/fonts', express.static(FONTS));
function pngSize(file) {
  try { const b = Buffer.alloc(24); const fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
    return b.toString('ascii', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : {}; } catch { return {}; }
}
const logoName = s => String(s || '').normalize('NFC').replace(/\.png$/i, '').replace(/[^\w\-가-힣 ]/g, '').trim().replace(/\s+/g, '-').slice(0, 40);
app.get('/api/logos', (req, res) => {
  const list = fs.readdirSync(LOGOS).filter(f => f.toLowerCase().endsWith('.png')).sort()
    .map(f => ({ name: f.replace(/\.png$/i, ''), ...pngSize(path.join(LOGOS, f)), mtime: fs.statSync(path.join(LOGOS, f)).mtimeMs }));
  res.json(list);
});
// body: { name, data: base64 PNG (already trimmed / background removed in the browser) }
app.post('/api/logos', (req, res) => {
  const name = logoName(req.body.name); const data = String(req.body.data || '').replace(/^data:image\/png;base64,/, '');
  if (!name || !data) return res.status(400).json({ error: 'name and data required' });
  fs.writeFileSync(path.join(LOGOS, name + '.png'), Buffer.from(data, 'base64'));
  res.json({ name });
});
app.delete('/api/logos/:name', (req, res) => {
  const name = logoName(req.params.name); const file = path.join(LOGOS, name + '.png');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

/* ---------- export ---------- */
const jobs = new Map();
let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    // containers usually run as root with a small /dev/shm; both flags are needed there and harmless locally
    args: HOSTED ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=256'] : [],
  });
  return browser;
}
// exports run one at a time — two 4K renders in parallel on one Chromium just slow each other down
let queue = Promise.resolve();
const enqueue = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
// hosted: exports are downloaded right away, so anything older than EXPORT_TTL_HOURS (default 24) is deleted
const EXPORT_TTL = (+process.env.EXPORT_TTL_HOURS || 24) * 3600 * 1000;
function cleanExports() {
  if (!HOSTED) return;
  const now = Date.now();
  for (const f of fs.readdirSync(EXPORTS)) {
    if (f.startsWith('.')) continue;
    const p = path.join(EXPORTS, f);
    try { if (now - fs.statSync(p).mtimeMs > EXPORT_TTL) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}
cleanExports(); setInterval(cleanExports, 3600 * 1000).unref();

function slug(s) { return s.replace(/\s+/g, '-').replace(/[^\w\-가-힣]/g, '').slice(0, 40) || 'text'; }

app.post('/api/export', async (req, res) => {
  const { config, format = 'prores4444', name } = req.body;
  if (!ALLOW_4K && config && config.width * config.height > 1920 * 1080) return res.status(400).json({ error: 'Exports above FHD (1920×1080) are turned off on this server for now.' });
  const id = Date.now().toString(36);
  const job = { id, status: 'starting', frame: 0, frames: 0, file: null, error: null };
  jobs.set(id, job);
  res.json({ id });
  job.status = 'queued';
  enqueue(() => runExport(job, config, format, name)).catch(err => { job.status = 'error'; job.error = String(err && (err.stack || err.message) || err || 'unknown error'); console.error('[export]', job.error); });
});
app.get('/api/export/:id', (req, res) => res.json(jobs.get(req.params.id) || { status: 'unknown' }));
app.get('/api/exports', (req, res) => {
  const files = fs.readdirSync(EXPORTS).filter(f => !f.startsWith('.')).map(f => ({ name: f, size: fs.statSync(path.join(EXPORTS, f)).size, mtime: fs.statSync(path.join(EXPORTS, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});
// ?download=1 → browser saves the file instead of opening it (used by the Download button when hosted)
app.use('/exports', (req, res, next) => {
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(req.path))}"`);
  next();
}, express.static(EXPORTS));
// reveal a file (or the exports folder) in Finder / Explorer
app.post('/api/reveal', (req, res) => {
  const f = req.body && req.body.file ? path.join(EXPORTS, path.basename(String(req.body.file))) : EXPORTS;
  const target = fs.existsSync(f) ? f : EXPORTS;
  const cmd = process.platform === 'darwin' ? ['open', target === EXPORTS ? [target] : ['-R', target]] : process.platform === 'win32' ? ['explorer', [target === EXPORTS ? target : '/select,' + target]] : ['xdg-open', [EXPORTS]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

async function runExport(job, config, format, name) {
  const { width, height, fps } = config;
  const base = `${slug(name || config.text.split('\n')[0])}_${config.effect}_${width}x${height}_${fps}fps_${job.id}`;
  job.status = 'starting';
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  // NOTE: must be plain utf8 -> base64. Buffer.from(unescape(encodeURIComponent(s))) double-encodes and turned
  // "22–23" into "22â€“23" (and mangled Hangul) in the render, while the live preview looked fine.
  const c = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  await page.goto(`http://localhost:${PORT}/stage.html?c=${encodeURIComponent(c)}`);
  await page.waitForFunction(() => window.TM_ready === true, null, { timeout: 30000 });
  const total = await page.evaluate(() => window.TM_total);
  // CDP capture with optimizeForSpeed is ~2x faster than page.screenshot at 4K
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: format === 'mp4' ? { r: 0, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 0, a: 0 } });
  const frames = Math.ceil(total / 1000 * fps) + 1;
  job.frames = frames; job.status = 'rendering';

  const outFile = format === 'png' ? null : path.join(EXPORTS, base + (format === 'mp4' ? '.mp4' : '.mov'));
  // In a container ffmpeg sees the host's core count (often 32+), spawns that many frame threads and gets
  // OOM-killed. FFMPEG_THREADS caps it (default 1 when hosted, auto on a Mac).
  const THREADS = process.env.FFMPEG_THREADS || (HOSTED ? '1' : '0');
  // prores_ks allocates its packet buffer from bits_per_mb; 8000 (well above ProRes 4444 spec) needs >1 GB at 4K and
  // gets OOM-killed on a 1 GB container. 2000 is still above the 4444 target rate and fits. PRORES_BPM overrides.
  const BPM = process.env.PRORES_BPM || (HOSTED ? '2000' : '8000');
  // Rec.709 / video-range conversion + colr tags: without these, Premiere/AE/QuickTime guess the colour space and
  // range of the file, and a pure white can come out slightly grey (or the gamma lifted) on top of footage
  const COLR = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+write_colr'];
  const encodeArgs = inputArgs => {
    const args = ['-y', '-threads', THREADS, ...inputArgs];
    if (format === 'prores4444') args.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-bits_per_mb', BPM, '-threads', THREADS, ...COLR);
    else if (format === 'mp4') args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-threads', THREADS, ...COLR.slice(0, -2), '-movflags', '+faststart+write_colr');
    args.push('-r', String(fps), outFile);
    return args;
  };
  const spawnFf = (args, stdin) => {
    const p = spawn(FFMPEG, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let errLog = '';
    p.stderr.on('data', d => { errLog += d; if (errLog.length > 20000) errLog = errLog.slice(-20000); });
    p.on('error', e => { job.error = 'ffmpeg: ' + e.message; });
    // if ffmpeg dies mid-render the next stdin write raises EPIPE — without this handler it takes the whole server down
    p.__exited = null;
    p.on('close', (code, signal) => { p.__exited = { code, signal }; });
    if (stdin) p.stdin.on('error', e => { console.error('ffmpeg stdin:', e.message); });
    p.__log = () => errLog;
    return p;
  };
  // Hosted (small RAM): two phases — capture every frame to a temp folder, shut Chromium down, then encode from disk.
  // Local Mac: stream frames straight into ffmpeg (faster, RAM is plentiful).
  const twoPhase = HOSTED && format !== 'png';
  let ff = null, pngDir = null, tmpDir = null;
  if (format === 'png') { pngDir = path.join(EXPORTS, base); fs.mkdirSync(pngDir, { recursive: true }); }
  else if (twoPhase) {
    // NOT os.tmpdir(): in containers /tmp is usually tmpfs (RAM), and 85 frames of 4K PNG is ~1 GB. Use real disk.
    const scratch = process.env.SCRATCH_DIR || path.join(__dirname, '.scratch');
    fs.mkdirSync(scratch, { recursive: true });
    for (const d of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, d), { recursive: true, force: true });   // leftovers from a crashed run
    tmpDir = fs.mkdtempSync(path.join(scratch, 'tm-')); pngDir = tmpDir;
  }
  else ff = spawnFf(encodeArgs(['-f', 'image2pipe', '-framerate', String(fps), '-i', '-']), true);

  for (let i = 0; i < frames; i++) {
    const t = Math.min(total, i * 1000 / fps);
    await page.evaluate(t => { window.TM_seek(t); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, t);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    const png = Buffer.from(shot.data, 'base64');
    if (pngDir) fs.writeFileSync(path.join(pngDir, `${tmpDir ? 'f' : base + '_'}${String(i).padStart(5, '0')}.png`), png);
    else {
      if (ff.__exited) { await page.close(); throw new Error(`ffmpeg exited early (code ${ff.__exited.code}, signal ${ff.__exited.signal}) at frame ${i}\n` + ff.__log().slice(-3000)); }
      if (!ff.stdin.write(png)) await new Promise(r => { const done = () => { ff.stdin.off('close', done); r(); }; ff.stdin.once('drain', done); ff.stdin.once('close', done); });
    }
    job.frame = i + 1;
  }
  await page.close();

  if (twoPhase) {
    // free Chromium's memory before ffmpeg starts
    try { await b.close(); } catch {} browser = null;
    job.status = 'encoding';
    const frameBytes = fs.readdirSync(tmpDir).reduce((s, f) => s + fs.statSync(path.join(tmpDir, f)).size, 0);
    console.log('[export] frames on disk:', (frameBytes / 1048576).toFixed(0), 'MB in', tmpDir);
    const enc = spawnFf(encodeArgs(['-f', 'image2', '-framerate', String(fps), '-i', path.join(tmpDir, 'f%05d.png')]), false);
    const code = await new Promise(r => enc.on('close', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (code !== 0) throw new Error('ffmpeg exited ' + code + (enc.__exited && enc.__exited.signal ? ' signal ' + enc.__exited.signal : '') + `\n[frames ${(frameBytes / 1048576).toFixed(0)} MB]\n` + enc.__log().slice(-1500));
    job.status = 'done'; job.file = path.basename(outFile); return;
  }

  if (ff) {
    job.status = 'encoding';
    ff.stdin.end();
    const code = ff.__exited ? ff.__exited.code : await new Promise(r => ff.on('close', r));
    if (code !== 0) throw new Error('ffmpeg exited ' + code + (ff.__exited && ff.__exited.signal ? ' signal ' + ff.__exited.signal : '') + '\n' + ff.__log().slice(-3000));
  }
  // hosted: a folder can't be downloaded, so zip the PNG sequence (needs the `zip` binary — see Dockerfile)
  if (pngDir && HOSTED) {
    job.status = 'encoding';
    const zipFile = pngDir + '.zip';
    const z = spawn('zip', ['-q', '-r', '-j', zipFile, pngDir], { stdio: 'ignore' });
    const code = await new Promise(r => z.on('close', r));
    if (code !== 0) throw new Error('zip exited ' + code);
    fs.rmSync(pngDir, { recursive: true, force: true });
    job.status = 'done'; job.file = path.basename(zipFile); return;
  }
  job.status = 'done';
  job.file = pngDir ? path.basename(pngDir) + '/' : path.basename(outFile);
}

app.use(express.static(PUBLIC));
// auto-restart when server.js is updated (start.command relaunches on exit code 75)
if (!process.env.NO_WATCH && !HOSTED) { let t; fs.watch(fileURLToPath(import.meta.url), () => { clearTimeout(t); t = setTimeout(() => { console.log('server.js changed — restarting'); process.exit(75); }, 300); }); }

app.listen(PORT, () => {
  console.log(`\n  text-motion  →  http://localhost:${PORT}${HOSTED ? '  (hosted mode)' : ''}\n  ffmpeg: ${FFMPEG}\n  exports: ${EXPORTS}\n  logos: ${LOGOS}${APP_PASSWORD ? '\n  password: on' : ''}\n`);
});
process.on('exit', () => browser && browser.close());
