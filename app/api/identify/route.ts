import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import sharp from "sharp";

export const maxDuration = 120;

const API_URL = "http://34.124.242.252:8000/v1/chat/completions";
const MODEL = "qwen3.5-9b";

let cachedRefDataUrl: string | null = null;

async function getRefDataUrl(): Promise<string> {
  if (cachedRefDataUrl) return cachedRefDataUrl;
  const refPath = path.join(process.cwd(), "public", "reference.png");
  const buf = await sharp(fs.readFileSync(refPath))
    .resize({ width: 700, withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  cachedRefDataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
  return cachedRefDataUrl;
}

function parseResult(text: string): { dealerId: string; confidence: string; reasoning: string } {
  // The assistant prefill starts with '{"dealerId":"', so prepend it back
  const full = '{"dealerId":"' + text;

  // 1. Strip <think>…</think> blocks
  const stripped = full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Try to extract a complete JSON object
  const jsonMatch = stripped.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.dealerId) return parsed;
    } catch { /* fall through */ }
  }

  // 3. Fallback: scan for "DEALER\d+" anywhere in the text
  const dealerMatch = stripped.match(/DEALER\d+z?/i);
  if (dealerMatch) {
    return {
      dealerId: dealerMatch[0].toUpperCase(),
      confidence: "medium",
      reasoning: stripped.slice(0, 200),
    };
  }

  throw new Error("Could not identify dealer. Raw: " + stripped.slice(0, 300));
}

export async function POST(req: NextRequest) {
  try {
    const { croppedImage } = await req.json();
    if (!croppedImage) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const refDataUrl = await getRefDataUrl();
    const croppedDataUrl = croppedImage.startsWith("data:")
      ? croppedImage
      : `data:image/jpeg;base64,${croppedImage}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 115_000);

    let fullText = "";

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer none" },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 512,
          stream: true,
          temperature: 0.1,
          reasoning={"enabled": False},
          messages: [
  {
    role: "system",
    content: "You are a JSON-only API. Do not output thinking or <think> tags. Output exactly one JSON object."
  },
  {
    role: "user",
    content: [
      {
        type: "text",
        text:
`Identify which dealer signature matches.

Image 1 = Reference chart containing 18 dealer signatures labeled DEALER1–DEALER18 (one is DEALER16z).
Image 2 = The signature we want to identify.

Compare Image 2 against Image 1.

Return ONLY this JSON:
{"dealerId":"DEALER?","confidence":"high|medium|low","reasoning":"one sentence"}

Do NOT output thinking or analysis.`
      },

      {
        type: "image_url",
        image_url: { url: refDataUrl }
      },

      {
        type: "image_url",
        image_url: { url: croppedDataUrl }
      }
    ]
  },
  {
    role: "assistant",
    content: '{"dealerId":"'
  }
]
         
         
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Server ${res.status}: ${body}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload);
            fullText += chunk.choices?.[0]?.delta?.content ?? "";
          } catch { /* skip malformed chunk */ }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    console.log("Model raw response:", fullText.slice(0, 500));
    const result = parseResult(fullText);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Identify error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
