import { useSyncExternalStore } from "react";
import { calls, type CallState } from "./lib/calls.js";
import { messenger, type MessengerState } from "./lib/messaging.js";

export function useMessenger(): MessengerState {
  return useSyncExternalStore(
    messenger.subscribe,
    messenger.getSnapshot,
    messenger.getSnapshot,
  );
}

export function useCalls(): CallState {
  return useSyncExternalStore(calls.subscribe, calls.getSnapshot, calls.getSnapshot);
}
