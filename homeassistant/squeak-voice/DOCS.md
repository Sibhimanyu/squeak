# Squeak Voice

Squeak on your Mac asks for a phone call through Firebase when a coding agent is waiting on you. This add-on
places the call: it registers as a 3CX extension through your SBC and rings your phone. Press your PIN, then a
key, and the answer goes back to the agent. The Mac needs no route to your PBX, so it works from any network.

Everything sent through Firebase is sealed with a key only Squeak and this add-on hold. You never copy that key: you
pair the add-on with a short code it shows. The PIN is set from the Squeak app (Settings > Phone calls) and kept only in this
add-on's storage; it travels sealed, so Firebase never sees it. Who to ring is also set in the app.

## Setup

1. Install the add-on, fill in the SIP options below from 3CX, and start it.
2. Open **Squeak Voice** in Home Assistant's sidebar. It shows a code such as `K7M2-QX9P`, and whether the add-on is
   paired, registered with your PBX and has a PIN.
3. In Squeak for Mac: Settings > Phone calls > Add gateway. Type the code and approve.

The add-on then keeps the channel and key in its own storage; it needs no restart and the code is never used again
(it also changes by itself every 13 minutes while unpaired). Squeak's Settings shows whether the add-on is connected
and whether it can register with your PBX. An older install that still has `database_url`, `channel` and `key`
options keeps working with them.

**Old pairing code.** The `pairing_code` option still works: make a code in Squeak (Settings > Phone calls > Use a
pairing code instead), paste it in the option and start the add-on, then confirm the four digits it logs.

## Updates

Choose **Open Home Assistant updates** in the Squeak Voice panel to open **Settings > Updates**.
Use Home Assistant’s **Check for updates** action to refresh available versions, then choose Squeak Voice to review
and install its update. Home Assistant manages installation and any backup options.
If you do not have permission to manage updates, ask your Home Assistant administrator.

**Update from your Mac.** The add-on checks for a newer version itself, and when one exists Squeak for Mac (Settings >
Phone calls) shows an **Update add-on** button. It asks Home Assistant to update this add-on and nothing else, which
is why the add-on declares the `manager` permission: Home Assistant only lets an add-on update itself with it. The
request is accepted only from your paired Mac, and the add-on restarts for a minute while it installs. Home Assistant
may ask you to accept the new permission the first time; if the button is refused, update once in Home Assistant.

## Options

| Option         | What                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pairing_code` | optional, old way: a pairing code made in Squeak for Mac; not needed with the panel, and ignored after the add-on is paired                |
| `sip_host`     | 3CX's "Registrar Hostname" (e.g. `1348.3cx.cloud`)                                                                                         |
| `sip_proxy`    | 3CX's "Outbound Proxy (SBC) Address" with port (e.g. `192.168.68.114:5060`)                                                                |
| `extension`    | the extension made for Squeak (3CX: Extension Number)                                                                                      |
| `auth_id`      | 3CX's Authentication ID                                                                                                                    |
| `password`     | 3CX's Authentication password                                                                                                              |
| `speech`       | `natural` (a local neural voice, about 300 MB of memory for a second or two per prompt) or `plain` for a small machine: robotic, but light |
| `transport`    | `udp` unless your SBC says otherwise                                                                                                       |

## Notes

- When the PIN is asked is set in the Squeak app (Settings > Phone calls > When Squeak asks for the PIN): separately for calls Squeak makes to you and for calls you make to Squeak. Only the one extension set in Squeak's Settings may call in either way. An older `call_in_pin: skip` option, if still in your options, only sets the starting value for calls you make.
- 0.11.0: when you ring out, the phone rings at once and the Mac's natural voice follows while it rings (until then the add-on speaks its own voice, so the line is never silent when you pick up). Calling in, you can also ask a question about a chat and hear the answer, or hear where a chat stands (needs Squeak for Mac 2.12.15 or newer; with an older Mac the call-in keys are as before).
- Create the extension in 3CX, then Add Phone > "I will configure the phone myself" to see its SIP details.
- The log shows each call as it is placed and why one could not be.
