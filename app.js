// ============================================================
// Shady Search - منطق التطبيق
// ============================================================

// عدّل اليوزر والباسورد هنا زي ما تحب
const AUTH_USERNAME = 'shady';
const AUTH_PASSWORD = '1234';
const AUTH_STORAGE_KEY = 'shady_search_auth_ok';

// إشعارات تليجرام - عن طريق وسيط Cloudflare Worker (لازم تعمله وتحط
// رابطه هنا - الخطوات في README.md)
const NOTIFY_PROXY_URL = 'shady-search-notify2.shadyyousryx.workers.dev/';

function getDeviceInfo() {
  const ua = navigator.userAgent || '';
  let os = 'جهاز غير معروف';
  if (/android/i.test(ua)) os = 'أندرويد';
  else if (/iphone/i.test(ua)) os = 'آيفون';
  else if (/ipad/i.test(ua)) os = 'آيباد';
  else if (/windows/i.test(ua)) os = 'ويندوز';
  else if (/macintosh|mac os/i.test(ua)) os = 'ماك';
  else if (/linux/i.test(ua)) os = 'لينكس';

  let browser = '';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';

  return browser ? `${os} - ${browser}` : os;
}

function sendTelegramNotification(text) {
  if (!NOTIFY_PROXY_URL || NOTIFY_PROXY_URL.includes('PUT_YOUR')) return;
  fetch(NOTIFY_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch((e) => console.warn('telegram notify failed', e));
}

const DB_CACHE_NAME = 'shady-search-db-v1';
const DB_CACHE_KEY = '/customers.db.assembled';

let allAreas = [];
let lastRows = [];

// -------------------- Web Worker لتشغيل SQLite بعيد عن الشاشة الرئيسية --------------------
// ده اللي بيمنع تجمّد الشاشة وقت البحث، حتى لو البحث نفسه ياخد وقت.

const sqlWorker = new Worker('worker.sql-wasm.js');
let workerReqId = 0;
const pendingWorkerRequests = new Map();

sqlWorker.onmessage = (event) => {
  const { id } = event.data;
  const resolver = pendingWorkerRequests.get(id);
  if (resolver) {
    pendingWorkerRequests.delete(id);
    resolver(event.data);
  }
};

sqlWorker.onerror = (err) => {
  console.error('SQL worker error:', err);
};

function workerRequest(action, extra = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = workerReqId++;
    pendingWorkerRequests.set(id, (data) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    });
    sqlWorker.postMessage({ id, action, ...extra }, transfer);
  });
}

function execInWorker(sql, params) {
  return workerRequest('exec', { sql, params }).then((data) => {
    const result = data.results && data.results[0];
    if (!result) return [];
    return result.values.map((valuesRow) =>
      Object.fromEntries(result.columns.map((col, i) => [col, valuesRow[i]]))
    );
  });
}

const loginScreen = document.getElementById('loginScreen');
const loginUser = document.getElementById('loginUser');
const loginPass = document.getElementById('loginPass');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');

const splashEl = document.getElementById('splash');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusText = document.getElementById('statusText');
const resultsEl = document.getElementById('results');
const resultsMetaEl = document.getElementById('resultsMeta');
const searchInput = document.getElementById('searchInput');
const areaInput = document.getElementById('areaInput');
const areaDropdown = document.getElementById('areaDropdown');
const areaClear = document.getElementById('areaClear');
const toastEl = document.getElementById('toast');
const refreshBtn = document.getElementById('refreshBtn');

let selectedArea = '';
let highlightedIndex = -1;
let currentFilteredAreas = [];

function setProgress(pct, status) {
  progressFill.style.width = pct + '%';
  progressText.textContent = Math.round(pct) + '%';
  if (status) statusText.textContent = status;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1200);
}

// -------------------- تسجيل الدخول --------------------

function isAuthenticated() {
  return localStorage.getItem(AUTH_STORAGE_KEY) === 'yes';
}

