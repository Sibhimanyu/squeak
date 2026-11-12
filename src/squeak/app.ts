import { execFile, spawn, type ChildProcess } from "node:child_process";
import { HttpAccountRelay } from "../cloud/account.js";
import fs from "node:fs";
import type { WorkspacePickerRow } from "../adapters/conductor-registry.js";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ChangeSet } from "../fleet/diff-view.js";
import type { FleetSession } from "../fleet/types.js";
import { applyProjectCorrection, ProjectInference, readKnownPonds } from "../fleet/project-inference.js";
import { workFolder } from "../fleet/session-folder.js";
import { fileURLToPath } from "node:url";
import { startupPhase } from "./startup.js";
import { appOwnsSignals, shutdownOnSignals } from "./early-listen.js";

import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { CliqChannel } from "../cliq/channel.js";
import { CliqWebhook } from "../cliq/client.js";
import { CliqRelayInbox } from "../cliq/inbox.js";
import { claudeCliRunner, claudeConversationOpener, FleetAssistant } from "../fleet/assistant.js";
import { ClaudeLimitsStore } from "../fleet/claude-limits.js";
import { ClaudeLimitsRefresher } from "../fleet/claude-limits-refresh.js";
import { ClaudeAccountSwitcher } from "../fleet/claude-accounts.js";
import { fetchClaudeUsage } from "../fleet/claude-usage-api.js";
import { Caffeinator } from "../fleet/caffeinate.js";
import { applyAwakeAction, type AwakeEnd, AwakeSession, readAwakeAction } from "../fleet/awake-session.js";
import { LidSleepGuard, SUDOERS_PATH, sudoersRule } from "../fleet/lid-sleep.js";
import { ensureBackstop } from "../fleet/awake-backstop.js";
import { awakeRules, readPower, type PowerReading } from "../fleet/power-monitor.js";
import { LidActions, readOpenSettings, readSettings as readLidActionSettings } from "../fleet/lid-actions.js";
import { readPendingAsk } from "../fleet/question.js";
import { readPhoneImage } from "../remote/phone-image.js";
import { preparePhoneMedia } from "../remote/phone-media.js";
import { ChatPresetsStore } from "../fleet/chat-presets.js";
import { SendDefaultStore, resolveSendMode } from "../fleet/send-default.js";
import {
  channelFilter,
  NOTIFY_CHANNELS,
  NotifySettingsStore,
  PushCounter,
  shouldPushInviteTo,
  wantsAllFinishes,
  type NotifyChannel,
} from "../fleet/notify-settings.js";
import { PondInviteNotifier } from "../fleet/pond-invites.js";
import { HOTSPOT_PHONE_RECENT_MS, HotspotFailover, macHotspotSystem, readHotspotRequest } from "../fleet/hotspot.js";
import {
  FANS_HELPER_PRIVILEGED,
  FANS_SUDOERS_PATH,
  fansSudoersRule,
  HEAT_CHECK_MS,
  HeatGovernor,
  macHeatSystem,
} from "../fleet/heat.js";
import { MacControls, macControlsSystem } from "../fleet/mac-controls.js";
import { macTabsSystem, WindowTabs } from "../fleet/window-tabs.js";
import { UsageStats } from "../fleet/usage-stats.js";
import { POWER_SUDOERS_PATH, PowerMode, isPowerChoice, powerSudoersRule, powerSystem } from "../fleet/power-mode.js";
import { AnswerService, answerControl } from "../fleet/answer.js";
import { HooksSetup } from "../fleet/hooks-setup.js";
import { answerRelayFrom } from "../fleet/answer-relay.js";
import { canTakeMessageNow, FleetController } from "../fleet/fleet-controller.js";
import { SqueakHandsSender } from "../fleet/conductor-ui.js";
import { HandsGrantsReader } from "../fleet/hands-grants.js";
import { closeChat } from "../fleet/close-chat.js";
import { readActivity } from "../fleet/activity.js";
import { BackgroundWorkReader } from "../fleet/background-work.js";
import { SubagentActivityReader } from "../fleet/subagent-activity.js";
import { resolveSetup } from "../fleet/chat-setup.js";
import { parseChoices } from "../fleet/choices.js";
import { cardLabel, renderUsage } from "../fleet/radar.js";
import { FleetReplyRouter, replyTargetFor } from "../fleet/reply-router.js";
import { ConductorReplier } from "../fleet/session-reply.js";
import {
  ConductorLink,
  CONDUCTOR_NOT_LINKED,
  parseLinkRequest,
  parseWorkspaceRequest,
  realProbe,
} from "../fleet/conductor-link.js";
import { findNewChatWorkspace, listNewChatWorkspaces, newChatControl } from "../fleet/new-chat.js";
import {
  archiveWorkspace,
  createPrPrompt,
  createWorkspace,
  listWorkspaceRepos,
  readWorkspace,
  workspaceControl,
} from "../fleet/workspace-actions.js";
import { listChatModels } from "../fleet/chat-models.js";
import { ProjectIcons, readRepositoryIcons, shrinkWithSips } from "../fleet/project-icons.js";
import type { IngressControl } from "../fleet/hook-ingress.js";
import {
  loadAddons,
  LinkedConductorRoute,
  NoConductorRoute,
  type ConductorRoute,
  type LoadedAddons,
} from "../addons.js";
import { realEffects, retireStaleRelay } from "../fleet/relay-retire.js";
import { SqueakHandsTerminal, TerminalReplier, lastAgentMessage } from "../fleet/terminal-reply.js";
import { FirestoreRest } from "../remote/firestore-rest.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { CloudControl } from "../cloud/control.js";
import { HostedCloud, hostedRelayUrl } from "../cloud/hosted.js";
import { activeLocation, createCloudStore, readCloudConfig } from "../cloud/config.js";
import { movePath, sealAddonMove } from "../cloud/move.js";
import { SwitchableStore } from "../cloud/switchable-store.js";
import { RemoteBridge } from "../remote/remote-bridge.js";
import { LocalAdvertiser, LocalChannelServer } from "../remote/local-channel.js";
import { MirrorStore } from "../remote/mirror-store.js";
import { BudgetedStore, CloudBudget } from "../remote/shared-limits.js";
import { FilmService } from "../workflows/rasanai/films.js";
import { RasanaiProvider } from "../workflows/rasanai/provider.js";
import { createFleetRuntime, type FleetRuntime } from "../fleet/runtime.js";
import { defaultHookInstallPaths, fleetHooksInstalled } from "../fleet/hook-install.js";
import { NativeReplier } from "../fleet/native-reply.js";
import { NativePhone } from "../fleet/native-phone.js";
import { NativeHostClient, tokenFromFile } from "../native/client.js";
import { DEFAULT_HOST_PORT } from "../native/server.js";
import { TelegramAvatar } from "../telegram/avatar.js";
import { BaresipLine } from "../voice/baresip-line.js";
import { REFUSED_SAYS, nothingRunning } from "../voice/mac-says.js";
import { VoiceFillers } from "../voice/fillers.js";
import { DirectLine } from "../voice/direct-line.js";
import { PinKeeper, type PinPolicy, type PinState } from "../voice/pin-keeper.js";
import { parsePinAction, type PinAction } from "../voice/relay-protocol.js";
import { OLD_ADDON, relayLineFor, type RelayLine } from "../voice/relay-line.js";
import {
  addonSupports,
  CALLBACK_ADDON,
  FOLLOW_UP_ADDON,
  HOLD_ADDON,
  ANSWER_STREAM_ADDON,
  VOICE_MENU_ADDON,
  READBACK_STREAM_ADDON,
  NEW_CHAT_ADDON,
  LATE_CLIPS_ADDON,
  VOICE_FIRST_ADDON,
} from "../voice/addon-update.js";
import { GatewayPairing } from "../voice/pairing-window.js";
import { GatewayClaim } from "../voice/gateway-claim.js";
import { RENDEZVOUS_DATABASE } from "../voice/claim-protocol.js";
import { CallHistory } from "../voice/call-history.js";
import { CallTrace } from "../voice/call-trace.js";
import { GatewayLogReader } from "../voice/gateway-log.js";
import { GatewayStatusReader, gatewayRouteView } from "../voice/gateway-status.js";
import { isNewer } from "../voice/addon-update.js";
import { claimPath, OrphanWatch, realOrphanWatchDeps } from "./orphan-watch.js";
import { AddonVersionCheck } from "../voice/addon-version-check.js";
import { setEnvValues } from "../cliq/setup.js";
import { ChannelsSetup } from "./channels-setup.js";
import { flags } from "./flags.js";
import { resolveSqueakEnvPath } from "./paths.js";
import { CallPolicy, DEFAULT_MIN_GAP_MIN_MS } from "../voice/policy.js";
import { MacSpeaker, type Speaker } from "../voice/tts.js";
import {
  availableVoices,
  naturalInstalled,
  naturalPaths,
  NaturalSettingsStore,
  NaturalSpeaker,
  NaturalVoice,
  fixedPhrases,
  PromptClipCache,
  ReadBackClips,
  renderCallClips,
  CLIPS_BUDGET_MS,
  OLD_ADDON_CLIPS_BUDGET_MS,
} from "../voice/natural-voice.js";
import type { VoiceLine } from "../voice/relay-line.js";
import { ensureReferenceClips, NaturalInstaller } from "../voice/natural-setup.js";
import { engineHasVoice, ENGINE_IDS, isEngineId, VOICE_ENGINES, type EngineId } from "../voice/voice-engines.js";
import { TEST_SCRIPT } from "../voice/test-script.js";
import { readIdleSeconds } from "../fleet/user-idle.js";
import { MemoInbox, type MemoTarget } from "../voice/memo-inbox.js";
import { readinessVoiceLabel, VoiceReadinessTracker } from "../voice/voice-readiness.js";
import {
  ChatConverser,
  ChatQuestioner,
  endedReadout,
  statusReadout,
  thinkingReadout,
  type ChatBriefInputs,
} from "../voice/chat-brief.js";
import { VoiceFavoritesStore, workspaceKeyOf } from "../voice/favorites.js";
import { cutAtWord, speakable, spokenChat, spokenChats, spokenWorkspace } from "../voice/spoken-labels.js";
import { applyPhoneVoiceChange, phoneCalls } from "../voice/phone-voice.js";
import { DEFAULT_PERSONA, isTerse, personaInstruction, VoiceSettingsStore } from "../voice/settings.js";
import { findWhisper, WhisperTranscriber } from "../voice/transcribe.js";
import { callNoteAllowed, callSentText, parseSentNote } from "../voice/call-summary.js";
import { CallbackRequests } from "../voice/callbacks.js";
import { VoiceChannel } from "../voice/voice-channel.js";
import { TelegramClient, isTransientTelegramError, summarizeTelegramError } from "../telegram/client.js";
import type { TelegramChat, TelegramConversationTarget, TelegramUpdate } from "../types.js";
import { logger } from "../utils/logger.js";
import { normalizeTelegramCommand } from "../utils/telegram-command.js";
import { openInSqueakLink } from "../fleet/open-link.js";
import { splitMarkdown } from "../utils/tg-format.js";
import type { SqueakConfig } from "./config.js";
import { channelsControl, TelegramStatus } from "./telegram-status.js";

const COMMANDS = [
  { command: "radar", description: "Show what every agent is doing right now" },
  // /mute still works — it is what the button and the older habit say — but one
  // of the two is enough in the menu.
  { command: "snooze", description: "Silence alerts for an hour" },
  { command: "unmute", description: "Resume alerts" },
  { command: "usage", description: "Codex quota and Claude's estimated cost" },
  { command: "hooks", description: "Check whether live signal is wired up" },
  { command: "help", description: "What Squeak does" },
];

function helpText(): string {
  return [
    "**Squeak** watches every coding agent on the Mac and squeaks when one of them",
    "wants something.",
    "",
    "It messages you when a session:",
    "· is blocked waiting for your approval",
    "· is blocked waiting for an answer",
    "· is a Conductor chat and has finished",
    "",
    "**Answering a finished Conductor chat**",
    "· tap a letter when it asked you to pick one",
    "· tap Reply, or swipe left on the card, and type",
    "It is typed into Conductor's own window, so it shows there live. If the",
    "Mac is locked or the chat is not open as a tab, it runs in the background",
    "instead and Conductor shows it on its next reload. Either way the answer",
    "comes back here as a new card.",
    "",
    "Everything else — errors, sessions running low on context — waits on the radar.",
    "",
    "/radar  what is running right now",
    "/snooze  silence for an hour · /unmute  resume",
    "/usage  Codex quota and Claude's estimated cost",
    "/hooks  check live-signal wiring",
  ].join("\n");
}

/**
 * Squeak: a notification-only daemon with its own bot.
 *
 * Deliberately separate from the bridge. The bridge is a conversation — you
 * navigate it and talk to agents through it. This is a pager, and mixing the
 * two in one chat means status pings bury the conversation and vice versa.
 */
/** The add-ons enabled for this run (src/addons.ts); none unless `SQUEAK_ADDONS` names one that is present. */
let addons: LoadedAddons | null = null;
/** Whether Conductor is linked (fleet/conductor-link.ts); loaded once, before the add-ons, since the relay depends on it. */
let loadedConductorLink: ConductorLink | null = null;

function conductorLinkFor(config: Pick<SqueakConfig, "conductorDbPath" | "supportDir" | "dbPath">): ConductorLink {
  loadedConductorLink ??= ConductorLink.load(
    path.join(config.supportDir, "conductor-link.json"),
    realProbe({ conductorDbPath: config.conductorDbPath, stateDbPath: config.dbPath }),
  );
  return loadedConductorLink;
}

/**
 * Call once before `new SqueakApp` (after the config has put `.env` into `process.env`). Loads the enabled add-ons;
 * unless the Conductor relay add-on really loaded, a Conductor still pointing at Squeak's old loopback relay is put
 * back (docs/conductor-local-feasibility.md 7.5). That reset belongs to core: it protects installs whose add-on is gone.
 */
export async function loadSqueakAddons(
  config: Pick<SqueakConfig, "conductorDbPath" | "supportDir" | "dbPath">,
): Promise<void> {
  const link = conductorLinkFor(config);
  addons = await loadAddons(
    { conductorDbPath: config.conductorDbPath, supportDir: config.supportDir },
    process.env,
    undefined,
    () => link.linked,
  );
  if (addons.names.includes("conductor-relay")) return;
  // Never linked: Conductor's database is not touched, not even to undo an old relay.
  if (!link.linked) return;
  const outcome = retireStaleRelay(
    realEffects({
      conductorDbPath: config.conductorDbPath,
      statePath: path.join(config.supportDir, "conductor-relay.json"),
    }),
  );
  if (outcome.action === "reset") {
    logger.warn("Conductor was pointed at Squeak's old local relay; put back. Restart Conductor once.", {
      keychainRemoved: outcome.keychainOk,
    });
    void notifyRelayRetired(outcome.keychainOk);
  } else if (outcome.action === "failed") {
    logger.warn("could not put Conductor back from Squeak's old local relay", { reason: outcome.reason });
  }
}

async function notifyRelayRetired(keychainOk: boolean): Promise<void> {
  const body = keychainOk
    ? "Quit Conductor (Cmd-Q) and reopen it once so it goes back to its own servers."
    : "Quit and reopen Conductor once. Squeak's entry in Keychain Access could not be removed; delete it there.";
  await new Promise<void>((resolve) =>
    execFile(
      "/usr/bin/osascript",
      ["-e", `display notification "${body}" with title "Squeak handed Conductor back"`],
      () => resolve(),
    ),
  );
}

