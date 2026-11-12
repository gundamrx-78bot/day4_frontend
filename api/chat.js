// Vercel 서버리스 함수: POST /api/chat
// Gemini function calling 으로 get_weather / find_spots 중 필요한 도구를 스스로 골라 호출하는 에이전트
const { declarations, executeTool } = require("./_tools");

// gemini-flash-latest: 항상 최신 flash 모델을 가리키는 별칭 (모델 단종에 영향받지 않음)
// 과부하(429/5xx)나 시간 초과가 나면 다음 모델로 자동 전환
// 실측(함수 호출 1회): thinkingLevel 기본값일 때 gemini-3.5-flash ~26초 → low 로 낮추면 ~2.7초
const MODELS = [process.env.GEMINI_MODEL || "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"].filter((m, i, a) => a.indexOf(m) === i);
// 생각 수준: minimal | low | medium | high (Gemini 3 계열만 지원). 빈 값이면 모델 기본값 사용
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL === undefined ? "low" : process.env.GEMINI_THINKING_LEVEL.trim();
const MAX_STEPS = 6; // 도구 호출 반복 상한

const SYSTEM = `너는 한국 여행·나들이 장소를 추천하는 친절한 AI 에이전트다. 한국어로 답한다.

사용할 수 있는 도구:
- get_weather(city): 실시간 날씨, 미세먼지, 오늘/내일 예보
- find_spots(city, category, ...): 주변 장소 검색

규칙:
1. 날씨나 미세먼지만 묻는 질문에는 get_weather만 호출한다.
2. 장소/데이트/나들이/맛집/카페 추천 질문에는 먼저 get_weather로 날씨를 확인하고, 그 결과에 맞는 category로 find_spots를 호출한다.
   - 비·눈·소나기가 오거나 강수확률이 높거나, 미세먼지(PM2.5/PM10)가 '나쁨' 이상이거나, 기온이 매우 낮거나 높으면 실내 장소(museum, cafe, restaurant, shopping)를 우선한다.
   - 맑고 미세먼지가 '좋음/보통'이면 야외(park, beach, viewpoint, mountain, attraction, theme_park)를 우선한다.
   - 사용자가 종류를 지정하면(예: 카페, 해변) 그 종류를 따른다. 필요하면 find_spots를 여러 category로 여러 번 호출해도 된다.
3. 도시가 없으면 사용자에게 어느 지역인지 되묻는다. 한국 밖 도시도 날씨 조회는 가능하다.
4. 장소는 반드시 find_spots 결과에 있는 것만 추천한다. 없는 장소·주소·영업시간을 지어내지 않는다.
5. 답변은 간결하게: 날씨 한 줄 요약 → 추천 장소 3~5곳(이름, 거리, 한 줄 이유) → 필요하면 팁. 왜 그 종류를 골랐는지(날씨 근거)를 밝힌다.
6. 도구 호출이 오류를 반환하면 솔직히 알리고 다른 방법을 제안한다.
7. 여행·날씨와 무관한 요청은 정중히 범위를 안내한다.`;

// 모델 목록을 순서대로 시도: 성공하거나 재시도 불가 오류(키/요청 오류)면 즉시 반환
async function callGemini(key, body) {
  let last;
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(
          THINKING_LEVEL && /^gemini-3/.test(model)
            ? { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: THINKING_LEVEL } } }
            : body
        ),
        signal: AbortSignal.timeout(25000),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok || !(r.status === 429 || r.status >= 500 || r.status === 404)) return { r, data };
      last = { r, data };
    } catch (e) {
      last = { r: { ok: false, status: 504 }, data: { error: { message: `Gemini 응답 시간 초과 (${model})` } } };
    }
  }
  return last;
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST 요청만 지원합니다." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });

  const { messages, location } = readBody(req);
  // 지도에서 사용자가 선택한 위치 → 시스템 프롬프트에 덧붙여 "여기/근처" 질문의 기준으로 사용
  let system = SYSTEM;
  let loc = null;
  const lat = Number(location?.latitude), lon = Number(location?.longitude);
  if (location && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const name = String(location.name || "선택한 위치").replace(/[\r\n]/g, " ").slice(0, 60);
    loc = { name, latitude: lat, longitude: lon };
    system += `\n\n[사용자가 지도에서 선택한 위치] ${name}\n- 질문에 "여기", "근처", "내 주변"처럼 지역이 명시되지 않으면 이 위치가 기준이다. 이때 get_weather/find_spots의 city, latitude, longitude는 모두 생략한다(서버가 선택한 위치의 좌표를 채운다).\n- 질문에 다른 지역이 명시되면 그 지역을 city로 지정한다.\n- 장소 추천 질문이면 먼저 get_weather를 호출하고, 그 결과를 본 뒤 find_spots를 호출한다.`;
  }
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages 가 필요합니다." });

  const contents = messages
    .slice(-12)
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text.slice(0, 2000) }] }));
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "마지막 메시지는 사용자 메시지여야 합니다." });
  }

  const steps = []; // 화면에 보여줄 도구 호출 기록
  const spots = []; // 지도에 핀으로 찍을 장소
  const places = [];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const { r, data } = await callGemini(key, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { temperature: 0.4 },
      });
      if (!r.ok) {
        const msg = data?.error?.message || `Gemini API 오류 (${r.status})`;
        return res.status(r.status === 429 ? 429 : 502).json({ error: msg, steps });
      }

      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);

      if (calls.length === 0) {
        const reply = parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({
          reply: reply || "답변을 만들지 못했습니다. 질문을 조금 바꿔서 다시 시도해 주세요.",
          steps,
          spots,
          places,
        });
      }

      // 모델의 함수 호출 턴을 그대로 기록한 뒤, 도구 실행 결과를 돌려준다
      contents.push({ role: "model", parts });
      const responses = await Promise.all(
        calls.map(async (p) => {
          const { name } = p.functionCall;
          let args = p.functionCall.args || {};
          // 지역을 지정하지 않은 호출은 선택한 위치 좌표로 채움 (모델이 좌표를 잘못 옮기는 것 방지)
          if (loc && !args.city) args = { ...args, latitude: loc.latitude, longitude: loc.longitude, city: loc.name };
          const out = await executeTool(name, args);
          steps.push({ name, args: args || {}, ok: out.ok, summary: out.summary });
          if (out.spots) spots.push(...out.spots.map((s) => ({ ...s })));
          if (out.place) places.push(out.place);
          return { functionResponse: { name, response: { result: out.result } } };
        })
      );
      contents.push({ role: "user", parts: responses });
    }
    return res.status(200).json({ reply: "도구 호출이 너무 많아 중단했습니다. 질문을 더 구체적으로 해 주세요.", steps, spots, places });
  } catch (e) {
    return res.status(500).json({ error: `에이전트 오류: ${e.message}`, steps });
  }
};
