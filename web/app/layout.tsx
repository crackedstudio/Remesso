import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AppHeader } from "@/components/AppHeader";

export const metadata: Metadata = {
  title: "Remesso",
  description: "Recurring stablecoin remittances on Celo, settling in cNGN.",
};

/// MiniPay is a mobile in-wallet browser, so the mobile viewport is the primary
/// target rather than a narrowed-down desktop one.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#11151c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 pb-24">
            <AppHeader />
            <main className="flex-1">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
