// Settings (issue #138): the account (name and email come from sign-in and are never editable here), Your devices (the account's
// one list, with Remove; removing one removes it from every Pond) and Sign out. Devices belong to the account and appear only
// here, never in a Pond.

import { useEffect, useState } from "preact/hooks";
import type { AccountInfo } from "../../../src/shared/shapes.js";
import { ago } from "../format.js";
import type { AccountDevice, Relay } from "../relay/client.js";
import { Avatar } from "./marks.js";
import { BackBar, OpenOnMac } from "./parts.js";
import { FAILED_CHANGE, FAILED_PEOPLE } from "./People.js";

export const ACCOUNT_NOTE =
  "Your name and email come from your sign-in, so Squeak does not change them. Edit them where you sign in and they update everywhere.";
export const DEVICES_NOTE = "Removing a device removes it from every Pond.";
const KIND_LABEL = { mac: "Squeak for Mac", web: "Web browser", iphone: "Squeak for iPhone" } as const;
/** A device seen this recently is "Active now". */
export const ACTIVE_MS = 5 * 60_000;

export interface SettingsProps {
  account: AccountInfo;
  relay: Relay;
  token: string;
  /** This browser's device id, once its key is loaded (marks "This device"). */
  selfDeviceId: string | null;
  onSignOut: () => void;
  onSignedOut: () => void;
  now?: number;
}

export function deviceLine(now: number, d: AccountDevice): string {
  if (d.thisDevice)
    return d.lastSeenAt > 0 && now - d.lastSeenAt >= ACTIVE_MS ? `last seen ${ago(now, d.lastSeenAt)}` : "Active now";
  return `${KIND_LABEL[d.kind]} · last seen ${d.lastSeenAt > 0 ? ago(now, d.lastSeenAt) : "never"}`;
}

export function SettingsScreen(props: SettingsProps) {
  const { relay, token, account } = props;
  const now = props.now ?? Date.now();
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async (): Promise<void> => {
    const result = await relay.devices(token, props.selfDeviceId);
    if (result.status === "unauthorized") return props.onSignedOut();
    if (result.status === "unreachable") return setFailed(true);
    setFailed(false);
    setDevices(result.devices);
  };
  useEffect(() => {
    void read();
    // read again once this browser's own device id is known
  }, [props.selfDeviceId]);

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await relay.removeDevice(token, id);
    setBusy(false);
    if (result.status === "unauthorized") return props.onSignedOut();
    if (result.status === "failed") return setError(result.message ?? FAILED_CHANGE);
    setConfirm(null);
    await read();
  };

  return (
    <section class="screen" data-screen="settings">
      <BackBar route={{ name: "settings" }} title="Settings" />
      <div class="content">
        <section aria-labelledby="h-account" data-block="account">
          <h2 id="h-account">Account</h2>
          <div class="card account-card">
            <div class="row">
              <Avatar name={account.name || account.email} />
              <div class="text">
                <strong data-account-name="">{account.name || account.email}</strong>
                <span class="sub" data-account-email="">
                  {account.email}
                </span>
              </div>
            </div>
            <p class="note">{ACCOUNT_NOTE}</p>
          </div>
        </section>
        <section aria-labelledby="h-devices" data-block="devices">
          <h2 id="h-devices">Your devices {devices ? <span class="count">{devices.length}</span> : null}</h2>
          {failed && !devices ? (
            <div class="failure" role="alert">
              <p>{FAILED_PEOPLE}</p>
              <button type="button" class="button" onClick={() => void read()}>
                Try again
              </button>
            </div>
          ) : null}
          {devices ? (
            <ul class="card list-card">
              {devices.map((d) => (
                <li key={d.deviceId} class="person-row device-row" data-device={d.deviceId}>
                  <span class="text">
                    <strong>{d.name}</strong>
                    <span class="sub">{deviceLine(now, d)}</span>
                  </span>
                  {d.thisDevice ? (
                    <span class="role">This device</span>
                  ) : (
                    <button
                      type="button"
                      class="outline danger-text"
                      disabled={busy}
                      onClick={() => setConfirm(d.deviceId)}
                    >
                      Remove
                    </button>
                  )}
                  {confirm === d.deviceId ? (
                    <div class="confirm" role="alertdialog" aria-label={`Remove ${d.name}`}>
                      <p>Remove {d.name}? It is signed out of every Pond.</p>
                      <button type="button" class="danger" disabled={busy} onClick={() => void remove(d.deviceId)}>
                        Remove
                      </button>
                      <button type="button" class="outline" onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p class="failure-line" role="alert" data-error="">
              {error}
            </p>
          ) : null}
          <p class="note">{DEVICES_NOTE}</p>
        </section>
        <OpenOnMac text="Mac controls, voice and usage" />
        <button type="button" class="outline wide sign-out" onClick={props.onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
}
