import { FlotillaError, type Role } from "./types.js";

/**
 * PondEnding: the one module that owns every way a person's relationship with a Pond ends, and the one way a Pond
 * becomes shared (docs/ponds.md, "Ending a Pond" and "Sharing is a state").
 *
 * - `offer(pondId)`: what this person may do now (`delete`, `leave` or `forget`), in the words a surface draws. Surfaces
 *   never decide local versus shared; they draw what this returns.
 * - `end(pondId, kind)`: the cloud steps first, the local ones last. Each step is recorded in `ponds.json` (`ending`) before
 *   it runs, so a half-done end resumes on the next press or at start. A failing step is never swallowed: the Pond stays in
 *   "Deleting... couldn't finish" with the sentence, and pressing again carries on from that step.
 * - `removeMember(pondId, memberId)`: the Owner removes someone; the account index is settled or the removal says it could
 *   not finish, and the retry settles it.
 * - `share(pondId)`: idempotent and resumable (publish the Pond, then make it exist at the relay). `sharing(pondId)` is the
 *   state every surface draws: `local`, `sharing` (started, not finished) or `shared`.
 *
 * It knows nothing about documents, tokens or the relay: the service supplies each step through `EndingPort`.
 */

export type EndKind = "delete" | "leave" | "forget";
export type Sharing = "local" | "sharing" | "shared";

/** The steps a plan is made of; the port runs each one and every one is safe to run twice. */
export type EndStep =
  | "remove" // a local Pond: the project is removed from Squeak (the host's Remove from Squeak), and the Pond goes with it
  | "tell" // the Owner tells each Member's device the Pond was deleted
  | "revoke" // every other Member's access ends
  | "cloud" // the relay's people records end (leaving: the account leaves)
  | "documents" // the Pond's sealed documents are deleted
  | "owner" // a leaving Member tells the Owner's Mac through the cloud queue
  | "forget"; // this Mac's record, snapshot and files

const PLANS = {
  delete: ["tell", "revoke", "cloud", "documents", "forget"],
  localDelete: ["remove"],
  leave: ["cloud", "owner", "forget"],
  forget: ["forget"],
} as const;

export interface EndWords {
  /** The sidebar and settings menu item, with its ellipsis: "Delete Pond…", "Leave Pond…". */
  menu: string;
  /** The confirm dialog's title. */
  title: string;
  /** The confirm dialog's message. */
  message: string;
  /** The confirm dialog's destructive button. */
  button: string;
}

export interface EndOffer {
  primary: EndKind;
  words: EndWords;
  /** A sentence when the person cannot do it right now (nothing to reach the cloud with); the surface draws it instead. */
  blockedBy?: string;
}

/** What is stored in `ponds.json` while an end is not finished. */
export interface EndingRecord {
  kind: EndKind;
  /** The step that runs next (or failed). */
  step: EndStep;
  /** The sentence the last attempt failed with. */
  failed?: string;
}

/** What a surface draws for a Pond being ended: "Deleting…", or the failure and Try again. */
export interface EndingView {
  kind: EndKind;
  line: string;
  failed?: string;
}

export interface EndingFacts {
  id: string;
  name: string;
  role: Role;
  local: boolean;
  /** `active`, `pending` (a join waiting) or `over` (declined, expired, revoked, removed). */
  status: "active" | "pending" | "over";
  /** People in the Pond, the Owner included. */
  people: number;
  ownerName?: string;
  /** A cloud store this Mac can reach exists. */
  cloud: boolean;
  ending?: EndingRecord;
  /** A share was started and has not finished. */
  sharingStarted?: boolean;
}

export interface EndingPort {
  facts(pondId: string): EndingFacts | null;
  /** Stores (or with null, clears) the Pond's `ending`; a Pond already forgotten is a no-op. */
  mark(pondId: string, ending: EndingRecord | null): void;
  /** Runs one step. Throws a `FlotillaError` with a plain sentence when it cannot finish. */
  run(pondId: string, step: EndStep): Promise<void>;
  /** Told after a record changed, so views redraw. */
  changed(pondId: string): void;
  /** The Owner's removal of one Member (the keys, the tokens, the member document, the new key). */
  removeMember(pondId: string, memberId: string): Promise<void>;
  /** Accounts removed from a Pond whose relay index still lists them. */
  unindexed(pondId: string): string[];
  /** Asks the relay to drop the accounts still listed; throws when it cannot. */
  settleIndex(pondId: string): Promise<void>;
  /** The two sharing steps. */
  publish(pondId: string): Promise<void>;
  ensureAtRelay(pondId: string): Promise<void>;
  markSharing(pondId: string, started: boolean): void;
  /** Pond ids with an unfinished end or removal, for the resume at start. */
  unfinished(): string[];
}

