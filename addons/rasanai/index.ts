import path from "node:path";
import type { Addon, AddonContext, AddonHandle } from "../../src/addons.js";
import { FilmService } from "./films.js";
import { filmCommand, filmsViewFields, phoneImages, phoneMedia, sessionFields, workflowCommand } from "./phone.js";
import { RasanaiProvider } from "./provider.js";

/**
 * The RasanAI add-on: films whose director is a Claude session waiting on the person for the product's own calls
 * (pick a story, pick a look, review the animatic and the film), answered through RasanAI's file protocol. It ships in
 * every build and is inert until the owner enables it in Settings › Add-ons: disabled, nothing annotates a session,
 * no film is listed and no phone command, picture or media request of its is answered. Core knows only
 * `src/addons.ts`; this folder may import core, never the other way round. Design: docs/rasanai-plugin.md.
 */
const addon: Addon = {
  activate(context: AddonContext): AddonHandle {
    // The provider recognises a film's run from files on disk; the service lists films independent of chats.
    const provider = new RasanaiProvider();
    const films = new FilmService({
      provider,
      extraDirs: () => context.snapshot().sessions.flatMap((session) => (session.cwd ? [session.cwd] : [])),
    });
    return {
      sessionAnnotators: [(sessions) => films.annotate(sessions)],
      phoneViewFields: (snapshot, caps) => filmsViewFields(films, snapshot.active, caps),
      phoneSessionFields: (session) => sessionFields(provider, session),
      phoneCommands: {
        workflow: workflowCommand(provider),
        film: filmCommand(films),
      },
      phoneImages: phoneImages(provider, films),
      phoneMedia: phoneMedia(provider, films, path.join(context.supportDir, "media-cache")),
    };
  },
};

export default addon;
