"use client";

import { useState, useRef, useCallback } from "react";

type AppState = "idle" | "cropping" | "preview" | "loading" | "result" | "error";

interface Result {
  dealerId: string;
  shapeOrder: string[];
}

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [croppedPreview, setCroppedPreview] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // ─── File selected → load image → ask API to find MRP → auto-crop ───
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setImageSrc(dataUrl);
      setCroppedPreview(null);
      setResult(null);
      setError(null);
      setState("cropping");
      setStatusMsg("Finding label content area…");
      findMrpAndCrop(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // ─── Step 1: Send full image to API to find MRP y-position ───
  const findMrpAndCrop = async (fullImageDataUrl: string) => {
    try {
      // Resize for API (keep it under ~500KB)
      const resized = await resizeImage(fullImageDataUrl, 800);

      setStatusMsg("Asking vision model to locate MRP…");
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ croppedImage: resized, mode: "crop" }),
      });
      const data = await res.json();

      if (!res.ok) {
        console.warn("Crop API failed, using fallback:", data);
        // Fallback: crop around typical MRP area (60-75% of label)
        doCrop(fullImageDataUrl, 55, 75);
        return;
      }

      const { mrp_y } = data;
      console.log(`Vision model says: mrp at ${mrp_y}%`);

      // Crop a box around MRP with padding (±8% of image height)
      const pad = 8;
      const topPct = Math.max(0, mrp_y - pad);
      const botPct = Math.min(100, mrp_y + pad);
      doCrop(fullImageDataUrl, topPct, botPct);
    } catch (err) {
      console.error("findMrpAndCrop error:", err);
      // Fallback crop
      doCrop(fullImageDataUrl, 55, 75);
    }
  };

  // ─── Crop the image by percentage and show preview ───
  const doCrop = (dataUrl: string, topPct: number, botPct: number) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const iw = tempImg.naturalWidth;
      const ih = tempImg.naturalHeight;
      const y1 = Math.round((topPct / 100) * ih);
      const y2 = Math.round((botPct / 100) * ih);
      const cropH = y2 - y1;

      if (cropH < 20) {
        // Too small — use fallback
        setState("error");
        setError("Could not find content area. Try cropping manually.");
        return;
      }

      const MAX = 600;
      const scale = Math.min(1, MAX / iw);
      const outW = Math.round(iw * scale);
      const outH = Math.round(cropH * scale);

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      canvas.getContext("2d")!.drawImage(
        tempImg, 0, y1, iw, cropH, 0, 0, outW, outH
      );

      const cropped = canvas.toDataURL("image/jpeg", 0.90);
      setCroppedPreview(cropped);
      setState("preview");
      setStatusMsg("");
    };
    tempImg.src = dataUrl;
  };

  // ─── Step 2: Send cropped image to identify shapes ───
  const identifyShapes = async () => {
    if (!croppedPreview) return;
    setState("loading");
    setStatusMsg("Identifying shapes…");
    setError(null);
    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ croppedImage: croppedPreview }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "API error");
      setResult(data);
      setState("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
    setStatusMsg("");
  };

  const handleReset = () => {
    setState("idle");
    setImageSrc(null);
    setCroppedPreview(null);
    setResult(null);
    setError(null);
    setStatusMsg("");
  };

  return (
    <main style={mainStyle}>
      <header style={headerStyle}>
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>
          Specter
        </span>
        <span style={badgeStyle}>Dealer ID</span>
      </header>

      <div style={bodyStyle}>
        {/* ─── IDLE ─── */}
        {state === "idle" && (
          <div style={centeredCol}>
            <p style={subtleText}>
              Upload a photo of the label to identify the dealer
            </p>
            <button onClick={() => fileInputRef.current?.click()} style={captureCircle}>
              <CameraIcon />
              <span style={{ fontSize: 11, color: "#666", letterSpacing: "0.05em" }}>
                UPLOAD
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

        {/* ─── CROPPING (auto — finding MRP) ─── */}
        {state === "cropping" && (
          <div style={centeredCol}>
            {imageSrc && (
              <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #222", maxWidth: 360, opacity: 0.6 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageSrc} alt="Full label" style={{ width: "100%", display: "block" }} />
              </div>
            )}
            <div style={spinnerStyle} />
            <p style={{ color: "#555", fontSize: 13, margin: 0 }}>{statusMsg}</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* ─── PREVIEW (auto-cropped above MRP) ─── */}
        {state === "preview" && croppedPreview && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ ...subtleText, fontSize: 12 }}>
              Auto-cropped around MRP area — verify it captures the shapes
            </p>

            <div style={previewContainer}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={croppedPreview}
                alt="Cropped above MRP"
                style={{ width: "100%", display: "block", borderRadius: 10 }}
              />
            </div>

            {/* Also show original with indication */}
            {imageSrc && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ color: "#444", fontSize: 12, cursor: "pointer" }}>
                  Show full image
                </summary>
                <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #222", marginTop: 8 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageSrc} alt="Full" style={{ width: "100%", display: "block", opacity: 0.7 }} />
                </div>
              </details>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleReset} style={ghostBtn}>
                Retake
              </button>
              <button onClick={identifyShapes} style={primaryBtn}>
                Identify Shapes
              </button>
            </div>
          </div>
        )}

        {/* ─── LOADING ─── */}
        {state === "loading" && (
          <div style={centeredCol}>
            {croppedPreview && (
              <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #222", maxWidth: 320, marginBottom: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={croppedPreview} alt="" style={{ width: "100%", display: "block" }} />
              </div>
            )}
            <div style={spinnerStyle} />
            <p style={{ color: "#444", fontSize: 13, margin: 0 }}>{statusMsg}</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* ─── RESULT ─── */}
        {state === "result" && result && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            {croppedPreview && (
              <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #1e1e1e", maxWidth: 320, alignSelf: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={croppedPreview} alt="" style={{ width: "100%", display: "block" }} />
              </div>
            )}
            <div style={resultCard}>
              <p style={labelSmall}>Identified as</p>
              <p style={dealerIdText}>{result.dealerId}</p>
              <p style={shapeOrderText}>{result.shapeOrder.join("  →  ")}</p>
            </div>
            <button onClick={handleReset} style={primaryBtn}>Scan Another</button>
          </div>
        )}

        {/* ─── ERROR ─── */}
        {state === "error" && (
          <div style={centeredCol}>
            {croppedPreview && (
              <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #2a1515", maxWidth: 320, marginBottom: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={croppedPreview} alt="" style={{ width: "100%", display: "block" }} />
              </div>
            )}
            <div style={errorCard}>
              <p style={{ color: "#e57373", fontSize: 14, margin: "0 0 8px" }}>
                {error?.includes("No matching") ? "Unknown Code" : "Error"}
              </p>
              <p style={{ color: "#6b3333", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                {error}
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button onClick={handleReset} style={ghostBtn}>Try Again</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ─── Resize helper ───
function resizeImage(dataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.80));
    };
    img.src = dataUrl;
  });
}

