import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import type { ParsedChoices } from "../fleet/choices.js";
import { parseChoices } from "../fleet/choices.js";
import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import { describeGitState } from "../fleet/git-state.js";
import { chatTitle, distinctTitles, sessionLabel } from "../fleet/radar.js";
import type { ReplyMode, ReplyOptions, ReplyOutcome } from "../fleet/session-reply.js";
import type { ClaudeLimits } from "../fleet/claude-limits.js";
import type { Activity } from "../fleet/activity.js";
import type { CodexUsage } from "../fleet/codex-usage.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { generateChannel, open, pairingCode, seal, verifyDeviceSignature } from "./remote-crypto.js";

/**
 * Squeak's side of the remote channel (docs/remote-channel.md): publish an
 * encrypted snapshot for paired phones, take pairing requests, and run the
 * commands those phones send — after checking every one of them.
 *
 * The one rule everything here serves: **the Mac trusts a key, not a
 * server.** Firestore can drop, delay or invent documents; none of that can
 * make this code send a reply that a paired phone did not sign, for a turn
 * that is still current, within the last few minutes, exactly once.
 */

/** What is kept on the Mac, never in the cloud. Mode 0600. */
export interface RemoteConfig {
  projectId: string;
  channelId: string;
  key: string;
  devices: PairedDevice[];
}

export interface PairedDevice {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: string;
  revokedAt?: string | null;
}

export interface PendingPairing {
  id: string;
  name: string;
  publicKey: string;
  code: string;
  requestedAt: string;
}

/** What a phone sends. Signed as the exact box string it arrives in. */
export interface RemoteCommand {
  v: 1;
  sessionId: string;
  /** The turn the phone was looking at; refused if the chat has moved on. */
  answersTurn: string | null;
  text: string;
  /**
   * Optional, signed with the rest. Absent means queue. Steer is still a plain
   * reply: it only changes where Conductor puts it when the agent is mid-turn.
   */
  mode?: ReplyMode;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface RemoteActivity {
  at: string;
  device: string;
  outcome: "sent" | "refused" | "rejected";
  detail: string;
}

export interface ChannelStore {
  get(path: string): Promise<ChannelDoc | null>;
  set(path: string, doc: ChannelDoc): Promise<void>;
  list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  delete(path: string): Promise<void>;
  /**
   * Present when the store can stream changes (the Realtime Database). The
   * bridge then runs a pass as soon as a phone writes, and polls only as a
   * fallback. A change only wakes the pass; every check still runs on what
   * the pass reads.
   */
  watch?(
    path: string,
    onChange: () => void,
    options?: { onOpen?: () => void; onError?: (error: Error) => void },
  ): () => void;
}

export interface RemoteReplier {
  lastTurnText(sessionId: string): string | null;
  lastTurnId(sessionId: string): string | null;
  send(
    sessionId: string,
    text: string,
    onFailed: (message: string) => void,
    options?: ReplyOptions,
  ): Promise<ReplyOutcome>;
}

export interface RemoteBridgeDependencies {
  configPath: string;
  projectId: string;
  /** Built per config, since a reset changes nothing but the channel path. */
  store: ChannelStore;
  replier: RemoteReplier;
  snapshot: () => FleetSnapshot;
  /**
   * A working session's current turn (fleet/activity.ts). Without it the
   * phone shows only the last message, as before.
   */
  activity?: ((session: FleetSession) => Activity | null) | null;
  /** Claude's last plan-limit reading, for the read-only usage view on the phone. */
  claudeLimits?: (() => ClaudeLimits | null) | null;
  /**
   * Subscribe to fresh snapshots. When one differs in what the phone shows
   * (state, title, detail — not just a newer timestamp) the bridge publishes
   * at once instead of waiting for its next pass. Optional; without it the
   * cadence alone applies.
   */
  onSnapshot?: ((listener: (snapshot: FleetSnapshot) => void) => () => void) | null;
  /**
   * The Realtime Database URL when `store` is one. It goes into the pairing
   * code, and is announced, sealed with the channel key, in Firestore's
   * `state/transport` through `announce`, so a phone paired before the move
   * follows without pairing again.
   */
  databaseUrl?: string | null;
  announce?: ChannelStore | null;
  now?: () => number;
  macName?: string;
}

/** A command older than this is refused even if nothing else is wrong. */
export const MAX_COMMAND_LIFETIME_MS = 10 * 60_000;
/** How long a phone counts as "open" after its last presence ping. */
const PRESENCE_WINDOW_MS = 60_000;
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;
const ACTIVE_PUBLISH_MS = 3_000;
const IDLE_PUBLISH_MS = 60_000;
/** A change publishes after this long, so a burst of snapshots becomes one write. */
const CHANGE_PUBLISH_DELAY_MS = 300;
/** Even change-driven publishes keep this gap, to bound Firestore writes. */
const CHANGE_PUBLISH_MIN_GAP_MS = 1_000;
/** With a streaming store a pass runs on every change; this is only the safety net. */
const STREAM_FALLBACK_MS = 60_000;
/** A burst of changes (a command, then its deletion) becomes one pass. */
const WATCH_DEBOUNCE_MS = 50;
/** Pairing is only listened for while the Mac app's pairing sheet is open. */
const PAIRING_WINDOW_MS = 10 * 60_000;
const MESSAGE_MAX_CHARS = 8_000;
/**
 * The phone gets less of a turn than the Mac window does: what leaves the Mac
 * is only what the phone must render (docs/remote-channel.md), so the newest
 * few steps, each clipped, and only while the session works.
 */
const PHONE_ACTIVITY_STEPS = 6;
const PHONE_ACTIVITY_STEP_CHARS = 200;
const ACTIVITY_LIMIT = 50;

export class RemoteBridge {
  private readonly deps: RemoteBridgeDependencies;
  private readonly now: () => number;
  private config: RemoteConfig | null;
  private readonly pending = new Map<string, PendingPairing>();
  private readonly seenNonces = new Map<string, number>();
  private readonly activity: RemoteActivity[] = [];
  private readonly messageCache = new Map<string, { text: string | null; choices: ParsedChoices | null }>();
  private readonly activityCache = new Map<string, PhoneActivity | null>();
  private pairingOpenUntil = 0;
  private phoneSeenAt = 0;
  private lastPublishedAt = 0;
  private lastPublished = "";
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private publishing = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private watching: { channelId: string; stops: Array<() => void> } | null = null;
  /** A change arrived during a pass; run another as soon as it ends. */
  private dirty = false;
  private announcedFor = "";
  private lastSignature: string | null = null;
  private changeTimer: NodeJS.Timeout | null = null;

