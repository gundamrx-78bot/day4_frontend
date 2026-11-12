// 에이전트가 호출할 수 있는 도구(tool) 2개: get_weather, find_spots
// 이 파일은 Vercel 서버리스 함수에서만 실행됩니다 (파일명이 _ 로 시작하면 라우트가 되지 않음).
const fs = require("fs");
const path = require("path");

const UA = "korea-weather-agent/1.0";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
// 공개 Overpass 서버는 자주 느려지므로 여러 미러를 순서대로 시도 (미러별 제한 시간)
const OVERPASS_URLS = [
  ["https://overpass.openstreetmap.fr/api/interpreter", 25000],
  ["https://overpass-api.de/api/interpreter", 25000],
  ["https://overpass.kumi.systems/api/interpreter", 25000],
];
const WIKI_URL = "https://ko.wikipedia.org/w/api.php";

const WEATHER_CODES = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "강한 어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "강한 어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈", 80: "약한 소나기", 81: "소나기", 82: "강한 소나기",
  85: "약한 눈 소나기", 86: "강한 눈 소나기", 95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 동반 뇌우",
};

// ---- 도구 선언 (Gemini function calling) ----
const declarations = [
  {
    name: "get_weather",
    description:
      "도시의 실시간 날씨(기온, 체감온도, 습도, 풍속, 강수량, 날씨 상태)와 미세먼지(PM10, PM2.5) 등급, 오늘·내일 예보를 조회한다. 날씨나 미세먼지를 묻거나, 장소를 추천하기 전에 현재 날씨를 확인할 때 사용한다.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "도시/지역 이름. 한글(예: 서울, 제주, 강릉) 또는 영문(예: Busan)." },
      },
      required: ["city"],
    },
  },
  {
    name: "find_spots",
    description:
      "도시 주변의 장소(관광지, 박물관/미술관, 공원, 카페, 식당, 해변, 전망대, 산, 쇼핑, 테마파크)를 검색한다. 사용자가 갈 만한 곳, 데이트, 나들이, 맛집, 카페 등을 추천해 달라고 할 때 사용한다.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "검색 중심이 되는 도시/지역 이름 (한글 또는 영문)." },
        category: {
          type: "string",
          enum: ["attraction", "museum", "park", "cafe", "restaurant", "beach", "viewpoint", "mountain", "shopping", "theme_park"],
          description:
            "장소 종류. attraction=관광명소, museum=박물관/미술관(실내), park=공원/정원, cafe=카페(실내), restaurant=식당(실내), beach=해변, viewpoint=전망대, mountain=산/봉우리, shopping=쇼핑몰/시장(실내), theme_park=놀이공원/워터파크.",
        },
        radius_km: { type: "number", description: "검색 반경(km). 기본 10, 최대 30." },
        limit: { type: "integer", description: "가져올 개수. 기본 8, 최대 15." },
      },
      required: ["city", "category"],
    },
  },
];

// ---- 지역 이름 -> 좌표 ----
let CITY_CACHE = null;
function krCities() {
  if (CITY_CACHE) return CITY_CACHE;
  for (const p of [path.join(__dirname, "..", "cities.js"), path.join(process.cwd(), "cities.js")]) {
    try {
      const src = fs.readFileSync(p, "utf8");
      CITY_CACHE = new Function(`${src}\nreturn KR_CITIES;`)();
      return CITY_CACHE;
    } catch {}
  }
  CITY_CACHE = [];
  return CITY_CACHE;
}

const stripSuffix = (s) => s.replace(/(특별자치시|특별자치도|특별시|광역시|시|군)$/, "");

