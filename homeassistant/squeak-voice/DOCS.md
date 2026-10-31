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
Phone calls) shows an **Update add-on** button. Home Assistant never lets an add-on update itself through the
Supervisor (it answers "can't update itself", whatever the permission), so the add-on asks Home Assistant Core to
install its own update, the same as pressing Update in Settings > Add-ons. For that it declares `homeassistant_api`
(to reach Core's update service) and `manager` (to make the Supervisor re-read the add-on repositories first, because
Home Assistant refuses an update it has not yet seen). The request is accepted only from your paired Mac, and the add-on
restarts for a minute while it installs; the Mac says "Updated to X" once the add-on is back with the new version.
These two permissions are new in 0.11.3: update **once in Home Assistant** (a version older than 0.11.3 cannot ask for
them), and from then on the button works. If the Mac says the add-on did not update, Home Assistant may not have seen
the new version yet: use **Settings > Add-ons > Add-on Store > ⋮ > Check for updates**, then press **Check again** in
Squeak (or press Update in Home Assistant yourself). An add-on installed from local files (the `/addons` folder) is not
updated this way: copy the new files again, then press Update in Home Assistant.

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
- 0.11.5: calls start talking sooner: the Mac's voice clips are fetched together instead of one after another (they used to trickle in 2-3 seconds apart), and the add-on no longer makes the same words itself with its slow voice while the Mac's clips are on their way.
- 0.11.4: the Mac's recordings of the call prompts (the greeting, the menus, "One moment", "Goodbye") are kept in the add-on's data folder, so the first call after a restart or an update opens with the Mac's voice at once instead of waiting for the connection or for this machine to make the words itself.
- 0.11.3: **Update add-on** works: the add-on now asks Home Assistant Core (`homeassistant_api`) to install its update, because the Supervisor refuses an add-on updating itself; it reads its own record first (`/addons/self/info`) after reloading the add-on list, says plainly when Home Assistant has not seen the new version, and the Mac no longer waits forever. Update once in Home Assistant to get the new permission. Calling in, a message now ends when you stop speaking (about 2.5 s of quiet after you spoke), not only on hash; it is capped at 60 s ("I have to stop there") and, if nothing is heard 8 s after the beep, the line says "I didn't hear anything. Press 1 to try again, or hash to hang up." instead of recording silence. Every key received is written in the call log with where it landed (PINs are never shown). If you call in while Squeak is trying to ring you about an agent, the Mac now waits (up to 3 minutes) and rings when your call ends. Every line spoken into a call is padded with 300 ms of silence and a line the add-on has to make itself during a call uses the plain, fast voice; the natural voice is only used in advance. After a call the log says "Line quality: good/fair/poor" (jitter, loss and round trip), and a Test call shows it in the apps. Calling in now starts with the chat you used last ("Press 1 for <chat>, the last one you used. Press 2 for another chat."), and a recording that comes back as silence or a few unclear words is never sent on its own: it says what it heard and offers to record again.
- 0.11.1: **Update add-on** and **Check for updates** now make Home Assistant refresh its add-on list first, so a new version is found and installed at once.
- 0.11.0: when you ring out, the phone rings at once and the Mac's natural voice follows while it rings (until then the add-on speaks its own voice, so the line is never silent when you pick up). Calling in, you can also ask a question about a chat and hear the answer, or hear where a chat stands (needs Squeak for Mac 2.12.16 or newer; with an older Mac the call-in keys are as before).
- Create the extension in 3CX, then Add Phone > "I will configure the phone myself" to see its SIP details.
- The log shows each call as it is placed and why one could not be.
