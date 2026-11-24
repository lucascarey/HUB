import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_BOOT } from "@/lib/theme";

// Fonts load from Google at runtime (not at build time, where a failed download breaks the whole deploy).
const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500&family=Syne:wght@600;700&display=swap";

export const metadata: Metadata = {
  title: "HUB",
  description: "Tu cabeza en un solo lugar: proyectos, tareas, ideas, plata y hábitos conectados.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "HUB", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#06070a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-AR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>{children}</body>
    </html>
  );
}