const verb = (kind: EndKind): string => (kind === "delete" ? "deleting" : kind === "leave" ? "leaving" : "removing");

/** The words for one Pond; pure, so the offer is tested without a service. */
export function offerFor(f: EndingFacts): EndOffer | null {
  if (f.status !== "active") {
    return {
      primary: "forget",
      words: { menu: "Remove Pond…", title: `Remove ${f.name}?`, message: "It leaves your list.", button: "Remove" },
    };
  }
  if (f.role === "owner") {
    if (f.local) {
      return {
        primary: "delete",
        words: {
          menu: "Remove from Squeak…",
          title: `Remove ${f.name} from Squeak?`,
          message: "Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.",
          button: "Remove from Squeak",
        },
      };
    }
    const others = Math.max(0, f.people - 1);
    const who = others <= 0 ? "No one else" : others === 1 ? "1 other person" : `${others} other people`;
    return {
      primary: "delete",
      words: {
        menu: "Delete Pond…",
        title: `Delete ${f.name} for everyone?`,
        message: `${who} will lose access to ${f.name} and everything shared in it. Your folder and files on this Mac stay. This can't be undone.`,
        button: "Delete for everyone",
      },
      ...(f.cloud ? {} : { blockedBy: "Squeak can't reach its cloud from here. Try again when you're back online." }),
    };
  }
  const owner = f.ownerName?.trim() || "the owner";
  return {
    primary: "leave",
    words: {
      menu: "Leave Pond…",
      title: `Leave ${f.name}?`,
      message: `Your messages stay in the Room under your name. To come back you need a new invite from ${owner}.`,
      button: "Leave",
    },
    ...(f.cloud ? {} : { blockedBy: "Squeak can't reach its cloud from here. Try again when you're back online." }),
  };
}

export class PondEnding {
  private readonly running = new Map<string, Promise<void>>();
  private readonly sharingRuns = new Map<string, Promise<void>>();

  constructor(private readonly port: EndingPort) {}

  private facts(pondId: string): EndingFacts {
    const facts = this.port.facts(pondId);
    if (!facts) throw new FlotillaError("no such pond", 404);
    return facts;
  }

  offer(pondId: string): EndOffer | null {
    const facts = this.port.facts(pondId);
    return facts ? offerFor(facts) : null;
  }

  /** `local` until a share starts, `sharing` from then until it finishes, `shared` after. */
  sharing(pondId: string): Sharing {
    const f = this.port.facts(pondId);
    if (!f) return "local";
    if (f.sharingStarted) return "sharing";
    return f.local ? "local" : "shared";
  }

  /** What the Pond row carries: the offer, the sharing state and, while an end is not finished, its line. */
  view(pondId: string): { endOffer?: EndOffer; sharing: Sharing; ending?: EndingView } {
    const f = this.port.facts(pondId);
    if (!f) return { sharing: "local" };
    const offer = offerFor(f);
    return {
      ...(offer ? { endOffer: offer } : {}),
      sharing: this.sharing(pondId),
      ...(f.ending ? { ending: this.endingView(f, f.ending) } : {}),
    };
  }

  private endingView(f: EndingFacts, ending: EndingRecord): EndingView {
    const v = verb(ending.kind);
    const failed = ending.failed && !this.running.has(f.id) ? ending.failed : undefined;
    return {
      kind: ending.kind,
      line: failed ? `Couldn't finish ${v} ${f.name}.` : `${v[0]!.toUpperCase()}${v.slice(1)}…`,
      ...(failed ? { failed } : {}),
    };
  }

  /** Ends the Pond the way `offer` says. A second press while one runs joins it; after a failure it resumes at the failed step. */
  end(pondId: string, kind: EndKind): Promise<void> {
    const running = this.running.get(pondId);
    if (running) return running;
    const run = this.endOnce(pondId, kind).finally(() => {
      this.running.delete(pondId);
      this.port.changed(pondId);
    });
    this.running.set(pondId, run);
    return run;
  }