export class SqueakApp {
  private readonly config: SqueakConfig;
  private readonly telegram: TelegramClient | null;
  /** Sets the bot's profile photo to Squeak's logo; the Mac app's route and the phone's `telegramAvatar` end in it. */
  private readonly telegramAvatar: TelegramAvatar;
  private readonly telegramStatus: TelegramStatus;
  /** Telegram and Cliq setup (channels-setup.ts); the phone's signed `telegram` and `cliq` commands end in it. */
  private readonly channelsSetup: ChannelsSetup;
  /** What Telegram and Cliq may push (notify-settings.json), edited from the Mac app and the phone. */
  private readonly notifySettings: NotifySettingsStore;
  private readonly projectInference: ProjectInference;
  /** What a message to a working chat does when it names no mode (send-default.json). */
  private readonly sendDefault: SendDefaultStore;
  /** New chat presets (chat-presets.json): one setting for the Mac app, the phone and the web. */
  private readonly chatPresets: ChatPresetsStore;
  /** Cards each channel pushed today, for the Mac app's "Fewer?" tip. */
  private readonly pushCounter = new PushCounter();
  private readonly runtime: FleetRuntime;
  /** RasanAI films waiting on a call, answered the way RasanAI Studio does (src/workflows/rasanai/). */
  private readonly rasanai = new RasanaiProvider();
  /** The same films as phone-listed projects, independent of chat sessions: liveness, chat, resume and stop. */
  private readonly films = new FilmService({
    provider: this.rasanai,
    extraDirs: () =>
      this.runtime?.monitor.snapshot.sessions.flatMap((session) => (session.cwd ? [session.cwd] : [])) ?? [],
  });
  private readonly controller: FleetController;
  private readonly replier: ConductorReplier;
  /** The loopback relay into Conductor's composer; inert until set up. */
  private readonly conductorRelay: ConductorRoute;
  /** Whether Conductor is linked, changed from Settings at run time (conductor-link.json). */
  private readonly conductorLink: ConductorLink;
  /** Squeak Hands, shared by sends and closes so they never drive Conductor's window at once. */
  private readonly hands: SqueakHandsSender | null;
  /** Conductor chats through `replier`, terminal agents typed into; what every Mac-side surface uses. */
  private readonly router: FleetReplyRouter;
  /** Talks to `squeak host`; calls fail with "not running" when it is down, which never breaks the daemon. */
  private readonly nativeHost: NativeHostClient;
  private readonly remote: RemoteBridge | null;
  private readonly sharedBudget: CloudBudget | null;
  /** The phone channel's store, behind a switch so a move to Catalyst (or back) needs no restart; null when none is set up. */
  private readonly cloud: SwitchableStore | null;
  private readonly cloudControl: CloudControl;
  /** Squeak's hosted cloud: signing in provisions this Mac's own key (cloud/hosted.ts). */
  private readonly hosted: HostedCloud;
  /** The direct same-Wi-Fi path to a paired phone (remote/local-channel.ts); null when off. */
  private readonly localChannel: LocalChannelServer | null;
  private readonly cliq: CliqChannel | null;
  private readonly pondInvites: PondInviteNotifier;
  /** Rings the owner through a SIP extension when an agent waits on them (src/voice/); null unless set up. */
  private voice: VoiceChannel | null = null;
  private voiceSpeaker: Speaker | null = null;
  private readonly naturalSettings: NaturalSettingsStore;
  private readonly naturalVoice: NaturalVoice;
  private readonly naturalInstaller: NaturalInstaller;
  private readonly promptClips: PromptClipCache;
  private readonly readBackClips: ReadBackClips;
  /** The line voice calls go out on (the gateway through the relay, or this Mac), also for a test call from an app. */
  private voiceLine: VoiceLine | null = null;
  /** The relay line when the gateway places the calls: also how a pin change reaches it. */
  private voiceRelayLine: RelayLine | null = null;
  /** Direct mode: the pin lives here, in the support directory (voice/pin-keeper.ts). */
  private voicePins: PinKeeper | null = null;
  /** Gateway mode: the last state the add-on told us, and when; "unknown" until the first answer. */
  private voicePinCache: { state: PinState | "unknown"; at: number } = { state: "unknown", at: 0 };
  private voicePinAsking = false;
  /** The add-on's last answer on when the pin is asked; null until it says (an older add-on never does). */
  private voicePolicyCache: PinPolicy | null = null;
  /** How the last test call from an app went; shown in the phone view and the Mac app. */
  private voiceTest: {
    at: number;
    status: "ringing" | "answered" | "unanswered" | "failed";
    letter?: string;
    reason?: string;
    /** How the line was on an answered test call (voice/line-quality.ts); absent from an older add-on. */
    quality?: { verdict: "good" | "fair" | "poor"; jitterMs?: number; lossPct?: number; rttMs?: number };
  } | null = null;
  /** Calling in: transcribes a phoned-in message and sends it (src/voice/memo-inbox.ts); null without the relay or Whisper. */
  private memoInbox: MemoInbox | null = null;
  /** Whether the current voice is ready for calls (`voiceView().natural.readiness`). */
  private readonly voiceReadiness = new VoiceReadinessTracker((_value, progressOnly) =>
    this.nudgeReadiness(progressOnly),
  );
  private readinessNudgedAt = 0;
  private readinessNudge: NodeJS.Timeout | null = null;
  private memoUnwatch: (() => void) | null = null;
  private memoTimer: NodeJS.Timeout | null = null;
  /** The extension to ring, edited from the Mac app (voice-settings.json). */
  private readonly voiceSettings: VoiceSettingsStore;
  private readonly voiceFavorites: VoiceFavoritesStore;
  private readonly voiceCallbacks: CallbackRequests;
  /** The Cliq webhook the channel posts through, for one-off notes (an awake session's end). */
  private cliqWebhook: CliqWebhook | null = null;
  /** Plain-language questions from Cliq, answered through the Mac's own `claude`. */
  private readonly assistant: FleetAssistant;
  /** Claude's plan limits, as the assistant's own `claude` runs last reported them. */
  private readonly claudeLimits: ClaudeLimitsStore;
  private readonly backgroundWork = new BackgroundWorkReader();
  /** Answers a spoken question about one chat: `claude` with no tools, a short leash (voice/chat-brief.ts). */
  private readonly chatQuestioner: ChatQuestioner;
  private readonly chatConverser: ChatConverser;
  /** The waiting lines of a call in, in the owner's character; a custom one is made once by the headless model. */
  private voiceFillers!: VoiceFillers;
  private readonly subagents = new SubagentActivityReader(this.backgroundWork);
  private readonly claudeRefresher: ClaudeLimitsRefresher;
  /** What Squeak Hands holds, for the Mac app's permission explainer (GET /control/hands/grants). */
  private readonly handsGrants = new HandsGrantsReader();
  /** Keeps the Mac awake while an agent works, and while plugged in (SQUEAK_CAFFEINATE). */
  private readonly caffeinator: Caffeinator;
  /** Joins the iPhone's hotspot when the Mac's internet drops while something needs it. */
  private readonly hotspot: HotspotFailover;
  /** Conductor's icon for each repository, for the phone to mark a project with. */
  private readonly projectIcons: ProjectIcons;
  private projectIconsTimer: NodeJS.Timeout | null = null;
  /** The user's awake session (menu bar, window, phone); held through the caffeinator. */
  private readonly awake: AwakeSession;
  /** What a closed lid does during a lid session: display off, mute, Low Power Mode, pause chat apps. */
  private readonly lidActions: LidActions;
  private lidRuleTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  /** Temperatures and fans while an awake session runs (fleet/heat.ts). */
  private readonly heat: HeatGovernor;
  private heatTimer: NodeJS.Timeout | null = null;
  /** Volume and brightness every 2 s while a phone is on the direct path, so a Mac-side change shows live. */
  private liveControlsTimer: NodeJS.Timeout | null = null;
  /** Detailed usage for the phone's Usage › Details (fleet/usage-stats.ts). */
  private readonly usageStats: UsageStats;
  /** Volume, brightness and fans from the phone's Mac controls page (fleet/mac-controls.ts). */
  private readonly controls: MacControls;
  /** Automatic, Low Power or High Power from the phone (fleet/power-mode.ts). */
  private readonly energy: PowerMode;
  /** The Mac's last battery/heat/lid reading, for the phone; refreshed once a minute. */
  private power: PowerReading | null = null;
  private unwatchCaffeinate: (() => void) | null = null;
  private lastUpdateId = 0;
  private stopped = false;
  /** The newest add-on version, looked up by the daemon itself (the add-on's own look is 6-hourly). */
  private readonly addonVersions = new AddonVersionCheck();
  /** Cleans up if Squeak.app is dragged to the Trash; armed only for an app-managed daemon (app-install.json). */
  private orphanWatch: OrphanWatch | null = null;

