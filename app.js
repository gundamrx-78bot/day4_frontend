// Open-Meteo (날씨 + 대기질): API 키 불필요
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

const WEATHER_VARS = "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m";
const AIR_VARS = "pm10,pm2_5";
const BATCH = 50; // 한 번에 요청할 좌표 수
const CACHE_KEY = "kr-weather-air-v1";
const CACHE_MS = 10 * 60 * 1000;

// WMO weather code -> [아이콘, 설명]
const WEATHER_CODES = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  56: ["🌧️", "약한 어는 이슬비"], 57: ["🌧️", "강한 어는 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  66: ["🌧️", "약한 어는 비"], 67: ["🌧️", "강한 어는 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"], 77: ["🌨️", "싸락눈"],
  80: ["🌦️", "약한 소나기"], 81: ["🌦️", "소나기"], 82: ["⛈️", "강한 소나기"],
  85: ["🌨️", "약한 눈 소나기"], 86: ["❄️", "강한 눈 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "약한 우박 동반 뇌우"], 99: ["⛈️", "강한 우박 동반 뇌우"],
};
const sky = (code) => WEATHER_CODES[code] ?? ["❓", "알 수 없음"];

// ---- 대기질 등급 (한국 환경부 기준) ----
const GRADE_NAMES = ["좋음", "보통", "나쁨", "매우나쁨"];
const GRADE_COLORS = ["#2f7ed8", "#2e9e5b", "#f08c00", "#d93025"];
const PM25_CUTS = [15, 35, 75];
const PM10_CUTS = [30, 80, 150];
const gradeOf = (v, cuts) => (v == null ? -1 : cuts.findIndex((c) => v <= c) === -1 ? 3 : cuts.findIndex((c) => v <= c));

function tempColor(t) {
  if (t == null) return "#999";
  return t <= 0 ? "#2f7ed8" : t <= 10 ? "#3aa6c4" : t <= 20 ? "#2e9e5b" : t <= 28 ? "#f08c00" : "#d93025";
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.json();
}

// ---- 한글 -> 영문 로마자 변환 (국어의 로마자 표기법, 단순 버전) ----
const ROM_INITIAL = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const ROM_VOWEL = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const ROM_FINAL = ["","k","k","k","n","n","n","t","l","k","m","l","l","l","p","l","m","p","p","t","t","ng","t","t","k","t","p","t"];

function romanize(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out += ch; continue; }
    out += ROM_INITIAL[Math.floor(code / 588)] + ROM_VOWEL[Math.floor((code % 588) / 28)] + ROM_FINAL[code % 28];
  }
  return out;
}

const hasHangul = (s) => /[가-힣]/.test(s);
const stripSuffix = (s) => s.replace(/(특별자치시|특별자치도|특별시|광역시|시|군)$/, "");
const cityLabel = (c) => (c.region === c.ko ? c.ko : `${c.ko} · ${c.region}`);

function suggest(query) {
  const q = stripSuffix(query.trim());
  if (!q) return [];
  const lower = q.toLowerCase();
  const starts = [], contains = [];
  for (const c of KR_CITIES) {
    if (c.ko.startsWith(q) || c.en.toLowerCase().startsWith(lower)) starts.push(c);
    else if (hasHangul(q) && c.ko.includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, 8);
}

async function geocode(name) {
  const params = new URLSearchParams({ name, count: "1", language: "ko", format: "json" });
  const data = await fetchJson(`${GEOCODE_URL}?${params}`);
  return data.results?.[0] ?? null;
}

// ---- 데이터 로딩 ----
async function fetchMany(baseUrl, vars, places) {
  const params = new URLSearchParams({
    latitude: places.map((p) => p.latitude).join(","),
    longitude: places.map((p) => p.longitude).join(","),
    current: vars,
    timezone: "auto",
  });
  const d = await fetchJson(`${baseUrl}?${params}`);
  return (Array.isArray(d) ? d : [d]).map((x) => x.current ?? null);
}

async function fetchAll(baseUrl, vars, places) {
  const chunks = [];
  for (let i = 0; i < places.length; i += BATCH) chunks.push(places.slice(i, i + BATCH));
  return (await Promise.all(chunks.map((c) => fetchMany(baseUrl, vars, c)))).flat();
}

// 날씨 + 대기질 (대기질 실패해도 날씨는 표시)
async function loadData(places) {
  const [w, a] = await Promise.all([
    fetchAll(FORECAST_URL, WEATHER_VARS, places),
    fetchAll(AIR_URL, AIR_VARS, places).catch(() => places.map(() => null)),
  ]);
  return places.map((place, i) => ({ place, w: w[i], a: a[i] }));
}

async function loadCities() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && Date.now() - cached.t < CACHE_MS && cached.data.length === KR_CITIES.length) return cached.data;
  } catch {}
  const data = await loadData(KR_CITIES.map(toPlace));
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch {}
  return data;
}

