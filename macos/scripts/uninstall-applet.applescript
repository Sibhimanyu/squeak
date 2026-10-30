-- Uninstall Squeak.app: the applet in the download. Built by make-dmg.sh with osacompile.
set homePath to POSIX path of (path to home folder)
set supportDaemon to homePath & "Library/Application Support/squeak/daemon/current"
set bundled to "/Applications/Squeak.app/Contents/Resources/daemon"

set nodePath to ""
set cliPath to ""
if (do shell script "[ -x '" & supportDaemon & "/node' ] && [ -f '" & supportDaemon & "/dist/squeak/cli.js' ] && echo yes || echo no") is "yes" then
	set nodePath to supportDaemon & "/node"
	set cliPath to supportDaemon & "/dist/squeak/cli.js"
else if (do shell script "[ -x '" & bundled & "/node' ] && [ -f '" & bundled & "/dist/squeak/cli.js' ] && echo yes || echo no") is "yes" then
	set nodePath to bundled & "/node"
	set cliPath to bundled & "/dist/squeak/cli.js"
end if

if nodePath is "" then
	display dialog "There is no Squeak service installed on this Mac, so there is nothing to remove." buttons {"OK"} default button "OK" with title "Uninstall Squeak" with icon note
	return
end if

set answer to display dialog "Remove Squeak from this Mac? Your Mac will ask for your password to remove Squeak's administrator rules." buttons {"Cancel", "Remove Squeak"} default button "Remove Squeak" cancel button "Cancel" with title "Uninstall Squeak" with icon caution

set keepFlag to " --keep-data"
set dataAnswer to display dialog "Also delete your Squeak settings?" buttons {"Keep my settings", "Also delete my settings"} default button "Keep my settings" with title "Uninstall Squeak"
if button returned of dataAnswer is "Also delete my settings" then set keepFlag to ""

set output to ""
try
	set output to do shell script quoted form of nodePath & " " & quoted form of cliPath & " uninstall --yes" & keepFlag & " 2>&1"
on error errMsg
	set output to errMsg
end try

set AppleScript's text item delimiters to linefeed
set outLines to paragraphs of output
set AppleScript's text item delimiters to ""
set tailText to ""
set n to count of outLines
set startAt to n - 7
if startAt < 1 then set startAt to 1
repeat with i from startAt to n
	set tailText to tailText & (item i of outLines) & linefeed
end repeat

try
	if (do shell script "[ -d /Applications/Squeak.app ] && echo yes || echo no") is "yes" then
		tell application "Finder" to delete (POSIX file "/Applications/Squeak.app" as alias)
	end if
end try

display dialog tailText buttons {"OK"} default button "OK" with title "Uninstall Squeak"
