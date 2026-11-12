import type { AddonCommandResult, AddonPhoneCall, AddonPhoneImages, AddonPhoneMedia } from "../../src/addons.js";
import type { FleetSession } from "../../src/fleet/types.js";
import { logger } from "../../src/utils/logger.js";
import type { FilmCommand, FilmService } from "./films.js";
import { preparePhoneMedia } from "./phone-media.js";
import type { RasanaiProvider } from "./provider.js";
import type { PhoneFilm, WorkflowStatus, WorkflowView } from "./types.js";

/**
 * RasanAI's side of the phone channel. Core has already verified the device's signature, opened the box, checked
 * expiry and the nonce and capped the size before any of this runs, and only while the add-on is enabled; what is
 * left is what only this add-on knows: that the named session is the Mac's own and still waiting, that the answer
 * fits the product's files as they are now, and that a film is one the Mac lists.
 */

/** A film's id: `film:` and the first 16 hex of sha256(realpath(projectDir)). */
export const FILM_ID = /^film:[0-9a-f]{16}$/;
export const FILM_OPS: ReadonlySet<unknown> = new Set(["answer", "chat", "resume", "stop", "installTool"]);

/** The Mac's own active session, by fleet key, that a workflow has marked as waiting (never the phone's copy). */
export function workflowSession(call: AddonPhoneCall, sessionKey: unknown): FleetSession | null {
  if (typeof sessionKey !== "string") return null;
  return call.snapshot.active.find((session) => session.key === sessionKey && session.workflow) ?? null;
}

const refuse = (reason: string): AddonCommandResult => ({ ok: false, reason });

/** An answer to a workflow's call: pick a story, pick a look, ask for three more, answer the director. */
export function workflowCommand(provider: RasanaiProvider) {
  return (command: Record<string, unknown>, call: AddonPhoneCall): AddonCommandResult => {
    if (
      command.v !== 1 ||
      typeof command.sessionKey !== "string" ||
      typeof command.step !== "string" ||
      typeof command.revision !== "string" ||
      typeof command.type !== "string" ||
      !/^[a-z-]{2,20}$/.test(command.type) ||
      (command.note !== undefined && typeof command.note !== "string") ||
      JSON.stringify(command.value ?? null).length > 8_000
    ) {
      return refuse("Not a request this Mac understands.");
    }
    const session = workflowSession(call, command.sessionKey);
    if (!session?.workflow) {
      return refuse("That isn't waiting on you any more.");
    }
    const result = provider.act(session.workflow.projectDir, {
      step: command.step,
      revision: command.revision,
      type: command.type,
      value: command.value ?? null,
      ...(command.note !== undefined ? { note: command.note as string } : {}),
    });
    if (!result.ok) return refuse(result.reason);
    return { ok: true, said: result.said, log: `${result.said} (${session.workflow.title ?? "a film"})` };
  };
}

/** A film command: answer a call, talk to Rasan, wake or stop the director, install a missing tool. */
export function filmCommand(films: FilmService) {
  return async (raw: Record<string, unknown>): Promise<AddonCommandResult> => {
    const command = raw as unknown as FilmCommand;
    const short = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
    const optional = (value: unknown, max: number) =>
      value === undefined || (typeof value === "string" && value.length <= max);
    if (
      command.v !== 1 ||
      typeof command.filmId !== "string" ||
      !FILM_ID.test(command.filmId) ||
      !FILM_OPS.has(command.op) ||
      !optional(command.step, 200) ||
      !optional(command.revision, 300) ||
      !optional(command.type, 20) ||
      !optional(command.note, 8_000) ||
      !optional(command.askId, 200) ||
      !optional(command.tool, 40) ||
      (command.type !== undefined && !/^[a-z-]{2,20}$/.test(command.type)) ||
      JSON.stringify(command.value ?? null).length > 24_000
    ) {
      return refuse("Not a request this Mac understands.");
    }
    if (
      command.op === "answer" &&
      (!short(command.step, 200) || !short(command.revision, 300) || !short(command.type, 20))
    ) {
      return refuse("Not a request this Mac understands.");
    }
    if (command.op === "installTool" && (!short(command.askId, 200) || !short(command.tool, 40))) {
      return refuse("Not a request this Mac understands.");
    }
    if (command.op === "chat") {
      if (typeof command.text !== "string" || !command.text.trim()) return refuse("Write a message first.");
      if (command.text.length > 2_000) return refuse("That message is too long.");
    }
    let result;
    try {
      result = await films.handle(command);
    } catch (error) {
      logger.warn("film command failed", { error: error instanceof Error ? error.message : String(error) });
      return refuse("Your Mac couldn't do that. Try again.");
    }
    if (!result.ok) return refuse(result.reason);
    return { ok: true, said: result.said, log: `${command.op}: ${result.said}` };
  };
}

