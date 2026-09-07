"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectBar } from "./ConnectBar";

const TABS = [
  { href: "/", label: "Schedules" },
  { href: "/schedules/new", label: "New" },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 -mx-4 mb-6 border-b border-black/10 bg-paper/90 px-4 py-3 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Remesso
        </Link>
        <ConnectBar />
      </div>
      <nav className="mt-3 flex gap-1">
        {TABS.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                active ? "bg-ink text-white" : "text-black/60 hover:bg-black/5"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
