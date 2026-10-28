# Squeak Voice

Squeak on your Mac asks for a phone call through Firebase when a coding agent is waiting on you. This add-on
places the call: it registers as a 3CX extension through your SBC and rings your phone. Press your PIN, then a
key, and the answer goes back to the agent. The Mac needs no route to your PBX, so it works from any network.

Everything sent through Firebase is sealed with the key below, which only Squeak and this add-on hold. The
PIN stays here: Squeak and Firebase never see it.

## Options

Run `squeak voice-relay` on the Mac: it makes the channel and key and prints `database_url`, `channel` and `key`.

| Option         | What                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `database_url` | Squeak's Firebase Realtime Database URL                                                              |
| `channel`      | from `squeak voice-relay`                                                                            |
| `key`          | from `squeak voice-relay`                                                                            |
| `sip_host`     | 3CX's "Registrar Hostname" (e.g. `1348.3cx.cloud`)                                                   |
| `sip_proxy`    | 3CX's "Outbound Proxy (SBC) Address" with port (e.g. `192.168.68.114:5060`)                          |
| `extension`    | the extension made for Squeak (3CX: Extension Number)                                                |
| `auth_id`      | 3CX's Authentication ID                                                                              |
| `password`     | 3CX's Authentication password                                                                        |
| `callee`       | optional: the extension to ring when Squeak does not name one. Squeak's Settings on your Mac sets it |
| `pin`          | 4 to 12 digits you key in to answer; required, or a call could never take an answer                  |
| `transport`    | `udp` unless your SBC says otherwise                                                                 |

## Notes

- Create the extension in 3CX, then Add Phone > "I will configure the phone myself" to see its SIP details.
- The log shows each call as it is placed and why one could not be.
