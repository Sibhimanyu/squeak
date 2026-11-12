import type { NewChatAgent } from "./chat-starter.js";

/**
 * A model a new chat may start with, as a host's picker (or Squeak's own catalog) lists it. The Mac checks a
 * phone's choice against this list again.
 */
export interface ChatModel {
  agent: NewChatAgent;
  /** The alias a chat stores (`opus-5-5-1m`). */
  id: string;
  label: string;
  /** The thinking levels it takes, lowest first; empty for a model with none (Haiku 4.5). */
  levels: string[];
  /** The level the picker starts it at. */
  defaultLevel?: string;
  favorite: boolean;
}