function toPlace(c) {
  return { name: cityLabel(c), country: "대한민국", latitude: c.latitude, longitude: c.longitude };
}

// ---- 지도 ----
const map = L.map("map", { zoomControl: true }).setView([36.3, 127.8], 7);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | 데이터: <a href="https://open-meteo.com">Open-Meteo</a>',
}).addTo(map);

let mode = "temp";
let entries = []; // [{place, w, a, marker}]
let customMarker = null;
// 낮은 줌에서는 주요 도시만, 확대하면 전체 표시
const MAJOR = new Set(["서울","부산","대구","인천","광주|광주","대전","울산","세종","수원","춘천","강릉","원주","청주","천안","전주","목포","여수","포항","안동","창원","제주"]);
const isMajor = (c) => MAJOR.has(c.ko) || MAJOR.has(`${c.ko}|${c.region}`);
const minorLayer = L.layerGroup();
const majorLayer = L.layerGroup().addTo(map);
function updateLayers() {
  const show = map.getZoom() >= 8;
  if (show && !map.hasLayer(minorLayer)) map.addLayer(minorLayer);
  if (!show && map.hasLayer(minorLayer)) map.removeLayer(minorLayer);
}
map.on("zoomend", updateLayers);
let selected = null;

// 마커에 표시할 [텍스트, 배경색, 클래스]
function markerView(e) {
  const { w, a } = e;
  if (mode === "sky") return [w ? sky(w.weather_code)[0] : "?", "#fff", "sky"];
  if (mode === "temp") return [w ? `${Math.round(w.temperature_2m)}°` : "-", tempColor(w?.temperature_2m), ""];
  const key = mode === "pm25" ? "pm2_5" : "pm10";
  const v = a?.[key];
  const g = gradeOf(v, mode === "pm25" ? PM25_CUTS : PM10_CUTS);
  return [v == null ? "-" : Math.round(v), g < 0 ? "#999" : GRADE_COLORS[g], ""];
}

function markerIcon(e) {
  const [text, bg, cls] = markerView(e);
  const sel = e === selected ? " sel" : "";
  return L.divIcon({
    className: "mk-wrap",
    html: `<div class="mk ${cls}${sel}" style="background:${bg}">${text}</div>`,
    iconSize: [40, 22],
    iconAnchor: [20, 11],
  });
}

function refreshMarkers() {
  entries.forEach((e) => e.marker.setIcon(markerIcon(e)));
  if (customMarker) customMarker.marker.setIcon(markerIcon(customMarker));
  renderLegend();
}

function renderLegend() {
  const el = $("legend");
  if (mode === "sky") { el.textContent = "아이콘: 현재 날씨"; return; }
  if (mode === "temp") {
    el.innerHTML = [["#2f7ed8", "≤0°"], ["#3aa6c4", "≤10°"], ["#2e9e5b", "≤20°"], ["#f08c00", "≤28°"], ["#d93025", ">28°"]]
      .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("");
    return;
  }
  const cuts = mode === "pm25" ? PM25_CUTS : PM10_CUTS;
  el.innerHTML = GRADE_NAMES.map((n, i) => `<span><i style="background:${GRADE_COLORS[i]}"></i>${n}${i < 3 ? ` (≤${cuts[i]})` : ""}</span>`).join("") + "<span>단위 μg/m³</span>";
}

document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".modes button").forEach((x) => x.classList.toggle("on", x === b));
    refreshMarkers();
  })
);

// ---- 상세 카드 ----
function setGrade(id, value, cuts) {
  const g = gradeOf(value, cuts);
  $(id).textContent = g < 0 ? "-" : GRADE_NAMES[g];
  $(id).style.background = g < 0 ? "#999" : GRADE_COLORS[g];
}

