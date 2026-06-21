/**
 * WebRTC call manager. Media (audio/video) flows peer-to-peer as DTLS-SRTP over
 * a UDP channel, traversing NAT with the STUN/TURN servers from /turn (coturn).
 * Signaling (offer/answer/ICE) is sent as E2E-encrypted control messages over
 * the normal Olm pipe, so the server can neither read nor MITM the call.
 */
import type { MessageContent } from "@fastmessage/shared";
import { api } from "./api.js";
import { messenger } from "./messaging.js";

export type CallStatus = "idle" | "calling" | "ringing" | "connected" | "ended";

export interface CallState {
  status: CallStatus;
  peerUserId?: string;
  peerName?: string;
  video: boolean;
  muted: boolean;
  error?: string;
}

type Listener = () => void;

class CallManager {
  private state: CallState = { status: "idle", video: false, muted: false };
  private listeners = new Set<Listener>();

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private callId = "";
  private peerUserId = "";
  private pendingIce: RTCIceCandidateInit[] = [];
  private incomingOffer: { sdp: string; video: boolean } | null = null;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): CallState => this.state;
  private set(p: Partial<CallState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  /** Register with the messenger so incoming call signals reach us. */
  init() {
    messenger.setCallSignalHandler((from, content) => void this.onSignal(from, content));
  }

  getLocalStream() {
    return this.localStream;
  }
  getRemoteStream() {
    return this.remoteStream;
  }

  private async newPeerConnection(): Promise<RTCPeerConnection> {
    const { iceServers } = await api.turn(messenger.token());
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void messenger.sendControl(this.peerUserId, {
          kind: "call-ice",
          callId: this.callId,
          candidate: JSON.stringify(e.candidate.toJSON()),
        });
      }
    };
    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0] ?? null;
      this.set({});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.set({ status: "connected" });
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        this.endLocal();
      }
    };
    this.pc = pc;
    return pc;
  }

  async startCall(peerUserId: string, video: boolean) {
    if (this.state.status !== "idle") return;
    this.peerUserId = peerUserId;
    this.callId = crypto.randomUUID();
    this.set({
      status: "calling",
      peerUserId,
      peerName: messenger.peerName(peerUserId),
      video,
      muted: false,
      error: undefined,
    });
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video,
      });
      const pc = await this.newPeerConnection();
      for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await messenger.sendControl(peerUserId, {
        kind: "call-offer",
        callId: this.callId,
        sdp: offer.sdp ?? "",
        video,
        sentAt: Date.now(),
      });
    } catch {
      this.set({ status: "idle", error: "Could not access mic/camera" });
      this.cleanup();
    }
  }

  async accept() {
    if (!this.incomingOffer) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: this.incomingOffer.video,
      });
      const pc = await this.newPeerConnection();
      for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
      await pc.setRemoteDescription({ type: "offer", sdp: this.incomingOffer.sdp });
      await this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await messenger.sendControl(this.peerUserId, {
        kind: "call-answer",
        callId: this.callId,
        sdp: answer.sdp ?? "",
      });
      this.set({ status: "connected" });
    } catch {
      this.set({ status: "idle", error: "Could not accept call" });
      this.cleanup();
    }
  }

  reject() {
    void messenger.sendControl(this.peerUserId, {
      kind: "call-hangup",
      callId: this.callId,
      reason: "rejected",
    });
    this.endLocal();
  }

  hangup() {
    void messenger.sendControl(this.peerUserId, {
      kind: "call-hangup",
      callId: this.callId,
    });
    this.endLocal();
  }

  toggleMute(): boolean {
    const tracks = this.localStream?.getAudioTracks() ?? [];
    const enabled = !(tracks[0]?.enabled ?? true);
    for (const t of tracks) t.enabled = enabled;
    this.set({ muted: !enabled });
    return !enabled;
  }

  private async onSignal(from: string, content: MessageContent) {
    if (content.kind === "call-offer") {
      if (this.state.status !== "idle") {
        void messenger.sendControl(from, {
          kind: "call-hangup",
          callId: content.callId,
          reason: "busy",
        });
        return;
      }
      this.peerUserId = from;
      this.callId = content.callId;
      this.incomingOffer = { sdp: content.sdp, video: content.video };
      this.set({
        status: "ringing",
        peerUserId: from,
        peerName: messenger.peerName(from),
        video: content.video,
        muted: false,
      });
    } else if (content.kind === "call-answer") {
      if (this.pc) {
        await this.pc.setRemoteDescription({ type: "answer", sdp: content.sdp });
        await this.flushIce();
      }
    } else if (content.kind === "call-ice") {
      const candidate = JSON.parse(content.candidate) as RTCIceCandidateInit;
      if (this.pc?.remoteDescription) {
        await this.pc.addIceCandidate(candidate).catch(() => undefined);
      } else {
        this.pendingIce.push(candidate);
      }
    } else if (content.kind === "call-hangup") {
      this.endLocal();
    }
  }

  private async flushIce() {
    if (!this.pc) return;
    for (const c of this.pendingIce) {
      await this.pc.addIceCandidate(c).catch(() => undefined);
    }
    this.pendingIce = [];
  }

  private endLocal() {
    this.set({ status: "ended" });
    this.cleanup();
    setTimeout(() => {
      if (this.state.status === "ended") {
        this.set({ status: "idle", peerUserId: undefined, peerName: undefined });
      }
    }, 1200);
  }

  private cleanup() {
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.incomingOffer = null;
    this.pendingIce = [];
  }
}

export const calls = new CallManager();