  private plan(f: EndingFacts, kind: EndKind): readonly EndStep[] {
    // Leave on a Pond whose join has not been answered or has ended is only forgetting it.
    if (kind === "leave" && f.status !== "active" && f.role !== "owner") return PLANS.forget;
    if (kind === "forget") {
      if (f.status === "active") throw new FlotillaError("You're still in that pond. Leave it first.", 409);
      return PLANS.forget;
    }
    if (kind === "leave") {
      if (f.role === "owner") throw new FlotillaError("An owner can't leave a pond: delete it instead.", 409);
      return PLANS.leave;
    }
    if (f.role !== "owner") throw new FlotillaError("Only an owner can delete the pond.", 403);
    if (f.status !== "active") throw new FlotillaError("That pond isn't active.", 409);
    return f.local ? PLANS.localDelete : PLANS.delete;
  }

  private async endOnce(pondId: string, kind: EndKind): Promise<void> {
    const f = this.facts(pondId);
    const plan = this.plan(f, kind);
    // A resume continues the recorded kind (a pressed Leave never turns a half-done Delete into something else).
    const resumed = f.ending && f.ending.kind === kind ? f.ending : undefined;
    if (f.ending && f.ending.kind !== kind)
      throw new FlotillaError(`${f.name} is already ${verb(f.ending.kind)}. Try that again.`, 409);
    let from = resumed ? plan.indexOf(resumed.step) : 0;
    if (from < 0) from = 0;
    for (const step of plan.slice(from)) {
      this.port.mark(pondId, { kind, step });
      this.port.changed(pondId);
      try {
        await this.port.run(pondId, step);
      } catch (error) {
        const sentence =
          error instanceof FlotillaError && error.message
            ? error.message
            : `Couldn't finish ${verb(kind)} ${f.name}. Try again.`;
        this.port.mark(pondId, { kind, step, failed: sentence });
        throw error instanceof FlotillaError ? error : new FlotillaError(sentence, 503);
      }
    }
    this.port.mark(pondId, null);
  }

  /**
   * The Owner removes a Member. The service does the keys, tokens and documents; this finishes the account index (the
   * relay's list of who is in which Pond) and says so when it cannot, so the retry settles it instead of it staying wrong.
   */
  async removeMember(pondId: string, memberId: string): Promise<void> {
    const f = this.facts(pondId);
    try {
      await this.port.removeMember(pondId, memberId);
    } catch (error) {
      // Gone already, with only the index left to settle: that is what the retry is for.
      const settledOnly = error instanceof FlotillaError && error.status === 404 && this.port.unindexed(pondId).length;
      if (!settledOnly) throw error;
    }
    try {
      await this.port.settleIndex(pondId);
    } catch (error) {
      if (error instanceof FlotillaError) throw error;
      throw new FlotillaError(`Couldn't finish removing them from ${f.name}. Try again.`, 503);
    }
  }

  /**
   * Makes the Pond shared: publishes it, then makes it exist at the relay (the invite route refuses a Pond it does not
   * know). Idempotent: a shared Pond only re-checks the relay row, and a share that failed halfway resumes at its step.
   */
  share(pondId: string): Promise<void> {
    const running = this.sharingRuns.get(pondId);
    if (running) return running;
    const run = this.shareOnce(pondId).finally(() => {
      this.sharingRuns.delete(pondId);
      this.port.changed(pondId);
    });
    this.sharingRuns.set(pondId, run);
    return run;
  }

  private async shareOnce(pondId: string): Promise<void> {
    const f = this.facts(pondId);
    if (f.role !== "owner") throw new FlotillaError("Only an owner can share the pond.", 403);
    if (f.status !== "active") throw new FlotillaError("That pond isn't active.", 409);
    if (f.ending)
      throw new FlotillaError(`${f.name} is being ${f.ending.kind === "delete" ? "deleted" : "ended"}.`, 409);
    this.port.markSharing(pondId, true);
    this.port.changed(pondId);
    await this.port.publish(pondId);
    await this.port.ensureAtRelay(pondId);
    this.port.markSharing(pondId, false);
  }

  /** At start: carries on every end that was half done, and settles every index that was left wrong. Failures wait for the next press. */
  async resume(log: (message: string, error: unknown) => void = () => undefined): Promise<void> {
    for (const id of this.port.unfinished()) {
      const f = this.port.facts(id);
      if (!f) continue;
      try {
        if (f.ending) await this.end(id, f.ending.kind);
        else await this.port.settleIndex(id);
      } catch (error) {
        log(`could not finish ending a pond: ${id}`, error);
      }
    }
  }
}