/* ─── Styles ─── */
const mainStyle: React.CSSProperties = {
  minHeight: "100svh", display: "flex", flexDirection: "column",
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  background: "#0c0c0c", color: "#fff",
};
const headerStyle: React.CSSProperties = {
  padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 10, zIndex: 10,
};
const badgeStyle: React.CSSProperties = {
  fontSize: 11, color: "#444", fontWeight: 500, letterSpacing: "0.08em",
  textTransform: "uppercase", marginTop: 2,
};
const bodyStyle: React.CSSProperties = {
  flex: 1, display: "flex", flexDirection: "column", padding: "16px 20px 28px", gap: 12,
};
const centeredCol: React.CSSProperties = {
  flex: 1, display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", gap: 24,
};
const subtleText: React.CSSProperties = {
  color: "#555", fontSize: 14, margin: 0, textAlign: "center",
};
const captureCircle: React.CSSProperties = {
  width: 120, height: 120, borderRadius: "50%", background: "#181818",
  border: "1px solid #2a2a2a", display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};
const previewContainer: React.CSSProperties = {
  borderRadius: 14, overflow: "hidden",
  border: "2px solid #1e1e1e", background: "#111",
};
const resultCard: React.CSSProperties = {
  background: "#111", border: "1px solid #1e1e1e", borderRadius: 16,
  padding: "32px 24px", display: "flex", flexDirection: "column",
  alignItems: "center", gap: 8, flex: 1, justifyContent: "center",
};
const labelSmall: React.CSSProperties = {
  fontSize: 11, color: "#444", letterSpacing: "0.12em", textTransform: "uppercase", margin: 0,
};
const dealerIdText: React.CSSProperties = {
  fontSize: 48, fontWeight: 700, letterSpacing: "-1px", margin: "8px 0 0", lineHeight: 1,
};
const shapeOrderText: React.CSSProperties = {
  fontSize: 14, color: "#555", textAlign: "center", lineHeight: 1.6,
  marginTop: 16, paddingTop: 16, borderTop: "1px solid #1e1e1e", width: "100%",
};
const errorCard: React.CSSProperties = {
  background: "#110a0a", border: "1px solid #2a1515", borderRadius: 16,
  padding: 24, width: "100%", textAlign: "center",
};
const primaryBtn: React.CSSProperties = {
  flex: 1, padding: "15px 0", borderRadius: 12, background: "#fff",
  color: "#0c0c0c", border: "none", fontSize: 14, fontWeight: 600,
  cursor: "pointer", letterSpacing: "-0.2px", WebkitTapHighlightColor: "transparent",
};
const ghostBtn: React.CSSProperties = {
  flex: 1, padding: "15px 0", borderRadius: 12, background: "transparent",
  color: "#555", border: "1px solid #222", fontSize: 14, fontWeight: 500,
  cursor: "pointer", WebkitTapHighlightColor: "transparent",
};
const spinnerStyle: React.CSSProperties = {
  width: 44, height: 44, borderRadius: "50%",
  border: "2px solid #2a2a2a", borderTopColor: "#fff",
  animation: "spin 0.8s linear infinite",
};

function CameraIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}