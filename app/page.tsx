"use client";

import { useState, useRef, useCallback, useEffect } from "react";

type AppState = "idle" | "camera" | "preview" | "loading" | "result" | "error";

interface Result {
  dealerId: string;
  shapeOrder: string[];
}

/**
 * Auto-crop: finds the label's content area (where shape codes live).
 * 
 * Strategy:
 * 1. Find the white label rectangle (bright region vs dark background)
 * 2. Within the label, skip the top header block (blue area with company info)
 * 3. Return the content zone: from "Part No:" line down to "MFD:" line
 *    This is where the small shape symbols are scattered between text.
 */
function autoCropContent(img: HTMLImageElement): string {
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

  // Grayscale
  const gray = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Step 1: Find the label (bright rectangular region)
  // Row brightness profile
  const rowBright = new Float32Array(ch);
  for (let y = 0; y < ch; y++) {
    let sum = 0;
    for (let x = 0; x < cw; x++) sum += gray[y * cw + x] > 160 ? 1 : 0;
    rowBright[y] = sum / cw;
  }

  // Label rows: >40% bright pixels
  let labelTop = 0, labelBot = ch - 1;
  for (let y = 0; y < ch; y++) { if (rowBright[y] > 0.35) { labelTop = y; break; } }
  for (let y = ch - 1; y >= 0; y--) { if (rowBright[y] > 0.35) { labelBot = y; break; } }

  // Column brightness within label rows
  let labelLeft = 0, labelRight = cw - 1;
  const colBright = new Float32Array(cw);
  for (let x = 0; x < cw; x++) {
    let sum = 0, n = 0;
    for (let y = labelTop; y <= labelBot; y++) {
      sum += gray[y * cw + x] > 160 ? 1 : 0;
      n++;
    }
    colBright[x] = sum / n;
  }
  for (let x = 0; x < cw; x++) { if (colBright[x] > 0.35) { labelLeft = x; break; } }
  for (let x = cw - 1; x >= 0; x--) { if (colBright[x] > 0.35) { labelRight = x; break; } }

  const lw = labelRight - labelLeft;
  const lh = labelBot - labelTop;

  // Step 2: Within the label, find where the header ends
  // The header has colored background (darker rows). Content area is lighter.
  // Compute row "whiteness" within the label (fraction of very bright pixels)
  const rowWhite = new Float32Array(lh);
  for (let y = 0; y < lh; y++) {
    let count = 0;
    const gy = labelTop + y;
    for (let x = labelLeft; x <= labelRight; x++) {
      if (gray[gy * cw + x] > 200) count++;
    }
    rowWhite[y] = count / lw;
  }

  // Smooth it
  const smoothed = new Float32Array(lh);
  const k = 3;
  for (let y = 0; y < lh; y++) {
    let s = 0, n = 0;
    for (let dy = -k; dy <= k; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < lh) { s += rowWhite[yy]; n++; }
    }
    smoothed[y] = s / n;
  }

  // Find content start: after the header zone (first 25-45% of label),
  // look for where whiteness exceeds 0.6 (transition from blue header to white content)
  let contentStartY = Math.round(lh * 0.30); // fallback
  const searchStart = Math.round(lh * 0.20);
  const searchEnd = Math.round(lh * 0.55);
  for (let y = searchStart; y < searchEnd; y++) {
    if (smoothed[y] > 0.55) {
      contentStartY = y;
      break;
    }
  }

  // Content end: bottom of label minus small margin
  const contentEndY = lh - Math.round(lh * 0.02);

  // Step 3: Convert back to original image coordinates
  const invScale = 1 / scale;
  const pad = 5;
  const cx1 = Math.max(0, Math.round((labelLeft + pad) * invScale));
  const cy1 = Math.max(0, Math.round((labelTop + contentStartY) * invScale));
  const cx2 = Math.min(img.naturalWidth, Math.round((labelRight - pad) * invScale));
  const cy2 = Math.min(img.naturalHeight, Math.round((labelBot - Math.round(lh * 0.01)) * invScale));

  // Crop and return as data URL
  const outW = Math.min(600, cx2 - cx1);
  const outH = Math.round(outW * (cy2 - cy1) / (cx2 - cx1));
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  outCanvas.getContext("2d")!.drawImage(
    img, cx1, cy1, cx2 - cx1, cy2 - cy1, 0, 0, outW, outH
  );
  return outCanvas.toDataURL("image/jpeg", 0.90);
}

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [croppedPreview, setCroppedPreview] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ─── Camera ───
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setState("camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1080 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : "Camera unavailable");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ─── Capture → Auto-crop → Show preview ───
  const captureAndCrop = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    // Grab full frame
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext("2d")!.drawImage(video, 0, 0);

    stopCamera();

    // Create a temporary image to run auto-crop on
    const tempImg = new Image();
    tempImg.onload = () => {
      const cropped = autoCropContent(tempImg);
      setCroppedPreview(cropped);
      setState("preview");
    };
    tempImg.src = fullCanvas.toDataURL("image/jpeg", 0.92);
  }, [stopCamera]);

  // ─── API ───
  const sendToApi = async () => {
    if (!croppedPreview) return;
    setState("loading");
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
  };

  const handleReset = () => {
    stopCamera();
    setState("idle");
    setCroppedPreview(null);
    setResult(null);
    setError(null);
    setCameraError(null);
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
              Point camera at the label to identify the dealer
            </p>
            <button onClick={startCamera} style={captureCircle}>
              <CameraIcon />
              <span style={{ fontSize: 11, color: "#666", letterSpacing: "0.05em" }}>
                SCAN
              </span>
            </button>
          </div>
        )}

        {/* ─── CAMERA ─── */}
        {state === "camera" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ ...subtleText, fontSize: 12 }}>
              Frame the entire label, then capture
            </p>

            <div style={viewfinderContainer}>
              {cameraError ? (
                <div style={{ ...centeredCol, padding: 24 }}>
                  <p style={{ color: "#e57373", fontSize: 13, textAlign: "center" }}>
                    {cameraError}
                  </p>
                  <button onClick={handleReset} style={{ ...ghostBtn, flex: "none", width: "auto", padding: "10px 24px" }}>
                    Back
                  </button>
                </div>
              ) : (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                  {/* Guide: show a label-shaped outline */}
                  <div style={guideOverlay}>
                    <div style={guideBox}>
                      <span style={guideLabel}>Align label here</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleReset} style={ghostBtn}>Cancel</button>
              <button
                onClick={captureAndCrop}
                disabled={!!cameraError}
                style={{ ...primaryBtn, opacity: cameraError ? 0.3 : 1 }}
              >
                Capture
              </button>
            </div>
          </div>
        )}

        {/* ─── PREVIEW (auto-cropped) ─── */}
        {state === "preview" && croppedPreview && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ ...subtleText, fontSize: 12 }}>
              Auto-cropped to content area. Verify it looks right.
            </p>

            <div style={previewContainer}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={croppedPreview}
                alt="Cropped content area"
                style={{ width: "100%", display: "block", borderRadius: 10 }}
              />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setCroppedPreview(null); startCamera(); }}
                style={ghostBtn}
              >
                Retake
              </button>
              <button onClick={sendToApi} style={primaryBtn}>
                Identify
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
            <p style={{ color: "#444", fontSize: 13, margin: 0 }}>Identifying shapes…</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* ─── RESULT ─── */}
        {state === "result" && result && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
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
            <div style={errorCard}>
              <p style={{ color: "#e57373", fontSize: 14, margin: "0 0 8px" }}>
                {error?.includes("No matching") ? "Unknown Code" : "Error"}
              </p>
              <p style={{ color: "#6b3333", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                {error}
              </p>
            </div>
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button onClick={() => { setCroppedPreview(null); startCamera(); }} style={ghostBtn}>
                Retake
              </button>
              <button onClick={handleReset} style={ghostBtn}>
                Start Over
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
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
const viewfinderContainer: React.CSSProperties = {
  flex: 1, position: "relative", borderRadius: 16, overflow: "hidden",
  background: "#000", border: "1px solid #1e1e1e", minHeight: 300,
};
const guideOverlay: React.CSSProperties = {
  position: "absolute", inset: 0, display: "flex",
  alignItems: "center", justifyContent: "center", pointerEvents: "none",
};
const guideBox: React.CSSProperties = {
  width: "90%", height: "70%",
  border: "2px solid rgba(255,255,255,0.4)", borderRadius: 12,
  boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
  display: "flex", alignItems: "flex-end", justifyContent: "center",
  paddingBottom: 8,
};
const guideLabel: React.CSSProperties = {
  fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.05em",
};
const previewContainer: React.CSSProperties = {
  flex: 1, borderRadius: 14, overflow: "hidden",
  border: "2px solid #1e1e1e", background: "#111",
  display: "flex", alignItems: "center", justifyContent: "center",
};
const resultCard: React.CSSProperties = {
  background: "#111", border: "1px solid #1e1e1e", borderRadius: 16,
  padding: "32px 24px", display: "flex", flexDirection: "column",
  alignItems: "center", gap: 8, flex: 1, justifyContent: "center",
};
const labelSmall: React.CSSProperties = {
  fontSize: 11, color: "#444", letterSpacing: "0.12em",
  textTransform: "uppercase", margin: 0,
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