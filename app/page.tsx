"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import ReactCrop, {
  type Crop,
  type PixelCrop,
  centerCrop,
  makeAspectCrop,
} from "react-image-crop";

type AppState = "idle" | "camera" | "cropping" | "loading" | "result" | "error";

interface Result {
  dealerId: string;
  shapeOrder: string[];
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

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // ─── Camera ───
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setState("camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      setCameraError(
        err instanceof Error ? err.message : "Could not access camera"
      );
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // ─── API ───
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
      if (!res.ok) throw new Error(data.error || "API error");
      setResult(data);
      setState("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
  };

  // Guide box proportions (must match the CSS below)
  const GUIDE_W = 0.88; // 88% of video width
  const GUIDE_H = 0.28; // 28% of video height

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // The video is displayed with objectFit:cover, so it may be cropped.
    // Calculate the visible region of the video that maps to the container.
    const container = video.parentElement;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const cAspect = cRect.width / cRect.height;
    const vAspect = vw / vh;

    let srcX = 0, srcY = 0, srcW = vw, srcH = vh;
    if (vAspect > cAspect) {
      // Video wider than container — cropped on sides
      srcW = Math.round(vh * cAspect);
      srcX = Math.round((vw - srcW) / 2);
    } else {
      // Video taller — cropped top/bottom
      srcH = Math.round(vw / cAspect);
      srcY = Math.round((vh - srcH) / 2);
    }

    // Guide box within the visible region (centered)
    const gw = Math.round(srcW * GUIDE_W);
    const gh = Math.round(srcH * GUIDE_H);
    const gx = srcX + Math.round((srcW - gw) / 2);
    const gy = srcY + Math.round((srcH - gh) / 2);

