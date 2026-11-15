const MODEL = "gemini-3.8-flash";
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
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are Dorie, the helpful, capable AI companion inside Phantom Veil. Be accurate, thoughtful, friendly and clear. Help with learning, reasoning, writing, planning, coding and creative work. Be honest about uncertainty and never claim to have generated an image or video unless an actual generation tool has done so. When users attach supported images or PDFs, inspect the provided content and answer their questions. Never ask users to share passwords or secret credentials." }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = data?.error?.message || "Gemini request failed.";
      const code = response.status === 429 ? 429 : 502;
      return res.status(code).json({ error: response.status === 429 ? "Gemini's free quota is temporarily exhausted. Please try again later." : msg });
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!text) return res.status(502).json({ error: "Gemini returned no text. Please try again." });
    return res.status(200).json({ text, model: MODEL });
  } catch (error) {
    return res.status(502).json({ error: "Could not connect to Gemini. Please try again." });
  }
};