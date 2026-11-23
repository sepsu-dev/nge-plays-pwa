import { MainContent } from "@/app/(app)/_components/main-content";

/**
 * Deep link Listen Together (`/room?room=CODE`).
 *
 * The only route besides `/`. Content stays the same SPA — AppShell detects
 * the `/room` pathname and opens the room modal, so switching menus never
 * goes through Next navigation.
 */
export default function RoomPage() {
  return <MainContent />;
}
