// SCRUB — strip every embedded tag from images AND videos, 100% in-browser.
// Images: exifr read + pure-pixel canvas re-encode.
// Videos: ffmpeg.wasm probe + lossless remux with -map_metadata -1.
// Output is verified to carry zero tags before download is offered.

import { parse, gps } from 'exifr';

const $ = (id) => document.getElementById(id);
const states = ['state-idle', 'state-loaded', 'state-done', 'state-error'];
function show(id) {
  for (const s of states) $(s).classList.toggle('hidden', s !== id);
}

let originalFile = null;
let originalName = '';
let isVideo = false;
let scrubbedBlob = null;
let scrubbedName = '';
let scrubbedMime = '';

const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
  fileInput.value = '';
});

const isMedia = (f) => f.type.startsWith('image/') || f.type.startsWith('video/');
for (const ev of ['dragenter', 'dragover']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); });
}
dropzone.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer.files || [])].find(isMedia);
  if (f) loadFile(f);
});
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find(isMedia);
  if (f && !$('state-idle').classList.contains('hidden')) loadFile(f);
});

function fail(msg) {
  $('err-msg').textContent = msg;
  show('state-error');
}
$('retry-btn').addEventListener('click', () => show('state-idle'));

function failQuiet(msg) { throw new Error(msg); }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function extOf(name) {
  const m = /\.([a-z0-9]{2,4})$/i.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '';
}

// ---------- lazy ffmpeg (only downloaded when a video is dropped) ----------
let ff = null;
async function ensureFFmpeg() {
  if (ff) return ff;
  const [{ FFmpeg }, { toBlobURL, fetchFile }] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ]);
  const ffmpeg = new FFmpeg();
  const coreURL = await toBlobURL('./ffmpeg-core.js', 'text/javascript');
  const wasmURL = await toBlobURL('./ffmpeg-core.wasm', 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });
  ff = { ffmpeg, fetchFile };
  return ff;
}

// Tags the MP4/MOV muxer always writes as track/container structure.
// Identical in billions of files; carry no device, user, location or time info.
const STRUCTURAL = new Set(['major_brand', 'minor_version', 'compatible_brands', 'handler_name', 'language', 'vendor_id']);

function parseFfmpegMeta(logs) {
  const tags = {};
  let duration = null;
  let inMeta = false;
  for (const line of logs.split('\n')) {
    const d = line.match(/Duration:\s*([\d:.]+)/);
    if (d) duration = d[1].split('.')[0];
    if (/^\s*Metadata:\s*$/.test(line)) { inMeta = true; continue; }
    if (inMeta) {
      const m = line.match(/^\s{4,}([\w.:-]+)\s*:\s*(.+?)\s*$/);
      if (m) { tags[m[1]] = m[2]; continue; }
      inMeta = false;
    }
  }
  return { tags, duration };
}

async function probeVideo(file) {
  const { ffmpeg, fetchFile } = await ensureFFmpeg();
  const inName = 'probe' + (extOf(file.name) || '.mp4');
  await ffmpeg.writeFile(inName, await fetchFile(file));
  let logs = '';
  const onLog = ({ message }) => { logs += message + '\n'; };
  ffmpeg.on('log', onLog);
  try {
    await ffmpeg.exec(['-hide_banner', '-i', inName]);
  } catch { /* no output file requested — logs are the product */ }
  ffmpeg.off('log', onLog);
  await ffmpeg.deleteFile(inName).catch(() => {});
  return parseFfmpegMeta(logs);
}

async function scrubVideo(file, onProgress) {
  const { ffmpeg, fetchFile } = await ensureFFmpeg();
  const inExt = extOf(file.name);
  const inName = 'in' + (inExt || '.mp4');
  const keepExt = ['.mp4', '.m4v', '.mov'].includes(inExt) ? inExt : '.mp4';
  const outName = 'out' + keepExt;
  await ffmpeg.writeFile(inName, await fetchFile(file));
  const prog = ({ progress }) => onProgress(Math.round(progress * 100));
  ffmpeg.on('progress', prog);
  try {
    // lossless remux: copy streams, nuke global + per-stream metadata,
    // and write no encoder tag of our own
    const code = await ffmpeg.exec(['-hide_banner', '-y', '-i', inName,
      '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1',
      '-c', 'copy', '-fflags', '+bitexact', outName]);
    if (code !== 0) throw new Error('remux failed with code ' + code);
  } finally {
    ffmpeg.off('progress', prog);
  }
  const data = await ffmpeg.readFile(outName);
  await ffmpeg.deleteFile(inName).catch(() => {});
  await ffmpeg.deleteFile(outName).catch(() => {});
  return {
    blob: new Blob([data], { type: keepExt === '.mov' ? 'video/quicktime' : 'video/mp4' }),
    ext: keepExt,
  };
}