function tryLogin() {
  const u = loginUser.value.trim();
  const p = loginPass.value;
  const device = getDeviceInfo();
  const time = new Date().toLocaleString('ar-EG', { hour12: true });
  if (u === AUTH_USERNAME && p === AUTH_PASSWORD) {
    localStorage.setItem(AUTH_STORAGE_KEY, 'yes');
    loginScreen.style.display = 'none';
    sendTelegramNotification(`✅ دخول جديد على Shady Search\nالجهاز: ${device}\nالوقت: ${time}`);
    startApp();
  } else {
    loginError.textContent = 'اسم المستخدم أو كلمة المرور غلط';
    sendTelegramNotification(`⚠️ محاولة دخول فاشلة\nاليوزر المكتوب: ${u || '(فاضي)'}\nالجهاز: ${device}\nالوقت: ${time}`);
  }
}

loginBtn.addEventListener('click', tryLogin);
loginPass.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryLogin();
});

function boot() {
  if (isAuthenticated()) {
    startApp();
  } else {
    loginScreen.style.display = 'flex';
  }
}

// -------------------- تجميع قاعدة البيانات من الأجزاء --------------------

async function getCachedDbBytes() {
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    const match = await cache.match(DB_CACHE_KEY);
    if (match) {
      const buf = await match.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch (e) {
    console.warn('cache read failed', e);
  }
  return null;
}

async function cacheDbBytes(bytes) {
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    const response = new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await cache.put(DB_CACHE_KEY, response);
  } catch (e) {
    console.warn('cache write failed', e);
  }
}

async function assembleDatabase() {
  // أول حاجة: هل عندنا نسخة محفوظة من قبل؟
  setProgress(0, 'بيتأكد من وجود نسخة محفوظة...');
  const cached = await getCachedDbBytes();
  if (cached && cached.length > 0) {
    setProgress(100, 'لقينا نسخة جاهزة');
    return cached;
  }

  // نزّل عدد الأجزاء
  setProgress(0, 'بيتم تجهيز البيانات لأول مرة...');
  const chunkCountText = await (await fetch('data/customers.db.chunks')).text();
  const totalChunks = parseInt(chunkCountText.trim(), 10);

  const parts = [];
  let totalBytes = 0;
  for (let i = 1; i <= totalChunks; i++) {
    const partName = String(i).padStart(3, '0');
    const resp = await fetch(`data/customers.db.part${partName}`);
    if (!resp.ok) throw new Error(`فشل تحميل الجزء ${partName}`);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    parts.push(bytes);
    totalBytes += bytes.length;
    setProgress(
      (i / totalChunks) * 100,
      `بيتحمّل الجزء ${i} من ${totalChunks}...`
    );
  }

  // ادمج كل الأجزاء في مصفوفة واحدة
  setProgress(100, 'بيتم التجميع...');
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  await cacheDbBytes(merged);
  return merged;
}

// -------------------- تهيئة قاعدة البيانات --------------------

async function initDatabase() {
  splashEl.style.display = 'flex';
  const bytes = await assembleDatabase();

  // ابعت البيانات للـ Worker (transfer مش نسخ، عشان يبقى سريع وماياخدش
  // ذاكرة إضافية) وسيبه هو اللي يفتح قاعدة البيانات
  await workerRequest('open', { buffer: bytes.buffer }, [bytes.buffer]);

  // حمّل قايمة المناطق
  try {
    const rows = await execInWorker(
      "SELECT DISTINCT area FROM customers WHERE area IS NOT NULL AND area != '' ORDER BY area"
    );
    allAreas = rows.map((r) => r.area);
    const areaCountBadge = document.getElementById('areaCountBadge');
    if (areaCountBadge) {
      areaCountBadge.textContent = `${allAreas.length} منطقة متاحة`;
    }
  } catch (e) {
    console.warn('area load failed', e);
  }

  splashEl.style.display = 'none';
}

// -------------------- البحث --------------------

