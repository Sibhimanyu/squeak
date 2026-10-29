# Squeak Voice

Squeak on your Mac asks for a phone call through Firebase when a coding agent is waiting on you. This add-on
places the call: it registers as a 3CX extension through your SBC and rings your phone. Press your PIN, then a
key, and the answer goes back to the agent. The Mac needs no route to your PBX, so it works from any network.

Everything sent through Firebase is sealed with a key only Squeak and this add-on hold. You never copy that key: you
pair the add-on with a short code. The PIN is set from the Squeak app (Settings > Phone calls) and kept only in this
add-on's storage; it travels sealed, so Firebase never sees it. Who to ring is also set in the app.

## Setup

1. In Squeak for Mac: Settings > Phone calls > Add gateway. Copy the code it shows (valid 10 minutes).
2. Paste it into this add-on's **Pairing code** option, fill in the SIP options below from 3CX, and start the add-on.
3. The log prints `Pairing: confirm NNNN on your Mac`. Squeak shows the same four digits: check they match, then Approve.

The add-on then keeps the channel and key in its own storage, and the code is never used again. Squeak's Settings shows
whether the add-on is connected and whether it can register with your PBX. To pair again, make a new code and paste it.
An older install that still has `database_url`, `channel` and `key` options keeps working with them.

## Options

| Option         | What                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pairing_code` | the code from Squeak for Mac (Settings > Phone calls > Add gateway); only needed once, and ignored after the add-on is paired              |
| `sip_host`     | 3CX's "Registrar Hostname" (e.g. `1348.3cx.cloud`)                                                                                         |
| `sip_proxy`    | 3CX's "Outbound Proxy (SBC) Address" with port (e.g. `192.168.68.114:5060`)                                                                |
| `extension`    | the extension made for Squeak (3CX: Extension Number)                                                                                      |
| `auth_id`      | 3CX's Authentication ID                                                                                                                    |
| `password`     | 3CX's Authentication password                                                                                                              |
| `speech`       | `natural` (a local neural voice, about 300 MB of memory for a second or two per prompt) or `plain` for a small machine: robotic, but light |
| `transport`    | `udp` unless your SBC says otherwise                                                                                                       |

## Notes

- When the PIN is asked is set in the Squeak app (Settings > Phone calls > When Squeak asks for the PIN): separately for calls Squeak makes to you and for calls you make to Squeak. Only the one extension set in Squeak's Settings may call in either way. An older `call_in_pin: skip` option, if still in your options, only sets the starting value for calls you make.
- Create the extension in 3CX, then Add Phone > "I will configure the phone myself" to see its SIP details.
- The log shows each call as it is placed and why one could not be.
