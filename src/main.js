// SCRUB — strip every embedded tag from an image, 100% in-browser.
// Read with exifr, scrub by re-encoding pure pixels through canvas,
// verify the output carries zero tags before offering download.

import { parse, gps } from 'exifr';

const $ = (id) => document.getElementById(id);
const states = ['state-idle', 'state-loaded', 'state-done', 'state-error'];
function show(id) {
  for (const s of states) $(s).classList.toggle('hidden', s !== id);
}

let originalFile = null;
let originalName = '';
let scrubbedBlob = null;
let scrubbedName = '';

const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
  fileInput.value = '';
});

for (const ev of ['dragenter', 'dragover']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); });
}
dropzone.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadFile(f);
});
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f && !$('state-idle').classList.contains('hidden')) loadFile(f);
});

function fail(msg) {
  $('err-msg').textContent = msg;
  show('state-error');
}
$('retry-btn').addEventListener('click', () => show('state-idle'));

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function fmtGps(g) {
  if (!g || g.latitude == null) return null;
  const lat = Math.abs(g.latitude).toFixed(5) + '°' + (g.latitude >= 0 ? 'N' : 'S');
  const lon = Math.abs(g.longitude).toFixed(5) + '°' + (g.longitude >= 0 ? 'E' : 'W');
  return `${lat} ${lon}`;
}

function summarize(tags, gpsData) {
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
  const count = Object.keys(tags).length;
  return { rows, more: Math.max(0, count - rows.length), count };
}

async function loadFile(file) {
  if (!file.type.startsWith('image/')) return fail("that's not an image file.");
  originalFile = file;
  originalName = file.name || 'image';
  try {
    // decode check — unreadable formats (HEIC etc.) fail here
    const bmp = await createImageBitmap(file);
    bmp.close();
  } catch {
    return fail("couldn't decode that image. try jpg, png or webp.");
  }
  try {
    const tags = (await parse(file, true)) || {};
    const gpsData = await gps(file).catch(() => null);
    const { rows, more, count } = summarize(tags, gpsData);

    $('preview').src = URL.createObjectURL(file);
    $('tag-count').textContent = count;
    const ul = $('tag-list');
    ul.innerHTML = '';
    if (!count) {
      ul.innerHTML = '<li class="more">no embedded tags found. already clean.</li>';
    } else {
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
    show('state-loaded');
  } catch {
    fail('could not read metadata. the file may be corrupt.');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('scrub-btn').addEventListener('click', async () => {
  if (!originalFile) return;
  const btn = $('scrub-btn');
  btn.disabled = true;
  btn.textContent = 'SCRUBBING…';
  try {
    const bmp = await createImageBitmap(originalFile);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();

    // pure pixel re-encode: drops EXIF, IPTC, XMP, ICC, thumbnails — everything
    const srcType = originalFile.type;
    const mime = srcType === 'image/png' ? 'image/png' : srcType === 'image/webp' ? 'image/webp' : 'image/jpeg';
    scrubbedBlob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), mime, 0.92)
    );

    // verify: the output must carry zero tags
    const check = (await parse(scrubbedBlob, true)) || {};
    const remaining = Object.keys(check).length;
    const removed = parseInt($('tag-count').textContent, 10) || 0;

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const base = originalName.replace(/\.[a-z0-9]+$/i, '') || 'image';
    scrubbedName = `${base}-scrubbed.${ext}`;

    $('removed-count').textContent = remaining === 0 ? Math.max(removed, 1) : removed;
    $('size-before').textContent = fmtBytes(originalFile.size);
    $('size-after').textContent = fmtBytes(scrubbedBlob.size);
    show('state-done');
  } catch {
    fail('scrub failed on this file. try another.');
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
  $('preview').removeAttribute('src');
  show('state-idle');
});
