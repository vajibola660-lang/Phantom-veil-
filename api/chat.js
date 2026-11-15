const MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
const MAX_BODY = 5 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST for chat requests." });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: "Dorie is not connected yet. The site owner must add a Gemini API key in Vercel settings." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid request body." }); } }
  if (!body || !Array.isArray(body.contents)) return res.status(400).json({ error: "No conversation was supplied." });
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) return res.status(413).json({ error: "This attachment is too large. Please use a smaller file." });

  const contents = body.contents.slice(-12);
  for (const item of contents) {
    if (!item || !["user", "model"].includes(item.role) || !Array.isArray(item.parts)) return res.status(400).json({ error: "Invalid conversation format." });
    for (const part of item.parts) {
      if (part.text && part.text.length > 100000) return res.status(413).json({ error: "Message is too long." });
      if (part.inlineData) {
        const { mimeType, data } = part.inlineData;
        if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(mimeType) || typeof data !== "string" || data.length > 5_600_000) return res.status(400).json({ error: "Unsupported or oversized attachment." });
      }
    }
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: "You are Dorie, the helpful, capable AI companion inside Phantom Veil. Be accurate, thoughtful, friendly and clear. Help with learning, reasoning, writing, planning, coding and creative work. Be honest about uncertainty and never claim to have generated an image or video unless an actual generation tool has done so. When users attach supported images or PDFs, inspect the provided content and answer their questions. Never ask users to share passwords or secret credentials." }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } }
  };

  async function callModel(model) {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
      signal: AbortSignal.timeout(12000),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    return { response, data };
  }

  try {
    let result;
    let usedModel = MODEL;
    try {
      result = await callModel(MODEL);
    } catch (error) {
      // If the primary model is slow or temporarily unavailable, try the free-tier fallback.
      result = await callModel(FALLBACK_MODEL);
      usedModel = FALLBACK_MODEL;
    }

    if (!result.response.ok && (result.response.status === 429 || result.response.status >= 500)) {
      result = await callModel(FALLBACK_MODEL);
      usedModel = FALLBACK_MODEL;
    }

    if (!result.response.ok) {
      const msg = result.data?.error?.message || "Gemini request failed.";
      const code = result.response.status === 429 ? 429 : 502;
      return res.status(code).json({ error: result.response.status === 429 ? "Both Gemini models are busy or their free limits have been reached. Please try again shortly." : msg });
    }

    const text = (result.data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!text) return res.status(502).json({ error: "Gemini returned no text. Please try again." });
    return res.status(200).json({ text, model: usedModel });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) return res.status(504).json({ error: "Both Gemini models took too long to respond. Please try again." });
    return res.status(502).json({ error: "Could not connect to Gemini. Please try again." });
  }
};