  constructor(config: SqueakConfig) {
    this.config = config;
    this.caffeinator = new Caffeinator();
    const lidGuard = new LidSleepGuard({
      journalPath: path.join(config.supportDir, "lid-journal.json"),
      // High Power picked on the phone: heat and safety rules go back to it, not to battery's switch.
      powerPick: () => this.energy.pick,
    });
    this.energy = new PowerMode({
      file: path.join(config.supportDir, "power-mode.json"),
      system: powerSystem(),
      override: lidGuard,
      onChange: () => this.remote?.changed(),
    });
    this.awake = new AwakeSession({
      path: path.join(config.supportDir, "keep-awake.json"),
      hold: (on) => this.caffeinator.setKeepAwake(on),
      lid: lidGuard,
      onChange: () => {
        this.remote?.changed();
        // A session starting or ending changes which mode's actions apply; no need to wait for the poll.
        void this.lidActions?.check();
      },
      onEnd: (end) => this.announceAwakeEnd(end),
      // Sleep left disabled (a failed restore, another tool's disable, a bit put back mid-session).
      onWarning: (text) => this.announce(text),
    });
    this.conductorLink = conductorLinkFor(config);
    this.projectIcons = new ProjectIcons(
      () => (this.conductorLink.linked ? readRepositoryIcons(config.conductorDbPath) : []),
      shrinkWithSips,
    );
    this.hotspot = new HotspotFailover({
      settingsPath: path.join(config.supportDir, "hotspot.json"),
      system: macHotspotSystem(config.handsAppPath),
      // An awake session, an agent at work, or a phone that looked at this Mac lately: the times a lost connection
      // costs something. A phone that was just here is the one that will want to reach it again.
      wanted: () =>
        this.awake.active ||
        this.runtime?.monitor.snapshot.active.some((s) => s.state === "working") === true ||
        this.remote?.phoneSeenWithin(HOTSPOT_PHONE_RECENT_MS) === true,
      onChange: () => this.remote?.changed(),
      notify: (text) => this.announce(text),
    });
    this.heat = new HeatGovernor({
      // The Mac app bundles the reader; a hand-built one in the support folder works too.
      system: macHeatSystem([
        "/Applications/Squeak.app/Contents/Helpers/squeak-fans",
        path.join(config.supportDir, "squeak-fans"),
      ]),
      journalPath: path.join(config.supportDir, "heat-journal.json"),
      setLowPower: (want, why) => void this.awake.setHeat(want, why),
      end: (why) => this.awake.end("heat", why),
      notify: (text) => this.announce(text),
      onChange: () => this.remote?.changed(),
    });
    const readers = [
      "/Applications/Squeak.app/Contents/Helpers/squeak-fans",
      path.join(config.supportDir, "squeak-fans"),
    ];
    const appsHelpers = [
      "/Applications/Squeak.app/Contents/Helpers/squeak-apps",
      path.join(config.supportDir, "squeak-apps"),
    ];
    const controlsSystem = macControlsSystem(readers, appsHelpers, config.handsAppPath);
    // The front app's tabs: Conductor's workspaces and chats from its records, any other app's through Squeak Hands.
    const tabs = new WindowTabs(
      macTabsSystem({
        handsAppPath: config.handsAppPath,
        front: async () => {
          const front = (await controlsSystem.running())?.find((app) => app.active);
          return front ? { id: front.id, name: front.name } : null;
        },
        conductor: () => {
          const workspaces = listNewChatWorkspaces(config.conductorDbPath, 8);
          const chats = this.runtime.registry.openChatsIn(workspaces.map((w) => w.id));
          return workspaces.map((w) => ({
            id: w.id,
            name: [w.repoName, w.branch].filter(Boolean).join(" · "),
            ...(w.repoName ? { repo: w.repoName } : {}),
            chats: chats
              .filter((chat) => chat.workspaceId === w.id)
              .map((chat) => ({
                id: chat.id,
                title: chat.title && chat.title !== "Untitled" ? chat.title : "Untitled chat",
                working: ["working", "waiting", "cancelling"].includes(chat.status ?? ""),
              })),
          }));
        },
        chat: (id) => {
          const row = this.runtime.registry.sessionForClose(id);
          return row ? { workspaceId: row.workspaceId, title: row.title } : null;
        },
      }),
    );
    this.controls = new MacControls(controlsSystem, this.heat, () => this.remote?.changed(), this.energy, tabs);
    this.usageStats = new UsageStats({ cachePath: path.join(config.supportDir, "usage-stats.json") });
    this.lidActions = new LidActions({
      settingsPath: path.join(config.supportDir, "awake-settings.json"),
      journalPath: path.join(config.supportDir, "lid-actions.json"),
      setLowPowerWanted: (wanted) => void this.awake.setLidLowPower(wanted),
      lidSessionOn: () => this.awake.state?.lidStatus === "on",
      sessionOn: () => this.awake.active,
      holdScreen: (on) => this.holdScreen(on),
    });
    this.telegram = config.botToken ? new TelegramClient(config.botToken) : null;
    const telegram = this.telegram;
    this.telegramAvatar = new TelegramAvatar({ telegram });
    this.notifySettings = new NotifySettingsStore(path.join(config.supportDir, "notify-settings.json"));
    this.sendDefault = new SendDefaultStore(path.join(config.supportDir, "send-default.json"));
    this.chatPresets = new ChatPresetsStore(path.join(config.supportDir, "chat-presets.json"), () => {
      try {
        return listChatModels(config.conductorDbPath);
      } catch {
        return [];
      }
    });
    this.voiceSettings = new VoiceSettingsStore(path.join(config.supportDir, "voice-settings.json"), Date.now, () =>
      listChatModels(config.conductorDbPath),
    );
    this.voiceFavorites = new VoiceFavoritesStore(path.join(config.supportDir, "voice-favorites.json"), (key) =>
      this.workspaceLabel(key),
    );
    this.voiceCallbacks = new CallbackRequests(path.join(config.supportDir, "voice-callbacks.json"));
    this.naturalSettings = new NaturalSettingsStore(
      path.join(config.supportDir, "voice-natural.json"),
      (engine) => naturalInstalled(naturalPaths(config.supportDir, engine)),
      (engine, voice) =>
        availableVoices(naturalPaths(config.supportDir, engine), engine).some((entry) => entry.id === voice) ||
        (engine === "kokoro" && engineHasVoice(engine, voice)),
    );
    this.naturalVoice = new NaturalVoice(
      (engine) => naturalPaths(config.supportDir, engine),
      () => this.naturalSettings.settings,
    );
    this.naturalInstaller = new NaturalInstaller(config.supportDir, {
      log: (detail) => logger.warn("realistic voice setup failed", { detail }),
    });
    this.promptClips = new PromptClipCache(this.naturalVoice, () => this.naturalVoiceKey());
    this.readBackClips = new ReadBackClips(this.naturalVoice, () => this.naturalVoiceKey());
    this.telegramStatus = new TelegramStatus({
      sender: telegram ? { sendMessage: (chatId, text) => telegram.sendMessage(chatId, text) } : null,
      allowedChatIds: config.allowedChatIds,
      redact: config.botToken ? [config.botToken] : [],
    });
    this.channelsSetup = new ChannelsSetup({
      envPath: resolveSqueakEnvPath(),
      namesPath: path.join(config.supportDir, "telegram-chats.json"),
      status: this.telegramStatus,
      live: () => ({ cliqOneWay: Boolean(config.cliqWebhookUrl), cliqTwoWay: Boolean(config.cliqTwoWay) }),
      // launchd's KeepAlive starts the daemon again, now with the saved settings.
      restart: () => {
        logger.info("channel settings changed; restarting to use them");
        process.exit(0);
      },
    });
    startupPhase("database");
    this.projectInference = new ProjectInference({
      supportDir: config.supportDir,
      ponds: () => readKnownPonds(config.supportDir, path.join(config.supportDir, "native.db")),
    });
    this.runtime = createFleetRuntime({
      projects: this.projectInference,
      workflows: this.films,
      // Core's adapters send through the same router and host client as every surface (nothing calls core's send yet).
      corePorts: () =>
        this.router && this.nativeHost
          ? {
              conductor: this.router,
              terminal: { send: (session, text) => this.router.send(session.key, text, () => undefined) },
              native: this.nativeHost,
            }
          : null,
      conductorDbPath: config.conductorDbPath,
      conductorLinked: () => this.conductorLink.linked,
      conductorWorkspaces: () => this.conductorLink.workspaces,
      cloudHosted: () => this.hosted.view(),
      // Read-only; a missing file (host never run) is simply no native chats.
      nativeDbPath: path.join(config.supportDir, "native.db"),
      workspacesRoot: config.workspacesRoot,
      defaultFallbackModel: config.defaultFallbackModel,
      defaultPermissionMode: config.defaultPermissionMode,
      stateDbPath: config.dbPath,
      supportDir: config.supportDir,
      hookPort: config.hookPort,
      pollIntervalMs: config.pollIntervalMs,
      activeWindowMs: config.activeWindowMs,
      idleAfterMs: config.idleAfterMs,
      contextPressurePercent: config.contextPressurePercent,
      codexQuotaWarnPercent: config.codexQuotaWarnPercent,
    });

    this.hands = config.handsAppPath ? new SqueakHandsSender(config.handsAppPath) : null;
    this.conductorRelay = new LinkedConductorRoute(
      addons?.conductorRoute ?? new NoConductorRoute(),
      () => this.conductorLink.linked,
      CONDUCTOR_NOT_LINKED,
    );
    // Linking or unlinking shows on the next refresh, which this asks for now; the relay add-on loads only at start.
    this.conductorLink.onChange(() => void this.runtime.monitor.refresh());
    this.replier = new ConductorReplier({
      registry: this.runtime.registry,
      claude: new ClaudeCodeAdapter(config.claudeBin),
      codex: new CodexAppServerAdapter(config.codexBin),
      relay: this.conductorRelay,
      ui: this.hands,
      linked: () => this.conductorLink.linked,
      workspacePicked: (id) => this.conductorLink.isPicked(id),
    });
    this.nativeHost = new NativeHostClient({
      baseUrl: `http://127.0.0.1:${Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT}`,
      token: tokenFromFile(defaultHookInstallPaths(config.supportDir).tokenPath),
    });
    this.router = new FleetReplyRouter({
      conductor: this.replier,
      native: new NativeReplier({
        client: this.nativeHost,
        lastMessage: (session) =>
          session.transcriptPath ? lastAgentMessage(session.agent, session.transcriptPath) : null,
      }),
      // Typing into Terminal goes through Squeak Hands too, which holds the
      // Automation grant for it; without Hands, terminal agents stay watch-only.
      terminal: config.handsAppPath
        ? new TerminalReplier({ screen: new SqueakHandsTerminal(config.handsAppPath) })
        : null,
      sessions: () => this.runtime.monitor.snapshot.sessions,
    });
    this.runtime.setCanReply((session) => this.router.canReply(session));
    // A finished turn's last message, read in full, tells the fleet whether it ends on a question for you.
    this.runtime.setLastMessage((session) =>
      session.conductorSessionId
        ? this.replier.lastTurnText(session.conductorSessionId)
        : session.transcriptPath
          ? lastAgentMessage(session.agent, session.transcriptPath)
          : null,
    );

    // Answers an agent's pending question or plan, for the Mac app and the phone
    // (docs/answering-questions.md): Conductor's API when it accepts answers,
    // else stop the waiting turn and send the answer as a message.
    const answers = new AnswerService({
      registry: this.runtime.registry,
      relay: answerRelayFrom({
        isReady: () => this.conductorRelay.isReady(),
        send: (args) => this.conductorRelay.send(args),
        request: () => this.conductorRelay.requestFn(),
      }),
      readAsk: (conductorSessionId) => {
        const session = this.runtime.monitor.snapshot.sessions.find(
          (candidate) => candidate.conductorSessionId === conductorSessionId,
        );
        return session?.agent === "claude" && session.transcriptPath ? readPendingAsk(session.transcriptPath) : null;
      },
    });

    // The phone channel, when a Firebase project is configured. Same replier,
    // same busy rules; the bridge adds pairing and signature checks on top.
    // Shared server: a daily byte budget under the cloud store (the direct path is above it and never pauses).
    const sharedBudget = config.remoteShared
      ? new CloudBudget(undefined, undefined, path.join(config.supportDir, "shared-budget.json"))
      : null;
    this.sharedBudget = sharedBudget;
    // cloud.json decides Firebase or Catalyst; absent, Firebase from SQUEAK_REMOTE_DATABASE_URL as always.
    const cloudFile = readCloudConfig(config.supportDir);
    const cloudLocation = activeLocation(cloudFile, config.remoteDatabaseUrl);
    this.cloud = cloudLocation
      ? new SwitchableStore(
          createCloudStore(cloudLocation, { onUnauthorized: () => this.hosted.onUnauthorized() }),
          cloudLocation,
        )
      : null;
    this.hosted = new HostedCloud({
      supportDir: config.supportDir,
      url: hostedRelayUrl(),
      current: () => this.cloud?.location ?? null,
      legacy: () => {
        const location = this.cloud?.location;
        if (!location) return null;
        if (location.provider === "firebase") return config.remoteShared ? "shared" : "firebase";
        return location.hosted ? null : "catalyst-own";
      },
      channelId: () => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(config.supportDir, "remote.json"), "utf8")) as {
            channelId?: unknown;
          };
          return typeof raw.channelId === "string" ? raw.channelId : null;
        } catch {
          return null;
        }
      },
      moveTo: (target) => this.cloudControl.moveTo(target),
      restart: () => {
        logger.info("hosted cloud changed; restarting to use it");
        process.exit(0);
      },
    });
    const bridgeProjectId =
      config.remoteProjectId ??
      (cloudLocation?.provider === "catalyst" ? (cloudFile?.catalyst?.projectId ?? "catalyst") : null);
    this.cloudControl = new CloudControl({
      supportDir: config.supportDir,
      hosted: this.hosted,
      onUnauthorized: () => this.hosted.onUnauthorized(),
      // Never used when no store is set up: the routes then answer that Firebase is not set up.
      store: this.cloud ?? new SwitchableStore(new RtdbRest("https://unset.firebaseio.com"), null),
      firebase: () => ({ databaseUrl: config.remoteDatabaseUrl, projectId: config.remoteProjectId }),
      announceMove: async (target) => {
        // Both channels, on the store they are on now: the phones' and the add-on's.
        await this.remote?.announceMove(target);
        const relay = this.config.voiceRelay;
        if (relay && this.cloud)
          await this.cloud.set(movePath(relay.channel), sealAddonMove(relay.key, target, Date.now()));
      },
    });
    const rawCloudStore = bridgeProjectId ? (this.cloud ?? new FirestoreRest(bridgeProjectId)) : null;
    const cloudStore = rawCloudStore && sharedBudget ? new BudgetedStore(rawCloudStore, sharedBudget) : rawCloudStore;
    // The direct path mirrors every document the bridge writes, so both transports show the same sealed ones.
    const localMirror = cloudStore && config.remoteLocal ? new MirrorStore(cloudStore) : null;
    this.remote =
      bridgeProjectId && cloudStore
        ? new RemoteBridge({
            configPath: path.join(config.supportDir, "remote.json"),
            projectId: bridgeProjectId,
            // The Realtime Database when configured: streamed, billed by bytes not reads.
            store: localMirror ?? cloudStore,
            localEndpoint: () => this.localChannel?.endpoint() ?? null,
            onDevicesChanged: () => void this.localChannel?.refresh(),
            databaseUrl: cloudLocation?.provider === "catalyst" ? null : config.remoteDatabaseUrl,
            location: () => this.cloud?.location ?? null,
            preferredChannelId: () => readCloudConfig(config.supportDir)?.hosted?.macId ?? null,
            accountRelay: () => {
              const location = this.cloud?.location;
              return location?.provider === "catalyst"
                ? new HttpAccountRelay(location.relayUrl, location.relayKey, undefined, location.hosted === true)
                : null;
            },
            // A device of the linked account added without a code: always told (a security event, not muted).
            onOwnDeviceAdded: ({ text }) => this.announce(text),
            announce:
              config.remoteDatabaseUrl && !sharedBudget && cloudLocation?.provider !== "catalyst"
                ? new FirestoreRest(bridgeProjectId)
                : null,
            shared: sharedBudget ? { budget: sharedBudget } : null,
            replier: this.replier,
            // Squeak's own chats: the open request in full, answering it, starting a chat (src/fleet/native-phone.ts).
            native: new NativePhone({
              dbPath: path.join(config.supportDir, "native.db"),
              baseUrl: `http://127.0.0.1:${Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT}`,
              tokenPath: defaultHookInstallPaths(config.supportDir).tokenPath,
              models: () => listChatModels(config.conductorDbPath),
            }),
            snapshot: () => this.runtime.monitor.snapshot,
            onSnapshot: (listener) => this.runtime.monitor.onSnapshot(listener),
            activity: (session) =>
              session.transcriptPath ? readActivity(session.agent, session.transcriptPath) : null,
            background: (session) =>
              session.transcriptPath ? this.subagents.tasks(session.transcriptPath, Date.now(), session.agent) : [],
            subagentActivity: (session, taskId, limit, stepChars) =>
              session.transcriptPath
                ? this.subagents.read(session.transcriptPath, taskId, Date.now(), { limit, stepChars }, session.agent)
                : null,
            // A question's prompts, or a plan waiting on approval with its text (the phone's plan card).
            question: (session) =>
              session.agent === "claude" && session.transcriptPath ? readPendingAsk(session.transcriptPath) : null,
            liveActivity: (session, limit, stepChars) =>
              session.transcriptPath ? readActivity(session.agent, session.transcriptPath, limit, { stepChars }) : null,
            verbose: config.remoteVerbose,
            // The phone's "what changed": the same reader Telegram's diff pages use.
            diff: this.runtime.diff,
            // An image a chat's agent showed, for the phone: only inside that chat's workspace.
            image: (source, cwd, root) => readPhoneImage(source, cwd, {}, root),
            // A film waiting on a call (RasanAI): its card, and the answer.
            workflow: this.rasanai,
            films: this.films,
            // Its film or soundtrack as a phone copy (avconvert / afconvert), cached beside Squeak's state.
            media: (source, cwd) =>
              preparePhoneMedia(source, cwd, { cacheDir: path.join(config.supportDir, "media-cache") }),
            claudeLimits: () => this.claudeLimits?.latest() ?? null,
            // The phone's Refresh on Usage: the same once-a-minute refresher as the Mac's button.
            refreshUsage: () => this.claudeRefresher.refresh(),
            stats: (range, agent) => this.usageStats.view(range, agent),
            controls: {
              state: () => this.controls.state,
              apply: (change) => this.controls.apply(change),
            },
            hotspot: {
              state: () => this.hotspot.state,
              apply: (request) => this.applyHotspot(request),
            },
            telegramAvatar: { apply: (request) => this.telegramAvatar.apply(request) },
            channelsSetup: {
              state: () => this.channelsSetup.state(),
              telegram: (change) => this.channelsSetup.telegram(change),
              cliq: (change) => this.channelsSetup.cliq(change),
            },
            voice: {
              state: () => this.voiceView(),
              apply: (request) => this.applyVoiceSettings(request),
              // The recent calls and their steps; sent only to a phone that says it reads them (`calls`).
              calls: () => {
                const trace = this.callTraceStore();
                const history = this.callHistoryStore();
                trace.deriveIncoming(history);
                return phoneCalls(history, trace);
              },
              test: () => this.testVoiceCall(),
              // The same function the Mac app's `POST /control/voice/preview` ends in.
              preview: (voice, engine, speed) => this.previewVoice(voice, engine, speed),
              changePin: (current, next) => this.changeVoicePin(current, next),
              gatewayUpdate: async () => {
                const outcome = await this.updateGatewayAddon();
                return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
              },
              pinAction: async (action) => {
                const outcome = await this.runPinAction(action);
                return outcome.ok ? { ok: true as const } : outcome;
              },
            },
            notify: {
              state: () => this.notifyView(),
              apply: (request) => this.applyNotify(request),
            },
            sendDefault: {
              state: () => this.sendDefault.mode,
              apply: (request) => this.applySendDefault(request),
            },
            claudeAccounts: {
              state: () => this.claudeAccountsView(),
              apply: (request) => this.applyClaudeAccount(request),
            },
            presets: {
              state: () => this.chatPresets.snapshot(),
              apply: (request) => this.applyPresets(request),
            },
            awake: {
              state: () => this.awake.state,
              lidReady: () => this.awake.lidReady,
              power: () => (this.power ? phonePower(this.power) : null),
              heat: () => phoneHeat(this.heat, this.awake.active),
              apply: (request) => this.applyAwake(request),
              lidActions: () => this.lidActions.settings,
              openActions: () => this.lidActions.openSettings,
              rules: () => awakeRules(config.awakeSafety),
              lastEnd: () => this.awake.lastEnd,
              sleepProblem: () => this.awake.sleepProblem,
            },
            // A signed phone may start a chat in a listed workspace; the bridge re-reads the list per command.
            answerer: answers,
            projectIcons: () => this.projectIcons.current(),
            renamer: { rename: (sessionId, title) => this.runtime.registry.renameSession(sessionId, title) },
            closer: {
              close: (sessionId) =>
                closeChat(
                  {
                    lookup: (id) => this.runtime.registry.sessionForClose(id),
                    hide: (id) => this.runtime.registry.closeSession(id),
                    ui: this.hands,
                  },
                  sessionId,
                ),
            },
            workspaceActions: (() => {
              const deps = { conductorDbPath: config.conductorDbPath, relay: this.conductorRelay };
              // The phone view is built on every publish; the repository list changes about never.
              let repos: { at: number; list: Array<{ id: string; name: string }> } | null = null;
              return {
                repos: () => {
                  if (!repos || Date.now() - repos.at > 60_000) {
                    repos = {
                      at: Date.now(),
                      list: listWorkspaceRepos(config.conductorDbPath).map(({ id, name }) => ({ id, name })),
                    };
                  }
                  return repos.list;
                },
                archive: (workspaceId: string) => archiveWorkspace(deps, workspaceId),
                create: (repoId: string) => createWorkspace(deps, repoId),
                prPrompt: (workspaceId: string) => {
                  const workspace = readWorkspace(config.conductorDbPath, workspaceId);
                  return workspace ? createPrPrompt(workspace) : null;
                },
              };
            })(),
            newChat: {
              workspaces: () => listNewChatWorkspaces(config.conductorDbPath, 20),
              models: () => listChatModels(config.conductorDbPath),
              start: (args) =>
                newChatControl({ conductorDbPath: config.conductorDbPath, relay: this.conductorRelay }).startChat(args),
            },
          })
        : null;
    const bridge = this.remote;
    this.localChannel =
      bridge && localMirror
        ? new LocalChannelServer({
            mirror: localMirror,
            access: () => bridge.localAccess(),
            port: config.remoteLocalPort,
            advertiser: new LocalAdvertiser(),
          })
        : null;

    // The Mac app answers chats through the same replier as Telegram, over
    // the loopback ingress, gated by the hook token.
    this.runtime.ingress.setControl({
      ...answerControl(answers),
      coreSessions: () => this.runtime.coreSessions(),
      cloud: { handle: (method, route, body) => this.cloudControl.handle(method, route, body) },
      remote: async (action, deviceId, body) => {
        // The Mac app's sign-in on Squeak's hosted cloud: `{ token }` (an account token) sets this Mac up, with or
        // without a phone channel yet. A ticket (`{ ticket }`) links the account on a channel that already exists.
        if (action === "account-link" && body && typeof body === "object" && "token" in body) {
          return Object.keys(body).length === 1
            ? this.hosted.signIn((body as { token: unknown }).token)
            : { ok: false, reason: "That sign-in could not be read. Sign in again." };
        }
        const remote = this.remote;
        if (!remote) {
          return { configured: false, available: false };
        }
        switch (action) {
          case "status":
            return { available: true, ...(remote.status() as object) };
          case "pair":
            return remote.startPairing();
          case "approve":
            return { ok: deviceId ? await remote.approve(deviceId) : false };
          case "reject":
            return { ok: deviceId ? await remote.reject(deviceId) : false };
          case "revoke":
            return { ok: deviceId ? remote.revoke(deviceId) : false };
          case "reset":
            remote.reset();
            return { ok: true };
          case "account":
            return remote.accountState();
          case "account-avatar":
            return { avatar: await remote.accountAvatar(deviceId === "refresh") };
          case "account-settings":
            return remote.setAccountSettings(body);
          case "account-unlink":
            return remote.unlinkAccount();
          case "account-link":
            return remote.linkAccountFromTicket((body as { ticket?: unknown } | null)?.ticket);
          default:
            return { ok: false };
        }
      },
      ...newChatControl({ conductorDbPath: config.conductorDbPath, relay: this.conductorRelay }),
      ...workspaceControl({ conductorDbPath: config.conductorDbPath, relay: this.conductorRelay }),
      ...channelsControl(this.telegramStatus, () => ({
        cliqOneWay: Boolean(config.cliqWebhookUrl),
        cliqTwoWay: Boolean(config.cliqTwoWay),
        phone: this.remote !== null,
      })),
      sessionMessage: (target) => {
        const text = this.router.lastTurnText(target);
        return { text, choices: parseChoices(text) };
      },
      refreshClaudeUsage: () => this.claudeRefresher.refresh(),
      handsGrants: () => this.handsGrants.read(),
      awake: (request) => this.applyAwake(request),
      power: (choice) =>
        isPowerChoice(choice)
          ? this.energy.apply(choice)
          : Promise.resolve({ ok: false, reason: "That energy mode isn't available." }),
      // The same function the phone's signed `hotspot` command ends in.
      hotspot: (request) => this.applyHotspot(request),
      notify: { read: () => this.notifyView(), apply: (request) => this.applyNotify(request) },
      projectCorrection: (key, request) => applyProjectCorrection(this.projectInference, key, request),
      conductorLink: {
        read: () => ({
          linked: this.conductorLink.linked,
          available: fs.existsSync(config.conductorDbPath),
          appInstalled: fs.existsSync("/Applications/Conductor.app"),
        }),
        apply: (request) => {
          const parsed = parseLinkRequest(request);
          if (!parsed.ok) return parsed;
          this.conductorLink.set(parsed.linked);
          return { ok: true as const, linked: this.conductorLink.linked };
        },
      },
      conductorWorkspaces: {
        read: () => this.conductorWorkspacesView(),
        apply: (request) => {
          const parsed = parseWorkspaceRequest(request);
          if (!parsed.ok) return parsed;
          this.conductorLink.setPicked(parsed.id, parsed.picked);
          return { ok: true as const, view: this.conductorWorkspacesView() };
        },
      },
      sendDefault: {
        read: () => ({ mode: this.sendDefault.mode }),
        apply: (request) => {
          const outcome = this.applySendDefault(request);
          return outcome.ok ? { ok: true as const, state: { mode: outcome.state } } : outcome;
        },
      },
      claudeAccounts: {
        read: () => this.claudeAccounts.list(),
        apply: (request) => this.applyClaudeAccount(request),
      },
      presets: { read: () => this.chatPresets.snapshot(), apply: (request) => this.applyPresets(request) },
      voice: {
        read: () => this.voiceView(),
        apply: (request) => this.applyVoice(request),
        preview: (voice, engine, speed) => this.previewVoice(voice, engine, speed),
      },
      // The Mac app's "Set up realistic voice": the install runs here, in the background, one at a time.
      voiceNatural: {
        status: (engine) => this.naturalInstaller.status(engine),
        start: (engine) => this.naturalInstaller.start(engine),
        remove: (engine) => this.naturalInstaller.remove(engine, this.naturalSettings.settings.engine),
      },
      // Not behind voiceRelay: pairing is how the Mac gets one.
      voiceGateway: {
        read: () =>
          gatewayRouteView(
            this.gatewayClaim?.view() ?? this.gatewayPairing?.view() ?? null,
            this.gatewayStatusReader().peek(),
            this.gatewayView(),
          ),
        check: () => this.checkGatewayAddon(),
        pair: () => {
          const pairing = this.gatewayPairingFor();
          if (!pairing) {
            return {
              ok: false as const,
              unavailable: true,
              reason:
                "Pairing needs the phone channel's own Firebase database (not the shared server) to be set up first.",
            };
          }
          this.gatewayClaim?.stop();
          return { ok: true as const, ...pairing.start() };
        },
        claim: async (code: string) => {
          const claim = this.gatewayClaimFor();
          if (!claim) {
            return {
              ok: false as const,
              status: 503 as const,
              reason: "Phone calls need your own Firebase (Settings > iPhone)",
            };
          }
          const started = await claim.start(code);
          if (started.ok) this.gatewayPairing?.stop();
          return started;
        },
        // The same function the phone's signed `gatewayUpdate` ends in.
        update: () => this.updateGatewayAddon(),
        // Whichever flow is open: a code typed on the Mac, or the older code made on the Mac.
        approve: (approve) =>
          this.gatewayClaim?.view()
            ? this.gatewayClaim.approve(approve)
            : this.gatewayPairing
              ? this.gatewayPairing.approve(approve)
              : Promise.resolve({ ok: false as const, reason: "No gateway is waiting to pair." }),
      },
      voiceBusy: () => {
        const inbox = this.memoInbox?.busy() ?? { busy: false };
        if (this.voice?.isCalling()) return { busy: true, since: inbox.since ?? Date.now() };
        return inbox;
      },
      voiceCalls: async () => {
        const gatewayLog = await this.ingestGatewayLog();
        const trace = this.callTraceStore();
        const history = this.callHistoryStore();
        trace.deriveIncoming(history);
        return {
          calls: history.list(100).map((entry) => ({ ...entry, events: trace.eventsFor(entry) })),
          gatewayLog,
        };
      },
      telegramAvatar: (request) => this.telegramAvatar.apply(request),
      fanRule: () => {
        const rule = fansSudoersRule(os.userInfo().username);
        return rule ? { path: FANS_SUDOERS_PATH, rule, helperPath: FANS_HELPER_PRIVILEGED } : null;
      },
      powerRule: () => {
        const rule = powerSudoersRule(os.userInfo().username);
        return rule ? { path: POWER_SUDOERS_PATH, rule } : null;
      },
      lidRule: () => {
        const rule = sudoersRule(os.userInfo().username);
        return rule ? { path: SUDOERS_PATH, rule } : null;
      },
      transcript: (target, limit, before) => this.router.transcript(target, limit, before),
      activity: (key) => {
        const session = this.runtime.monitor.snapshot.sessions.find((candidate) => candidate.key === key);
        if (!session?.transcriptPath) return { steps: [], total: 0 };
        // Subagents and background shells ride along for a Claude chat (fleet/background-work.ts), and a Codex chat's
        // subagents too (fleet/codex-subagents.ts).
        const background = this.subagents.tasks(session.transcriptPath, Date.now(), session.agent);
        return { ...readActivity(session.agent, session.transcriptPath), ...(background.length ? { background } : {}) };
      },
      changes: async (key) => (await this.readChanges(key))?.changes ?? null,
      changeFile: async (key, filePath) => {
        const read = await this.readChanges(key);
        if (!read) return null;
        const patch = await this.runtime.diff.readChangePatch(
          read.folder,
          read.session.baseRef,
          read.changes,
          filePath,
        );
        return patch ? { path: filePath, ...patch } : null;
      },
      subagentActivity: (key, taskId) => {
        const session = this.runtime.monitor.snapshot.sessions.find((candidate) => candidate.key === key);
        if (!session?.transcriptPath) return null;
        return this.subagents.read(session.transcriptPath, taskId, Date.now(), {}, session.agent);
      },
      chatModels: () => listChatModels(config.conductorDbPath),
      flags: () => flags().list(),
      sessionAction: (sessionId, action, body) => this.chatAction(sessionId, action, body),
      queue: (sessionId) => this.replier.queue(sessionId),
      ...(addons?.routes.length ? { addonRoutes: addons.routes } : {}),
      hooks: this.hooksSetup(),
      queueAction: (sessionId, messageId, action) => this.replier.queueAction(sessionId, messageId, action),
      reply: async (target, text, mode, answersTurn) => {
        // A client that names the turn it answered is refused once the chat has moved on (answered on the laptop).
        if (typeof answersTurn === "string" && this.router.lastTurnId(target) !== answersTurn) {
          return { status: "refused", reason: "That chat has moved on, so nothing was sent." };
        }
        return this.router.send(
          target,
          text,
          (message) => {
            logger.warn("reply from the Mac app failed", { target, message });
          },
          { mode: resolveSendMode(mode, this.sendDefault.mode) },
        );
      },
    });

    this.runtime.monitor.setWidenFinishes(() => wantsAllFinishes(this.notifySettings.settings));
    this.claudeLimits = new ClaudeLimitsStore(path.join(config.supportDir, "claude-limits.json"));
    this.runtime.setClaudeLimits(() => this.claudeLimits.latest());
    this.runtime.setAwake(() => ({
      state: this.awake.state,
      lidReady: this.awake.lidReady,
      lastEnd: this.awake.lastEnd,
      lidActions: this.lidActions.settings,
      openActions: this.lidActions.openSettings,
      lidClosedNow: this.lidActions.active,
      sleepProblem: this.awake.sleepProblem,
      rules: awakeRules(config.awakeSafety),
      hotspot: this.hotspot.state,
      heat: this.heat.state,
      power: this.energy.state,
      sendDefault: this.sendDefault.mode,
    }));
    const claudeRunner = claudeCliRunner(config.claudeBin, path.join(config.supportDir, "assistant"), (limits) =>
      this.claudeLimits.record(limits),
    );
    this.assistant = new FleetAssistant(claudeRunner);
    const persona = (): string => personaInstruction(this.voiceSettings.settings.persona);
    this.chatQuestioner = new ChatQuestioner(
      claudeCliRunner(config.claudeBin, path.join(config.supportDir, "assistant"), null, 40_000),
      persona,
    );
    // One `claude` per call, kept up between turns; the one-shot runner is only the fallback.
    this.chatConverser = new ChatConverser(
      claudeCliRunner(config.claudeBin, path.join(config.supportDir, "assistant"), null, 40_000),
      claudeConversationOpener(config.claudeBin, path.join(config.supportDir, "assistant")),
      persona,
    );
    // Only a Refresh press reaches this: no timer, no model call, and the
    // Keychain is read only then.
    this.claudeRefresher = new ClaudeLimitsRefresher(this.claudeLimits, () => fetchClaudeUsage());
    this.voiceFillers = new VoiceFillers(
      path.join(config.supportDir, "voice-fillers.json"),
      claudeCliRunner(config.claudeBin, path.join(config.supportDir, "assistant"), null, 30_000),
      () => void this.memoInbox?.publish().catch(() => undefined),
    );
    this.voiceFillers.refresh(this.voiceSettings.settings.persona);
    // Pond invite cards (fleet/pond-invites.ts): the sinks read the channel and its switch when a card is due.
    this.pondInvites = new PondInviteNotifier({
      port: this.nativeHost,
      file: path.join(config.supportDir, "pond-invites.json"),
      sinks: [
        {
          channel: "telegram",
          allowed: () => this.telegram !== null && shouldPushInviteTo("telegram", this.notifySettings.settings),
          push: (card) => this.controller.pushPondCard(card.text, card.buttons),
        },
        {
          channel: "cliq",
          allowed: () => this.cliq !== null && shouldPushInviteTo("cliq", this.notifySettings.settings),
          push: (card) => this.cliq!.pushPondCard(card.text, card.buttons),
        },
      ],
    });
    this.cliq = this.createCliq();
    this.voice = this.createVoice();
    this.memoInbox = this.createMemoInbox();
    // Start the realistic voice's worker now and render the fixed call phrases while no call waits on them. Readiness
    // starts as preparing: it is ready once the first publish to the add-on is out.
    this.prepareVoice();
    this.makeMissingReferenceClips();

    this.controller = new FleetController({
      telegram: this.telegram,
      store: this.runtime.store,
      monitor: this.runtime.monitor,
      ingress: this.runtime.ingress,
      diff: this.runtime.diff,
      // No conversation view to hand a chat to — but a finished chat can be
      // answered in place, which is what the replier is for.
      openConductorSession: null,
      replier: this.router,
      nativeResponder: {
        respond: (requestId, decision, message) => this.nativeHost.respond(requestId, decision, message),
      },
      pondInvites: this.pondInvites,
      // Telegram buttons only open https links, so the card points at a static page on GitHub Pages
      // (published by ios/scripts/release.sh) that hands off to the phone app.
      phoneLink: (conductorSessionId) => (this.remote?.hasPairedPhone() ? openInSqueakLink(conductorSessionId) : null),
      notify: channelFilter(this.notifySettings, "telegram", Date.now, this.pushCounter),
      fallbackChatIds: config.allowedChatIds ? Array.from(config.allowedChatIds) : [],
    });
  }

  async start(): Promise<void> {
    appOwnsSignals();
    const onSignal = shutdownOnSignals(() => this.stop());
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    // Answer first: hooks, /state and the control routes work from here on, before the slow work below.
    await this.runtime.ingress.start().catch((error: unknown) => {
      logger.warn("fleet hook ingress failed to start; falling back to polling only", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // Before the controller, which starts the monitor: the first push must reach Cliq too.
    this.cliq?.start();
    this.pondInvites.start();
    this.voice?.start();
    this.startMemoInbox();
    this.startTraceWatch();
    if (this.config.caffeinate) {
      this.unwatchCaffeinate = this.runtime.monitor.onSnapshot((snapshot) => this.caffeinator.update(snapshot));
    }
    // The user's own switch is honoured even with SQUEAK_CAFFEINATE=off: they asked.
    // Undoes what a previous run left behind (sleep disabled, muted, apps paused) before anything else.
    // The session first, so the lid actions can tell a resumed lid session
    // with the lid still shut, and keep what they did rather than undo and redo it.
    await this.awake.restore();
    await this.lidActions.recover();
    await this.heat.recover();
    void this.controls.refresh();
    // The first read of every transcript (seconds, once; then only changed files), off the start's path.
    setTimeout(() => void this.usageStats.scan(), 30_000).unref?.();
    void this.energy.refresh(true);
    await this.hotspot.start().catch((error: unknown) =>
      logger.warn("hotspot failover failed to start", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    this.lidActions.start();
    void this.refreshLidRule();
    this.lidRuleTimer = setInterval(() => void this.refreshLidRule(), 10 * 60_000);
    this.lidRuleTimer.unref?.();
    // The safety rules read the battery and heat once a minute while a session runs.
    this.safetyTimer = setInterval(() => void this.checkAwakeSafety(), 60_000);
    this.safetyTimer.unref?.();
    // Heat is looked at every 15 s, but acted on only during an awake session.
    this.heatTimer = setInterval(() => void this.checkHeat(), HEAT_CHECK_MS);
    this.heatTimer.unref?.();
    this.liveControlsTimer = setInterval(() => {
      if (this.localChannel?.hasPhone() && this.remote?.isPhoneOpen()) void this.controls.refresh();
    }, 2_000);
    this.liveControlsTimer.unref?.();
    // Conductor's repository icons, read now and every few minutes (they change when someone sets one).
    void this.refreshProjectIcons();
    this.projectIconsTimer = setInterval(() => void this.refreshProjectIcons(), 5 * 60_000);
    this.projectIconsTimer.unref?.();
    if (this.config.caffeinateOnPower) {
      this.caffeinator.holdOnPower();
    }
    startupPhase("fleet");
    await this.controller.start();
    startupPhase("listening");
    this.conductorRelay.start();
    this.remote?.start();
    this.hosted.start();
    // Never fatal: the cloud path carries on if the port or the network is not available.
    await this.localChannel?.start().catch((error: unknown) => {
      logger.warn("direct phone path did not start", { error: error instanceof Error ? error.message : String(error) });
    });
    if (this.telegram) {
      await this.startTelegram(this.telegram);
    } else {
      logger.info("telegram is off: no SQUEAK_BOT_TOKEN; the fleet, phone channel and Cliq still run");
    }

    if (fs.existsSync(claimPath(this.config.supportDir))) {
      const cliJs = fileURLToPath(new URL("./cli.js", import.meta.url));
      this.orphanWatch = new OrphanWatch(
        realOrphanWatchDeps(this.config.supportDir, cliJs, (message) => logger.info(message)),
      );
      this.orphanWatch.start();
    }

    startupPhase("ready");
    logger.info("squeak started", { hookPort: this.config.hookPort });
    if (this.telegram) {
      await this.pollLoop(this.telegram);
    } else {
      // Nothing to poll: stay alive for the ingress, relay and Cliq until stopped.
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (this.stopped) {
            clearInterval(timer);
            resolve();
          }
        }, 1000);
      });
    }
  }

  private async startTelegram(telegram: TelegramClient): Promise<void> {
    if (!this.config.allowedChatIds) {
      logger.warn("SQUEAK_ALLOWED_CHAT_IDS is not set: every chat that messages the bot is trusted");
    }
    try {
      this.telegramStatus.setBot((await telegram.getMe()).username);
    } catch (error) {
      this.telegramStatus.setBot(null);
      this.telegramStatus.pollFailed(summarizeTelegramError(error).message);
    }
    await telegram.setMyCommands(COMMANDS).catch((error) => {
      logger.warn("could not publish squeak commands", { error: summarizeTelegramError(error) });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.unwatchCaffeinate?.();
    this.orphanWatch?.stop();
    if (this.lidRuleTimer) clearInterval(this.lidRuleTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    if (this.heatTimer) clearInterval(this.heatTimer);
    if (this.liveControlsTimer) clearInterval(this.liveControlsTimer);
    this.controls.stop();
    await this.heat.stop().catch(() => undefined);
    if (this.projectIconsTimer) clearInterval(this.projectIconsTimer);
    await this.lidActions.stop().catch(() => undefined);
    await this.awake.stop().catch(() => undefined);
    this.hotspot.stop();
    this.caffeinator.stop();
    this.remote?.stop();
    this.hosted.stop();
    this.sharedBudget?.flush();
    await this.localChannel?.stop().catch(() => undefined);
    this.cliq?.stop();
    this.pondInvites.stop();
    this.voice?.stop();
    this.stopMemoInbox();
    if (this.readinessNudge) clearTimeout(this.readinessNudge);
    this.stopTraceWatch();
    this.voiceSpeaker?.dispose();
    this.naturalVoice.stop();
    this.naturalInstaller.stop();
    this.stopReferenceClips();
    await addons?.stop().catch(() => undefined);
    await this.replier.stop().catch(() => undefined);
    await this.controller.stop().catch(() => undefined);
    logger.info("squeak stopped");
  }

  /** Hotspot failover's one entry: the phone's signed command and the Mac app's control route both end here. */
  /**
   * The Mac app's chat actions: Conductor's Stop, a new model or thinking level (checked against the models this
   * Mac offers for the chat's own agent, as the phone's are), and asking a resting chat to open a pull request.
   */
  /** Agent hooks from the Mac app (fleet/hooks-setup.ts) for the ingress's `/control/hooks*` routes. */
  private hooksSetup(): NonNullable<IngressControl["hooks"]> {
    const setup = new HooksSetup({ supportDir: this.config.supportDir, port: this.config.hookPort });
    return {
      status: () => setup.status(),
      install: () => setup.install(),
      uninstall: () => setup.uninstall(),
    };
  }

  /** A session's change list for the Mac inspector, by fleet key (or its Conductor / agent id); null when unknowable. */
  private async readChanges(
    key: string,
  ): Promise<{ session: FleetSession; folder: string; changes: ChangeSet } | null> {
    const session = this.runtime.monitor.snapshot.sessions.find(
      (candidate) => candidate.key === key || candidate.conductorSessionId === key || candidate.sourceId === key,
    );
    const folder = session ? workFolder(session) : null;
    if (!session || !folder) return null;
    const changes = await this.runtime.diff.readChanges(folder, session.baseRef);
    return changes ? { session, folder, changes } : null;
  }

  private async chatAction(
    sessionId: string,
    action: "stop" | "setup" | "pr",
    body: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const snapshot = this.runtime.monitor.snapshot;
    const session = snapshot.sessions.find((candidate) => candidate.conductorSessionId === sessionId);
    if (!session) return { ok: false, reason: "That chat isn't in Conductor any more." };
    if (action === "stop") return this.replier.stopTurn(sessionId);
    if (action === "setup") {
      const setup = resolveSetup(listChatModels(this.config.conductorDbPath), session, {
        model: body.model,
        thinking: body.thinking,
        fast: body.fast,
      });
      if (!setup.ok) return setup;
      return this.replier.setSetup(sessionId, {
        model: setup.model,
        ...(setup.thinkingLevel ? { thinkingLevel: setup.thinkingLevel } : {}),
        fastMode: setup.fastMode,
      });
    }
    if (["working", "awaiting_approval", "awaiting_input"].includes(session.state)) {
      return { ok: false, reason: "The agent is mid-turn. Ask for the PR once it has finished." };
    }
    const workspace = session.conductorWorkspaceId
      ? readWorkspace(this.config.conductorDbPath, session.conductorWorkspaceId)
      : null;
    if (!workspace) return { ok: false, reason: "That chat's workspace isn't in Conductor any more." };
    const outcome = await this.router.send(sessionId, createPrPrompt(workspace), (message) => {
      logger.warn("PR request from the Mac app failed", { sessionId, message });
    });
    return outcome.status === "refused" || outcome.status === "unconfirmed"
      ? { ok: false, reason: outcome.reason }
      : { ok: true };
  }

  /** The settings and which channels exist: what `GET /control/notify` and the phone's `notify` carry. */
  /** Settings › Conductor's list: every workspace with whether the owner added it. Read-only against conductor.db. */
  private conductorWorkspacesView(): { linked: boolean; workspaces: unknown[] } {
    const linked = this.conductorLink.linked;
    if (!linked) return { linked, workspaces: [] };
    let rows: WorkspacePickerRow[];
    try {
      rows = this.runtime.registry.listWorkspacesForPicker();
    } catch {
      rows = [];
    }
    return { linked, workspaces: rows.map((row) => ({ ...row, picked: this.conductorLink.isPicked(row.id) })) };
  }

  private notifyView() {
    return {
      ...this.notifySettings.snapshot(),
      channels: { telegram: Boolean(this.config.botToken), cliq: Boolean(this.config.cliqWebhookUrl) },
      pushedToday: this.pushCounter.today(),
    };
  }

  /**
   * Calling in: the gateway answers your call and checks the PIN; this publishes who can take a message,
   * transcribes the recording with Whisper and sends it through the same replier as every other surface.
   * Off without the relay, or without whisper-cli, ffmpeg and the model (a warning says which).
   */
  private createMemoInbox(): MemoInbox | null {
    const { voiceRelay, voiceWhisperModel } = this.config;
    if (!voiceRelay || !this.cloud) return null;
    const whisper = findWhisper(voiceWhisperModel);
    if (!whisper) {
      logger.warn("calling in is off: needs whisper-cli, ffmpeg and a speech model", { model: voiceWhisperModel });
      return null;
    }
    return new MemoInbox({
      store: this.cloud,
      channel: voiceRelay.channel,
      key: voiceRelay.key,
      transcriber: new WhisperTranscriber(whisper),
      targets: () => this.memoTargets(),
      canSend: (target) => {
        const session = this.runtime.monitor.snapshot.sessions.find((s) => replyTargetFor(s) === target);
        return Boolean(session) && canTakeMessageNow(session!, this.router);
      },
      send: (target, text, onFailed) => this.router.send(target, text, onFailed),
      caller: () => this.voiceSettings.settings.callee,
      favorites: () => this.voiceFavorites.list().map((fav) => ({ ...fav, label: this.spokenFavoriteLabel(fav) })),
      // No "the last one you used" offer: a call in goes straight to the workspaces (owner's call, 2026-11-01).
      stateFile: path.join(this.config.supportDir, "voice-call-state.json"),
      // The call-in dialog in the Mac's own voice: every prompt, and the read-back of each message.
      audioClips: async (texts) => {
        const key = this.promptVoiceKey();
        const clips = await this.promptClips.clips(
          texts,
          (done, total) => this.voiceReadiness.progress(key, done, total),
          "background",
        );
        this.voiceReadiness.sending(key, clips.length, new Set(texts).size);
        return clips;
      },
      voiceKey: () => this.promptVoiceKey(),
      audioPublished: (_version, voiceKey) => {
        if (voiceKey !== null) this.voiceReadiness.ready(voiceKey);
      },
      // Only what was heard is rendered per call; the fixed suffix per chat is kept, and the two are joined.
      readBack: (text, label, ask) => this.readBackClips.clip(text, label, ask),
      prepareReadBack: (labels, ask) => this.readBackClips.prepare(labels, ask),
      // An add-on from 0.19.0 plays the read-back part by part as it is made: head and tail are made ahead.
      speechParts: (parts, onPart) => this.naturalVoice.partClips(parts, onPart),
      streamsReadBack: () =>
        this.naturalVoice.usable && addonSupports(this.gatewayStatusReader().peek().version, READBACK_STREAM_ADDON),
      prepareSpeech: (texts) => this.readBackClips.prepareTexts(texts),
      // An add-on from 0.20.0 plays the Mac's clip on a refusal: the lines the Mac says are made ahead, locally.
      refusalAudio: () =>
        this.naturalVoice.usable && addonSupports(this.gatewayStatusReader().peek().version, VOICE_MENU_ADDON),
      prepareMacSays: (texts) => this.naturalVoice.prewarm(texts).then(() => undefined),
      // Questions and status by phone: read-only, from the chat's own transcript; nothing reaches the replier.
      describe: (target, label) => {
        const input = this.chatBriefInputs(target, label);
        return input ? statusReadout(input) : null;
      },
      answer: async (target, label, question) => {
        const input = this.chatBriefInputs(target, label);
        if (!input) throw new Error("chat not found");
        return this.chatQuestioner.ask(question, input);
      },
      // Voice-first calls: what a spoken reply meant. It only proposes words; the person's yes sends them.
      converse: async (target, label, say) => {
        const input = this.chatBriefInputs(target, label);
        if (!input) throw new Error("chat not found");
        // A call in has no script: the options are whatever the agent's last message lettered, if it did.
        const options =
          say.options.length > 0
            ? say.options
            : (parseChoices(input.lastTurnText ?? input.session.detail ?? null)?.options ?? []);
        return this.chatConverser.converse({ ...say, options }, input);
      },
      endCall: (callId) => this.chatConverser.end(callId),
      terse: () => isTerse(this.voiceSettings.settings.persona),
      // Waiting lines in the owner's character, for an add-on from 0.20.0 (it ignores them before).
      fillers: () =>
        addonSupports(this.gatewayStatusReader().peek().version, VOICE_MENU_ADDON)
          ? this.voiceFillers.current(this.voiceSettings.settings.persona)
          : null,
      // Menus answered by voice: an add-on from 0.20.0 listens and sends the recording up; Whisper is this Mac's (calling in
      // is off without it), and the match is deterministic.
      pickByVoice: () =>
        this.voiceSettings.menusByVoice() && addonSupports(this.gatewayStatusReader().peek().version, VOICE_MENU_ADDON),
      // The newest chat waiting on the person offered first on a call in (an owner's setting, off by default).
      offerWaitingChat: () => this.voiceSettings.offerWaitingChat(),
      // A new chat from a call in: the same `startChat` as the phone app, with the owner's model pick for calls.
      newChat: {
        supported: () => addonSupports(this.gatewayStatusReader().peek().version, NEW_CHAT_ADDON),
        workspaceId: (key) => {
          try {
            return findNewChatWorkspace(this.config.conductorDbPath, key)?.id ?? null;
          } catch {
            return null;
          }
        },
        model: () => this.newChatCallModel(),
        start: (args) =>
          newChatControl({ conductorDbPath: this.config.conductorDbPath, relay: this.conductorRelay }).startChat({
            workspaceId: args.workspaceId,
            text: args.text,
            ...(args.model
              ? {
                  agent: args.model.agent,
                  model: args.model.id,
                  ...(args.model.level ? { thinking: args.model.level } : {}),
                }
              : {}),
          }),
      },
      // Offered after a message the person approved: stay on the line while it works, a key for its thinking.
      hold: {
        supported: () => addonSupports(this.gatewayStatusReader().peek().version, HOLD_ADDON),
        state: (target, label) => {
          const input = this.chatBriefInputs(target, label);
          return input ? (input.session.state === "working" ? "working" : "stopped") : null;
        },
        ended: (target, label) => {
          const input = this.chatBriefInputs(target, label);
          return input ? endedReadout(input, isTerse(this.voiceSettings.settings.persona)) : "It has stopped.";
        },
        peek: (target, label) => {
          const input = this.chatBriefInputs(target, label);
          return input ? thinkingReadout(input) : null;
        },
      },
      requestCallback: (target, label, note, afterSend) => this.requestCallback(target, label, note, afterSend),
      speech: async (text) => (await this.promptClips.clips([text]))[0],
      // An add-on from 0.17.0 plays an answer sentence by sentence as it is made; an older one gets one whole clip.
      speechStream: (text, onPart, laterMin) =>
        this.naturalVoice.sentenceClips(text, onPart, laterMin === undefined ? {} : { laterMin }),
      speechPace: () => this.naturalVoice.pace(),
      streamsAnswers: () =>
        this.naturalVoice.usable && addonSupports(this.gatewayStatusReader().peek().version, ANSWER_STREAM_ADDON),
      note: (text) => this.announceCallNote(text),
      trace: (kind, text, extra) => this.traceMac(kind, text, extra),
    });
  }

  /** The "New chats from calls use" pick as a preset Conductor still offers; null (the workspace's usual model) when unset or gone. */
  private newChatCallModel(): { id: string; level?: string; agent: "claude" | "codex"; label: string } | null {
    const pick = this.voiceSettings.settings.newChatModel;
    if (!pick) return null;
    try {
      const preset = listChatModels(this.config.conductorDbPath).find((model) => model.id === pick.id);
      if (!preset) return null;
      const level = pick.level && preset.levels.includes(pick.level) ? pick.level : undefined;
      return { id: preset.id, agent: preset.agent, label: preset.label, ...(level ? { level } : {}) };
    } catch {
      return null;
    }
  }

  /** The model presets for the picker in both apps (`voiceView().chatModels`); empty when Conductor cannot be read. */
  private callChatModels() {
    try {
      return listChatModels(this.config.conductorDbPath).map((model) => ({
        id: model.id,
        label: model.label,
        agent: model.agent,
        levels: model.levels,
        ...(model.defaultLevel ? { defaultLevel: model.defaultLevel } : {}),
      }));
    } catch {
      return [];
    }
  }

  /**
   * A call back asked for on a call. Without a message just sent, the chat must be working: there is nothing to wait
   * for otherwise, and saying so beats a promise that never rings.
   */
  private requestCallback(
    target: string,
    label: string,
    note: string,
    afterSend: boolean,
  ): { ok: true } | { ok: false; reason: string } {
    const session = this.runtime.monitor.snapshot.sessions.find((s) => replyTargetFor(s) === target);
    if (!session) return { ok: false, reason: REFUSED_SAYS.noCallbackChat };
    if (!afterSend && session.state !== "working") {
      return { ok: false, reason: nothingRunning(label) };
    }
    const request = this.voiceCallbacks.add(target, label, note, session.state === "working");
    return request ? { ok: true } : { ok: false, reason: REFUSED_SAYS.tooManyCallbacks };
  }

  /** What a call may read about one chat: its state, steps, last message, changes and background work. */
  private chatBriefInputs(target: string, label: string): ChatBriefInputs | null {
    const session = this.runtime.monitor.snapshot.sessions.find((s) => replyTargetFor(s) === target);
    if (!session) return null;
    const nowMs = Date.now();
    const safely = <T>(read: () => T, fallback: T): T => {
      try {
        return read();
      } catch {
        return fallback;
      }
    };
    return {
      session,
      label,
      nowMs,
      lastTurnText: safely(() => this.router.lastTurnText(target), null),
      history: safely(() => this.router.transcript(target, 8).messages, []),
      activity: session.transcriptPath
        ? safely(() => readActivity(session.agent, session.transcriptPath!), null)
        : null,
      background: session.transcriptPath
        ? safely(() => this.backgroundWork.read(session.transcriptPath!, nowMs), [])
        : [],
    };
  }

  /** The chats that can take a message right now, those waiting on you first, then the newest. */
  private memoTargets(): MemoTarget[] {
    const snapshot = this.runtime.monitor.snapshot;
    const needing = new Set(snapshot.attention.map((item) => item.session.key));
    const ordered = snapshot.active
      .filter((session) => !session.retired && canTakeMessageNow(session, this.router))
      .sort(
        (a, b) =>
          Number(needing.has(b.key)) - Number(needing.has(a.key)) ||
          Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
      );
    const spoken = spokenChats(ordered, workspaceKeyOf);
    // A workspace is said as its repo; the branch is added only where two workspaces in the list share that repo.
    const keysByRepo = new Map<string, Set<string | null>>();
    for (const session of ordered) {
      const repo = spokenWorkspace(session, false).toLowerCase();
      keysByRepo.set(repo, (keysByRepo.get(repo) ?? new Set<string | null>()).add(workspaceKeyOf(session)));
    }
    const sharesRepo = (session: (typeof ordered)[number]): boolean =>
      (keysByRepo.get(spokenWorkspace(session, false).toLowerCase())?.size ?? 0) > 1;
    return ordered.map((session) => ({
      target: replyTargetFor(session),
      label: spoken.get(session.key) ?? spokenChat(session),
      workspace: workspaceKeyOf(session),
      workspaceLabel: spokenWorkspace(session, sharesRepo(session)),
      waiting: needing.has(session.key),
    }));
  }

  /** A favourite's spoken name: its live workspace, else the stored label made speakable (no "…"). */
  private spokenFavoriteLabel(fav: { workspace: string; label: string }): string {
    const session = this.runtime.monitor.snapshot.sessions
      .filter((s) => workspaceKeyOf(s) === fav.workspace)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];
    return session ? spokenWorkspace(session) : cutAtWord(speakable(fav.label), 50) || "a workspace";
  }

  /** A workspace's current spoken name, from its newest live session; null when none is known. */
  private workspaceLabel(key: string): string | null {
    const session = this.runtime.monitor.snapshot.sessions
      .filter((s) => workspaceKeyOf(s) === key)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];
    return session ? cardLabel(session) : null;
  }

  /** Workspaces a favourite can be set on: distinct, live, newest first. */
  private voiceWorkspaces(): Array<{ key: string; label: string }> {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string }> = [];
    const sessions = [...this.runtime.monitor.snapshot.sessions].sort(
      (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
    for (const session of sessions) {
      const key = workspaceKeyOf(session);
      if (!key || seen.has(key) || session.retired || session.workspaceRetired) continue;
      seen.add(key);
      out.push({ key, label: cardLabel(session) });
      if (out.length >= 40) break;
    }
    return out;
  }

  private startMemoInbox(): void {
    const inbox = this.memoInbox;
    if (!inbox) return;
    inbox.start();
    // The list follows the fleet: a short pause so a burst of changes is one write.
    this.memoUnwatch = this.runtime.monitor.onSnapshot(() => {
      if (this.memoTimer) return;
      this.memoTimer = setTimeout(() => {
        this.memoTimer = null;
        void inbox.publish().catch(() => undefined);
      }, 3000);
    });
  }

  private stopMemoInbox(): void {
    this.memoUnwatch?.();
    this.memoUnwatch = null;
    if (this.memoTimer) clearTimeout(this.memoTimer);
    this.memoTimer = null;
    this.memoInbox?.stop();
  }

  private gatewayPairing: GatewayPairing | null = null;
  private gatewayClaim: GatewayClaim | null = null;
  private gatewayStatus: GatewayStatusReader | null = null;
  private gatewayLog: GatewayLogReader | null = null;
  private callHistory: CallHistory | null = null;

  private callTrace: CallTrace | null = null;
  private traceTimer: NodeJS.Timeout | null = null;
  private traceInterval: NodeJS.Timeout | null = null;

  private callTraceStore(): CallTrace {
    this.callTrace ??= new CallTrace(this.config.supportDir);
    return this.callTrace;
  }

  /** One line in the Calls page's log from this Mac; the add-on's side is read 6 s later, once it has published. */
  private traceMac(
    kind: "step" | "said" | "heard" | "key" | "warn",
    text: string,
    extra?: { ms?: number; label?: string },
  ): void {
    this.callTraceStore().mac(kind, text, extra);
    if (this.traceTimer) return;
    this.traceTimer = setTimeout(() => {
      this.traceTimer = null;
      void this.ingestGatewayLog();
    }, 6_000);
    this.traceTimer.unref();
  }

  /** Reads the add-on's log into the trace (and returns it, for the app); never throws. */
  private async ingestGatewayLog(): Promise<Awaited<ReturnType<GatewayLogReader["read"]>>> {
    const log = await (this.gatewayLogReader()?.read() ?? Promise.resolve(null)).catch(() => null);
    if (log) this.callTraceStore().ingestGateway(log.lines);
    return log;
  }

  /** At start, and every 90 s while a call was logged in the last 15 min. */
  private startTraceWatch(): void {
    void this.ingestGatewayLog();
    this.traceInterval = setInterval(() => {
      if (this.callTraceStore().activeSince(Date.now() - 15 * 60_000)) void this.ingestGatewayLog();
    }, 90_000);
    this.traceInterval.unref();
  }

  private stopTraceWatch(): void {
    if (this.traceTimer) clearTimeout(this.traceTimer);
    if (this.traceInterval) clearInterval(this.traceInterval);
    this.traceTimer = null;
    this.traceInterval = null;
  }

  private callHistoryStore(): CallHistory {
    this.callHistory ??= new CallHistory(path.join(this.config.supportDir, "voice-calls.json"));
    return this.callHistory;
  }

  /** The add-on's log reader, or null without a relay (the call list is still served). */
  private gatewayLogReader(): GatewayLogReader | null {
    const { voiceRelay } = this.config;
    if (!voiceRelay || !this.cloud) return null;
    this.gatewayLog ??= new GatewayLogReader({
      store: this.cloud,
      relay: () => {
        const { voiceRelay: relay } = this.config;
        return relay && this.cloud ? { channel: relay.channel, key: relay.key } : null;
      },
    });
    return this.gatewayLog;
  }

  /** The pairing window's owner, made on first use; null unless the phone channel's own database is set up. */
  private gatewayPairingFor(): GatewayPairing | null {
    const { remoteDatabaseUrl, remoteShared } = this.config;
    if (!this.cloud || remoteShared) return null;
    this.gatewayPairing ??= new GatewayPairing({
      store: this.cloud,
      databaseUrl: remoteDatabaseUrl ?? "",
      location: () => this.cloud?.location ?? null,
      current: () =>
        this.config.voiceRelay ? { channel: this.config.voiceRelay.channel, key: this.config.voiceRelay.key } : null,
      save: (channel, key) =>
        setEnvValues(resolveSqueakEnvPath(), { SQUEAK_VOICE_RELAY_CHANNEL: channel, SQUEAK_VOICE_RELAY_KEY: key }),
      // launchd's KeepAlive starts the daemon again, now with the relay.
      restart: () => {
        logger.info("gateway paired; restarting to use it");
        process.exit(0);
      },
    });
    return this.gatewayPairing;
  }

  /** The short-code claim's owner; null unless the phone channel's own database is set up (never in shared mode). */
  private gatewayClaimFor(): GatewayClaim | null {
    const { remoteDatabaseUrl, remoteShared } = this.config;
    if (!this.cloud || remoteShared) return null;
    this.gatewayClaim ??= new GatewayClaim({
      store: new RtdbRest(RENDEZVOUS_DATABASE),
      databaseUrl: remoteDatabaseUrl ?? "",
      location: () => this.cloud?.location ?? null,
      current: () =>
        this.config.voiceRelay ? { channel: this.config.voiceRelay.channel, key: this.config.voiceRelay.key } : null,
      save: (channel, key) =>
        setEnvValues(resolveSqueakEnvPath(), { SQUEAK_VOICE_RELAY_CHANNEL: channel, SQUEAK_VOICE_RELAY_KEY: key }),
      restart: () => {
        logger.info("gateway paired; restarting to use it");
        process.exit(0);
      },
    });
    return this.gatewayClaim;
  }

  private gatewayStatusReader(): GatewayStatusReader {
    this.gatewayStatus ??= new GatewayStatusReader({
      store: this.cloud ?? new RtdbRest("https://unset.firebaseio.com"),
      relay: () => {
        const { voiceRelay } = this.config;
        return voiceRelay && this.cloud ? { channel: voiceRelay.channel, key: voiceRelay.key } : null;
      },
    });
    return this.gatewayStatus;
  }

  private previewingVoice = false;

  private async previewVoice(voice: string, engine?: string, speed?: number): Promise<Buffer | null> {
    if (engine !== undefined && !isEngineId(engine)) return null;
    if (this.previewingVoice) return null;
    this.previewingVoice = true;
    try {
      return await this.naturalVoice.preview(voice, engine, speed);
    } finally {
      this.previewingVoice = false;
    }
  }

  /**
   * The realistic voice in `voiceView`: `installed`, `enabled`, `voice` and `voices` are the current engine's (what a
   * client that knows only Kokoro reads), `engines` lists every engine with its own voices and pick.
   */
  private naturalView() {
    const { enabled, engine, emotion, speed, voice } = this.naturalSettings.settings;
    const installed = (id: EngineId) => naturalInstalled(naturalPaths(this.config.supportDir, id));
    // A cloning engine lists only the voices whose reference clip exists; its pick shows what it speaks now.
    const offered = (id: EngineId) => availableVoices(naturalPaths(this.config.supportDir, id), id);
    return {
      installed: installed(engine),
      enabled,
      voice,
      voices: offered(engine),
      engine,
      emotion,
      speed,
      engines: ENGINE_IDS.map((id) => {
        const spec = VOICE_ENGINES[id];
        return {
          id,
          label: spec.label,
          summary: spec.summary,
          size: spec.size,
          installed: installed(id),
          emotion: spec.emotion,
          voices: offered(id),
          voice: this.naturalSettings.spoken(id),
          licence: spec.licence,
        };
      }),
    };
  }

  /** What the prompt and read-back caches key a voice by: another engine, voice, emotion level or speed never reuses a clip. */
  /** The voice call-in prompts are recorded in: the Mac's when it can speak, else the add-on's own. */
  private promptVoiceKey(): string {
    return this.naturalVoice.usable ? this.naturalVoiceKey() : "add-on";
  }

  private naturalVoiceKey(): string {
    const { engine, voice, emotion, speed } = this.naturalSettings.settings;
    // Speed 1 keeps the key it always had, so nothing already recorded is thrown away.
    const pace = speed === 1 ? "" : `:x${speed}`;
    return `${engine}:${voice}:${VOICE_ENGINES[engine].emotion ? emotion : "none"}${pace}`;
  }

  /**
   * The one place the realistic voice's settings change (the Mac app's route and the phone's signed command). A new
   * engine, voice or emotion level starts the engine and makes the fixed call phrases again while no call waits.
   */
  private applyNatural(request: unknown): { ok: true } | { ok: false; reason: string } {
    const before = this.promptVoiceKey();
    const outcome = this.naturalSettings.apply(request);
    if (outcome.ok && this.promptVoiceKey() !== before) {
      // The call-in prompts were recorded in the old voice: publish them again (the list's version names the voice).
      this.prepareVoice();
      void this.memoInbox?.publish().catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Gets the current voice ready for calls and tracks it in `voiceReadiness`: loads the engine and renders the fixed
   * phrases while no call waits, then (with a memo inbox) the prompts are recorded and sent to the add-on, which makes
   * it ready. Without one, ready once the engine is warm. A newer change restarts it; the old voice's reports are
   * ignored by key.
   */
  private prepareVoice(): void {
    const key = this.promptVoiceKey();
    const usable = this.naturalVoice.usable;
    const publishes = this.memoInbox !== null;
    const label = usable ? this.naturalVoiceLabel() : "the add-on's voice";
    if (!usable) {
      if (publishes) this.voiceReadiness.begin(key, label, "sending");
      else this.voiceReadiness.beginReady(key, label);
      return;
    }
    this.voiceReadiness.begin(key, label);
    void this.naturalVoice
      .warm()
      .then(async (warmed) => {
        if (!warmed) {
          this.voiceReadiness.fail(key);
          return;
        }
        if (this.memoInbox) this.voiceReadiness.recording(key);
        await this.naturalVoice.prewarm(fixedPhrases());
        if (!this.memoInbox) this.voiceReadiness.ready(key);
      })
      .catch(() => this.voiceReadiness.fail(key));
  }

  /**
   * Ming and Chatterbox installed before the shared voice list have no reference clips for it: Kokoro makes them in the
   * background (installing Kokoro first if it is missing). Their voices appear as each clip does, and a call meanwhile
   * uses Heart or the add-on's voice; once they exist the call phrases are made again for the new voice.
   */
  private makeMissingReferenceClips(): void {
    const stop = new AbortController();
    this.stopReferenceClips = () => stop.abort();
    void ensureReferenceClips(this.config.supportDir, {
      signal: stop.signal,
      log: (detail) => logger.warn("voice reference clips", { detail }),
    })
      .then((engines) => {
        if (engines.length > 0 && !stop.signal.aborted) this.prepareVoice();
      })
      .catch(() => undefined);
  }
  private stopReferenceClips: () => void = () => undefined;

  /** The current voice's name as a sentence says it ("Sohee"). */
  private naturalVoiceLabel(): string {
    const { engine, voice } = this.naturalSettings.settings;
    const found = VOICE_ENGINES[engine].voices.find((item) => item.id === voice);
    return readinessVoiceLabel(found?.label ?? voice);
  }

  /** Phones and the cloud learn of a readiness change; progress alone at most every 2 s, the last one never lost. */
  private nudgeReadiness(progressOnly: boolean): void {
    const send = () => {
      this.readinessNudgedAt = Date.now();
      if (this.readinessNudge) clearTimeout(this.readinessNudge);
      this.readinessNudge = null;
      this.remote?.changed();
    };
    if (!progressOnly) return send();
    const wait = 2_000 - (Date.now() - this.readinessNudgedAt);
    if (wait <= 0) return send();
    if (!this.readinessNudge) {
      this.readinessNudge = setTimeout(send, wait);
      this.readinessNudge.unref?.();
    }
  }

  /** Whether voice is set up and who it rings: what `GET /control/voice` carries. */
  private voiceView() {
    const { voice, voiceRelay } = this.config;
    const mode = voiceRelay && this.cloud ? "gateway" : voice ? "direct" : "off";
    return {
      mode,
      callee: this.voiceSettings.settings.callee,
      defaultCallee: voice?.callee ?? null,
      pin: this.voicePinState(),
      ...this.voicePolicyView(),
      pause: this.voiceSettings.pause(),
      persona: {
        ...(this.voiceSettings.settings.persona ?? DEFAULT_PERSONA),
        // A custom character's waiting lines are written by `claude -p` (voice/fillers.ts), so a UI can say so.
        customLinesByClaude: true,
      },
      offerWaitingChat: this.voiceSettings.offerWaitingChat(),
      menusByVoice: this.voiceSettings.menusByVoice(),
      // When a question rings the phone: every key present, the defaults where the owner changed nothing.
      hold: this.voiceSettings.hold(),
      // The model a chat started from a call uses (null: the workspace's usual one) and the presets to pick from.
      newChatModel: this.voiceSettings.settings.newChatModel ?? null,
      chatModels: this.callChatModels(),
      favorites: this.voiceFavorites.list(),
      workspaces: this.voiceWorkspaces(),
      // The realistic voice this Mac makes for calls (`squeak voice-tts-setup` installs it).
      natural: { ...this.naturalView(), ...this.readinessView() },
      ...(mode === "gateway" ? { gateway: this.gatewayView() } : {}),
      // Absent until a test has been asked for.
      ...(this.voiceTest ? { lastTest: this.voiceTest } : {}),
    };
  }

  private readinessView(): { readiness?: NonNullable<VoiceReadinessTracker["state"]> } {
    const readiness = this.voiceReadiness.state;
    return readiness ? { readiness } : {};
  }

  private gatewayView() {
    const { state, version, latestVersion: reported, sipRegistered, sipError } = this.gatewayStatusReader().peek();
    // Look in the background when the last look is old; the view never waits for it.
    const checkedAt = this.addonVersions.checkedAt();
    if (checkedAt === undefined || Date.now() - checkedAt > 30 * 60_000) void this.addonVersions.latest();
    const fetched = this.addonVersions.peek();
    const latestVersion = isNewer(fetched, reported) || (reported === undefined && fetched) ? fetched : reported;
    return {
      state,
      ...(version !== undefined ? { version } : {}),
      ...(latestVersion != null ? { latestVersion } : {}),
      // Computed here so every surface agrees: strictly newer than the running version, false when either is unknown.
      updateAvailable: isNewer(latestVersion, version),
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(sipRegistered !== undefined ? { sipRegistered } : {}),
      ...(sipError ? { sipError } : {}),
    };
  }

  /** `POST /control/voice/gateway/check`: look up the newest add-on version now. */
  private async checkGatewayAddon(): Promise<
    | { ok: true; latestVersion?: string; updateAvailable: boolean; checkedAt?: number }
    | { ok: false; reason: string; status: 502 | 503 }
  > {
    if (!this.voiceRelayLine) {
      return { ok: false, reason: "Phone calls don't go through a Home Assistant add-on on this Mac.", status: 503 };
    }
    // Best effort, in parallel with the daemon's own look: the add-on asks Home Assistant to refresh and reads the
    // repo itself. A silent or old add-on changes nothing here; its answer is never the route's.
    const asked = this.voiceRelayLine.gatewayCommand("check", 10_000).catch(() => ({ ok: false as const }));
    await this.addonVersions.latest(true);
    if ((await asked).ok)
      await this.gatewayStatusReader()
        .read(true)
        .catch(() => undefined);
    if (!this.addonVersions.lastOk()) {
      return {
        ok: false,
        reason: "Could not look up the newest version. Check your internet connection.",
        status: 502,
      };
    }
    const view = this.gatewayView();
    return {
      ok: true,
      ...(view.latestVersion !== undefined ? { latestVersion: view.latestVersion } : {}),
      updateAvailable: view.updateAvailable,
      ...(view.checkedAt !== undefined ? { checkedAt: view.checkedAt } : {}),
    };
  }

  /**
   * Tells the add-on to update itself (Home Assistant restarts it): the Mac app's route and the phone's signed
   * command end here. Only when the add-on reported a newer version; the add-on checks again itself.
   */
  private async updateGatewayAddon(): Promise<{ ok: true } | { ok: false; reason: string; status: 400 | 503 }> {
    const line = this.voiceRelayLine;
    if (!line) {
      return { ok: false, reason: "Phone calls don't go through a Home Assistant add-on on this Mac.", status: 503 };
    }
    if (!this.gatewayView().updateAvailable) {
      return { ok: false, reason: "The add-on is already on the newest version.", status: 400 };
    }
    // The add-on writes its reply BEFORE Home Assistant stops it, but the checks before that (reload the add-on list,
    // read its record) take time, and the stop can cut the reply off. No reply at all is therefore "probably
    // updating": the Mac confirms by the add-on coming back with the new version, and says so after ~2 minutes if not.
    const outcome = await line.gatewayCommand("update", 60_000);
    if (outcome.ok) return outcome;
    if (outcome.reason === OLD_ADDON) return { ok: true };
    return { ok: false, reason: outcome.reason, status: 400 };
  }

  /** Where the pin stands, never the pin. Gateway: the add-on's last answer, refreshed when older than a minute. */
  private voicePinState(): PinState | "unknown" {
    if (this.voicePins) return this.voicePins.status();
    if (this.voiceRelayLine && Date.now() - this.voicePinCache.at > 60_000) void this.refreshVoicePin();
    return this.voicePinCache.state;
  }

  /** `policy` when known; absent from an older add-on. */
  private voicePolicyView(): { policy?: PinPolicy } {
    const policy = this.voicePins ? this.voicePins.policy() : this.voicePolicyCache;
    return policy ? { policy: { outgoing: policy.outgoing, incoming: policy.incoming } } : {};
  }

  /** Asks the add-on where the pin stands (fire and forget); a silent or old add-on leaves the last state. */
  private async refreshVoicePin(): Promise<void> {
    const line = this.voiceRelayLine;
    if (!line || this.voicePinAsking) return;
    this.voicePinAsking = true;
    // Stamp first: a failure is retried in a minute, not on every read.
    this.voicePinCache = { ...this.voicePinCache, at: Date.now() };
    try {
      const answer = await line.pinControl({ action: "status" });
      if (answer.ok) {
        const before = `${this.voicePinCache.state}|${JSON.stringify(this.voicePolicyCache)}`;
        this.voicePinCache = { state: answer.state, at: Date.now() };
        if (answer.policy) this.voicePolicyCache = answer.policy;
        if (before !== `${answer.state}|${JSON.stringify(this.voicePolicyCache)}`) this.remote?.changed();
      }
    } catch {
      // Unknown stays unknown.
    } finally {
      this.voicePinAsking = false;
    }
  }

  /**
   * One place a pin action ends: the Mac app's `POST /control/voice` and the phone's signed command. Direct mode asks
   * the local keeper, gateway mode the add-on through the relay. A pin is never logged.
   */
  private async runPinAction(action: PinAction): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.voicePins) {
      const keeper = this.voicePins;
      const outcome =
        action.action === "change"
          ? keeper.change(action.current, action.next)
          : action.action === "policy"
            ? keeper.setPolicy({ outgoing: action.outgoing, incoming: action.incoming })
            : action.action === "disable"
              ? keeper.disable(action.current)
              : action.action === "enable"
                ? keeper.enable(action.next)
                : keeper.reset(action.next);
      if (outcome.ok) this.remote?.changed();
      return outcome.ok ? { ok: true } : outcome;
    }
    const line = this.voiceRelayLine;
    if (!line) return { ok: false, reason: "Phone calls are not set up on this Mac." };
    const outcome = await line.pinControl(action);
    if (outcome.ok) {
      this.voicePinCache = { state: outcome.state, at: Date.now() };
      if (outcome.policy) this.voicePolicyCache = outcome.policy;
      else if (action.action === "policy")
        this.voicePolicyCache = { outgoing: action.outgoing, incoming: action.incoming };
      this.remote?.changed();
      return { ok: true };
    }
    return outcome;
  }

  /** A new pin for the gateway, from an app: only through the relay, and only with the current pin. */
  private async changeVoicePin(current: string, next: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.runPinAction({ action: "change", current, next });
  }

  /**
   * A test call from an app: rings with a made-up question and answers at once; the outcome lands in `lastTest`
   * (the phone and Mac app read it from the view). It touches no chat, and one at a time, 15 s apart.
   */
  private testVoiceCall(): { ok: true } | { ok: false; reason: string } {
    const line = this.voiceLine;
    if (!line) return { ok: false, reason: "Phone calls are not set up on this Mac." };
    if (this.voiceTest?.status === "ringing") return { ok: false, reason: "A test call is already ringing." };
    if (this.voiceTest && Date.now() - this.voiceTest.at < 15_000) {
      return { ok: false, reason: "Wait a few seconds before another test call." };
    }
    const placedAt = Date.now();
    this.voiceTest = { at: placedAt, status: "ringing" };
    this.remote?.changed();
    const history = this.callHistoryStore();
    const writeDown = (outcome: "answered" | "unanswered" | "failed", extra: { letter?: string; failure?: string }) =>
      history.record({ at: placedAt, kind: "test", outcome, durationMs: Date.now() - placedAt, ...extra });
    void line
      .call(TEST_SCRIPT, true)
      .then((result) => {
        if (result.status === "failed") writeDown("failed", { failure: result.reason });
        else if (result.status === "unanswered") writeDown("unanswered", {});
        else writeDown("answered", result.letter ? { letter: result.letter } : {});
        this.voiceTest =
          result.status === "failed"
            ? { at: Date.now(), status: "failed", reason: result.reason }
            : result.status === "unanswered"
              ? { at: Date.now(), status: "unanswered" }
              : {
                  at: Date.now(),
                  status: "answered",
                  ...(result.letter ? { letter: result.letter } : {}),
                  ...(result.quality ? { quality: result.quality } : {}),
                };
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        writeDown("failed", { failure: reason });
        this.voiceTest = { at: Date.now(), status: "failed", reason };
      })
      .finally(() => this.remote?.changed());
    return { ok: true };
  }

  /** The callee setting only (the phone's signed command, which handles pin actions itself). */
  private applyVoiceSettings(request: unknown) {
    // The realistic voice and the quick workspaces end in the same stores as the Mac app's route.
    const phone = applyPhoneVoiceChange(request, {
      natural: {
        installed: () => ENGINE_IDS.some((id) => naturalInstalled(naturalPaths(this.config.supportDir, id))),
        apply: (natural) => this.applyNatural(natural),
      },
      favorites: this.voiceFavorites,
      knownWorkspaces: () => new Set(this.voiceWorkspaces().map((w) => w.key)),
      currentFavorites: () => this.voiceFavorites.list(),
    });
    if (phone) {
      if (phone.ok && typeof request === "object" && request !== null && "favorites" in request) {
        void this.memoInbox?.publish().catch(() => undefined);
      }
      return phone.ok ? { ok: true as const, state: this.voiceView() } : phone;
    }
    const outcome = this.voiceSettings.apply(request);
    // A persona change decides what the next call in says first: publish the list again so the add-on sees it. A custom
    // one's waiting lines are made in the background (the friendly set stands in until they are), then published again.
    if (outcome.ok) {
      this.voiceFillers.refresh(this.voiceSettings.settings.persona);
      void this.memoInbox?.publish().catch(() => undefined);
    }
    return outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome;
  }

  private applyVoice(request: unknown) {
    // `{ test: true }`: a test call, the same function as the phone's signed `test` command.
    if (
      typeof request === "object" &&
      request !== null &&
      !Array.isArray(request) &&
      Object.keys(request).join(",") === "test" &&
      (request as { test: unknown }).test === true
    ) {
      const outcome = this.testVoiceCall();
      return Promise.resolve(outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome);
    }
    // `{ pin: PinAction }`: the pin controls (the Mac app does Touch ID before a reset). Nothing else rides along.
    if (typeof request === "object" && request !== null && !Array.isArray(request) && "pin" in request) {
      const keys = Object.keys(request);
      const action = keys.length === 1 ? parsePinAction((request as { pin: unknown }).pin) : null;
      if (!action) return Promise.resolve({ ok: false as const, reason: "A pin is 4 to 12 digits." });
      return this.runPinAction(action).then((outcome) =>
        outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome,
      );
    }
    if (typeof request === "object" && request !== null && !Array.isArray(request) && "natural" in request) {
      const keys = Object.keys(request);
      const natural = keys.length === 1 ? (request as { natural: unknown }).natural : null;
      const outcome = this.applyNatural(natural);
      return Promise.resolve(outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome);
    }
    if (typeof request === "object" && request !== null && !Array.isArray(request) && "favorites" in request) {
      const outcome = this.voiceFavorites.apply(request);
      if (outcome.ok) void this.memoInbox?.publish().catch(() => undefined);
      return Promise.resolve(outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome);
    }
    const outcome = this.voiceSettings.apply(request);
    // Who may call in is the same setting: tell the gateway now.
    if (outcome.ok) {
      this.voiceFillers.refresh(this.voiceSettings.settings.persona);
      void this.memoInbox?.publish().catch(() => undefined);
    }
    return outcome.ok ? { ok: true as const, state: this.voiceView() } : outcome;
  }

  /** The one place the send default changes: `POST /control/send-default` and the phone's signed `sendDefault`. */
  private applySendDefault(request: unknown) {
    const outcome = this.sendDefault.apply(request);
    return outcome.ok ? { ok: true as const, state: outcome.mode } : outcome;
  }

  /** The one place a setting changes: the Mac app's route and the phone's signed `notify` command both end here. */
  private applyNotify(request: unknown) {
    const outcome = this.notifySettings.apply(request);
    return outcome.ok ? { ok: true as const, state: this.notifyView() } : outcome;
  }

  private readonly claudeAccounts = new ClaudeAccountSwitcher();

  /** The saved Claude accounts for the phone's view: only when this Mac can switch (claude-swap and two accounts). */
  private claudeAccountsView() {
    const list = this.claudeAccounts.list();
    return list.available ? list : null;
  }

  /**
   * The one place the Claude account changes: the Mac app's route and the phone's signed `claudeAccount` command
   * both end here. Exactly `{ use: name }`. Afterwards the usage reading is asked to refresh (it reads Claude Code's
   * own sign-in, so it now reports the new account; the refresher's own one-a-minute guard may answer from cache).
   */
  private async applyClaudeAccount(request: unknown) {
    const keys = typeof request === "object" && request !== null && !Array.isArray(request) ? Object.keys(request) : [];
    if (keys.length !== 1 || keys[0] !== "use") {
      return { ok: false as const, reason: "Not a Claude account request this Mac understands." };
    }
    const outcome = await this.claudeAccounts.use((request as { use: unknown }).use);
    if (!outcome.ok) return outcome;
    void this.claudeRefresher.refresh().catch(() => undefined);
    return { ok: true as const, current: outcome.current, state: this.claudeAccounts.list() };
  }

  /** The one place a preset changes: the Mac app's route and the phone's signed `presets` command both end here. */
  private applyPresets(request: unknown) {
    const outcome = this.chatPresets.apply(request);
    return outcome.ok ? { ok: true as const, state: outcome.doc } : outcome;
  }

  private async applyHotspot(request: unknown) {
    const parsed = readHotspotRequest(request);
    return parsed
      ? this.hotspot.apply(parsed)
      : { ok: false as const, reason: "Not a hotspot request this Mac understands." };
  }

  /** The lid-open mode's display hold: a `caffeinate -d` child that dies with the daemon, so it cannot outlive it. */
  private screenHold: ChildProcess | null = null;
  private holdScreen(on: boolean): void {
    if (!on) {
      this.screenHold?.kill();
      this.screenHold = null;
      return;
    }
    if (this.screenHold && this.screenHold.exitCode === null) return;
    const child = spawn("/usr/bin/caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => {
      if (this.screenHold === child) this.screenHold = null;
    });
    child.unref();
    this.screenHold = child;
  }

  private async applyAwake(request: unknown) {
    // What a closed lid does: { action: "lid-actions", settings: { mute: false, ... } }.
    // Lid open's: { action: "lid-actions", mode: "open", settings: { screenOn: true } }.
    if ((request as { action?: unknown } | null)?.action === "lid-actions") {
      const { settings, mode } = request as { settings?: unknown; mode?: unknown };
      if (typeof settings !== "object" || settings === null) {
        return { ok: false as const, reason: "Expected settings." };
      }
      if (mode !== undefined && mode !== "open" && mode !== "closed") {
        return { ok: false as const, reason: "Mode must be open or closed." };
      }
      if (mode === "open") {
        this.lidActions.updateOpenSettings(readOpenSettings({ ...this.lidActions.openSettings, ...settings }));
      } else {
        this.lidActions.updateSettings(readLidActionSettings({ ...this.lidActions.settings, ...settings }));
      }
      return { ok: true as const, state: this.awake.state };
    }
    // The Mac app asks after installing fan control.
    if ((request as { action?: unknown } | null)?.action === "recheck-fans") {
      this.heat.recheckFanControl();
      await this.checkHeat(true);
      return { ok: true as const, state: this.awake.state };
    }
    // The Mac app asks after installing the energy mode rule.
    if ((request as { action?: unknown } | null)?.action === "recheck-power") {
      await this.energy.refresh(true);
      return { ok: true as const, state: this.awake.state };
    }
    // The Mac app asks after installing or removing the lid rule.
    if ((request as { action?: unknown } | null)?.action === "recheck-lid") {
      await this.refreshLidRule();
      return { ok: true as const, state: this.awake.state };
    }
    const action = readAwakeAction(request);
    if (!action) {
      return { ok: false as const, reason: "Not a request to change the awake session." };
    }
    if (action.kind === "start" && action.lid) {
      await this.refreshLidRule();
    }
    const outcome = applyAwakeAction(this.awake, action);
    // A session started on 8% battery should end now, not in a minute.
    if (outcome.ok && action.kind === "start") {
      await this.checkAwakeSafety();
      return { ok: true as const, state: this.awake.state };
    }
    return outcome;
  }

  /** Re-checks the sudoers rule; with it in, makes sure the backstop agent is there too. */
  private async refreshProjectIcons(): Promise<void> {
    if (await this.projectIcons.refresh()) {
      this.remote?.changed();
    }
  }

  private async refreshLidRule(): Promise<void> {
    if (!(await this.awake.refreshLidRule())) {
      return;
    }
    await ensureBackstop({
      supportDir: this.config.supportDir,
      journalPath: path.join(this.config.supportDir, "lid-journal.json"),
      actionsPath: path.join(this.config.supportDir, "lid-actions.json"),
    }).catch((error: unknown) => {
      logger.warn("awake backstop failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** A session's look at heat; outside one, a look a minute only so surfaces have a reading. */
  private heatLooks = 0;
  private async checkHeat(now = false): Promise<void> {
    // The controls page shows volume and brightness live while a phone looks.
    if (this.remote?.isPhoneOpen()) void this.controls.refresh();
    const active = this.awake.active;
    if (!active && !now && this.heatLooks++ % 4 !== 0) return;
    const power = active ? await readPower() : this.power;
    await this.heat.check({ battery: power?.batteryTemp ?? null, lidClosed: power?.lidClosed ?? null }, active);
  }

  private async checkAwakeSafety(): Promise<void> {
    // Home's Mac status strip shows the current energy mode from `/state`.
    // Refresh it with the existing minute power check so a change made in
    // macOS (outside Squeak) does not leave the strip showing an old mode.
    void this.energy.refresh();
    const before = JSON.stringify(this.power && phonePower(this.power));
    this.power = await readPower();
    if (JSON.stringify(phonePower(this.power)) !== before) this.remote?.changed();
    if (!this.awake.active) {
      return;
    }
    await this.awake.checkSafety(this.power, this.config.awakeSafety);
  }

  /** A safety rule ended a session: say so wherever the owner hears from Squeak. */
  /** A one-off note to every allowed Telegram chat and to Cliq. */
  private announce(text: string): void {
    for (const chatId of this.config.allowedChatIds ?? []) {
      void this.telegram?.sendMessage(chatId, text).catch(() => undefined);
    }
    void this.cliqWebhook?.post(text).catch(() => null);
  }

  /** One short text to one channel only (Telegram's allowed chats, or Cliq), counted like a card. */
  private pushToChannel(channel: NotifyChannel, text: string): void {
    this.pushCounter.record(channel);
    if (channel === "cliq") {
      void this.cliqWebhook?.post(text).catch(() => null);
      return;
    }
    for (const chatId of this.config.allowedChatIds ?? []) {
      void this.telegram?.sendMessage(chatId, text).catch(() => undefined);
    }
  }

  /**
   * What a call in did: the one text after it sent a message ("Call: sent your message to <chat>: ...") goes only to
   * a channel that is not muted and not in its quiet hours; any other note is announced as before.
   */
  private announceCallNote(text: string): void {
    const sent = parseSentNote(text);
    if (!sent) {
      this.announce(text);
      return;
    }
    const line = callSentText(sent.label, sent.message);
    const now = Date.now();
    for (const channel of NOTIFY_CHANNELS) {
      if (callNoteAllowed(this.notifySettings.settings[channel], now)) this.pushToChannel(channel, line);
    }
  }

  private announceAwakeEnd(end: AwakeEnd): void {
    if (end.reason !== "battery" && end.reason !== "heat") {
      return;
    }
    const text = `Squeak let your Mac sleep again: ${end.why ?? (end.reason === "heat" ? "it was too hot" : "the battery was low")}.`;
    for (const chatId of this.config.allowedChatIds ?? []) {
      void this.telegram?.sendMessage(chatId, text).catch(() => undefined);
    }
    void this.cliqWebhook?.post(text).catch(() => null);
  }

  private async pollLoop(telegram: TelegramClient): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await telegram.getUpdates(this.lastUpdateId + 1, this.config.pollTimeoutSeconds);
        this.telegramStatus.pollOk();
        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.telegramStatus.pollFailed(summarizeTelegramError(error).message);
        if (!isTransientTelegramError(error)) {
          logger.error("squeak poll failed", { error: summarizeTelegramError(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** A chat that is not allowed is remembered for the app to offer, never acted on. */
  private authorized(chat: TelegramChat): boolean {
    this.telegramStatus.noteChat(chat);
    return this.telegramStatus.isAllowed(chat.id);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const message = update.callback_query.message;
      if (!message || !this.authorized(message.chat)) {
        return;
      }
      const location: TelegramConversationTarget = {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
      };
      await this.telegram?.answerCallbackQuery(update.callback_query.id).catch(() => undefined);
      const result = await this.controller.handleCallback(
        location,
        update.callback_query.data ?? "",
        message.message_id,
      );
      if (result.notice) {
        await this.send(location, result.notice);
      }
      return;
    }

    const message = update.message;
    if (message && !message.text) {
      this.authorized(message.chat);
    }
    if (!message?.text || !this.authorized(message.chat)) {
      return;
    }
    const location: TelegramConversationTarget = {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id ?? null,
    };

    // A swipe-reply to a card, or text typed into a Reply prompt, is an answer
    // for that card's chat — even if it happens to start with a slash.
    const replyTo = message.reply_to_message?.message_id;
    if (replyTo !== undefined && (await this.controller.handleReplyMessage(location, replyTo, message.text))) {
      return;
    }

    const command = normalizeTelegramCommand(message.text.trim());
    switch (command) {
      case "/start":
      case "/radar":
      case "/status":
        await this.controller.showRadar(location);
        return;
      case "/snooze":
      case "/mute":
        await this.controller.handleCallback(location, "fleet:mute:60");
        await this.send(location, "Snoozed for an hour.");
        return;
      case "/unmute":
        await this.controller.handleCallback(location, "fleet:unmute");
        await this.send(location, "Unmuted.");
        return;
      case "/usage":
        await this.send(
          location,
          renderUsage(await this.runtime.monitor.refresh(), Date.now(), this.claudeLimits.latest()),
        );
        return;
      case "/hooks":
        await this.send(location, this.hookStatus());
        return;
      case "/help":
        await this.send(location, helpText());
        return;
      default:
        // Loose text has no addressee: there may be several chats waiting, and
        // guessing which one it was for would put words in the wrong chat.
        await this.send(
          location,
          replyTo !== undefined
            ? "That message is not one I can answer through. Reply to a card, or tap its Reply button."
            : "To answer a chat, swipe left on its card and reply, or tap Reply. /radar shows what is running.",
        );
    }
  }

  /**
   * A bad URL turns Cliq off rather than failing startup: launchd would
   * restart the daemon in a loop, and Telegram and the duck with it.
   */
  private createCliq(): CliqChannel | null {
    const url = this.config.cliqWebhookUrl;
    if (!url) {
      return null;
    }
    try {
      const webhook = new CliqWebhook(url);
      this.cliqWebhook = webhook;
      const twoWay = this.config.cliqTwoWay;
      return new CliqChannel({
        webhook,
        monitor: this.runtime.monitor,
        store: this.runtime.store,
        claudeLimits: () => this.claudeLimits.latest(),
        notify: channelFilter(this.notifySettings, "cliq", Date.now, this.pushCounter),
        pondInvites: this.pondInvites,
        inbound: twoWay
          ? {
              inbox: new CliqRelayInbox({
                // Streamed from the Realtime Database when configured, still
                // reading Firestore for handlers pasted before the move.
                store: this.config.remoteDatabaseUrl
                  ? new RtdbRest(this.config.remoteDatabaseUrl)
                  : new FirestoreRest(twoWay.projectId),
                legacy: this.config.remoteDatabaseUrl ? new FirestoreRest(twoWay.projectId) : null,
                relayId: twoWay.relayId,
                secret: twoWay.relaySecret,
                seen: this.runtime.store,
              }),
              replier: this.router,
              ownerId: twoWay.ownerId,
              ownerEmail: twoWay.ownerEmail,
              hookStatus: () => this.hookStatus(),
              ask: (question) =>
                this.assistant.ask(question, {
                  snapshot: this.runtime.monitor.snapshot,
                  lastTurnText: (session) => {
                    try {
                      return this.router.lastTurnText(replyTargetFor(session));
                    } catch {
                      return null;
                    }
                  },
                  activity: (session) =>
                    session.transcriptPath ? readActivity(session.agent, session.transcriptPath) : null,
                  canAnswer: (session) => canTakeMessageNow(session, this.router),
                  claudeLimits: this.claudeLimits.latest(),
                  nowMs: Date.now(),
                }),
              sessions: () => this.runtime.monitor.snapshot.sessions,
            }
          : null,
      });
    } catch (error) {
      logger.warn("cliq disabled", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Voice goes through the Home Assistant gateway when the relay is set up (any network), else the Mac
   * places the call itself (needs a route to the PBX). A bad setting was already turned into "off" by the config.
   */
  private createVoice(): VoiceChannel | null {
    const { voice, voiceRelay } = this.config;
    const base = {
      monitor: this.runtime.monitor,
      replier: this.router,
      note: (text: string) => this.announce(text),
      history: this.callHistoryStore(),
      trace: (kind: "step" | "said" | "warn" | "key", text: string, extra?: { ms?: number; label?: string }) =>
        this.traceMac(kind, text, extra),
      paused: () => this.voiceSettings.pause() !== null,
      // A missed call: the one retry, and the question as a text where the notify rules allow it and it has not gone.
      notify: {
        settings: () => this.notifySettings.settings,
        push: (channel: NotifyChannel, text: string) => this.pushToChannel(channel, text),
      },
    };
    if (voiceRelay && this.cloud) {
      // An add-on from 0.11.0 takes the Mac's voice while the phone rings; an older one needs it in the request, so
      // that render is kept short (the ring is silent for as long as it takes).
      const lateClips = (): boolean => addonSupports(this.gatewayStatusReader().peek().version, LATE_CLIPS_ADDON);
      const line = relayLineFor(
        this.cloud,
        voiceRelay,
        this.voiceSettings,
        async (script, _answerable, onClip) => {
          // Whether the add-on asks for a pin decides which of the dialog's words are worth recording.
          const pin = this.voicePinState();
          const began = Date.now();
          const clips = await renderCallClips(
            this.naturalVoice,
            script,
            pin === "set" ? "ask" : pin === "unknown" ? "both" : "none",
            onClip ? CLIPS_BUDGET_MS : OLD_ADDON_CLIPS_BUDGET_MS,
            Date.now,
            onClip,
          );
          const took = Date.now() - began;
          this.traceMac("step", `Rendered ${clips?.length ?? 0} voice clips in ${(took / 1000).toFixed(1)} s`, {
            ms: took,
          });
          return clips;
        },
        {
          lateClips,
          trace: (text) => this.traceMac("step", text),
          // A call out names the chat that asked, so 9 (a message) and 0 (its status) work on it.
          registerFollowUp: (callId, follow) =>
            this.memoInbox?.registerCall(callId, follow.target, follow.label, follow.script),
        },
      );
      this.voiceLine = line;
      this.voiceRelayLine = line;
      // Ask the add-on where the pin stands; the view says "unknown" until it answers.
      void this.refreshVoicePin();
      return new VoiceChannel({
        ...base,
        line,
        canTakeKeys: true,
        idleSeconds: () => readIdleSeconds(),
        followUp: () =>
          this.memoInbox !== null && addonSupports(this.gatewayStatusReader().peek().version, FOLLOW_UP_ADDON),
        // Talking a call through needs the inbox (and whisper), its model, and an add-on that runs the talk loop.
        voiceFirst: () =>
          this.memoInbox !== null && addonSupports(this.gatewayStatusReader().peek().version, VOICE_FIRST_ADDON),
        policy: new CallPolicy({ minGapMs: DEFAULT_MIN_GAP_MIN_MS, quiet: voiceRelay.quiet }),
        // "Call me back when you're done" is taken on a call (needs the inbox); an older add-on is told by a call.
        terse: () => isTerse(this.voiceSettings.settings.persona),
        hold: () => this.voiceSettings.hold(),
        callbacks: this.voiceCallbacks,
        callbackVoice: () =>
          this.memoInbox !== null && addonSupports(this.gatewayStatusReader().peek().version, CALLBACK_ADDON),
      });
    }
    if (voiceRelay) {
      logger.warn("voice relay needs SQUEAK_REMOTE_DATABASE_URL; voice is off");
    }
    if (!voice) {
      return null;
    }
    if (!voice.callee && !this.voiceSettings.settings.callee) {
      logger.warn("voice needs SQUEAK_VOICE_CALLEE or an extension in Settings; voice is off");
      return null;
    }
    this.voiceSpeaker = new NaturalSpeaker(this.naturalVoice, new MacSpeaker(voice.speechVoice));
    const pins = new PinKeeper(voice.pin, path.join(this.config.supportDir, "voice-pin.json"));
    this.voicePins = pins;
    const direct = new DirectLine(
      new BaresipLine(voice.line, this.voiceSpeaker),
      () => this.voiceSettings.settings.callee ?? voice.callee ?? "",
      () => pins.current(),
      () => pins.requiresPin(),
    );
    this.voiceLine = direct;
    return new VoiceChannel({
      ...base,
      line: direct,
      canTakeKeys: () => pins.answerable(),
      hold: () => this.voiceSettings.hold(),
      policy: new CallPolicy({ minGapMs: DEFAULT_MIN_GAP_MIN_MS, quiet: voice.quiet }),
    });
  }

  private hookStatus(): string {
    const installed = fleetHooksInstalled(defaultHookInstallPaths(this.config.supportDir));
    if (installed) {
      return [
        "**Hooks: installed**",
        `Ingress: 127.0.0.1:${this.config.hookPort}`,
        "",
        "Agents report state as it happens, and permission prompts reach you within a second.",
      ].join("\n");
    }
    return [
      "**Hooks: not installed**",
      `Ingress: 127.0.0.1:${this.config.hookPort}`,
      "",
      `Without them I poll every ${Math.round(this.config.pollIntervalMs / 1000)}s and **cannot see permission prompts at all**.`,
      "",
      "Install with `squeak install-hooks` on this Mac.",
    ].join("\n");
  }

  private async send(location: TelegramConversationTarget, text: string): Promise<void> {
    const telegram = this.telegram;
    if (!telegram) {
      return;
    }
    for (const chunk of splitMarkdown(text)) {
      await telegram
        .sendMessage(location.chatId, chunk, {
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        })
        .catch((error) => {
          logger.warn("squeak send failed", { error: summarizeTelegramError(error) });
        });
    }
  }
}

/** What the phone shows of the Mac's power: whole percent and watts, so a reading does not republish every minute. */
function phonePower(reading: PowerReading) {
  return {
    percent: reading.percent,
    onBattery: reading.onBattery,
    watts: reading.watts == null ? null : Math.round(reading.watts),
    lidClosed: reading.lidClosed ?? null,
  };
}

/** Heat as the phone shows it, while a session runs: whole degrees, rounded fan speeds. */
function phoneHeat(heat: HeatGovernor, active: boolean) {
  const state = heat.state;
  if (!active || (state.die === null && state.battery === null)) return null;
  return {
    level: state.level,
    chip: state.die,
    battery: state.battery,
    fansRpm: state.fansRpm,
    fansMax: state.fansMax,
    fanControl: state.fanControl,
  };
}
