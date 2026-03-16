"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import ReactCrop, {
  type Crop,
  type PixelCrop,
  centerCrop,
  makeAspectCrop,
} from "react-image-crop";

type AppState = "idle" | "detecting" | "cropping" | "loading" | "result" | "error";

interface Result {
  dealerId: string;
  shapeOrder: string[];
}

/* ─── Auto-detect shape region on a canvas ─── */
function detectShapeRegion(
  img: HTMLImageElement
): { x: number; y: number; w: number; h: number } | null {
  const canvas = document.createElement("canvas");
  const MAX = 800;
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const cw = Math.round(img.naturalWidth * scale);
  const ch = Math.round(img.naturalHeight * scale);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, cw, ch);
  const imageData = ctx.getImageData(0, 0, cw, ch);
  const data = imageData.data;

  // Convert to grayscale and threshold to find dark pixels (shapes/text)
  const gray = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // Threshold: dark pixels = content
  const thresh = 140;
  const binary = gray.map((v) => (v < thresh ? 1 : 0));

  // Compute row density (% of dark pixels per row)
  const rowDensity = new Float32Array(ch);
  for (let y = 0; y < ch; y++) {
    let count = 0;
    for (let x = 0; x < cw; x++) {
      if (binary[y * cw + x]) count++;
    }
    rowDensity[y] = count / cw;
  }

  // Smooth row density
  const smoothed = new Float32Array(ch);
  const kernel = 5;
  for (let y = 0; y < ch; y++) {
    let sum = 0,
      n = 0;
    for (let k = -kernel; k <= kernel; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < ch) {
        sum += rowDensity[yy];
        n++;
      }
    }
    smoothed[y] = sum / n;
  }

  // Find horizontal bands of content — look for gaps (low density rows)
  // Shape codes are typically a thin horizontal strip with moderate density
  const bandThreshold = 0.02; // min density to count as content
  const bands: { top: number; bottom: number; density: number }[] = [];
  let inBand = false;
  let bandStart = 0;
  let bandDensitySum = 0;

  for (let y = 0; y < ch; y++) {
    if (smoothed[y] > bandThreshold) {
      if (!inBand) {
        inBand = true;
        bandStart = y;
        bandDensitySum = 0;
      }
      bandDensitySum += smoothed[y];
    } else if (inBand) {
      const height = y - bandStart;
      if (height > 8) {
        bands.push({
          top: bandStart,
          bottom: y,
          density: bandDensitySum / height,
        });
      }
      inBand = false;
    }
  }
  if (inBand) {
    const height = ch - bandStart;
    if (height > 8) {
      bands.push({
        top: bandStart,
        bottom: ch,
        density: bandDensitySum / height,
      });
    }
  }

  if (bands.length === 0) return null;

  // Shape code characteristics:
  // - Relatively thin band (not the main text block which is taller)
  // - Moderate density (bold outlines but mostly white inside shapes)
  // - Usually at top or bottom of label (away from main text)
  // 
  // Strategy: find bands that look like shape codes based on aspect ratio
  // Shape strip is wide and short (aspect ratio > 2.5)
  // Also look for the band that's most isolated (furthest from other bands)

  // For each band, compute column span (leftmost to rightmost dark pixel)
  const scoredBands = bands.map((band) => {
    let minX = cw, maxX = 0;
    for (let y = band.top; y < band.bottom; y++) {
      for (let x = 0; x < cw; x++) {
        if (binary[y * cw + x]) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    const bw = maxX - minX;
    const bh = band.bottom - band.top;
    const aspect = bw / Math.max(1, bh);
    
    // Score: prefer wide-and-short bands (high aspect), moderate density
    // Shape codes have aspect ~3-5, density ~0.05-0.15
    let score = 0;
    if (aspect > 2.0) score += 2;
    if (aspect > 3.0) score += 2;
    if (band.density > 0.03 && band.density < 0.25) score += 2;
    // Prefer bands that are NOT the tallest (tallest is usually main text)
    const maxBandHeight = Math.max(...bands.map(b => b.bottom - b.top));
    if (bh < maxBandHeight * 0.6) score += 3;
    // Prefer bands near edges (top 25% or bottom 25%)
    const midY = (band.top + band.bottom) / 2;
    if (midY < ch * 0.25 || midY > ch * 0.75) score += 2;

    return { ...band, minX, maxX, bw, bh, aspect, score };
  });

  // Sort by score descending
  scoredBands.sort((a, b) => b.score - a.score);

  // If no band scores well, fall back to the full label
  if (scoredBands[0].score < 4) return null;

  const best = scoredBands[0];
  
  // Add padding and convert back to original image coordinates
  const pad = 15;
  const invScale = 1 / scale;
  return {
    x: Math.max(0, Math.round((best.minX - pad) * invScale)),
    y: Math.max(0, Math.round((best.top - pad) * invScale)),
    w: Math.min(
      img.naturalWidth,
      Math.round((best.bw + pad * 2) * invScale)
    ),
    h: Math.min(
      img.naturalHeight,
      Math.round((best.bh + pad * 2) * invScale)
    ),
  };
}

function getCroppedImg(img: HTMLImageElement, crop: PixelCrop): string {
  const scaleX = img.naturalWidth / img.width;
  const scaleY = img.naturalHeight / img.height;
  const MAX = 600;
  const rawW = Math.floor(crop.width * scaleX);
  const rawH = Math.floor(crop.height * scaleY);
  const s = Math.min(1, MAX / Math.max(rawW, rawH));
  const outW = Math.round(rawW * s);
  const outH = Math.round(rawH * s);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext("2d")!.drawImage(
    img,
    crop.x * scaleX,
    crop.y * scaleY,
    rawW,
    rawH,
    0,
    0,
    outW,
    outH
  );
  return canvas.toDataURL("image/jpeg", 0.85);
}

function getCroppedImgFromNative(
  img: HTMLImageElement,
  region: { x: number; y: number; w: number; h: number }
): string {
  const MAX = 600;
  const s = Math.min(1, MAX / Math.max(region.w, region.h));
  const outW = Math.round(region.w * s);
  const outH = Math.round(region.h * s);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext("2d")!.drawImage(
    img,
    region.x,
    region.y,
    region.w,
    region.h,
    0,
    0,
    outW,
    outH
  );
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detectedPreview, setDetectedPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const hiddenImgRef = useRef<HTMLImageElement>(null);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageSrc(reader.result as string);
      setCrop(undefined);
      setCompletedCrop(undefined);
      setDetectedPreview(null);
      setState("detecting");
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // Auto-detect once the hidden image loads
  const onHiddenImgLoad = useCallback(() => {
    const img = hiddenImgRef.current;
    if (!img || state !== "detecting") return;

    const region = detectShapeRegion(img);
    if (region && region.w > 20 && region.h > 10) {
      // Auto-detected — show preview and send directly
      const preview = getCroppedImgFromNative(img, region);
      setDetectedPreview(preview);
      // Auto-send to API
      sendToApi(preview);
    } else {
      // Failed to detect — fall back to manual crop
      setState("cropping");
    }
  }, [state]);

  const sendToApi = async (croppedDataUrl: string) => {
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ croppedImage: croppedDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "API error");
      }
      setResult(data);
      setState("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
  };

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget;
      const initial = centerCrop(
        makeAspectCrop({ unit: "%", width: 70 }, 3, width, height),
        width,
        height
      );
      setCrop(initial);
    },
    []
  );

  const handleIdentify = async () => {
    if (!imgRef.current || !completedCrop) return;
    const cropped = getCroppedImg(imgRef.current, completedCrop);
    sendToApi(cropped);
  };

  const handleManualCrop = () => {
    setState("cropping");
    setDetectedPreview(null);
  };

  const handleReset = () => {
    setState("idle");
    setImageSrc(null);
    setResult(null);
    setError(null);
    setDetectedPreview(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
  };

  return (
    <main
      style={{
        minHeight: "100svh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "20px 20px 0",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-0.5px",
            color: "#fff",
          }}
        >
          Specter
        </span>
        <span
          style={{
            fontSize: 11,
            color: "#444",
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginTop: 2,
          }}
        >
          Dealer ID
        </span>
      </header>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "24px 20px 32px",
          gap: 16,
        }}
      >
        {/* Hidden image for auto-detection */}
        {imageSrc && state === "detecting" && (
          <img
            ref={hiddenImgRef}
            src={imageSrc}
            alt=""
            onLoad={onHiddenImgLoad}
            style={{ display: "none" }}
          />
        )}

        {/* IDLE */}
        {state === "idle" && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 40,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <p style={{ color: "#555", fontSize: 14, margin: 0 }}>
                Photograph a label to identify the dealer
              </p>
            </div>

            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: 120,
                height: 120,
                borderRadius: "50%",
                background: "#181818",
                border: "1px solid #2a2a2a",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
                transition: "background 0.15s, transform 0.1s",
              }}
              onPointerDown={(e) =>
                (e.currentTarget.style.transform = "scale(0.95)")
              }
              onPointerUp={(e) =>
                (e.currentTarget.style.transform = "scale(1)")
              }
            >
              <CameraIcon />
              <span
                style={{
                  fontSize: 11,
                  color: "#666",
                  letterSpacing: "0.05em",
                }}
              >
                CAPTURE
              </span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onFileChange}
              style={{ display: "none" }}
            />
          </div>
        )}

        {/* DETECTING */}
        {state === "detecting" && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                border: "2px solid #2a2a2a",
                borderTopColor: "#fff",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <p style={{ color: "#444", fontSize: 13, margin: 0 }}>
              Detecting shape code on label…
            </p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* CROPPING (manual fallback) */}
        {state === "cropping" && imageSrc && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <p
              style={{
                color: "#555",
                fontSize: 13,
                margin: 0,
                textAlign: "center",
              }}
            >
              Auto-detect missed — crop around the 4 shapes manually
            </p>

            <div
              style={{
                borderRadius: 12,
                overflow: "hidden",
                background: "#111",
                border: "1px solid #1e1e1e",
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 280,
                maxHeight: "58vh",
              }}
            >
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                style={{ maxHeight: "58vh", width: "100%" }}
                ruleOfThirds
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt="Captured"
                  onLoad={onImageLoad}
                  style={{
                    maxHeight: "58vh",
                    width: "100%",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              </ReactCrop>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleReset} style={ghostBtn}>
                Cancel
              </button>
              <button
                onClick={handleIdentify}
                disabled={!completedCrop?.width}
                style={{
                  ...primaryBtn,
                  opacity: !completedCrop?.width ? 0.4 : 1,
                }}
              >
                Identify
              </button>
            </div>
          </div>
        )}

        {/* LOADING */}
        {state === "loading" && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
            }}
          >
            {detectedPreview && (
              <div
                style={{
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid #2a2a2a",
                  marginBottom: 8,
                  maxWidth: 320,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detectedPreview}
                  alt="Detected region"
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            )}
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                border: "2px solid #2a2a2a",
                borderTopColor: "#fff",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <p style={{ color: "#444", fontSize: 13, margin: 0 }}>
              Identifying shapes…
            </p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* RESULT */}
        {state === "result" && result && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {detectedPreview && (
              <div
                style={{
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid #1e1e1e",
                  maxWidth: 320,
                  alignSelf: "center",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detectedPreview}
                  alt="Detected shapes"
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            )}
            <div
              style={{
                background: "#111",
                border: "1px solid #1e1e1e",
                borderRadius: 16,
                padding: "32px 24px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                flex: 1,
                justifyContent: "center",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  color: "#444",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  margin: 0,
                }}
              >
                Identified as
              </p>
              <p
                style={{
                  fontSize: 48,
                  fontWeight: 700,
                  letterSpacing: "-1px",
                  margin: "8px 0 0",
                  lineHeight: 1,
                }}
              >
                {result.dealerId}
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: "#555",
                  textAlign: "center",
                  lineHeight: 1.6,
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: "1px solid #1e1e1e",
                  width: "100%",
                }}
              >
                {result.shapeOrder.join(" → ")}
              </p>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleReset} style={primaryBtn}>
                Scan Another
              </button>
            </div>
          </div>
        )}

        {/* ERROR */}
        {state === "error" && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
            }}
          >
            {detectedPreview && (
              <div
                style={{
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid #2a1515",
                  maxWidth: 320,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detectedPreview}
                  alt="Detected region"
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            )}
            <div
              style={{
                background: "#110a0a",
                border: "1px solid #2a1515",
                borderRadius: 16,
                padding: "24px",
                width: "100%",
                textAlign: "center",
              }}
            >
              <p
                style={{ color: "#e57373", fontSize: 14, margin: "0 0 8px" }}
              >
                {error?.includes("No matching") ? "Unknown Code" : "Error"}
              </p>
              <p
                style={{
                  color: "#6b3333",
                  fontSize: 12,
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {error}
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button onClick={handleManualCrop} style={ghostBtn}>
                Manual Crop
              </button>
              <button onClick={handleReset} style={ghostBtn}>
                Try Again
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

const primaryBtn: React.CSSProperties = {
  flex: 1,
  padding: "15px 0",
  borderRadius: 12,
  background: "#fff",
  color: "#0c0c0c",
  border: "none",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "-0.2px",
  WebkitTapHighlightColor: "transparent",
};

const ghostBtn: React.CSSProperties = {
  flex: 1,
  padding: "15px 0",
  borderRadius: 12,
  background: "transparent",
  color: "#555",
  border: "1px solid #222",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

function CameraIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}