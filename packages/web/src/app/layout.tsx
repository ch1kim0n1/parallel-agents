import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import { getProjectName } from "@/lib/project-name";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/app/providers";
import { schibstedGrotesk, jetbrainsMono } from "@/fonts/fonts";
import "./globals.css";
// Per-screen mission-control styles, loaded after globals.css so they win on
// equal specificity (see DESIGN.md). Split per screen to keep them focused.
import "./mc-sidebar.css";
import "./mc-board.css";
import "./mc-session.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return {
    title: {
      template: `%s | ${projectName}`,
      default: `AgentMesh | ${projectName}`,
    },
    description: "AgentMesh Dashboard for managing parallel AI coding agents",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: `AgentMesh | ${projectName}`,
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`light ${schibstedGrotesk.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="h-screen overflow-hidden bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <Sentry.ErrorBoundary
          fallback={
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <h1 className="mb-2 text-lg font-semibold">Something went wrong</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  The dashboard hit an unexpected error. Refresh the page or check
                  the server logs.
                </p>
              </div>
            </div>
          }
        >
          <Providers>{children}</Providers>
        </Sentry.ErrorBoundary>
        <ServiceWorkerRegistrar />
        <footer className="fixed bottom-0 left-0 z-10 px-4 py-1 text-xs text-[var(--color-text-secondary)] opacity-60 hover:opacity-100">
          <a href="/legal/terms" className="hover:underline">Terms</a>
          <span className="mx-1">·</span>
          <a href="/legal/privacy" className="hover:underline">Privacy</a>
        </footer>
      </body>
    </html>
  );
}
