import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Specter",
  description: "Dealer signature identification",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#0c0c0c", color: "#ffffff", margin: 0 }}>
        {children}
        <script type="text/javascript">
          {`
            var Module = {
              onRuntimeInitialized() {
                console.log('OpenCV.js is ready.');
                window.opencvReady = true;
              }
            };
          `}
        </script>
        <script async src="https://docs.opencv.org/4.8.0/opencv.js" type="text/javascript"></script>
      </body>
    </html>
  );
}
