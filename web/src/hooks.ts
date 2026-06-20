import { useSyncExternalStore } from "react";
import { messenger, type MessengerState } from "./lib/messaging.js";

export function useMessenger(): MessengerState {
  return useSyncExternalStore(
    messenger.subscribe,
    messenger.getSnapshot,
    messenger.getSnapshot,
  );
}
