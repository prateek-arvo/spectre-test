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

function toDataUrl(img: string): string {
  return img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
}

const SHAPE_SET = new Set([
  "circle", "triangle", "square", "star", "diamond", "cross", "arrow",
]);
const SYNONYMS: Record<string, string> = {
  plus: "cross", "+": "cross", "plus sign": "cross",
  rhombus: "diamond", pentagon: "diamond",
  rect: "square", rectangle: "square",
  "right arrow": "arrow", pointer: "arrow",
};

function parseShapes(text: string): string[] {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[.!?]/g, "")
    .trim()
    .toLowerCase();

  const tokens = cleaned.split(/[,\n→>|]+/).map(s => s.trim()).filter(Boolean);
  const shapes: string[] = [];

  for (const token of tokens) {
    const t = token.replace(/^\d+[\.\)\s]+/, "").trim();
    if (SHAPE_SET.has(t)) { shapes.push(t); }
    else if (SYNONYMS[t]) { shapes.push(SYNONYMS[t]); }
    else {
      for (const s of SHAPE_SET) {
        if (t.includes(s)) { shapes.push(s); break; }
      }
    }
    if (shapes.length >= 4) break;
  }
  return shapes;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { croppedImage, mode } = body;

    if (!croppedImage) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const client = new Together();
    const imgUrl = toDataUrl(croppedImage);

    // ─── MODE: CROP — Find MRP position and return crop coordinates ───
    if (mode === "crop") {
      const response = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 512,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          {
            role: "system",
            content:
              "You analyze product label images. Return ONLY a JSON object, nothing else.\n" +
              "No markdown, no backticks, no explanation.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  'This is a product label. Find the text "MRP:" on it.\n' +
                  "Return its vertical center position as a percentage of image height (0=top, 100=bottom).\n" +
                  'Return ONLY: {"mrp_y": <number>}',
              },
              { type: "image_url", image_url: { url: imgUrl } },
            ] as never,
          },
        ],
      });

      const msg = response.choices[0]?.message as { content?: string };
      const raw = (msg?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      console.log("Crop response:", raw);

      // Parse JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return NextResponse.json(
          { error: "Could not parse crop coordinates", raw: raw.slice(0, 300) },
          { status: 422 }
        );
      }

      try {
        const coords = JSON.parse(jsonMatch[0]);
        const mrpY = Number(coords.mrp_y ?? 65);
        return NextResponse.json({
          mrp_y: Math.max(0, Math.min(100, mrpY)),
        });
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON in response", raw: raw.slice(0, 300) },
          { status: 422 }
        );
      }
    }

    // ─── MODE: IDENTIFY — Read shapes from cropped image ───
    const refDataUrl = await getRefDataUrl();

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 512,
      temperature: 0,
      reasoning: { enabled: false },
      messages: [
        {
          role: "system",
          content:
            "You are a shape detector. You will see an image containing a row of 4 geometric shapes.\n" +
            "The shapes are from this set: circle, triangle, square, star, diamond, cross, arrow.\n" +
            "Return ONLY the 4 shape names in left-to-right order, comma separated, lowercase.\n" +
            "Example: circle,star,diamond,triangle\n" +
            "Return nothing else.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Reference sheet — all 7 possible shapes with names:",
            },
            { type: "image_url", image_url: { url: refDataUrl } },
            {
              type: "text",
              text: "Now identify the 4 shapes in this image, left to right:",
            },
            { type: "image_url", image_url: { url: imgUrl } },
          ] as never,
        },
      ],
    });

    const msg = response.choices[0]?.message as { content?: string; reasoning?: string };
    const fullText = (msg?.content || msg?.reasoning || "").trim();
    console.log("Identify response:", fullText);

    const shapes = parseShapes(fullText);

    if (shapes.length !== 4) {
      return NextResponse.json(
        {
          error: `Expected 4 shapes, got ${shapes.length}: [${shapes.join(", ")}]. Raw: "${fullText.slice(0, 200)}"`,
          shapeOrder: shapes,
        },
        { status: 422 }
      );
    }

    // Match against db
    let matchedDealer = null;
    for (const [dealerId, dealerData] of Object.entries(db)) {
      const dbShapes = dealerData.names.map((name: string) => name.toLowerCase());
      if (JSON.stringify(dbShapes) === JSON.stringify(shapes)) {
        matchedDealer = dealerId;
        break;
      }
    }

    if (matchedDealer) {
      return NextResponse.json({ dealerId: matchedDealer, shapeOrder: shapes });
    } else {
      return NextResponse.json(
        { error: "No matching dealer for: " + shapes.join(", "), shapeOrder: shapes },
        { status: 404 }
      );
    }
  } catch (err) {
    console.error("API error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}