    // Crop just the guide region
    const MAX = 600;
    const scale = Math.min(1, MAX / Math.max(gw, gh));
    const outW = Math.round(gw * scale);
    const outH = Math.round(gh * scale);

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext("2d")!.drawImage(video, gx, gy, gw, gh, 0, 0, outW, outH);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.90);

    stopCamera();
    // Skip cropping — send directly to API
    sendToApi(dataUrl);
  }, [stopCamera]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget;
      const initial = centerCrop(
        makeAspectCrop({ unit: "%", width: 80 }, 3.5, width, height),
        width,
        height
      );
      setCrop(initial);
    },
    []
  );

  const handleIdentify = () => {
    if (!imgRef.current || !completedCrop) return;
    sendToApi(getCroppedImg(imgRef.current, completedCrop));
  };

  const handleReset = () => {
    stopCamera();
    setState("idle");
    setImageSrc(null);
    setResult(null);
    setError(null);
    setCameraError(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
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
              Point camera at the shape code on the label
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
              Align the shapes inside the guide, then capture
            </p>

            <div style={viewfinderContainer}>
              {cameraError ? (
                <div style={centeredCol}>
                  <p style={{ color: "#e57373", fontSize: 13, textAlign: "center", padding: 24 }}>
                    {cameraError}
                  </p>
                  <button onClick={handleReset} style={{ ...ghostBtn, width: "auto", flex: "none", padding: "10px 24px" }}>
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

                  {/* Guide rectangle */}
                  <div style={guideOverlay}>
                    <div style={guideBox} />
                  </div>

                  {/* Hint shapes along the bottom */}
                  <div style={hintRow}>
                    {["○", "△", "□", "☆", "◇", "✚", "→"].map((s, i) => (
                      <span key={i} style={{ fontSize: 18, color: "rgba(255,255,255,0.3)" }}>
                        {s}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleReset} style={ghostBtn}>Cancel</button>
              <button
                onClick={capturePhoto}
                disabled={!!cameraError}
                style={{ ...primaryBtn, opacity: cameraError ? 0.3 : 1 }}
              >
                Capture &amp; Identify
              </button>
            </div>
          </div>
        )}

        {/* ─── CROPPING ─── */}
        {state === "cropping" && imageSrc && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ ...subtleText, fontSize: 12 }}>
              Drag to crop tightly around the 4 shapes
            </p>

            <div style={cropContainer}>
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                style={{ maxHeight: "60vh", width: "100%" }}
                ruleOfThirds
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt="Captured"
                  onLoad={onImageLoad}
                  style={{ maxHeight: "60vh", width: "100%", objectFit: "contain", display: "block" }}
                />
              </ReactCrop>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setImageSrc(null); startCamera(); }}
                style={ghostBtn}
              >
                Retake
              </button>
              <button
                onClick={handleIdentify}
                disabled={!completedCrop?.width}
                style={{ ...primaryBtn, opacity: !completedCrop?.width ? 0.4 : 1 }}
              >
                Identify
              </button>
            </div>
          </div>
        )}

        {/* ─── LOADING ─── */}
        {state === "loading" && (
          <div style={centeredCol}>
            <div style={spinnerStyle} />
            <p style={{ color: "#444", fontSize: 13, margin: 0 }}>
              Identifying shapes…
            </p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* ─── RESULT ─── */}
        {state === "result" && result && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={resultCard}>
              <p style={labelSmall}>Identified as</p>
              <p style={dealerIdText}>{result.dealerId}</p>
              <p style={shapeOrderText}>
                {result.shapeOrder.join("  →  ")}
              </p>
            </div>
            <button onClick={handleReset} style={primaryBtn}>
              Scan Another
            </button>
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
            <button onClick={handleReset} style={{ ...ghostBtn, flex: "none", width: "100%" }}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/* ─── Shared Styles ─── */
const mainStyle: React.CSSProperties = {
  minHeight: "100svh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  background: "#0c0c0c",
  color: "#fff",
};
const headerStyle: React.CSSProperties = {
  padding: "16px 20px 0",
  display: "flex",
  alignItems: "center",
  gap: 10,
  zIndex: 10,
};
const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#444",
  fontWeight: 500,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  marginTop: 2,
};
const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  padding: "16px 20px 28px",
  gap: 12,
};
const centeredCol: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 24,
};
const subtleText: React.CSSProperties = {
  color: "#555",
  fontSize: 14,
  margin: 0,
  textAlign: "center",
};
const captureCircle: React.CSSProperties = {
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
};
const viewfinderContainer: React.CSSProperties = {
  flex: 1,
  position: "relative",
  borderRadius: 16,
  overflow: "hidden",
  background: "#000",
  border: "1px solid #1e1e1e",
  minHeight: 300,
};
const guideOverlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};
const guideBox: React.CSSProperties = {
  width: "88%",
  height: "28%",
  border: "2px solid rgba(255,255,255,0.45)",
  borderRadius: 12,
  boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
};
const hintRow: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: 0,
  right: 0,
  display: "flex",
  justifyContent: "center",
  gap: 12,
  pointerEvents: "none",
};
const cropContainer: React.CSSProperties = {
  borderRadius: 12,
  overflow: "hidden",
  background: "#111",
  border: "1px solid #1e1e1e",
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 280,
  maxHeight: "60vh",
};
const resultCard: React.CSSProperties = {
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
};
const labelSmall: React.CSSProperties = {
  fontSize: 11,
  color: "#444",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  margin: 0,
};
const dealerIdText: React.CSSProperties = {
  fontSize: 48,
  fontWeight: 700,
  letterSpacing: "-1px",
  margin: "8px 0 0",
  lineHeight: 1,
};
const shapeOrderText: React.CSSProperties = {
  fontSize: 14,
  color: "#555",
  textAlign: "center",
  lineHeight: 1.6,
  marginTop: 16,
  paddingTop: 16,
  borderTop: "1px solid #1e1e1e",
  width: "100%",
};
const errorCard: React.CSSProperties = {
  background: "#110a0a",
  border: "1px solid #2a1515",
  borderRadius: 16,
  padding: 24,
  width: "100%",
  textAlign: "center",
};
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
const spinnerStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "2px solid #2a2a2a",
  borderTopColor: "#fff",
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