  constructor(deps: RemoteBridgeDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.config = readConfig(deps.configPath);
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
    this.ensureWatches();
    this.unsubscribe?.();
    this.unsubscribe =
      this.deps.onSnapshot?.((snapshot) => {
        const signature = snapshotSignature(snapshot);
        const changed = this.lastSignature !== null && signature !== this.lastSignature;
        this.lastSignature = signature;
        if (changed) {
          this.nudgePublish(CHANGE_PUBLISH_DELAY_MS);
        }
      }) ?? null;
  }

  /** Publish soon because what the phone shows just changed. */
  private nudgePublish(delayMs: number): void {
    if (this.stopped || this.changeTimer || !this.config?.devices.some((device) => !device.revokedAt)) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.publishForChange();
    }, delayMs);
    this.changeTimer.unref?.();
  }

  private async publishForChange(): Promise<void> {
    const config = this.config;
    if (this.stopped || !config || !config.devices.some((device) => !device.revokedAt)) {
      return;
    }
    const wait = this.lastPublishedAt + CHANGE_PUBLISH_MIN_GAP_MS - this.now();
    if (wait > 0 || this.publishing) {
      this.nudgePublish(Math.max(wait, CHANGE_PUBLISH_DELAY_MS));
      return;
    }
    try {
      await this.publish(config, true);
    } catch (error) {
      logger.warn("remote change publish failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopWatches();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether any phone could act on a link to one of its sessions right now. */
  hasPairedPhone(): boolean {
    return Boolean(this.config?.devices.some((device) => !device.revokedAt));
  }

  /* ---------- what the Mac app shows and does ---------- */

  status(): unknown {
    const config = this.config;
    return {
      configured: Boolean(config),
      projectId: this.deps.projectId,
      phoneOpen: this.phoneOpen(),
      pairingOpen: this.pairingOpenUntil > this.now(),
      devices: (config?.devices ?? []).map(({ id, name, pairedAt, revokedAt }) => ({ id, name, pairedAt, revokedAt })),
      pending: [...this.pending.values()].map(({ id, name, code, requestedAt }) => ({ id, name, code, requestedAt })),
      activity: this.activity.slice(-20).reverse(),
    };
  }

  /**
   * Open the pairing window and return the QR payload. Makes the channel on
   * first use. The payload is the one secret that lets a phone read.
   */
  startPairing(): { url: string } {
    const config = this.config ?? this.createChannel();
    this.pairingOpenUntil = this.now() + PAIRING_WINDOW_MS;
    this.schedule(0);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        p: config.projectId,
        c: config.channelId,
        k: config.key,
        n: this.macName(),
        ...(this.deps.databaseUrl ? { r: this.deps.databaseUrl } : {}),
      }),
    ).toString("base64url");
    return { url: `squeak://pair?d=${payload}` };
  }

  async approve(deviceId: string): Promise<boolean> {
    const request = this.pending.get(deviceId);
    const config = this.config;
    if (!request || !config) {
      return false;
    }
    config.devices = config.devices.filter((device) => device.id !== deviceId);
    config.devices.push({
      id: request.id,
      name: request.name,
      publicKey: request.publicKey,
      pairedAt: new Date(this.now()).toISOString(),
    });
    this.save();
    this.pending.delete(deviceId);
    await this.answerPairing(deviceId, true);
    this.log(request.name, "sent", "paired");
    return true;
  }

  async reject(deviceId: string): Promise<boolean> {
    if (!this.pending.delete(deviceId)) {
      return false;
    }
    await this.answerPairing(deviceId, false);
    return true;
  }

  revoke(deviceId: string): boolean {
    const device = this.config?.devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      return false;
    }
    device.revokedAt = new Date(this.now()).toISOString();
    this.save();
    this.log(device.name, "rejected", "revoked on this Mac");
    return true;
  }

  /**
   * Forget every phone and start a new channel. The old QR code, and any
   * copy of the old key, can no longer read anything new.
   */
  reset(): void {
    this.config = null;
    this.pending.clear();
    this.stopWatches();
    this.announcedFor = "";
    try {
      fs.rmSync(this.deps.configPath, { force: true });
    } catch {
      // Nothing to remove.
    }
  }

  /* ---------- the loop ---------- */

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /** One pass: presence, pairing, commands, snapshot. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    this.dirty = false;
    try {
      const config = this.config;
      this.ensureWatches();
      if (config) {
        await this.announceTransport(config);
        await this.readPresence(config);
        if (this.pairingOpenUntil > this.now()) {
          await this.readPairing(config);
        }
        if (config.devices.some((device) => !device.revokedAt)) {
          await this.readCommands(config);
          await this.publish(config);
        }
      }
    } catch (error) {
      logger.warn("remote channel pass failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
      if (this.dirty) {
        this.dirty = false;
        this.schedule(0);
      } else if (this.watching) {
        this.schedule(STREAM_FALLBACK_MS);
      } else {
        this.schedule(this.phoneOpen() || this.pairingOpenUntil > this.now() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      }
    }
  }

  /* ---------- streaming (Realtime Database) ---------- */

  /** Watch what phones write: presence, pairing requests and commands. One stream each. */
  private ensureWatches(): void {
    const watch = this.deps.store.watch?.bind(this.deps.store);
    const config = this.config;
    if (!watch || this.stopped || !config) {
      if (!config) this.stopWatches();
      return;
    }
    if (this.watching?.channelId === config.channelId) {
      return;
    }
    this.stopWatches();
    const onError = (error: Error) => logger.debug("remote watch dropped; reconnecting", { error: error.message });
    this.watching = {
      channelId: config.channelId,
      stops: [
        this.channel(config, "state", "presence"),
        this.channel(config, "pairing"),
        this.channel(config, "commands"),
      ].map((path) => watch(path, () => this.wake(), { onError })),
    };
  }

  private stopWatches(): void {
    for (const stop of this.watching?.stops ?? []) {
      stop();
    }
    this.watching = null;
  }

  /** A phone wrote something: run a pass now (or right after the one running). */
  private wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.schedule(WATCH_DEBOUNCE_MS);
  }

  /** Tell phones paired before the move where the channel lives now. Once per channel per run. */
  private async announceTransport(config: RemoteConfig): Promise<void> {
    const url = this.deps.databaseUrl;
    const store = this.deps.announce;
    if (!url || !store || this.announcedFor === config.channelId) {
      return;
    }
    try {
      await store.set(this.channel(config, "state", "transport"), {
        box: seal(config.key, { r: url }),
        at: this.now(),
      });
      this.announcedFor = config.channelId;
    } catch (error) {
      // Best effort, retried next pass; it must never hold up a command.
      logger.warn("remote transport announcement failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private phoneOpen(): boolean {
    return this.now() - this.phoneSeenAt < PRESENCE_WINDOW_MS;
  }

  private channel(config: RemoteConfig, kind: string, id?: string): string {
    return id ? `channels/${config.channelId}/${kind}/${id}` : `channels/${config.channelId}/${kind}`;
  }

  private async readPresence(config: RemoteConfig): Promise<void> {
    const doc = await this.deps.store.get(this.channel(config, "state", "presence"));
    if (!doc) {
      return;
    }
    try {
      const presence = open<{ at: number }>(config.key, doc.box);
      // A phone's clock is not ours; only trust it not to be in the future.
      this.phoneSeenAt = Math.max(this.phoneSeenAt, Math.min(presence.at, this.now()));
    } catch {
      // Not ours — ignore it.
    }
  }

  private async readPairing(config: RemoteConfig): Promise<void> {
    for (const { id, doc } of await this.deps.store.list(this.channel(config, "pairing"))) {
      if (this.pending.has(id) || config.devices.some((device) => device.id === id && !device.revokedAt)) {
        continue;
      }
      try {
        const request = open<{ name: string; publicKey: string }>(config.key, doc.box);
        if (typeof request.publicKey !== "string" || typeof request.name !== "string") {
          continue;
        }
        this.pending.set(id, {
          id,
          name: request.name.slice(0, 60),
          publicKey: request.publicKey,
          code: pairingCode(request.publicKey),
          requestedAt: new Date(this.now()).toISOString(),
        });
      } catch {
        // Undecryptable: not from a phone that scanned this Mac's code.
      }
    }
  }

  private async answerPairing(deviceId: string, approved: boolean): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }
    await this.deps.store.set(this.channel(config, "results", `pair-${deviceId}`), {
      box: seal(config.key, { approved, mac: this.macName() }),
      at: this.now(),
    });
    await this.deps.store.delete(this.channel(config, "pairing", deviceId)).catch(() => undefined);
  }

  private async readCommands(config: RemoteConfig): Promise<void> {
    for (const { id, doc } of await this.deps.store.list(this.channel(config, "commands"))) {
      const verdict = await this.handleCommand(config, id, doc);
      // Deleted whatever the verdict, so nothing is ever looked at twice.
      await this.deps.store.delete(this.channel(config, "commands", id)).catch(() => undefined);
      if (verdict.write) {
        await this.deps.store
          .set(this.channel(config, "results", id), { box: seal(config.key, verdict.result), at: this.now() })
          .catch(() => undefined);
      }
    }
  }

  /** Every check from docs/remote-channel.md, in order; the first failure wins. */
  async handleCommand(
    config: RemoteConfig,
    id: string,
    doc: ChannelDoc,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const device = config.devices.find((candidate) => candidate.id === doc.device);
    // 1. A paired, unrevoked device signed exactly this box.
    if (!device || device.revokedAt || !doc.sig || !verifyDeviceSignature(device.publicKey, doc.box, doc.sig)) {
      this.log(device?.name ?? "unknown device", "rejected", "signature did not verify");
      // No result: an unsigned writer learns nothing, not even that it failed.
      return { write: false, result: {} };
    }

    let command: RemoteCommand;
    try {
      command = open<RemoteCommand>(config.key, doc.box);
    } catch {
      this.log(device.name, "rejected", "could not be decrypted");
      return { write: false, result: {} };
    }

    const refuse = (reason: string) => {
      this.log(device.name, "rejected", reason);
      return { write: true, result: { id, status: "refused", reason } };
    };

    // 2. Fresh, and never seen before.
    const now = this.now();
    this.forgetOldNonces(now);
    if (
      typeof command.expiresAt !== "number" ||
      command.expiresAt < now ||
      command.expiresAt > now + MAX_COMMAND_LIFETIME_MS
    ) {
      return refuse("That reply expired before this Mac saw it. Send it again.");
    }
    if (typeof command.nonce !== "string" || command.nonce.length < 16 || this.seenNonces.has(command.nonce)) {
      return refuse("That reply was already received.");
    }
    this.seenNonces.set(command.nonce, command.expiresAt);

    // 3. The only action there is: a reply to an existing chat.
    if (command.v !== 1 || typeof command.sessionId !== "string" || typeof command.text !== "string") {
      return refuse("Not a reply this Mac understands.");
    }
    if (command.mode !== undefined && command.mode !== "queue" && command.mode !== "steer") {
      return refuse("Not a reply this Mac understands.");
    }
    const text = command.text.trim();
    if (!text || text.length > 20_000) {
      return refuse("There is nothing to send.");
    }

    // 4. Still answering the question the phone was looking at.
    const currentTurn = this.deps.replier.lastTurnId(command.sessionId);
    if (command.answersTurn !== currentTurn) {
      return refuse("That chat has moved on since your phone last looked. Check it and reply again.");
    }

    // 5. The same busy rules as Telegram and the Mac window.
    const outcome = await this.deps.replier.send(
      command.sessionId,
      text,
      (message) => {
        this.log(device.name, "refused", `the reply failed: ${message}`);
      },
      { mode: command.mode ?? "queue" },
    );
    if (outcome.status === "refused") {
      this.log(device.name, "refused", outcome.reason);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.log(device.name, "sent", `${text.length <= 3 ? text : "a reply"} to ${command.sessionId.slice(0, 8)}`);
    return {
      write: true,
      result: {
        id,
        status: "sent",
        via: outcome.via,
        ...(outcome.via === "background" ? { fallbackReason: outcome.fallbackReason } : {}),
        ...(outcome.delivery ? { delivery: outcome.delivery } : {}),
        ...(outcome.note ? { note: outcome.note } : {}),
      },
    };
  }

  private forgetOldNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt < now) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /** The phone's whole view, encrypted. Written only when it changed. */
  private async publish(config: RemoteConfig, force = false): Promise<void> {
    const interval = this.phoneOpen() ? ACTIVE_PUBLISH_MS : IDLE_PUBLISH_MS;
    if (this.publishing || (!force && this.now() - this.lastPublishedAt < interval)) {
      return;
    }
    this.publishing = true;
    try {
      await this.publishView(config);
    } finally {
      this.publishing = false;
    }
  }

  private async publishView(config: RemoteConfig): Promise<void> {
    const view = this.phoneView();
    // Readings' ages are drawn on the phone from observedAt, so an unchanged
    // reading must not republish the snapshot just because it was re-read.
    const serialized =
      JSON.stringify(view.sessions) +
      JSON.stringify(view.duck) +
      JSON.stringify(view.usage, (key, value: unknown) => (key === "observedAt" ? undefined : value));
    if (serialized === this.lastPublished) {
      return;
    }
    await this.deps.store.set(this.channel(config, "state", "snapshot"), {
      box: seal(config.key, view),
      at: this.now(),
    });
    this.lastPublished = serialized;
    this.lastPublishedAt = this.now();
  }

  phoneView() {
    const snapshot = this.deps.snapshot();
    const titles = distinctTitles(snapshot.active);
    const blocked = snapshot.active.filter((session) => session.state.startsWith("awaiting")).length;
    const working = snapshot.active.filter((session) => session.state === "working").length;
    return {
      v: 1,
      mac: this.macName(),
      generatedAt: new Date(this.now()).toISOString(),
      duck: { blockedCount: blocked, workingCount: working },
      // Read-only. Refreshing Claude's reading is a Mac action; commands are plain replies only.
      usage: phoneUsage(snapshot.codexUsage, this.deps.claudeLimits?.() ?? null),
      sessions: snapshot.active.map((session) => {
        const conductorSessionId = session.conductorSessionId;
        const title = titles.get(session.key);
        const message = conductorSessionId ? this.message(conductorSessionId, session.lastActivityAt) : null;
        const git = session.git ? describeGitState(session.git, { countCommits: false }) : null;
        return {
          key: session.key,
          conductorSessionId,
          label: title ? `${sessionLabel(session)} (${title})` : sessionLabel(session),
          // The phone's row headline (DESIGN.md §8.2); older phones ignore it.
          title: chatTitle(session),
          agent: session.agent,
          state: session.state,
          lastActivityAt: session.lastActivityAt,
          detail: session.detail,
          git: git && git !== "clean" ? git : null,
          contextPercent: session.contextPercent,
          turnId: conductorSessionId ? this.deps.replier.lastTurnId(conductorSessionId) : null,
          message: message?.text ?? null,
          choices: message?.choices ?? null,
          activity: session.state === "working" ? this.activityFor(session) : null,
        };
      }),
    };
  }

  /** Read once per step: the key moves with the session's activity. */
  private activityFor(session: FleetSession): PhoneActivity | null {
    const read = this.deps.activity;
    if (!read) {
      return null;
    }
    const key = `${session.key}|${session.lastActivityAt}`;
    if (this.activityCache.has(key)) {
      return this.activityCache.get(key) ?? null;
    }
    let value: PhoneActivity | null = null;
    try {
      const activity = read(session);
      if (activity && activity.steps.length > 0) {
        value = {
          total: activity.total,
          steps: activity.steps.slice(-PHONE_ACTIVITY_STEPS).map((step) => ({
            kind: step.kind,
            text:
              step.text.length > PHONE_ACTIVITY_STEP_CHARS
                ? `${step.text.slice(0, PHONE_ACTIVITY_STEP_CHARS - 1).trimEnd()}…`
                : step.text,
          })),
        };
      }
    } catch (error) {
      logger.debug("could not read activity for the phone", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.activityCache.size > 200) {
      this.activityCache.clear();
    }
    this.activityCache.set(key, value);
    return value;
  }

  private message(sessionId: string, activity: string): { text: string | null; choices: ParsedChoices | null } {
    const key = `${sessionId}|${activity}`;
    const cached = this.messageCache.get(key);
    if (cached) {
      return cached;
    }
    const full = this.deps.replier.lastTurnText(sessionId);
    const text = full && full.length > MESSAGE_MAX_CHARS ? `${full.slice(0, MESSAGE_MAX_CHARS)}…` : full;
    const value = { text, choices: parseChoices(full) };
    if (this.messageCache.size > 200) {
      this.messageCache.clear();
    }
    this.messageCache.set(key, value);
    return value;
  }

  /* ---------- bookkeeping ---------- */

  private createChannel(): RemoteConfig {
    const { channelId, key } = generateChannel();
    this.config = { projectId: this.deps.projectId, channelId, key, devices: [] };
    this.save();
    return this.config;
  }

  private save(): void {
    if (!this.config) {
      return;
    }
    fs.mkdirSync(path.dirname(this.deps.configPath), { recursive: true });
    const temp = `${this.deps.configPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.deps.configPath);
  }

  private log(device: string, outcome: RemoteActivity["outcome"], detail: string): void {
    this.activity.push({ at: new Date(this.now()).toISOString(), device, outcome, detail });
    if (this.activity.length > ACTIVITY_LIMIT) {
      this.activity.shift();
    }
    logger.info("remote command", { device, outcome, detail });
  }

  private macName(): string {
    return this.deps.macName ?? os.hostname().replace(/\.local$/, "");
  }
}

/** One plan window as the phone draws it: percent used (0-100) and when it resets. */
interface PhoneUsageWindow {
  usedPercent: number;
  resetsAt: string;
}

/** Both agents' readings in one shape, each with when it was observed. */
export interface PhoneUsage {
  claude: { fiveHour: PhoneUsageWindow | null; sevenDay: PhoneUsageWindow | null; observedAt: string } | null;
  codex: { fiveHour: PhoneUsageWindow | null; weekly: PhoneUsageWindow | null; observedAt: string } | null;
}

export function phoneUsage(codex: CodexUsage | null, claude: ClaudeLimits | null): PhoneUsage {
  const claudeWindow = (window: ClaudeLimits["fiveHour"]): PhoneUsageWindow | null =>
    window ? { usedPercent: Math.round(window.utilization * 1000) / 10, resetsAt: window.resetsAt } : null;
  const codexWindow = (window: CodexUsage["primary"]): PhoneUsageWindow | null =>
    window ? { usedPercent: Math.round(window.usedPercent * 10) / 10, resetsAt: window.resetsAt } : null;
  return {
    claude: claude
      ? {
          fiveHour: claudeWindow(claude.fiveHour),
          sevenDay: claudeWindow(claude.sevenDay),
          observedAt: claude.observedAt,
        }
      : null,
    codex: codex
      ? { fiveHour: codexWindow(codex.primary), weekly: codexWindow(codex.secondary), observedAt: codex.observedAt }
      : null,
  };
}

/** What the phone gets of a turn: no timestamps, fewer and shorter steps. */
interface PhoneActivity {
  total: number;
  steps: Array<{ kind: string; text: string }>;
}

function readConfig(configPath: string): RemoteConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as RemoteConfig;
    return parsed.channelId && parsed.key ? { ...parsed, devices: parsed.devices ?? [] } : null;
  } catch {
    return null;
  }
}

/**
 * What differs between two snapshots *as the phone would draw them*. Not
 * lastActivityAt: a working chat bumps that constantly, and the phone redraws
 * ages from its own clock.
 */
export function snapshotSignature(snapshot: FleetSnapshot): string {
  return JSON.stringify(
    snapshot.active.map((session) => [
      session.key,
      session.state,
      session.title,
      session.detail,
      session.conductorSessionId,
    ]),
  );
}
