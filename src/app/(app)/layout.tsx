import { AppShell } from "@/app/(app)/_components/app-shell";
import { PlayerProvider } from "@/app/(app)/_components/player-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlayerProvider>
      <AppShell>{children}</AppShell>
    </PlayerProvider>
  );
}