async function runSearch() {
  const q = searchInput.value.trim();
  const area = selectedArea;

  if (!q && !area) {
    resultsMetaEl.textContent = '';
    resultsEl.innerHTML = `<div class="empty-state">اكتب اسم أو تليفون أو اختار منطقة عشان تبدأ البحث</div>`;
    return;
  }

  const whereParts = [];
  const params = [];

  // كل كلمة أو رقم مكتوب بيتفصل عن التاني بمسافة، ولازم كل جزء يتلاقي
  // في العمود المجمّع (search_blob) عشان الصف يظهر في النتيجة - فحص
  // واحد بس لكل كلمة بدل ما يفحص كل عمود لوحده، فبيبقى أسرع بكتير
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      whereParts.push('search_blob LIKE ?');
      params.push(`%${token}%`);
    }
  }

  if (area) {
    whereParts.push('area = ?');
    params.push(area);
  }

  const sql = `SELECT * FROM customers WHERE ${whereParts.join(' AND ')} LIMIT 300`;

  let rows = [];
  try {
    rows = await execInWorker(sql, params);
  } catch (e) {
    resultsEl.innerHTML = `<div class="empty-state">حصل خطأ أثناء البحث: ${e.message}</div>`;
    return;
  }

  if (q) {
    sendTelegramNotification(
      `🔍 بحث جديد: "${q}"${area ? '\nالمنطقة: ' + area : ''}\nعدد النتائج: ${rows.length}\nالجهاز: ${getDeviceInfo()}`
    );
  }

  renderResults(rows);
}