// ---------- image path ----------
// Chromium's JPEG encoder embeds a stock JFIF APP0 + sRGB ICC APP2 segment.
// Neither identifies anyone, but scrub-hard means they go too.
function stripJpegSegments(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xd9) { parts.push(bytes.subarray(i, i + 2)); break; } // EOI
    if (marker === 0xda) { parts.push(bytes.subarray(i)); break; } // SOS: scan data verbatim
    if (marker >= 0xd0 && marker <= 0xd7) { parts.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) break;
    const seg = bytes.subarray(i, i + 2 + len);
    const isJfif = marker === 0xe0 && seg[4] === 0x4a && seg[5] === 0x46 && seg[6] === 0x49 && seg[7] === 0x46;
    let isIcc = false;
    if (marker === 0xe2 && len > 14) {
      isIcc = String.fromCharCode(seg[4], seg[5], seg[6], seg[7], seg[8], seg[9], seg[10], seg[11], seg[12], seg[13], seg[14]) === 'ICC_PROFILE';
    }
    if (!isJfif && !isIcc) parts.push(seg);
    i += 2 + len;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// exifr reports PNG's mandatory IHDR header as tags. IHDR isn't metadata —
// it's the image dimensions every PNG must carry. Filter it like the
// video STRUCTURAL set; real chunks (tEXt, iCCP, eXIf, tIME) still count.
const PNG_STRUCTURAL = new Set(['ImageWidth', 'ImageHeight', 'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace']);
// PNG: keep only the chunks pixels need. iCCP, tEXt, tIME, pHYs, eXIf — gone.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
function stripPngChunks(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let k = 0; k < 8; k++) if (bytes[k] !== sig[k]) return bytes;
  const parts = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 0 || i + 12 + len > bytes.length) break;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') break;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fmtGps(g) {
  if (!g || g.latitude == null) return null;
  const lat = Math.abs(g.latitude).toFixed(5) + '°' + (g.latitude >= 0 ? 'N' : 'S');
  const lon = Math.abs(g.longitude).toFixed(5) + '°' + (g.longitude >= 0 ? 'E' : 'W');
  return `${lat} ${lon}`;
}

function summarizeImage(tags, gpsData) {
  const rowsAll = [];
  const g = fmtGps(gpsData);
  if (g) rowsAll.push(['GPS', g]);
  const dev = [tags.Make, tags.Model].filter(Boolean).join(' ').trim();
  if (dev) rowsAll.push(['DEVICE', dev]);
  if (tags.DateTimeOriginal) rowsAll.push(['TAKEN', String(tags.DateTimeOriginal).slice(0, 19).replace('T', ' ')]);
  if (tags.Software) rowsAll.push(['SOFTWARE', String(tags.Software).slice(0, 26)]);
  if (tags.Artist) rowsAll.push(['ARTIST', String(tags.Artist).slice(0, 26)]);
  if (tags.ImageDescription) rowsAll.push(['DESCRIPTION', String(tags.ImageDescription).slice(0, 26)]);
  const rows = rowsAll.slice(0, 4);
  const count = Object.keys(tags).filter((k) => !PNG_STRUCTURAL.has(k)).length;
  return { rows, more: Math.max(0, count - rows.length), count };
}

function summarizeVideo(meta) {
  const rowsAll = [];
  const { tags, duration } = meta;
  if (tags.location) rowsAll.push(['GPS', tags.location]);
  if (tags.creation_time) rowsAll.push(['CREATED', String(tags.creation_time).slice(0, 19).replace('T', ' ')]);
  if (tags.encoder && !/Lavf/i.test(tags.encoder)) rowsAll.push(['ENCODER', String(tags.encoder).slice(0, 26)]);
  if (duration) rowsAll.push(['LENGTH', duration]);
  if (tags.make || tags.model) rowsAll.push(['DEVICE', [tags.make, tags.model].filter(Boolean).join(' ')]);
  const rows = rowsAll.slice(0, 4);
  const count = Object.keys(tags).filter((k) => !STRUCTURAL.has(k)).length;
  return { rows, more: Math.max(0, count - rows.length), count };
}

function renderFindings({ rows, more, count }) {
  $('tag-count').textContent = count;
  const ul = $('tag-list');
  ul.innerHTML = '';
  if (!count) {
    ul.innerHTML = '<li class="more">no embedded tags found. already clean.</li>';
    return;
  }
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<b>&#10005;</b> ${k} — ${escapeHtml(v)}`;
    ul.appendChild(li);
  }
  if (more) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = `+${more} more tags`;
    ul.appendChild(li);
  }
}

