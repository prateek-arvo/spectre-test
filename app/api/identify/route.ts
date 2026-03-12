import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Together from "together-ai";

export const maxDuration = 120;

const MODEL = "Qwen/Qwen3.5-9B";

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
  // 1. Strip <think>…</think> blocks
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

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

    const client = new Together();

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: 0.1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [
        {
          role: "system",
          content: "You are a pattern matcher only return answer /no_think",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `/no_think which DEALER does the second image match from the grid of labels in first image

Return ONLY this JSON:
{"dealerId":"DEALER?","confidence":"high|medium|low","reasoning":"one sentence"}`,
            },
            {
              type: "image_url",
              image_url: { url: refDataUrl },
            },
            {
              type: "image_url",
              image_url: { url: croppedDataUrl },
            },
          ] as never,
        },
      ],
    });

    console.log("Full response:", JSON.stringify(response.choices[0], null, 2));
    const msg = response.choices[0]?.message as { content?: string; reasoning?: string };
    const fullText = msg?.content || msg?.reasoning || "";
    console.log("Model raw response:", fullText.slice(0, 500));
    const result = parseResult(fullText);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Identify error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