function renderResults(rows) {
  if (rows.length === 0) {
    resultsMetaEl.textContent = '';
    resultsEl.innerHTML = `<div class="empty-state">مفيش نتايج</div>`;
    return;
  }

  resultsMetaEl.textContent = `${rows.length} نتيجة`;
  lastRows = rows;
  resultsEl.innerHTML = rows.map((row, idx) => rowToCardHtml(row, idx)).join('');

  // اربط أحداث النسخ لكل رقم
  resultsEl.querySelectorAll('.phone-chip').forEach((btn) => {
    btn.addEventListener('click', () => copyPhone(btn.dataset.phone));
  });

  // اربط زرار الخريطة لكل كارت
  resultsEl.querySelectorAll('.map-btn').forEach((btn) => {
    btn.addEventListener('click', () => openMapModal(lastRows[Number(btn.dataset.idx)]));
  });
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function rowToCardHtml(row, idx) {
  const name = row.name || '';
  const area = row.area || '';
  const phones = [row.phone1, row.phone2, row.phone3].filter((p) => p && p.trim());
  const addressParts = [
    ['الشارع', row.street],
    ['الوصف', row.description],
    ['رقم العقار', row.building],
    ['الدور', row.floor],
    ['الشقة', row.apartment],
    ['ملاحظات', row.notes],
  ].filter(([, v]) => v && v.trim());

  const initial = name ? esc(name.substring(0, 1)) : '?';

  const phonesHtml = phones.length
    ? `<div class="phones">${phones
        .map(
          (p) =>
            `<button class="phone-chip" data-phone="${esc(p)}">📞 ${esc(p)} 📋</button>`
        )
        .join('')}</div>`
    : '';

  const addressHtml = addressParts.length
    ? `<div class="address-lines">${addressParts
        .map(([label, val]) => `<div><b>${esc(label)}:</b> ${esc(val)}</div>`)
        .join('')}</div>`
    : '';

  return `
    <div class="card">
      <div class="card-top">
        <div class="avatar">${initial}</div>
        <div class="name">${esc(name) || '(بدون اسم)'}</div>
        ${area ? `<div class="area-chip">${esc(area)}</div>` : ''}
      </div>
      ${phonesHtml}
      ${addressHtml}
      <div class="phones" style="margin-top:8px;">
        <button class="map-btn" data-idx="${idx}">
          🗺️ اعرض على الخريطة
        </button>
      </div>
    </div>
  `;
}

function copyPhone(phone) {
  navigator.clipboard
    .writeText(phone)
    .then(() => showToast(`اتنسخ الرقم: ${phone}`))
    .catch(() => {
      // فولباك لو الكوبي API مش شغالة
      const ta = document.createElement('textarea');
      ta.value = phone;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(`اتنسخ الرقم: ${phone}`);
    });
}

// -------------------- الخريطة --------------------
// خرائط مجانية بالكامل (Leaflet + OpenStreetMap)، مقفولة على حدود مصر
// بس، وبتحاول تلاقي مكان العنوان فعليًا عن طريق بحث نصي (Geocoding).
// مفيش عندنا إحداثيات GPS حقيقية للعملاء أصلاً، فالخريطة دي بتحاول
// تدوّر على العنوان وقت ما تفتحها بس - محتاجة إنترنت عشان تشتغل.

const EGYPT_BOUNDS = [
  [21.5, 24.5], // جنوب غرب
  [32.2, 37.0], // شمال شرق
];
const EGYPT_CENTER = [26.8, 30.8];

let leafletMap = null;
let leafletMarker = null;
let geocodeCache = new Map();
let lastGeocodeTime = 0;

if (typeof L !== 'undefined') {
  L.Icon.Default.prototype.options.imagePath = 'leaflet/images/';
}

function ensureMapInitialized() {
  if (leafletMap) return leafletMap;

  leafletMap = L.map('leafletMap', {
    center: EGYPT_CENTER,
    zoom: 6,
    minZoom: 6,
    maxBounds: EGYPT_BOUNDS,
    maxBoundsViscosity: 1.0,
    zoomControl: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(leafletMap);

  L.control.zoom({ position: 'bottomleft' }).addTo(leafletMap);

  return leafletMap;
}

function buildAddressQuery(row) {
  const parts = [row.street, row.area].filter((v) => v && v.trim());
  return parts.join('، ');
}

function buildFullAddressText(row) {
  const parts = [
    row.street,
    row.description,
    row.building ? `عقار ${row.building}` : '',
    row.floor ? `دور ${row.floor}` : '',
    row.apartment ? `شقة ${row.apartment}` : '',
    row.area,
  ].filter((v) => v && v.trim());
  return parts.join('، ');
}

async function geocodeAddress(query) {
  if (!query) return null;
  if (geocodeCache.has(query)) return geocodeCache.get(query);
  if (!NOTIFY_PROXY_URL || NOTIFY_PROXY_URL.includes('PUT_YOUR')) return null;

  // احترام حد الاستخدام العادل لـ Nominatim (طلب واحد في الثانية تقريبًا)
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastGeocodeTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeTime = Date.now();

  // بيمر عن طريق نفس الـ Worker بتاع إشعارات تليجرام، عشان يحل مشكلة
  // إن Nominatim مش بيسمح للمتصفح يكلمه مباشرة
  const url = `${NOTIFY_PROXY_URL}/geocode?q=${encodeURIComponent(query + '، مصر')}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const result = data && data[0] ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
    geocodeCache.set(query, result);
    return result;
  } catch (e) {
    console.warn('geocode failed', e);
    return null;
  }
}

function setMapStatus(text, show) {
  const el = document.getElementById('mapStatus');
  el.textContent = text;
  el.classList.toggle('show', !!show);
}

async function openMapModal(row) {
  if (!row) return;
  const modal = document.getElementById('mapModal');
  modal.classList.add('show');

  document.getElementById('mapHeaderName').textContent = row.name || 'موقع العميل';
  document.getElementById('sheetName').textContent = row.name || '(بدون اسم)';
  document.getElementById('sheetArea').textContent = row.area || '';

  const phones = [row.phone1, row.phone2, row.phone3].filter((p) => p && p.trim());
  document.getElementById('sheetPhones').innerHTML = phones
    .map((p) => `<button class="phone-chip" data-phone="${esc(p)}">📞 ${esc(p)} 📋</button>`)
    .join('');
  document.getElementById('sheetPhones').querySelectorAll('.phone-chip').forEach((btn) => {
    btn.addEventListener('click', () => copyPhone(btn.dataset.phone));
  });

  const fullAddress = buildFullAddressText(row);
  document.getElementById('sheetAddress').textContent = fullAddress || 'مفيش تفاصيل عنوان مسجّلة';

  const googleQuery = encodeURIComponent((fullAddress || row.area || '') + '، مصر');
  document.getElementById('openGoogleMapsBtn').onclick = () => {
    window.open(`https://www.google.com/maps/search/?api=1&query=${googleQuery}`, '_blank');
  };

  const map = ensureMapInitialized();
  setTimeout(() => map.invalidateSize(), 50);

  if (!navigator.onLine) {
    setMapStatus('محتاج إنترنت عشان الخريطة تشتغل - جرب افتحه في خرائط جوجل', true);
    map.setView(EGYPT_CENTER, 6);
    return;
  }

  setMapStatus('بيدوّر على مكان العنوان...', true);
  if (leafletMarker) {
    map.removeLayer(leafletMarker);
    leafletMarker = null;
  }

  const query = buildAddressQuery(row);
  const result = await geocodeAddress(query);

  if (result) {
    setMapStatus('', false);
    map.setView([result.lat, result.lon], 16);
    leafletMarker = L.marker([result.lat, result.lon]).addTo(map);
    leafletMarker
      .bindPopup(`<b>${esc(row.name || '')}</b><br>${esc(fullAddress)}`)
      .openPopup();
  } else {
    setMapStatus('مقدرناش نلاقي المكان بالظبط على الخريطة - جرب "افتح في خرائط جوجل" تحت 👇', true);
    map.setView(EGYPT_CENTER, 6);
  }
}

function closeMapModal() {
  document.getElementById('mapModal').classList.remove('show');
}

document.getElementById('mapCloseBtn').addEventListener('click', closeMapModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMapModal();
});

// -------------------- إعادة التجهيز --------------------

async function resetDatabase() {
  if (!confirm('هيتم إعادة تحميل البيانات من جديد. متأكد؟')) return;
  try {
    const cache = await caches.open(DB_CACHE_NAME);
    await cache.delete(DB_CACHE_KEY);
  } catch (e) {
    console.warn(e);
  }
  location.reload();
}

// -------------------- خانة بحث المنطقة (combobox) --------------------

function normalizeArabic(s) {
  // يخلي البحث مش حساس لاختلافات بسيطة شائعة في الكتابة العربية
  return (s || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

function getFilteredAreas() {
  const q = normalizeArabic(areaInput.value.trim());
  if (!q) return allAreas;
  return allAreas.filter((a) => normalizeArabic(a).includes(q));
}

function renderAreaDropdown() {
  currentFilteredAreas = getFilteredAreas();
  highlightedIndex = -1;

  let html = `<div class="area-option all-option" data-area="">كل المناطق</div>`;
  if (currentFilteredAreas.length === 0) {
    html += `<div class="area-empty">مفيش منطقة بالاسم ده</div>`;
  } else {
    html += currentFilteredAreas
      .map((a) => `<div class="area-option" data-area="${a.replace(/"/g, '&quot;')}">${a}</div>`)
      .join('');
  }
  areaDropdown.innerHTML = html;
  areaDropdown.classList.add('show');

  areaDropdown.querySelectorAll('.area-option').forEach((el) => {
    el.addEventListener('click', () => {
      selectArea(el.dataset.area);
    });
  });
}

function selectArea(area) {
  selectedArea = area || '';
  areaInput.value = area || '';
  areaClear.classList.toggle('show', !!selectedArea);
  closeAreaDropdown();
  runSearch();
}

function closeAreaDropdown() {
  areaDropdown.classList.remove('show');
  highlightedIndex = -1;
}

function updateHighlight() {
  const opts = areaDropdown.querySelectorAll('.area-option');
  opts.forEach((el, i) => el.classList.toggle('highlighted', i === highlightedIndex));
  if (highlightedIndex >= 0 && opts[highlightedIndex]) {
    opts[highlightedIndex].scrollIntoView({ block: 'nearest' });
  }
}

areaInput.addEventListener('focus', renderAreaDropdown);
areaInput.addEventListener('input', () => {
  if (areaInput.value.trim() === '') {
    selectedArea = '';
    areaClear.classList.remove('show');
    runSearch();
  }
  renderAreaDropdown();
});

areaInput.addEventListener('keydown', (e) => {
  const opts = areaDropdown.querySelectorAll('.area-option');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, opts.length - 1);
    updateHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex = Math.max(highlightedIndex - 1, 0);
    updateHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightedIndex >= 0 && opts[highlightedIndex]) {
      selectArea(opts[highlightedIndex].dataset.area);
    } else if (currentFilteredAreas.length === 1) {
      selectArea(currentFilteredAreas[0]);
    }
  } else if (e.key === 'Escape') {
    closeAreaDropdown();
    areaInput.blur();
  }
});

areaClear.addEventListener('click', () => {
  selectArea('');
  areaInput.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.area-combo')) {
    closeAreaDropdown();
  }
});

// -------------------- ربط الأحداث --------------------

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 300);
});
refreshBtn.addEventListener('click', resetDatabase);

// -------------------- تسجيل Service Worker (للعمل أوفلاين) --------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((e) => {
      console.warn('service worker registration failed', e);
    });
  });
}

// -------------------- البدء --------------------

function startApp() {
  initDatabase().catch((e) => {
    statusText.textContent = 'حصلت مشكلة: ' + e.message;
    console.error(e);
  });
}

boot();
