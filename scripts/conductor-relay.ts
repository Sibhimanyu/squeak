#!/usr/bin/env tsx
/**
 * Drive Conductor's desktop-relay locally, with no cloud, so a message can be
 * injected into a chat while the screen is locked and show live in the window.
 * See `.context/re/conductor-remote-control-protocol.md` and the module under
 * `src/fleet/conductor-relay/`.
 *
 * Commands:
 *   list                               recent chats (workspace id, session id, title)
 *   setup  --port <n>                  point Conductor's relay at us + enable mobile access (writes conductor.db; needs a Conductor restart)
 *   reset                              undo setup (writes conductor.db; needs a Conductor restart)
 *   run    --port <n> [--link <L>] [--workspace <id> --session <id> --text <t>]
 *                                      start the local relay+proxy; pair (first time, with the link) or auth; optionally send one message; stay up
 *
 * Nothing here touches the live app except `setup`/`reset`, which only write
 * settings rows; they print the restart reminder rather than restarting it.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { ConductorRelayServer } from "../src/fleet/conductor-relay/relay-server.js";
import {
  DEFAULT_RELAY_PORT,
  ENABLE_KEY,
  KEYCHAIN_SERVICE,
  OVERRIDE_KEY,
  PAIRED_DEVICES_ACCOUNT,
  pairDevice,
  realEffects,
  resetRelay,
  setupRelay,
} from "../src/fleet/conductor-relay/setup.js";
import { parsePairingLink } from "../src/fleet/conductor-relay/pairing.js";
import type { DeviceCredentials, PhoneClient } from "../src/fleet/conductor-relay/phone.js";

const CONDUCTOR_DB = path.join(os.homedir(), "Library/Application Support/com.conductor.app/conductor.db");
const STATE_FILE = path.join(os.homedir(), "Library/Application Support/squeak/conductor-relay.json");
const UPSTREAM = "https://api.conductor.build";