async function getJson(url, init) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(url).hostname})`);
  return res.json();
}

async function resolvePlace(city) {
  const q = String(city || "").trim();
  if (!q) throw new Error("city 값이 비어 있습니다.");
  const hit = krCities().find((c) => c.ko === stripSuffix(q) || c.en.toLowerCase() === q.toLowerCase());
  if (hit) {
    const label = hit.region === hit.ko ? hit.ko : `${hit.ko}(${hit.region})`;
    return { name: label, latitude: hit.latitude, longitude: hit.longitude, country: "대한민국" };
  }
  const params = new URLSearchParams({ name: q, count: "1", language: "ko", format: "json" });
  const data = await getJson(`${GEOCODE_URL}?${params}`);
  const r = data.results?.[0];
  if (!r) throw new Error(`'${q}' 지역을 찾을 수 없습니다. 영문 이름으로 다시 시도해 보세요.`);
  return { name: r.name, latitude: r.latitude, longitude: r.longitude, country: r.country };
}

// ---- get_weather ----
function grade(v, cuts) {
  if (v == null) return null;
  const i = cuts.findIndex((c) => v <= c);
  return ["좋음", "보통", "나쁨", "매우나쁨"][i === -1 ? 3 : i];
}

async function get_weather({ city }) {
  const place = await resolvePlace(city);
  const wp = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "2",
    timezone: "auto",
  });
  const ap = new URLSearchParams({ latitude: place.latitude, longitude: place.longitude, current: "pm10,pm2_5", timezone: "auto" });
  const [w, a] = await Promise.all([
    getJson(`${FORECAST_URL}?${wp}`),
    getJson(`${AIR_URL}?${ap}`).catch(() => null), // 대기질 실패해도 날씨는 반환
  ]);
  const c = w.current;
  const d = w.daily;
  const day = (i) => ({
    weather: WEATHER_CODES[d.weather_code[i]] ?? "알 수 없음",
    temp_min: d.temperature_2m_min[i],
    temp_max: d.temperature_2m_max[i],
    rain_probability_percent: d.precipitation_probability_max?.[i] ?? null,
  });
  const pm25 = a?.current?.pm2_5 ?? null;
  const pm10 = a?.current?.pm10 ?? null;
  const result = {
    place: place.name,
    time: c.time,
    weather: WEATHER_CODES[c.weather_code] ?? "알 수 없음",
    temperature_c: c.temperature_2m,
    feels_like_c: c.apparent_temperature,
    humidity_percent: c.relative_humidity_2m,
    wind_kmh: c.wind_speed_10m,
    precipitation_mm: c.precipitation,
    air_quality: a
      ? { pm25_ugm3: pm25, pm25_grade: grade(pm25, [15, 35, 75]), pm10_ugm3: pm10, pm10_grade: grade(pm10, [30, 80, 150]), note: "모델 추정값" }
      : "대기질 정보를 가져오지 못함",
    today: day(0),
    tomorrow: day(1),
  };
  const summary = `${place.name}: ${result.weather} ${Math.round(c.temperature_2m)}°C` + (pm25 != null ? `, PM2.5 ${Math.round(pm25)}(${grade(pm25, [15, 35, 75])})` : "");
  return { result, summary, place };
}

// ---- find_spots ----
const CATS = {
  attraction: { sel: ['["tourism"="attraction"]'], indoor: false },
  museum: { sel: ['["tourism"~"^(museum|gallery)$"]'], indoor: true },
  park: { sel: ['["leisure"~"^(park|garden)$"]'], indoor: false },
  cafe: { sel: ['["amenity"="cafe"]'], indoor: true },
  restaurant: { sel: ['["amenity"="restaurant"]'], indoor: true },
  beach: { sel: ['["natural"="beach"]'], indoor: false },
  viewpoint: { sel: ['["tourism"="viewpoint"]'], indoor: false },
  mountain: { sel: ['["natural"="peak"]'], indoor: false },
  shopping: { sel: ['["shop"="mall"]', '["amenity"="marketplace"]'], indoor: true },
  theme_park: { sel: ['["tourism"="theme_park"]', '["leisure"="water_park"]'], indoor: false },
};

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function overpass(query) {
  // 미러들을 동시에 호출하고 가장 먼저 성공한 응답을 사용
  try {
    return await Promise.any(
      OVERPASS_URLS.map(([url, ms]) =>
        getJson(url, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(ms),
        })
      )
    );
  } catch (e) {
    throw new Error(`장소 검색 서버 오류: ${e.errors?.[0]?.message || e.message}`);
  }
}

// Overpass 가 모두 실패했을 때의 대체: 위키백과 위치 검색 (카페/식당 같은 상점류는 불가)
const WIKI_EXCLUDE = /학교|대학|병원|의료원|의원|아파트|주민센터|경찰|소방|우체국|우편|교도소|보건|역$|터미널|동$|리$|면$|읍$/;
const WIKI_KEYWORDS = {
  museum: /박물관|미술관|전시|기념관|갤러리/,
  park: /공원|정원|수목원|숲|호수|저수지/,
  beach: /해수욕장|해변|해안|포구|항$/,
  viewpoint: /전망|일출|해돋이|해안|대교|타워/,
  mountain: /산|봉$|악$|령$|고개/,
  theme_park: /테마파크|놀이공원|워터파크|랜드|월드/,
};

async function wikiSpots(place, category, radius, n) {
  if (category === "cafe" || category === "restaurant" || category === "shopping") {
    throw new Error("현재 장소 검색 서버가 응답하지 않아 이 종류(카페/식당/쇼핑)는 검색할 수 없습니다.");
  }
  const params = new URLSearchParams({
    action: "query", generator: "geosearch", ggscoord: `${place.latitude}|${place.longitude}`,
    ggsradius: String(Math.min(radius, 10000)), ggslimit: "500", prop: "description|coordinates", ggsnamespace: "0",
    format: "json", formatversion: "2",
  });
  const data = await getJson(`${WIKI_URL}?${params}`);
  const kw = WIKI_KEYWORDS[category];
  return (data.query?.pages || [])
    .map((pg) => {
      const c = pg.coordinates?.[0];
      if (!c) return null;
      const text = `${pg.title} ${pg.description || ""}`;
      if (WIKI_EXCLUDE.test(pg.title) || /학교|대학|병원|아파트/.test(pg.description || "")) return null;
      if (kw && !kw.test(text)) return null;
      return {
        name: pg.title,
        category,
        indoor: CATS[category].indoor,
        latitude: +c.lat.toFixed(5),
        longitude: +c.lon.toFixed(5),
        distance_km: +distKm(place.latitude, place.longitude, c.lat, c.lon).toFixed(1),
        address: pg.description || undefined,
        _notable: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, n);
}

async function find_spots({ city, category, radius_km, limit }) {
  const cat = CATS[category];
  if (!cat) throw new Error(`지원하지 않는 category: ${category}`);
  const place = await resolvePlace(city);
  const radius = Math.min(Math.max(Number(radius_km) || 10, 1), 30) * 1000;
  const n = Math.min(Math.max(parseInt(limit) || 8, 1), 15);

  const body = cat.sel.map((s) => `nwr${s}["name"](around:${radius},${place.latitude},${place.longitude});`).join("");
  let source = "OpenStreetMap";
  let raw;
  try {
    const data = await overpass(`[out:json][timeout:20];(${body});out center 60;`);
    // 과부하 시 200 + 빈 결과 + remark 로 오는 경우를 오류로 취급
    if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(`장소 검색 서버 과부하: ${data.remark.slice(0, 80)}`);
    raw = (data.elements || []).map((el) => {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) return null;
      const addr = t["addr:full"] || [t["addr:city"], t["addr:district"], t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
      return {
        name: t["name:ko"] || t.name,
        english_name: t["name:en"] || undefined,
        category,
        indoor: cat.indoor,
        latitude: +lat.toFixed(5),
        longitude: +lon.toFixed(5),
        distance_km: +distKm(place.latitude, place.longitude, lat, lon).toFixed(1),
        address: addr || undefined,
        website: t.website || t["contact:website"] || undefined,
        _notable: !!(t.wikidata || t.wikipedia || t.website || t["name:en"]),
      };
    }).filter(Boolean);
  } catch (e) {
    // OpenStreetMap 서버 장애 -> 위키백과로 대체 (실패하면 원래 오류를 전달)
    source = "Wikipedia";
    try {
      raw = await wikiSpots(place, category, radius, 60);
    } catch (e2) {
      throw new Error(`${e.message} / 대체 검색도 실패: ${e2.message}`);
    }
  }

  const spots = raw
    // 이름이 같은 중복 제거
    .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i)
    .sort((a, b) => Number(b._notable) - Number(a._notable) || a.distance_km - b.distance_km)
    .slice(0, n)
    .map(({ _notable, ...s }) => s);

  const result = { center: place.name, category, source, count: spots.length, spots };
  if (spots.length === 0) result.note = "검색 결과가 없습니다. 반경을 넓히거나 다른 category로 시도해 보세요.";
  if (source === "Wikipedia") result.note = (result.note ? result.note + " " : "") + "주 검색 서버 장애로 위키백과 기반 결과입니다(일부 장소만 포함).";
  return { result, summary: `${place.name} 주변 ${category} ${spots.length}곳 (${source})`, spots, place };
}

const TOOLS = { get_weather, find_spots };

async function executeTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return { result: { error: `알 수 없는 도구: ${name}` }, summary: `알 수 없는 도구 ${name}`, ok: false };
  try {
    return { ...(await fn(args || {})), ok: true };
  } catch (e) {
    // 오류도 모델에게 돌려줘서 스스로 복구(재시도/사과)할 수 있게 함
    return { result: { error: e.message }, summary: `오류: ${e.message}`, ok: false };
  }
}

module.exports = { declarations, executeTool };
