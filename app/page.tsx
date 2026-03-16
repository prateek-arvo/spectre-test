"use client";

import { useState, useRef, useCallback } from "react";
import ReactCrop, { type Crop, type PixelCrop, centerCrop, makeAspectCrop } from "react-image-crop";

type AppState = "idle" | "cropping" | "loading" | "result" | "error";

interface Result {
  dealerId: string;
  shapeOrder: string[];
}

function getCroppedImg(img: HTMLImageElement, crop: PixelCrop): string {
  const scaleX = img.naturalWidth / img.width;
  const scaleY = img.naturalHeight / img.height;

  // Cap output at 600px on the longest side to keep payload small
  const MAX = 600;
  const rawW = Math.floor(crop.width * scaleX);
  const rawH = Math.floor(crop.height * scaleY);
  const scale = Math.min(1, MAX / Math.max(rawW, rawH));
  const outW = Math.round(rawW * scale);
  const outH = Math.round(rawH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(
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
  // JPEG at 85% quality is far smaller than PNG
  return canvas.toDataURL("image/jpeg", 0.85);
}

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageSrc(reader.result as string);
      setCrop(undefined);
      setCompletedCrop(undefined);
      setState("cropping");
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget;
    const initial = centerCrop(
      makeAspectCrop({ unit: "%", width: 70 }, 1, width, height),
      width,
      height
    );
    setCrop(initial);
  }, []);

  const handleIdentify = async () => {
    if (!imgRef.current || !completedCrop) return;
    setState("loading");
    setError(null);
    try {
      const cropped = getCroppedImg(imgRef.current, completedCrop);
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ croppedImage: cropped }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "API error");
      }
      const data: any = await res.json();
      setResult(data);
      setState("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
  };

  const handleReset = () => {
    setState("idle");
    setImageSrc(null);
    setResult(null);
    setError(null);
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
                Photograph a dealer signature to identify it
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
              <span style={{ fontSize: 11, color: "#666", letterSpacing: "0.05em" }}>
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

        {/* CROPPING */}
        {state === "cropping" && imageSrc && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ color: "#555", fontSize: 13, margin: 0, textAlign: "center" }}>
              Drag corners to crop around the signature
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
              Analysing signature…
            </p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* RESULT */}
        {state === "result" && result && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: "#555",
                    textTransform: "capitalize",
                  }}
                >
                  Shape Order: {result.shapeOrder.join(', ')}
                </span>
              </div>
              {result && (
                <p
                  style={{
                    fontSize: 13,
                    color: "#555",
                    textAlign: "center",
                    lineHeight: 1.6,
                    marginTop: 20,
                    paddingTop: 20,
                    borderTop: "1px solid #1e1e1e",
                    width: "100%",
                  }}
                >
                  Detected shape order: {result.shapeOrder.join(', ')}
                </p>
              )}
            </div>

            <button onClick={handleReset} style={primaryBtn}>
              Scan Another
            </button>
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
              <p style={{ color: "#e57373", fontSize: 14, margin: "0 0 8px" }}>
                Error
              </p>
              <p style={{ color: "#6b3333", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                {error}
              </p>
            </div>
            <button onClick={handleReset} style={ghostBtn}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function confidenceDot(c: string) {
  if (c === "high") return "#4ade80";
  if (c === "medium") return "#facc15";
  return "#f87171";
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