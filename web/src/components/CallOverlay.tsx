import { useEffect, useRef } from "react";
import { useCalls } from "../hooks.js";
import { calls } from "../lib/calls.js";

export function CallOverlay() {
  const state = useCalls();
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  // Re-attach streams every render (cheap, and handles late-arriving tracks).
  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = calls.getLocalStream();
    if (remoteRef.current) remoteRef.current.srcObject = calls.getRemoteStream();
  });

  if (state.status === "idle") return null;

  return (
    <div className="call-overlay">
      <div className="call-card">
        <div className="call-status">
          {state.status === "ringing" && `Incoming ${state.video ? "video " : ""}call`}
          {state.status === "calling" && "Calling…"}
          {state.status === "connected" && "🔒 Connected (encrypted)"}
          {state.status === "ended" && "Call ended"}
        </div>
        <div className="call-peer">{state.peerName}</div>
        {state.error && <div className="error">{state.error}</div>}

        <div className={state.video ? "call-video" : "call-video audio-only"}>
          <video ref={remoteRef} autoPlay playsInline className="remote" />
          <video ref={localRef} autoPlay playsInline muted className="local" />
          {!state.video && <div className="call-avatar">🎙️</div>}
        </div>

        <div className="call-actions">
          {state.status === "ringing" ? (
            <>
              <button className="primary" type="button" onClick={() => void calls.accept()}>
                Accept
              </button>
              <button className="danger" type="button" onClick={() => calls.reject()}>
                Reject
              </button>
            </>
          ) : (
            <>
              {state.status === "connected" && (
                <button className="tab" type="button" onClick={() => calls.toggleMute()}>
                  {state.muted ? "Unmute" : "Mute"}
                </button>
              )}
              <button className="danger" type="button" onClick={() => calls.hangup()}>
                Hang up
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
