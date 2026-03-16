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
      max_tokens: 512,
      temperature: 0,
      reasoning: { enabled: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [
        {
          role: "system",
          content:
            "You are a shape detector. You will see an image containing a row of 4 geometric shapes. " +
            "The shapes are from this set: circle, triangle, square, star, diamond, cross, arrow. " +
            "Return ONLY the 4 shape names in left-to-right order, comma separated, lowercase. " +
            "Example: circle,star,diamond,triangle\n" +
            "Return nothing else — no explanation, no punctuation except commas.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Here is the reference sheet showing all 7 possible shapes with their names:",
            },
            {
              type: "image_url",
              image_url: { url: refDataUrl },
            },
            {
              type: "text",
              text: "Now identify the 4 shapes in this image from left to right:",
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
    const msg = response.choices[0]?.message as {
      content?: string;
      reasoning?: string;
    };
    const fullText = (msg?.content || msg?.reasoning || "").trim();
    console.log("Model raw response:", fullText);

    // Parse shapes — handle various formats the model might return
    const cleaned = fullText
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/[.!?]/g, "")
      .trim()
      .toLowerCase();

    // Try to extract just the comma-separated shapes
    const shapeSet = new Set([
      "circle",
      "triangle",
      "square",
      "star",
      "diamond",
      "cross",
      "arrow",
    ]);
    const synonyms: Record<string, string> = {
      plus: "cross",
      "+": "cross",
      "plus sign": "cross",
      rhombus: "diamond",
      pentagon: "diamond",
      rect: "square",
      rectangle: "square",
      "right arrow": "arrow",
      pointer: "arrow",
    };

    // Split by comma, newline, or common separators
    const tokens = cleaned
      .split(/[,\n→>|]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const shapes: string[] = [];
    for (const token of tokens) {
      const t = token.replace(/^\d+[\.\)\s]+/, "").trim(); // strip "1. " prefixes
      if (shapeSet.has(t)) {
        shapes.push(t);
      } else if (synonyms[t]) {
        shapes.push(synonyms[t]);
      } else {
        // Fuzzy: check if any shape name is contained in the token
        for (const s of shapeSet) {
          if (t.includes(s)) {
            shapes.push(s);
            break;
          }
        }
      }
      if (shapes.length >= 4) break;
    }

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
        {
          error:
            "No matching dealer found for shape order: " + shapes.join(", "),
          shapeOrder: shapes,
        },
        { status: 404 }
      );
    }
  } catch (err) {
    console.error("Identify error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}