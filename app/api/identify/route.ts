import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import Together from "together-ai";
import db from "./db.json";

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
      temperature: 0,
      reasoning: {"enabled":false}, 
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [
        {
          role: "system",
          content: "You are a shape detector only return answer",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `What shapes do you see in this image in order return them textually comma separated.`,
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

    // Parse shapes from AI response
    const shapes = fullText.split(',').map(s => s.trim().toLowerCase());

    // Match against db
    let matchedDealer = null;
    for (const [dealerId, dealerData] of Object.entries(db)) {
      const dbShapes = dealerData.names.map(name => name.toLowerCase());
      if (JSON.stringify(dbShapes) === JSON.stringify(shapes)) {
        matchedDealer = dealerId;
        break;
      }
    }

    if (matchedDealer) {
      return NextResponse.json({ dealerId: matchedDealer, shapeOrder: shapes });
    } else {
      return NextResponse.json({ error: "No matching dealer found for the shape order", shapeOrder: shapes }, { status: 404 });
    }
  } catch (err) {
    console.error("Identify error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
