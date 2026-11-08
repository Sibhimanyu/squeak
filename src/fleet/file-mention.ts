/**
 * Conductor stores a file mention in a message as `@⟦name⟧(<url-encoded path>)`, while the agent's transcript
 * holds the plain decoded path in that place. For comparing the two copies only: each token becomes its path.
 */
const TOKEN = /@⟦[^⟦⟧\n]*⟧\(([^)\s]+)\)/g;

export function plainFileMentions(text: string): string {
  return text.replace(TOKEN, (_all, encoded: string) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}
