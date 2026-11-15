const MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
const MAX_BODY = 5 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 9000;

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
    systemInstruction: { parts: [{ text: "You are Dorie, the helpful, capable AI companion inside Phantom Veil. Be accurate, thoughtful, friendly and clear. When asked who created you, say: "I was created by OVANICE and Dorie." Help with learning, reasoning, writing, planning, coding and creative work. Be honest about uncertainty and never claim to have generated an image or video unless an actual generation tool has done so. When users attach supported images or PDFs, inspect the provided content and answer their questions. Never ask users to share passwords or secret credentials." }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 768, thinkingConfig: { thinkingLevel: "low" } }
  };

  async function callModel(model) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error("Model request timed out");
          error.name = "TimeoutError";
          reject(error);
        }, MODEL_TIMEOUT_MS);
      });
      const request = (async () => {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
          signal: controller.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        });
        let data;
        try { data = await response.json(); } catch { data = {}; }
        return { response, data };
      })();
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  try {
    let result;
    let usedModel = MODEL;
    try {
      result = await callModel(MODEL);
      if (!result.response.ok && result.response.status !== 429 && result.response.status < 500) {
        const msg = result.data?.error?.message || "Gemini request failed.";
        return res.status(502).json({ error: msg });
      }
      if (!result.response.ok) {
        usedModel = FALLBACK_MODEL;
        result = await callModel(FALLBACK_MODEL);
      }
    } catch (primaryError) {
      // One bounded fallback attempt only; never retry the fallback a second time.
      usedModel = FALLBACK_MODEL;
      try {
        result = await callModel(FALLBACK_MODEL);
      } catch (fallbackError) {
        const timedOut = primaryError?.name === "TimeoutError" || fallbackError?.name === "TimeoutError" || primaryError?.name === "AbortError" || fallbackError?.name === "AbortError";
        return res.status(timedOut ? 504 : 502).json({
          error: timedOut
            ? "Gemini is taking too long right now. Please try again shortly."
            : "Could not connect to Gemini right now. Please try again."
        });
      }
    }

    if (!result.response.ok) {
      return res.status(result.response.status === 429 ? 429 : 502).json({
        error: result.response.status === 429
          ? "Gemini is busy or its free usage limit has been reached. Please try again shortly."
          : (result.data?.error?.message || "Gemini could not complete the request. Please try again.")
      });
    }

    const answer = (result.data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!answer) return res.status(502).json({ error: "Gemini returned no text. Please try again." });
    return res.status(200).json({ text: answer, model: usedModel });
  } catch (error) {
    return res.status(502).json({ error: "Dorie could not complete that request. Please try again." });
  }
};