/** Which folder an `image` command's picture may be read from: a film's card or poster, or a waiting workflow's card. */
export function phoneImages(provider: RasanaiProvider, films: FilmService): AddonPhoneImages {
  return {
    fields: ["filmId", "sessionKey"],
    resolve(command, call) {
      const source = command.source as string;
      if (command.filmId !== undefined) {
        if (typeof command.filmId !== "string" || !FILM_ID.test(command.filmId)) {
          return { refuse: "Not a request this Mac understands." };
        }
        const projectDir = films.imageProject(command.filmId, source);
        return projectDir ? { projectDir } : { refuse: "That picture isn't on this film." };
      }
      const session = workflowSession(call, command.sessionKey);
      if (!session?.workflow) return { refuse: "That isn't waiting on you any more." };
      if (!provider.allowsImage(session.workflow as WorkflowStatus, source)) {
        return { refuse: "That picture isn't on this card." };
      }
      return { projectDir: session.workflow.projectDir };
    },
  };
}

/** Which folder a `media` command's film or soundtrack may be read from, and how it becomes a phone copy. */
export function phoneMedia(provider: RasanaiProvider, films: FilmService, cacheDir: string): AddonPhoneMedia {
  return {
    fields: ["filmId", "sessionKey"],
    resolve(command, call) {
      const source = command.source as string;
      if (command.filmId !== undefined) {
        if (typeof command.filmId !== "string" || !FILM_ID.test(command.filmId)) {
          return { refuse: "Not a request this Mac understands." };
        }
        const projectDir = films.mediaProject(command.filmId, source);
        return projectDir ? { source, projectDir } : { refuse: "That isn't on this film." };
      }
      if (typeof command.sessionKey !== "string") return { refuse: "Not a request this Mac understands." };
      const session = workflowSession(call, command.sessionKey);
      if (!session?.workflow) return { refuse: "That isn't waiting on you any more." };
      if (!provider.allowsMedia(session.workflow as WorkflowStatus, source)) {
        return { refuse: "That isn't on this card." };
      }
      return { source, projectDir: session.workflow.projectDir };
    },
    prepare: (source, projectDir) => preparePhoneMedia(source, projectDir, { cacheDir }),
  };
}

/** The phone view's `films`, for a phone whose presence says it reads them. */
export function filmsViewFields(
  films: FilmService,
  snapshotActive: FleetSession[],
  caps: readonly string[],
): { films?: PhoneFilm[] } {
  if (!caps.includes("films")) return {};
  try {
    return { films: films.list(snapshotActive) };
  } catch (error) {
    logger.debug("could not list films", { error: error instanceof Error ? error.message : String(error) });
    return { films: [] };
  }
}

/** A session row's `workflow` card and `workflowProgress`. */
export function sessionFields(
  provider: RasanaiProvider,
  session: FleetSession,
): { workflow?: WorkflowView | null; workflowProgress?: unknown } {
  const fields: { workflow?: WorkflowView | null; workflowProgress?: unknown } = {};
  if (session.workflow) {
    try {
      fields.workflow = provider.view(session.workflow as WorkflowStatus);
    } catch (error) {
      logger.debug("could not read a workflow card", { error: error instanceof Error ? error.message : String(error) });
      fields.workflow = null;
    }
  }
  if (session.workflowProgress) fields.workflowProgress = session.workflowProgress;
  return fields;
}