function render(e) {
  const { place, w, a } = e;
  const [icon, desc] = sky(w.weather_code);
  $("place").textContent = [place.name, place.country].filter(Boolean).join(", ");
  $("icon").textContent = icon;
  $("temp").textContent = `${Math.round(w.temperature_2m)}°C`;
  $("desc").textContent = desc;
  $("feels").textContent = `${Math.round(w.apparent_temperature)}°C`;
  $("humidity").textContent = `${w.relative_humidity_2m}%`;
  $("wind").textContent = `${w.wind_speed_10m} km/h`;
  $("precip").textContent = `${w.precipitation} mm`;
  $("pm25").textContent = a?.pm2_5 == null ? "-" : `${Math.round(a.pm2_5)} μg/m³`;
  $("pm10").textContent = a?.pm10 == null ? "-" : `${Math.round(a.pm10)} μg/m³`;
  setGrade("pm25-grade", a?.pm2_5, PM25_CUTS);
  setGrade("pm10-grade", a?.pm10, PM10_CUTS);
  $("updated").textContent = `기준 시각: ${w.time.replace("T", " ")} (현지) · 대기질은 모델 추정값`;
  $("weather").hidden = false;
}

function select(e, fly = true) {
  const prev = selected;
  selected = e;
  if (prev && prev.marker) prev.marker.setIcon(markerIcon(prev));
  if (e.marker) e.marker.setIcon(markerIcon(e));
  if (e.w) render(e);
  if (fly) map.flyTo([e.place.latitude, e.place.longitude], Math.max(map.getZoom(), 9), { duration: 0.8 });
}

// 목록에 없는 장소(검색/내 위치)
async function showCustom(place) {
  setStatus("불러오는 중...");
  try {
    const [e] = await loadData([place]);
    if (!e.w) throw new Error("날씨를 가져오지 못했습니다.");
    if (customMarker) map.removeLayer(customMarker.marker);
    e.marker = L.marker([place.latitude, place.longitude], { icon: markerIcon(e), zIndexOffset: 1000 }).addTo(map);
    e.marker.on("click", () => select(e, false));
    customMarker = e;
    select(e);
    setStatus("");
  } catch (err) {
    setStatus(err.message || "날씨를 가져오지 못했습니다.", true);
  }
}

function pickCity(c) {
  const e = entries.find((x) => x.city === c);
  if (e) { select(e); setStatus(""); }
  else showCustom(toPlace(c));
}

async function searchAndShow(query) {
  const q = query.trim();
  const exact = KR_CITIES.find((c) => c.ko === stripSuffix(q) || c.en.toLowerCase() === q.toLowerCase());
  if (exact) return pickCity(exact);
  const term = hasHangul(q) ? romanize(stripSuffix(q)) : q;
  const found = await geocode(term);
  if (!found) throw new Error(`'${q}' 지역을 찾을 수 없습니다.${hasHangul(q) ? ` (영문 변환: ${term})` : ""}`);
  await showCustom(found);
}

// ---- 자동완성 드롭다운 ----
const input = $("city-input");
const listEl = $("suggestions");
let items = [];
let active = -1;

function closeList() { listEl.hidden = true; items = []; active = -1; }
function highlight() { [...listEl.children].forEach((li, i) => li.classList.toggle("active", i === active)); }

function openList(matches) {
  items = matches;
  active = -1;
  listEl.replaceChildren(
    ...matches.map((c) => {
      const li = document.createElement("li");
      li.textContent = `${cityLabel(c)}  (${c.en})`;
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(c); });
      return li;
    })
  );
  listEl.hidden = matches.length === 0;
}

function pick(c) {
  input.value = c.ko;
  closeList();
  pickCity(c);
}

input.addEventListener("input", () => openList(suggest(input.value)));
input.addEventListener("blur", closeList);
input.addEventListener("keydown", (e) => {
  if (listEl.hidden || items.length === 0) return;
  if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
  else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
  else if (e.key === "Escape") closeList();
});

$("search-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  closeList();
  setStatus("지역 검색 중...");
  try {
    await searchAndShow(q);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("geo-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("이 브라우저는 위치 기능을 지원하지 않습니다.", true);
  setStatus("위치 확인 중...");
  navigator.geolocation.getCurrentPosition(
    (pos) => showCustom({ name: "현재 위치", latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
    () => setStatus("위치 권한이 거부되었습니다.", true)
  );
});

// ---- 시작: 전국 도시 한꺼번에 로딩 ----
(async function init() {
  renderLegend();
  setStatus("전국 날씨·대기질 불러오는 중...");
  try {
    const data = await loadCities();
    entries = data.map((e, i) => {
      e.city = KR_CITIES[i];
      e.marker = L.marker([e.place.latitude, e.place.longitude], { icon: markerIcon(e) }).addTo(isMajor(e.city) ? majorLayer : minorLayer);
      e.marker.on("click", () => select(e, false));
      return e;
    });
    updateLayers();
    select(entries[0], false); // 서울
    setStatus("");
  } catch (err) {
    setStatus(err.message || "데이터를 가져오지 못했습니다.", true);
  }
})();
