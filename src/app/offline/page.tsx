import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Offline",
  description: "Nge-Plays is offline right now.",
  robots: { index: false, follow: false },
};

/**
 * Precached by the service worker and shown when a navigation fails while offline.
 */
export default function OfflinePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-[#0D0F14] text-[#F4F5F7]">
      <svg className="w-12 h-12" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M7 6.8C7 4.45 9.62 3.05 11.58 4.35L25.4 13.55C27.15 14.71 27.15 17.29 25.4 18.45L11.58 27.65C9.62 28.95 7 27.55 7 25.2V6.8Z"
          fill="#FFD014"
        />
      </svg>
      <h1 className="text-lg font-extrabold tracking-tight">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-[#9CA3AF]">
        Nge-Plays needs a connection to fetch music. Your queue and history are saved on this
        device and will be here when you reconnect.
      </p>
      <Link
        href="/"
        className="mt-2 h-10 px-5 rounded-full bg-[#FFD014] text-[#18181B] text-xs font-bold flex items-center transition active:scale-95"
      >
        Try again
      </Link>
    </main>
  );
}