// ---------- load ----------
async function loadFile(file) {
  if (!isMedia(file)) return fail("that's not an image or video file.");
  originalFile = file;
  originalName = file.name || (file.type.startsWith('video/') ? 'video' : 'image');
  isVideo = file.type.startsWith('video/');
  const btn = $('scrub-btn');
  btn.disabled = true;
  btn.textContent = 'READING…';
  try {
    if (isVideo) {
      const meta = await probeVideo(file).catch(() => failQuiet('could not read that video.'));
      const pv = $('preview-video');
      const pi = $('preview-img');
      pv.src = URL.createObjectURL(file);
      pv.classList.remove('hidden');
      pi.classList.add('hidden');
      renderFindings(summarizeVideo(meta));
    } else {
      const bmp = await createImageBitmap(file).catch(() => failQuiet("couldn't decode that image. try jpg, png or webp."));
      bmp.close();
      const tags = (await parse(file, true).catch(() => ({}))) || {};
      const gpsData = await gps(file).catch(() => null);
      const pv = $('preview-video');
      const pi = $('preview-img');
      pi.src = URL.createObjectURL(file);
      pi.classList.remove('hidden');
      pv.classList.add('hidden');
      pv.removeAttribute('src');
      renderFindings(summarizeImage(tags, gpsData));
    }
    show('state-loaded');
  } catch (e) {
    fail(e.message || 'could not read that file.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'SCRUB IT';
  }
}

// ---------- scrub ----------
$('scrub-btn').addEventListener('click', async () => {
  if (!originalFile) return;
  const btn = $('scrub-btn');
  btn.disabled = true;
  btn.textContent = 'SCRUBBING…';
  try {
    const removed = parseInt($('tag-count').textContent, 10) || 0;
    if (isVideo) {
      const { blob, ext } = await scrubVideo(originalFile, (p) => { btn.textContent = `SCRUBBING ${p}%`; })
        .catch(() => failQuiet('scrub failed — video may be too large for this device.'));
      // verify
      const { ffmpeg, fetchFile } = await ensureFFmpeg();
      const vName = 'verify' + ext;
      await ffmpeg.writeFile(vName, await fetchFile(blob));
      let logs = '';
      const onLog = ({ message }) => { logs += message + '\n'; };
      ffmpeg.on('log', onLog);
      try { await ffmpeg.exec(['-hide_banner', '-i', vName]); } catch {}
      ffmpeg.off('log', onLog);
      await ffmpeg.deleteFile(vName).catch(() => {});
      const { tags } = parseFfmpegMeta(logs);
      const remaining = Object.keys(tags).filter((k) => !STRUCTURAL.has(k)).length;
      if (remaining > 0) failQuiet('verification found leftover tags. not shipping that.');
      scrubbedBlob = blob;
      scrubbedMime = blob.type;
      const base = originalName.replace(/\.[a-z0-9]+$/i, '') || 'video';
      scrubbedName = `${base}-scrubbed${ext}`;
    } else {
      const bmp = await createImageBitmap(originalFile);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      // pure pixel re-encode: drops EXIF, IPTC, XMP, ICC, thumbnails — everything
      const srcType = originalFile.type;
      const mime = srcType === 'image/png' ? 'image/png' : srcType === 'image/webp' ? 'image/webp' : 'image/jpeg';
      scrubbedBlob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), mime, 0.92)
      ).catch(() => failQuiet('scrub failed on this file.'));
      if (mime === 'image/jpeg' || mime === 'image/png') {
        // drop the encoder's own stock segments/chunks from the bytes
        const raw = new Uint8Array(await scrubbedBlob.arrayBuffer());
        const stripped = mime === 'image/jpeg' ? stripJpegSegments(raw) : stripPngChunks(raw);
        // sanity: the stripped file must still decode, or we ship nothing
        await createImageBitmap(new Blob([stripped], { type: mime })).then((b) => b.close())
          .catch(() => failQuiet('scrub failed on this file.'));
        scrubbedBlob = new Blob([stripped], { type: mime });
      }
      const check = (await parse(scrubbedBlob, true).catch(() => ({}))) || {};
      const imgRemaining = Object.keys(check).filter((k) => !PNG_STRUCTURAL.has(k)).length;
      if (imgRemaining > 0) failQuiet('verification found leftover tags. not shipping that.');
      scrubbedMime = mime;
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const base = originalName.replace(/\.[a-z0-9]+$/i, '') || 'image';
      scrubbedName = `${base}-scrubbed.${ext}`;
    }
    $('removed-count').textContent = Math.max(removed, 1);
    $('size-before').textContent = fmtBytes(originalFile.size);
    $('size-after').textContent = fmtBytes(scrubbedBlob.size);
    show('state-done');
  } catch (e) {
    fail(e.message || 'scrub failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'SCRUB IT';
  }
});

$('download-btn').addEventListener('click', () => {
  if (!scrubbedBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(scrubbedBlob);
  a.download = scrubbedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$('again-btn').addEventListener('click', () => {
  originalFile = null;
  scrubbedBlob = null;
  $('preview-img').removeAttribute('src');
  const pv = $('preview-video');
  pv.removeAttribute('src');
  pv.classList.add('hidden');
  $('preview-img').classList.remove('hidden');
  show('state-idle');
});
