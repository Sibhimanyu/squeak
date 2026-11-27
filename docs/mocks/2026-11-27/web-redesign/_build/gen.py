#!/usr/bin/env python3
"""Generates the three web redesign directions (a, b, c). Static HTML, brand assets from ../assets.
Run: python3 gen.py  ->  ../a/*.html ../b/*.html ../c/*.html. Then shot.sh renders PNGs headless."""
import os, random, base64

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUCK = "data:image/png;base64," + base64.b64encode(open(os.path.join(ROOT, "assets", "duckThread.png"), "rb").read()).decode()

# ---------- icons (Lucide, 1.5 stroke) ----------
def icon(paths, size=18, sw=1.6, extra=""):
    return ('<svg class="ic" width="%d" height="%d" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="%s" stroke-linecap="round" stroke-linejoin="round" %s>%s</svg>' % (size, size, sw, extra, paths))

TRI = '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
UP = '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'
BACK = '<path d="m15 18-6-6 6-6"/>'
PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>'
MAIL = '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'
GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'

def tri(size=18, cls="tri"):
    return '<span class="%s" title="Waiting for you">%s</span>' % (cls, icon(TRI, size, 1.6))

def tide(cols=10, rows=4, pitch=3.5, seed=1):
    """Static frame of the TideGlyph: a twinkling pixel cloud fading to the edges (animates in the app)."""
    rnd = random.Random(seed)
    w = cols * pitch - pitch * .25
    h = rows * pitch - pitch * .25
    cells = []
    for y in range(rows):
        for x in range(cols):
            dx = (x - (cols - 1) / 2) / (cols / 2)
            dy = (y - (rows - 1) / 2) / (rows / 2)
            fade = max(0, 1 - (dx * dx + dy * dy) ** .5 * .85)
            v = rnd.random() * fade * 1.5
            a = 0 if v < .3 else .3 if v < .55 else .6 if v < .8 else 1
            if a:
                cells.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill-opacity="%s"/>' %
                             (x * pitch, y * pitch, pitch * .75, pitch * .75, a))
    return ('<svg class="tide" width="%.1f" height="%.1f" viewBox="0 0 %.1f %.1f" fill="currentColor" aria-label="Working">%s</svg>'
            % (w, h, w, h, "".join(cells)))

# ---------- shared bits ----------
PEOPLE = {"Sibhi": (262, "S"), "Asha": (340, "A"), "Dev": (190, "D"), "Meera": (130, "M"), "Neha": (20, "N"), "Vikram": (230, "V")}

def av(name, size=32, ring=False, outlined=False, cls=""):
    h, l = PEOPLE[name]
    return '<span class="av %s %s" style="--h:%d;--s:%d">%s</span>' % ("out" if outlined else "", cls, h, size, l)

def avs(names, size=30, outlined=()):
    return '<span class="avs">%s</span>' % "".join(av(n, size, outlined=(n in outlined)) for n in names)

def tile(letter, h, size=48, badge=None, cls=""):
    b = ""
    if badge:
        b = '<span class="tb">%s</span>' % av(badge, max(16, round(size * .36)))
    return '<span class="tile %s" style="--h:%d;--s:%d">%s%s</span>' % (cls, h, size, letter, b)

def td(h, size=22):
    return '<span class="td" style="--h:%d;--s:%d"></span>' % (h, size)

POND = {"greenroom": 150, "orchard": 14, "farm-dashboard": 88, "ledger": 270, "harvest": 200, "harbour": 215}

# the Room feed (oldest first, newest at the bottom)
def feed(waiting_icon=True):
    out = []
    out.append('<div class="day">Yesterday</div>')
    out.append(msg("Sibhi", "16:30", "Pond is set up. Asha and Dev, you can both post here and message any Duck."))
    out.append(mine("Great, starting with the Room tab.", "16:42"))
    out.append('<div class="day">Today</div>')
    out.append(msg("Sibhi", "9:12", "Invite flow: email only, shipping today. Dev, can you take the sheet?"))
    out.append(msg("Dev", "9:20", "On it. I’ll start a Duck for the People sheet."))
    out.append(state(120, "invite-email", "started", "9:21"))
    out.append(mine("Can the sheet show who already has a pending invite?", "9:41"))
    out.append(msg("Sibhi", "9:44", "Yes, it refuses the address and says why."))
    out.append('<div class="note">Neha declined the invitation · 9:50</div>')
    out.append(state(150, "room-tabs", "asked a question", "10:02", mark="tri"))
    out.append(state(300, "people-sheet", "is working", "10:05", mark="tide"))
    out.append(msg("Dev", "10:08", "The question is for whoever is free, Asha?"))
    return "".join(out)

def msg(who, t, text):
    return ('<div class="m">%s<div class="mb"><div class="mh"><b>%s</b><span>%s</span></div><div class="mt">%s</div></div></div>'
            % (av(who, 36, cls="mav"), who, t, text))

def mine(text, t):
    return '<div class="m me"><div class="bub">%s</div><div class="mtime">%s</div></div>' % (text, t)

def state(h, name, what, t, mark=None):
    m = ""
    if mark == "tri":
        m = tri(16)
    elif mark == "tide":
        m = tide(7, 3, 3.5, seed=7)
    return ('<div class="st">%s<span class="stt"><b>%s</b> %s</span><span class="sp"></span>%s<span class="tr">%s</span></div>'
            % (td(h, 20), name, what, m, t))

FONTS = """
@font-face{font-family:Figtree;font-weight:500;src:url(../assets/fonts/Figtree-500.ttf)}
@font-face{font-family:Figtree;font-weight:600;src:url(../assets/fonts/Figtree-600.ttf)}
@font-face{font-family:Figtree;font-weight:700;src:url(../assets/fonts/Figtree-700.ttf)}
@font-face{font-family:"JetBrains Mono";font-weight:500;src:url(../assets/fonts/JetBrainsMono-Medium.ttf)}
"""

BASE = FONTS + """
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
:root{--bg:#fff;--side:#FCF7F1;--raised:#fff;--sel:#F1ECE6;--sel2:#E7E2DD;--ink:#292622;--muted:#67625E;--subtle:#8A8580;
 --line:#E7E2DD;--ls:rgba(20,16,15,.16);--warn:#A16207;--work:#1D4ED8;--ducktext:#8A5A00;--neg:#DC2626;--paper:#F8F7F3;
 --duck:#FFDA1A;--duckwing:#FFC812;--inkb:#18191B}
.dark{--bg:#13100C;--side:#1C1915;--raised:#26221E;--sel:#26221E;--sel2:#312D29;--ink:#ECE7E2;--muted:#AFAAA5;--subtle:#7B7772;
 --line:rgba(255,255,255,.10);--ls:rgba(255,255,255,.2);--warn:#E0A030;--work:#4C8DFF;--ducktext:#FFDA1A;--paper:#13100C}
body{font-family:-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);
 -webkit-font-smoothing:antialiased;overflow:hidden;font-size:15px;line-height:1.4}
.ic{flex:none;display:block}
.tri{color:var(--warn);display:inline-flex}
.tide{color:var(--work);display:block;flex:none}
/* pond colours (palette hue --h). tile soft fill, accent text, avatar, thread duck */
.tile{width:calc(var(--s)*1px);height:calc(var(--s)*1px);border-radius:calc(var(--s)*.3px);flex:none;position:relative;display:inline-flex;
 align-items:center;justify-content:center;font-weight:700;font-size:calc(var(--s)*.42px);
 background:hsl(var(--h) 62% 86%);color:hsl(var(--h) 60% 24%)}
.dark .tile{background:hsl(var(--h) 34% 24%);color:hsl(var(--h) 75% 80%)}
.tb{position:absolute;right:-5px;bottom:-5px;display:flex;border-radius:50%;box-shadow:0 0 0 2px var(--tbring,var(--side))}
.av{width:calc(var(--s)*1px);height:calc(var(--s)*1px);border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;
 font-weight:600;font-size:calc(var(--s)*.42px);background:hsl(var(--h) 60% 87%);color:hsl(var(--h) 55% 27%)}
.dark .av{background:hsl(var(--h) 30% 28%);color:hsl(var(--h) 70% 82%)}
.av.out{background:transparent;border:1.5px dashed var(--subtle);color:var(--muted)}
.avs{display:inline-flex}.avs .av{box-shadow:0 0 0 2px var(--avring,var(--bg));margin-left:-8px}.avs .av:first-child{margin-left:0}
.td{width:calc(var(--s)*1px);height:calc(var(--s)*1px);flex:none;display:inline-block;background:hsl(var(--h) 58% 52%);
 -webkit-mask:url(__DUCK__) center/contain no-repeat;mask:url(__DUCK__) center/contain no-repeat}
.dark .td{background:hsl(var(--h) 84% 69%)}
.pa{--acc:hsl(var(--h) 55% 34%)}.dark .pa{--acc:hsl(var(--h) 60% 66%)}
/* the feed */
.feed{-webkit-mask-image:linear-gradient(transparent 0,#000 56px);mask-image:linear-gradient(transparent 0,#000 56px)}
.day{text-align:center;font-size:12px;color:var(--muted);padding:6px 0 2px}
.note{text-align:center;font-size:13px;color:var(--muted);padding:4px 0}
.m{display:flex;gap:12px;align-items:flex-start}
.mh{display:flex;gap:8px;align-items:baseline}.mh b{font-weight:600;font-size:14px}.mh span{font-size:12px;color:var(--muted)}
.mt{font-size:15.5px;line-height:1.45}
.m.me{flex-direction:column;align-items:flex-end;gap:4px}.bub{padding:10px 16px;max-width:78%}.mtime{font-size:12px;color:var(--muted)}
.st{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted)}.st b{color:var(--ink);font-weight:600}.sp{flex:1}.tr{font-size:12.5px;min-width:38px;text-align:right}
button,.btn{font:inherit;cursor:default}
"""

def page(direction, name, body, css, dark=False, w=1440, h=900):
    html = ('<!doctype html><html lang="en" class="%s"><head><meta charset="utf-8"><meta name="viewport" content="width=%d">'
            '<title>%s %s</title><style>%s%s</style></head><body style="width:%dpx;height:%dpx">%s</body></html>'
            % ("dark" if dark else "", w, direction, name, BASE, css, w, h, body)).replace("__DUCK__", DUCK)
    with open(os.path.join(ROOT, direction, name + ".html"), "w") as f:
        f.write(html)

# the ponds a Member can see (the web lists only shared Ponds; there is no sharing filter)
PONDS = [  # name, letter, owner badge or None, sub line, trail, bold
    ("greenroom", "G", "Sibhi", "Dev: The question is for whoever is free…", "tri", True),
    ("orchard", "O", "Dev", "irrigation-plan is working", "tide", False),
    ("farm-dashboard", "F", "Sibhi", "Finished a Task", "1 h", True),
    ("ledger", "L", "Meera", "You can view", "Yesterday", False),
    ("harvest", "H", "Sibhi", "Nothing running", "Mon", False),
]
NEEDS = [(150, "Which tab should open first?", "greenroom · room-tabs · 4 min"),
         (215, "Keep the old Pond colours?", "orchard · palette-pass · 38 min")]
EMAIL = "asha@fernlabs.dev"

# =====================================================================
# DIRECTION A: refined light. Warm, colourful list, Pond tint, yellow primary.
# =====================================================================
A_CSS = """
body{display:flex}
.side{width:392px;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:22px 18px 0;flex:none}
.top{display:flex;align-items:center;justify-content:space-between;padding:0 6px 18px}
.top img{height:30px;display:block}
.dark .top img.l{display:none}.top img.d{display:none}.dark .top img.d{display:block}
.lab{font-size:13px;font-weight:600;color:var(--muted);padding:14px 8px 8px;display:flex;gap:6px}
.lab i{font-style:normal;font-weight:500;color:var(--subtle)}
.card{background:var(--raised);border:1px solid var(--line);border-radius:16px}
.dark .card{border-color:transparent}
.inv{display:flex;align-items:center;gap:12px;padding:12px 12px 12px 12px}
.inv .tx{flex:1;min-width:0}.inv b{display:block;font-size:15px;font-weight:600}.inv small{font-size:13px;color:var(--muted)}
.btnp{background:var(--duck);color:#18191B;border:0;border-radius:10px;padding:8px 16px;font-weight:600;font-size:14px}
.btns{background:transparent;color:var(--muted);border:0;border-radius:10px;padding:8px 10px;font-weight:500;font-size:14px}
.need{display:flex;align-items:center;gap:12px;padding:11px 14px 11px 14px;position:relative}
.need+.need{border-top:1px solid var(--line)}
.need::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--subtle)}
.need b{display:block;font-size:14.5px;font-weight:600}.need small{font-size:12.5px;color:var(--muted)}
.need .tx{flex:1;min-width:0}
.pl{display:flex;flex-direction:column;gap:2px;flex:1;overflow:hidden}
.pr{display:flex;align-items:center;gap:13px;padding:9px 12px;border-radius:14px;position:relative}
.pr.sel{background:color-mix(in srgb,hsl(var(--h) 60% 45%) 12%,var(--sel))}
.pr .tx{flex:1;min-width:0}.pr b{display:block;font-size:15.5px;font-weight:500;letter-spacing:-.005em}.pr.bold b{font-weight:700}
.pr small{display:block;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr .tail{font-size:12.5px;color:var(--muted);flex:none;min-width:28px;display:flex;justify-content:flex-end}
.foot{border-top:1px solid var(--line);margin:0 -18px;padding:14px 24px;display:flex;align-items:center;gap:12px;font-size:14px}
.foot .e{flex:1;color:var(--ink);font-weight:500}.foot .s{color:var(--muted);font-size:13.5px}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.hd{padding:20px 44px 0;background:linear-gradient(180deg,color-mix(in srgb,hsl(var(--h) 62% 50%) 12%,var(--bg)) 0%,var(--bg) 100%);border-bottom:1px solid var(--line)}
.hrow{display:flex;align-items:center;gap:16px}
.hrow h1{font-size:25px;font-weight:700;letter-spacing:-.015em;line-height:1.1}.hrow small{display:block;font-size:13.5px;color:var(--muted);margin-top:3px}
.hrow .tx{flex:1}
.tabs{display:flex;gap:26px;margin-top:14px}.tabs span{padding:8px 0 11px;font-size:14.5px;font-weight:500;color:var(--muted);border-bottom:2.5px solid transparent;margin-bottom:-1px}
.tabs .on{color:var(--ink);font-weight:600;border-color:var(--acc)}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:15px;padding:20px 0 14px;align-items:center}
.feed>*{width:688px;flex:none}
.bub{background:var(--sel);border-radius:20px 20px 6px 20px}
.dark .bub{background:var(--sel2)}
.st{background:transparent}
.comp{padding:0 0 26px;display:flex;flex-direction:column;align-items:center;gap:10px}
.comp>*{width:688px}
.chips{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--muted)}
.chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--ls);border-radius:999px;padding:5px 12px 5px 9px;color:var(--ink);font-weight:500}
.field{display:flex;align-items:center;gap:12px;border:1.5px solid color-mix(in srgb,var(--acc) 45%,var(--line));border-radius:22px;padding:8px 8px 8px 20px;background:var(--raised);color:var(--subtle);font-size:15.5px}
.field span{flex:1}.send{width:36px;height:36px;border-radius:50%;background:var(--duck);color:#18191B;display:flex;align-items:center;justify-content:center}
"""

def a_side(selected=0, empty=False):
    s = '<aside class="side"><div class="top"><img class="l" src="../assets/squeak-lockup-horizontal-ink.svg"><img class="d" src="../assets/squeak-lockup-horizontal-paper.svg"></div>'
    if not empty:
        s += '<div class="lab">Invitations <i>1</i></div><div class="card inv">%s<div class="tx"><b>harbour</b><small>Dev invited you</small></div><button class="btnp">Join</button><button class="btns">Decline</button></div>' % tile("H", POND["harbour"], 42, "Dev")
        s += '<div class="lab">Needs you <i>2</i></div><div class="card">'
        for h, t, sub in NEEDS:
            s += '<div class="need">%s<div class="tx"><b>%s</b><small>%s</small></div>%s</div>' % (td(h, 24), t, sub, tri(19))
        s += '</div><div class="lab">Ponds</div><div class="pl">'
        for i, (n, l, o, sub, trail, bold) in enumerate(PONDS):
            tr = tri(19) if trail == "tri" else tide(8, 3, 3.5, seed=3) if trail == "tide" else trail
            s += '<div class="pr %s %s" style="--h:%d">%s<div class="tx"><b>%s</b><small>%s</small></div><span class="tail">%s</span></div>' % (
                "sel" if i == selected else "", "bold" if bold else "", POND[n], tile(l, POND[n], 44, o), n, sub, tr)
        s += '</div>'
    else:
        s += '<div class="lab">Ponds</div><div style="padding:6px 10px;font-size:14px;color:var(--muted);line-height:1.5">Nothing yet. Ponds that are shared with you will be listed here, newest first.</div><div class="pl"></div>'
    s += '<div class="foot">%s<span class="e">%s</span><span class="s">Settings</span></div></aside>' % (av("Asha", 32), EMAIL)
    return s

def a_room(dark):
    body = a_side() + '''<main class="main pa" style="--h:150"><div class="hd" style="--h:150"><div class="hrow">%s<div class="tx"><h1>greenroom</h1><small>Sibhi’s Pond · Member · Live</small></div>%s</div>
<div class="tabs"><span class="on">Room</span><span>Ducks</span></div></div>
<div class="feed">%s</div><div class="comp"><div class="chips"><span class="chip">%s Make task</span>Sibhi approves new Tasks</div>
<div class="field"><span>Message greenroom</span><div class="send">%s</div></div></div></main>''' % (
        tile("G", 150, 52), avs(["Sibhi", "Asha", "Dev", "Meera", "Vikram"], 32, outlined=("Vikram",)), feed(), icon(PLUS, 15), icon(UP, 18, 2))
    page("a", "wide-room-dark" if dark else "wide-room", body, A_CSS, dark)

A_EMPTY_CSS = A_CSS + """
.empty{flex:1;display:flex;align-items:center;justify-content:center;background:
 radial-gradient(900px 500px at 50% 38%,color-mix(in srgb,var(--duck) 16%,var(--bg)),var(--bg) 70%)}
.eb{width:520px;text-align:center;display:flex;flex-direction:column;align-items:center}
.eb img{width:150px;margin-bottom:26px}
.eb h1{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.15}
.eb p{font-size:16.5px;line-height:1.55;color:var(--muted);margin-top:14px;max-width:440px}
.eb .btnp{margin-top:28px;padding:12px 24px;font-size:15.5px;border-radius:12px}
.eb small{margin-top:16px;font-size:13.5px;color:var(--muted)}
"""

def a_empty():
    body = a_side(empty=True) + '''<main class="main"><div class="empty"><div class="eb"><img src="../assets/squeak-duck-full-color-512.png" alt="">
<h1>Ponds you share from your Mac appear here</h1>
<p>Share a Pond from Squeak for Mac and it shows up in this list, ready to chat in. When someone invites you to theirs, it arrives here too.</p>
<button class="btnp">Get Squeak for Mac</button><small>Just shared one? It can take a minute to appear.</small></div></div></main>'''
    page("a", "wide-empty", body, A_EMPTY_CSS)

A_PHONE_CSS = BASE and """
body{display:flex;flex-direction:column}
.bar{padding:52px 16px 0;background:linear-gradient(180deg,color-mix(in srgb,hsl(var(--h) 62% 50%) 14%,var(--bg)),var(--bg))}
.back{display:flex;align-items:center;gap:2px;color:var(--ducktext);font-size:15px;font-weight:500;margin-left:-4px;margin-bottom:10px}
.hrow{display:flex;align-items:center;gap:12px}.hrow .tx{flex:1;min-width:0}
.hrow h1{font-size:21px;font-weight:700;letter-spacing:-.015em;line-height:1.1}.hrow small{display:block;font-size:12.5px;color:var(--muted);margin-top:2px}
.tabs{display:flex;gap:24px;margin:12px 0 0;border-bottom:1px solid var(--line);margin-left:-16px;margin-right:-16px;padding:0 16px}
.tabs span{padding:8px 0 10px;font-size:14.5px;font-weight:500;color:var(--muted);border-bottom:2.5px solid transparent;margin-bottom:-1px}.tabs .on{color:var(--ink);font-weight:600;border-color:var(--acc)}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;padding:14px 16px 10px}
.feed .mt{font-size:15px}.m{gap:10px}
.bub{background:var(--sel);border-radius:18px 18px 5px 18px;font-size:15px;max-width:84%;padding:9px 14px}
.comp{padding:6px 14px 30px}
.field{display:flex;align-items:center;gap:10px;border:1.5px solid color-mix(in srgb,var(--acc) 45%,var(--line));border-radius:22px;padding:6px 6px 6px 16px;background:var(--raised);color:var(--subtle);font-size:15px}
.field span{flex:1}.send{width:34px;height:34px;border-radius:50%;background:var(--duck);color:#18191B;display:flex;align-items:center;justify-content:center}
.st{font-size:13px;gap:8px}.st .tr{min-width:30px}
"""

def a_phone_room():
    body = '''<div class="bar pa" style="--h:150"><div class="back">%s Ponds</div><div class="hrow">%s<div class="tx"><h1>greenroom</h1><small>Sibhi’s Pond · Member · Live</small></div>%s</div>
<div class="tabs"><span class="on">Room</span><span>Ducks</span></div></div><div class="feed pa" style="--h:150">%s</div>
<div class="comp pa" style="--h:150"><div class="field"><span>Message greenroom</span><div class="send">%s</div></div></div>''' % (
        icon(BACK, 20, 2), tile("G", 150, 42), avs(["Sibhi", "Asha", "Dev"], 26), feed(), icon(UP, 17, 2))
    page("a", "phone-room", body, A_PHONE_CSS, w=390, h=844)

A_INV_CSS = """
body{display:flex;flex-direction:column;align-items:center;background:var(--bg)}
.wash{position:absolute;inset:0 0 auto 0;height:420px;background:linear-gradient(180deg,color-mix(in srgb,hsl(150 62% 50%) 16%,#fff),#fff);z-index:0}
.c{position:relative;z-index:1;width:100%;padding:44px 26px 0;display:flex;flex-direction:column}
.c img.lk{height:28px;align-self:flex-start;margin-bottom:46px}
.c h1{font-size:34px;font-weight:700;letter-spacing:-.025em;line-height:1.08;margin-top:20px}.c h1 em{font-style:normal;color:hsl(150 55% 30%)}
.c p{font-size:16px;line-height:1.5;color:var(--muted);margin-top:14px}
.who{display:flex;align-items:center;gap:12px;margin-top:22px;font-size:14.5px;line-height:1.35}.who b{font-weight:600}
.btnp{margin-top:26px;background:var(--duck);color:#18191B;border:0;border-radius:14px;padding:16px;font-weight:600;font-size:17px;text-align:center}
.fine{font-size:13.5px;color:var(--muted);text-align:center;margin-top:12px;line-height:1.5}
.card{margin-top:30px;background:var(--side);border:1px solid var(--line);border-radius:18px;padding:16px 18px;font-size:14.5px;line-height:1.5;color:var(--muted)}
.card b{color:var(--ink);font-weight:600}
"""

def a_invite():
    body = '''<div class="wash"></div><div class="c"><img class="lk" src="../assets/squeak-lockup-horizontal-ink.svg">%s
<h1>Sibhi invited you to <em>greenroom</em></h1>
<p>A shared place where people and coding Ducks work on the same project, together in one Room.</p>
<div class="who">%s<span><b>Sibhi, Dev and Meera</b> are waiting for you</span></div>
<div class="btnp">Join in your browser</div>
<div class="fine">Sign up with Zoho, Google or email. Nothing to install.<br>This invitation is for a***@gmail.com and lasts until 3 December.</div>
<div class="card"><b>As a Member</b> you can read and post in the Room, start Ducks and answer their questions. Sibhi approves new Tasks.</div></div>''' % (
        tile("G", 150, 60), avs(["Sibhi", "Dev", "Meera"], 34))
    page("a", "phone-invite", body, A_INV_CSS, w=390, h=844)

# =====================================================================
# DIRECTION B: chat first. A rail of pond tiles, the Room is the screen.
# =====================================================================
B_CSS = """
body{display:flex;--side:#1C1915}
.rail{width:88px;background:#1C1915;display:flex;flex-direction:column;align-items:center;padding:18px 0 16px;gap:6px;flex:none;color:#ECE7E2}
.dark .rail{background:#0C0A07}
.rail .logo{width:44px;margin-bottom:12px}
.ri{width:88px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:5px 0;position:relative;font-size:11.5px;color:#AFAAA5;font-weight:500}
.ri .tile{--tbring:#1C1915;background:hsl(var(--h) 55% 70%);color:hsl(var(--h) 70% 16%)}
.dark .ri .tile{--tbring:#0C0A07;background:hsl(var(--h) 55% 70%);color:hsl(var(--h) 70% 16%)}
.ri.bold{color:#ECE7E2;font-weight:700}
.ri.sel{color:#fff}
.ri.sel .tile{box-shadow:0 0 0 3px #1C1915,0 0 0 5px hsl(var(--h) 80% 78%)}
.dark .ri.sel .tile{box-shadow:0 0 0 3px #0C0A07,0 0 0 5px hsl(var(--h) 80% 78%)}
.ri.sel::before{content:"";position:absolute;left:0;top:18px;width:4px;height:28px;border-radius:0 4px 4px 0;background:#F8F7F3}
.ri .mk{position:absolute;top:-1px;right:3px;display:flex}
.ri .mk .tri{color:#E0A030}.ri .mk .tide{color:#7FB0FF}
.ri .lbl{max-width:78px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ri.dash .tile{background:transparent;border:1.5px dashed #6b655f;color:#ECE7E2}
.ri.dash .ic{color:#ECE7E2}
.ri .cnt{position:absolute;top:0;right:14px;font-size:11px;font-weight:700;color:#18191B;background:#F8F7F3;border-radius:9px;padding:0 6px;line-height:18px}
.rsp{flex:1}
.main{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
.hd{padding:16px 40px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line)}
.hd .tx{flex:1}.hd h1{font-size:21px;font-weight:700;letter-spacing:-.015em;line-height:1.15}.hd small{display:block;font-size:13px;color:var(--muted)}
.seg{display:inline-flex;background:var(--sel);border-radius:11px;padding:3px;gap:2px;font-size:13.5px;font-weight:500;color:var(--muted)}
.seg span{padding:6px 16px;border-radius:8px}.seg .on{background:var(--raised);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.dark .seg .on{background:var(--sel2)}
.pin{margin:14px 40px 0;display:flex;align-items:center;gap:14px;padding:12px 16px 12px 18px;border-radius:16px;position:relative;background:color-mix(in srgb,var(--acc) 9%,var(--bg));border:1px solid color-mix(in srgb,var(--acc) 22%,var(--line))}
.pin::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:2px;background:var(--subtle)}
.pin .tx{flex:1;min-width:0;font-size:14.5px}.pin b{font-weight:600}.pin small{display:block;font-size:13px;color:var(--muted)}
.pin .more{font-size:13px;color:var(--muted)}
.btnp{background:var(--inkb);color:#F8F7F3;border:0;border-radius:10px;padding:8px 16px;font-weight:600;font-size:14px}
.dark .btnp{background:var(--duck);color:#18191B}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:15px;padding:18px 0 14px;align-items:center}
.feed>*{width:860px;flex:none}
.m{gap:14px}.mt{font-size:16px}
.bub{background:color-mix(in srgb,var(--acc) 15%,var(--bg));border-radius:20px 20px 6px 20px;color:var(--ink)}
.dark .bub{background:color-mix(in srgb,var(--acc) 22%,var(--bg))}
.st{padding:8px 14px;border-radius:12px;background:var(--sel);margin-left:50px;width:810px}
.st .tr{color:var(--muted)}
.comp{padding:0 0 26px;display:flex;justify-content:center}
.field{width:860px;display:flex;align-items:center;gap:12px;border:1.5px solid var(--ls);border-radius:26px;padding:10px 10px 10px 22px;background:var(--raised);color:var(--subtle);font-size:16px;box-shadow:0 2px 10px rgba(30,20,10,.06)}
.field .chip{display:inline-flex;gap:5px;align-items:center;border-radius:999px;background:var(--sel);color:var(--ink);padding:5px 12px 5px 9px;font-size:13px;font-weight:500}
.field span.p{flex:1}.send{width:40px;height:40px;border-radius:50%;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:center}
.dark .send{color:#13100C}
.hint{width:860px;margin:0 auto;padding-bottom:8px;font-size:12.5px;color:var(--muted)}
"""

def b_rail(empty=False, selected=0):
    s = '<nav class="rail"><img class="logo" src="../assets/squeak-duck-full-color-512.png" alt="Squeak">'
    if not empty:
        s += '<div class="ri dash"><span class="tile" style="--s:52">%s</span><span class="cnt">1</span><span class="lbl">Invites</span></div>' % icon(MAIL, 22, 1.6)
        for i, (n, l, o, sub, trail, bold) in enumerate(PONDS):
            mk = tri(16) if trail == "tri" else tide(6, 3, 4, seed=3) if trail == "tide" else ""
            s += '<div class="ri %s %s" style="--h:%d"><span class="tile" style="--s:52;--h:%d">%s<span class="tb">%s</span></span><span class="mk">%s</span><span class="lbl">%s</span></div>' % (
                "sel" if i == selected else "", "bold" if bold else "", POND[n], POND[n], l, av(o, 19), mk, n)
    else:
        s += '<div class="ri dash"><span class="tile" style="--s:52"></span></div>'
    s += '<div class="rsp"></div><div class="ri">%s<span class="lbl">Asha</span></div></nav>' % av("Asha", 40)
    return s

def b_room(dark):
    body = b_rail() + '''<main class="main pa" style="--h:150"><div class="hd">%s<div class="tx"><h1>greenroom</h1><small>Sibhi’s Pond · Member · Live</small></div>%s<span style="width:10px"></span><div class="seg"><span class="on">Room</span><span>Ducks</span></div></div>
<div class="pin">%s<div class="tx"><b>Which tab should open first?</b><small>room-tabs asks · 4 min · and 1 more waiting in orchard</small></div>%s<button class="btnp">Answer</button></div>
<div class="feed">%s</div><div class="comp"><div class="field"><span class="chip">%s Make task</span><span class="p">Message greenroom</span><div class="send">%s</div></div></div></main>''' % (
        tile("G", 150, 40), avs(["Sibhi", "Asha", "Dev", "Meera", "Vikram"], 30, outlined=("Vikram",)), td(150, 28), tri(19), feed(), icon(PLUS, 14), icon(UP, 19, 2))
    page("b", "wide-room-dark" if dark else "wide-room", body, B_CSS, dark)

def b_empty():
    css = B_CSS + """
.ew{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;background:radial-gradient(800px 420px at 50% 70%,color-mix(in srgb,var(--duck) 13%,var(--bg)),var(--bg) 70%)}
.eb{width:640px;display:flex;flex-direction:column;gap:14px;margin-bottom:60px}
.eb .m{gap:14px}.eb .bubl{background:var(--sel);border-radius:6px 22px 22px 22px;padding:16px 20px;font-size:17px;line-height:1.5;max-width:520px}
.eb .bubl b{font-weight:700}
.eb .sub{margin-left:50px;font-size:13px;color:var(--muted)}
.eb .btnp{margin-left:50px;align-self:flex-start;padding:11px 20px;font-size:15px;border-radius:12px;background:var(--duck);color:#18191B}
.ph{width:640px;border:1.5px solid var(--line);border-radius:26px;padding:16px 22px;color:var(--subtle);font-size:16px;opacity:.7}
"""
    body = b_rail(empty=True) + '''<main class="main"><div class="hd"><div class="tx"><h1>Ponds</h1><small>asha@fernlabs.dev</small></div></div><div class="ew"><div class="eb">
<div class="m"><img src="../assets/squeak-duck-full-color-512.png" width="38" style="width:38px;height:33px;margin-top:4px;object-fit:contain" alt=""><div class="mb"><div class="mh"><b>Squeak</b></div><div class="bubl"><b>Ponds you share from your Mac appear here.</b> When someone invites you to theirs, it shows up here too, and you can chat in it straight away.</div></div></div>
<div class="sub">Just shared one? It can take a minute to appear.</div><button class="btnp">Get Squeak for Mac</button></div></div></main>'''
    # the placeholder composer line is drawn under the bubble to keep the chat-app shape
    page("b", "wide-empty", body, css)

B_PH_CSS = """
body{display:flex;flex-direction:column}
.strip{background:#1C1915;padding:50px 14px 10px;display:flex;gap:12px;align-items:flex-start;overflow:hidden;color:#AFAAA5}
.si{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10.5px;width:50px;font-weight:500;position:relative}
.si .tile{--tbring:#1C1915;background:hsl(var(--h) 55% 70%);color:hsl(var(--h) 70% 16%)}
.si.sel{color:#fff}.si.sel .tile{box-shadow:0 0 0 2px #1C1915,0 0 0 4px hsl(var(--h) 80% 78%)}
.si.bold{color:#ECE7E2;font-weight:700}.si .mk{position:absolute;top:-4px;right:-2px;display:flex}.si .mk .tri{color:#E0A030}.si .mk .tide{color:#7FB0FF}
.si .lbl{max-width:50px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.si.dash .tile{background:transparent;border:1.5px dashed #6b655f;color:#ECE7E2}
.hd{padding:12px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line)}
.hd .tx{flex:1;min-width:0}.hd h1{font-size:18px;font-weight:700;letter-spacing:-.01em;line-height:1.15}.hd small{display:block;font-size:12px;color:var(--muted)}
.seg{display:inline-flex;background:var(--sel);border-radius:10px;padding:2px;font-size:13px;font-weight:500;color:var(--muted)}.seg span{padding:5px 12px;border-radius:8px}.seg .on{background:var(--raised);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.pin{margin:10px 14px 0;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:14px;background:color-mix(in srgb,var(--acc) 9%,var(--bg));border:1px solid color-mix(in srgb,var(--acc) 22%,var(--line));position:relative}
.pin::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--subtle)}
.pin .tx{flex:1;min-width:0;font-size:13.5px;line-height:1.3}.pin b{font-weight:600;display:block}.pin small{color:var(--muted);font-size:12px}
.btnp{background:var(--inkb);color:#F8F7F3;border:0;border-radius:9px;padding:7px 13px;font-weight:600;font-size:13px}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;padding:12px 14px 8px}
.m{gap:10px}.mt{font-size:15px}.bub{background:color-mix(in srgb,var(--acc) 15%,var(--bg));border-radius:18px 18px 5px 18px;font-size:15px;max-width:84%;padding:9px 14px}
.st{font-size:13px;gap:8px;padding:7px 12px;border-radius:12px;background:var(--sel);margin-left:46px}.st .tr{min-width:28px}
.comp{padding:4px 12px 30px}
.field{display:flex;align-items:center;gap:8px;border:1.5px solid var(--ls);border-radius:24px;padding:6px 6px 6px 14px;background:var(--raised);color:var(--subtle);font-size:15px}
.field .chip{display:inline-flex;align-items:center;border-radius:999px;background:var(--sel);color:var(--ink);padding:4px 10px 4px 7px;font-size:12.5px;font-weight:500;gap:3px}
.field .p{flex:1}.send{width:34px;height:34px;border-radius:50%;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:center}
"""

def b_phone_room():
    strip = '<div class="strip"><div class="si dash"><span class="tile" style="--s:44;--h:0">%s</span><span class="lbl">Invites</span></div>' % icon(MAIL, 19)
    for i, (n, l, o, sub, trail, bold) in enumerate(PONDS):
        mk = tri(14) if trail == "tri" else ""
        strip += '<div class="si %s %s" style="--h:%d"><span class="tile" style="--s:44;--h:%d">%s</span><span class="mk">%s</span><span class="lbl">%s</span></div>' % (
            "sel" if i == 0 else "", "bold" if bold else "", POND[n], POND[n], l, mk, n)
    strip += '</div>'
    f = feed().replace('<div class="day">Yesterday</div>' + msg("Sibhi", "16:30", "Pond is set up. Asha and Dev, you can both post here and message any Duck.") + mine("Great, starting with the Room tab.", "16:42"), "")
    body = strip + '''<div class="hd pa" style="--h:150"><div class="tx"><h1>greenroom</h1><small>Sibhi’s Pond · Member · Live</small></div><div class="seg"><span class="on">Room</span><span>Ducks</span></div></div>
<div class="pin pa" style="--h:150">%s<div class="tx"><b>Which tab should open first?</b><small>room-tabs · 4 min</small></div>%s<button class="btnp">Answer</button></div>
<div class="feed pa" style="--h:150">%s</div><div class="comp pa" style="--h:150"><div class="field"><span class="chip">%s Task</span><span class="p">Message greenroom</span><div class="send">%s</div></div></div>''' % (
        td(150, 24), tri(17), f, icon(PLUS, 13), icon(UP, 17, 2))
    page("b", "phone-room", body, B_PH_CSS, w=390, h=844)

B_INV_CSS = """
body{display:flex;flex-direction:column;background:#F8F7F3;--bg:#F8F7F3}
.top{background:#1C1915;padding:52px 22px 22px;display:flex;align-items:center;gap:12px;color:#ECE7E2;font-size:14px}
.top img{width:40px}.top span{flex:1;color:#AFAAA5}
.thread{flex:1;padding:22px 18px 0;display:flex;flex-direction:column;gap:14px;background:#F8F7F3}
.feed{-webkit-mask-image:linear-gradient(transparent 0,#000 56px);mask-image:linear-gradient(transparent 0,#000 56px)}
.day{text-align:center;font-size:12px;color:var(--muted)}
.m{display:flex;gap:10px;align-items:flex-start}.mh{display:flex;gap:8px;align-items:baseline}.mh b{font-size:14px;font-weight:600}.mh span{font-size:12px;color:var(--muted)}
.bubl{background:#fff;border:1px solid var(--line);border-radius:6px 20px 20px 20px;padding:12px 16px;font-size:16px;line-height:1.45;margin-top:3px;max-width:290px}
.pc{margin-left:46px;background:#fff;border:1px solid var(--line);border-radius:22px;overflow:hidden}
.pch{padding:18px 18px 14px;background:linear-gradient(180deg,hsl(150 62% 90%),#fff);display:flex;gap:14px;align-items:center}
.pch h2{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.1}.pch small{font-size:13px;color:var(--muted)}
.pcb{padding:2px 18px 18px}.pcb .who{display:flex;gap:10px;align-items:center;font-size:13.5px;color:var(--muted);margin-bottom:14px}
.btnp{background:#18191B;color:#F8F7F3;border-radius:13px;padding:14px;font-weight:600;font-size:16.5px;text-align:center}
.fine{font-size:12.5px;color:var(--muted);text-align:center;margin-top:10px;line-height:1.5}
.sub{margin-left:46px;font-size:13px;color:var(--muted);line-height:1.5}
"""

def b_invite():
    body = '''<div class="top"><img src="../assets/squeak-duck-full-color-512.png" alt=""><span>Squeak</span></div><div class="thread">
<div class="day">Invitation</div>
<div class="m">%s<div class="mb"><div class="mh"><b>Sibhi</b><span>just now</span></div><div class="bubl">Come and join greenroom. It is where we talk and where the Ducks report back.</div></div></div>
<div class="pc"><div class="pch pa" style="--h:150">%s<div><h2>greenroom</h2><small>Sibhi’s Pond</small></div></div><div class="pcb"><div class="who">%s<span>Sibhi, Dev and Meera are in</span></div>
<div class="btnp">Join in your browser</div><div class="fine">Sign up with Zoho, Google or email. Nothing to install.</div></div></div>
<div class="sub">This invitation is for a***@gmail.com and lasts until 3 December. As a Member you can post, start Ducks and answer their questions.</div></div>''' % (
        av("Sibhi", 36), tile("G", 150, 56), avs(["Sibhi", "Dev", "Meera"], 28))
    page("b", "phone-invite", body, B_INV_CSS, w=390, h=844)

# =====================================================================
# DIRECTION C: bold. Duck-yellow ground, Figtree display, mono labels, ink cards.
# =====================================================================
C_CSS = """
body{display:flex;background:var(--bg);--paper:#F8F7F3;--bg:#F8F7F3}
.dark body,body.dk{--bg:#13100C}
.side{width:408px;background:#FFDA1A;color:#18191B;display:flex;flex-direction:column;padding:26px 22px 0;flex:none;--muted:#4a4637;--line:rgba(24,25,27,.16);--subtle:#6d6648;--warn:#A16207;--ink:#18191B}
.top{display:flex;align-items:center;justify-content:space-between}
.top img{height:38px}
h1.pt{font-family:Figtree,sans-serif;font-size:46px;font-weight:700;letter-spacing:-.03em;line-height:1;margin:18px 0 4px}
.mono{font-family:"JetBrains Mono",monospace;font-weight:500;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase}
.mono i{font-style:normal;opacity:.6}
.sec{margin:20px 2px 9px;display:flex;gap:8px}
.wc{background:#fff;border-radius:18px;color:#292622;--muted:#67625E;--subtle:#8A8580;--ink:#292622;--line:#E7E2DD}
.inv{display:flex;align-items:center;gap:12px;padding:12px 12px}
.inv .tx{flex:1;min-width:0}.inv b{display:block;font-family:Figtree;font-size:17px;font-weight:700;letter-spacing:-.01em}.inv small{font-size:12.5px;color:var(--muted)}
.btnp{background:#18191B;color:#F8F7F3;border:0;border-radius:10px;padding:8px 15px;font-weight:600;font-size:14px}
.btns{background:transparent;color:var(--muted);border:0;padding:8px 6px;font-weight:500;font-size:13.5px}
.need{display:flex;align-items:center;gap:12px;padding:11px 14px}.need+.need{border-top:1px solid var(--line)}
.need b{display:block;font-size:14.5px;font-weight:600}.need small{font-size:12.5px;color:var(--muted)}.need .tx{flex:1;min-width:0}
.pl{display:flex;flex-direction:column;gap:8px;flex:1;overflow:hidden}
.pr{display:flex;align-items:center;gap:13px;padding:10px 14px 10px 10px;border-radius:18px;background:#fff;color:#292622;--muted:#67625E}
.pr .tx{flex:1;min-width:0}.pr b{display:block;font-family:Figtree;font-size:18px;font-weight:600;letter-spacing:-.015em;line-height:1.15}.pr.bold b{font-weight:700}
.pr small{display:block;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr .tail{font-size:12.5px;color:var(--muted);flex:none;display:flex;justify-content:flex-end}
.pr.sel{background:#18191B;color:#F8F7F3;--muted:#ACAFB5;--tbring:#18191B}
.pr.sel .tail{color:#ACAFB5}.pr.sel .tri{color:#E0A030}.pr.sel .tide{color:#7FB0FF}
.pr .tile{--tbring:#fff}.pr.sel .tile{--tbring:#18191B}
.foot{margin:0 -22px;padding:14px 24px;display:flex;align-items:center;gap:12px;font-size:14px;border-top:1px solid rgba(24,25,27,.16)}
.foot .e{flex:1;font-weight:600}.foot .s{font-size:13.5px;color:#4a4637}
.dark .side{--work:#1D4ED8}
.dark .side .tile,.dark .side .av{background:hsl(var(--h) 62% 86%);color:hsl(var(--h) 60% 24%)}
.dark .side .td{background:hsl(var(--h) 58% 52%)}
.dark .side .pr.sel .tide{color:#7FB0FF}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.hd{padding:28px 48px 0;background:color-mix(in srgb,hsl(var(--h) 70% 55%) 13%,var(--bg));border-bottom:1px solid var(--line)}
.dark .hd{background:color-mix(in srgb,hsl(var(--h) 60% 45%) 16%,var(--bg))}
.hd .mono{color:var(--acc)}
.hrow{display:flex;align-items:flex-end;gap:16px;margin-top:6px}
.hrow h2{font-family:Figtree;font-size:54px;font-weight:700;letter-spacing:-.035em;line-height:1;color:var(--acc);flex:1}
.hrow .avs{margin-bottom:6px;--avring:color-mix(in srgb,hsl(var(--h) 70% 55%) 13%,var(--bg))}
.dark .hrow .avs{--avring:color-mix(in srgb,hsl(var(--h) 60% 45%) 16%,var(--bg))}
.tabs{display:flex;gap:30px;margin-top:20px}.tabs span{font-family:"JetBrains Mono";font-weight:500;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:8px 0 13px;border-bottom:3px solid transparent;margin-bottom:-1px}
.tabs .on{color:var(--ink);border-color:var(--acc)}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:15px;padding:20px 0 14px;align-items:center}
.feed>*{width:700px;flex:none}
.mh b{font-family:Figtree;font-size:16px;font-weight:700}
.bub{background:#18191B;color:#F8F7F3;border-radius:22px 22px 6px 22px}
.dark .bub{background:#F8F7F3;color:#18191B}
.st{padding:9px 14px;border:1.5px solid var(--line);border-radius:14px;margin-left:0}.st .tr{color:var(--muted)}
.comp{padding:0 0 26px;display:flex;flex-direction:column;align-items:center;gap:10px}.comp>*{width:700px}
.chips{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--muted)}
.chip{display:inline-flex;gap:6px;align-items:center;border:1.5px solid var(--ls);border-radius:999px;padding:4px 12px 4px 8px;color:var(--ink);font-weight:500}
.field{display:flex;align-items:center;gap:12px;border:2px solid #18191B;border-radius:20px;padding:8px 8px 8px 20px;background:#fff;color:#8A8580;font-size:16px}
.dark .field{border-color:#FFDA1A;background:#1C1915}
.field span{flex:1}.send{width:38px;height:38px;border-radius:12px;background:#FFDA1A;color:#18191B;display:flex;align-items:center;justify-content:center}
"""

def c_side(empty=False, selected=0):
    s = '<aside class="side"><div class="top"><img src="../assets/squeak-duck-mono-ink-512.png" alt="Squeak"></div><h1 class="pt">Ponds</h1><div class="mono"><i>%s</i></div>' % (EMAIL if empty else "Shared with you")
    if not empty:
        s += '<div class="sec mono">Invitations <i>1</i></div><div class="wc inv">%s<div class="tx"><b>harbour</b><small>Dev invited you</small></div><button class="btnp">Join</button><button class="btns">Decline</button></div>' % tile("H", POND["harbour"], 42, "Dev")
        s += '<div class="sec mono">Needs you <i>2</i></div><div class="wc">'
        for h, t, sub in NEEDS:
            s += '<div class="need">%s<div class="tx"><b>%s</b><small>%s</small></div>%s</div>' % (td(h, 24), t, sub, tri(19))
        s += '</div><div class="sec mono">All Ponds</div><div class="pl">'
        for i, (n, l, o, sub, trail, bold) in enumerate(PONDS[:4]):
            tr = tri(19) if trail == "tri" else tide(8, 3, 3.5, seed=3) if trail == "tide" else trail
            s += '<div class="pr %s %s">%s<div class="tx"><b>%s</b><small>%s</small></div><span class="tail">%s</span></div>' % (
                "sel" if i == selected else "", "bold" if bold else "", tile(l, POND[n], 44, o), n, sub, tr)
        s += '</div>'
    else:
        s += '<div class="sec mono">Nothing yet</div><div class="pl"><div class="wc" style="padding:16px 18px;font-size:14.5px;line-height:1.5;color:#67625E">Ponds that are shared with you are listed here, newest first.</div></div>'
    if not empty:
        s += ''
    s += '<div class="foot">%s<span class="e">%s</span><span class="s">Settings</span></div></aside>' % (av("Asha", 34), EMAIL if not empty else "Signed in")
    return s

def c_room(dark):
    body = c_side() + '''<main class="main pa" style="--h:150"><div class="hd" style="--h:150"><div class="mono">Sibhi’s Pond · Member · Live</div>
<div class="hrow"><h2>greenroom</h2>%s</div><div class="tabs"><span class="on">Room</span><span>Ducks</span></div></div>
<div class="feed">%s</div><div class="comp"><div class="chips"><span class="chip">%s Make task</span>Sibhi approves new Tasks</div>
<div class="field"><span>Message greenroom</span><div class="send">%s</div></div></div></main>''' % (
        avs(["Sibhi", "Asha", "Dev", "Meera", "Vikram"], 36, outlined=("Vikram",)), feed(), icon(PLUS, 14), icon(UP, 19, 2.2))
    page("c", "wide-room-dark" if dark else "wide-room", body, C_CSS, dark)

def c_empty():
    css = C_CSS + """
.eh{flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 90px;position:relative;overflow:hidden}
.eh .mono{color:var(--muted)}
.eh h2{font-family:Figtree;font-size:68px;font-weight:700;letter-spacing:-.04em;line-height:1.02;margin:16px 0 20px;max-width:700px}
.eh p{font-size:19px;line-height:1.55;color:var(--muted);max-width:520px}
.eh .btnp{align-self:flex-start;margin-top:30px;padding:15px 26px;font-size:16.5px;border-radius:14px}
.eh small{margin-top:16px;font-size:13.5px;color:var(--muted)}
.eh img{position:absolute;right:70px;bottom:60px;width:340px}
.eh h2 em{font-style:normal;background:linear-gradient(transparent 62%,#FFDA1A 62%,#FFDA1A 92%,transparent 92%)}
"""
    body = c_side(empty=True) + '''<main class="main"><div class="eh"><div class="mono">Nothing shared yet</div><h2>Ponds you share from your <em>Mac</em> appear here</h2>
<p>Share a Pond from Squeak for Mac and it shows up in this list, ready to chat in. When someone invites you to theirs, it arrives here too.</p>
<button class="btnp">Get Squeak for Mac</button><small>Just shared one? It can take a minute to appear.</small>
<img src="../assets/squeak-duck-full-color-512.png" alt=""></div></main>'''
    page("c", "wide-empty", body, css)

C_PH_CSS = """
body{display:flex;flex-direction:column;--bg:#F8F7F3}
.bar{background:color-mix(in srgb,hsl(var(--h) 70% 55%) 13%,var(--bg));padding:52px 18px 0;border-bottom:1px solid var(--line)}
.back{display:flex;align-items:center;gap:2px;color:var(--ink);font-size:14.5px;font-weight:600;margin-left:-4px}
.mono{font-family:"JetBrains Mono",monospace;font-weight:500;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.hrow{display:flex;align-items:flex-end;margin-top:12px}.hrow h1{font-family:Figtree;font-size:40px;font-weight:700;letter-spacing:-.035em;line-height:1;color:var(--acc);flex:1}
.hrow .avs{margin-bottom:3px;--avring:color-mix(in srgb,hsl(var(--h) 70% 55%) 13%,var(--bg))}
.tabs{display:flex;gap:24px;margin-top:14px}.tabs span{font-family:"JetBrains Mono";font-weight:500;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:7px 0 11px;border-bottom:3px solid transparent;margin-bottom:-1px}.tabs .on{color:var(--ink);border-color:var(--acc)}
.feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;padding:14px 18px 10px}
.m{gap:10px}.mt{font-size:15px}.mh b{font-family:Figtree;font-size:15px;font-weight:700}
.bub{background:#18191B;color:#F8F7F3;border-radius:20px 20px 5px 20px;font-size:15px;max-width:84%;padding:9px 15px}
.st{font-size:13px;gap:8px;padding:7px 12px;border:1.5px solid var(--line);border-radius:13px}.st .tr{min-width:28px}
.comp{padding:4px 14px 30px}
.field{display:flex;align-items:center;gap:10px;border:2px solid #18191B;border-radius:18px;padding:6px 6px 6px 16px;background:#fff;color:#8A8580;font-size:15px}
.field span{flex:1}.send{width:34px;height:34px;border-radius:11px;background:#FFDA1A;color:#18191B;display:flex;align-items:center;justify-content:center}
"""

def c_phone_room():
    f = feed()
    body = '''<div class="bar pa" style="--h:150"><div class="back">%s Ponds</div><div class="mono" style="margin-top:14px">Sibhi’s Pond · Member · Live</div>
<div class="hrow"><h1>greenroom</h1>%s</div><div class="tabs"><span class="on">Room</span><span>Ducks</span></div></div>
<div class="feed pa" style="--h:150">%s</div><div class="comp pa" style="--h:150"><div class="field"><span>Message greenroom</span><div class="send">%s</div></div></div>''' % (
        icon(BACK, 20, 2), avs(["Sibhi", "Asha", "Dev"], 28), f, icon(UP, 17, 2.2))
    page("c", "phone-room", body, C_PH_CSS, w=390, h=844)

C_INV_CSS = """
body{display:flex;flex-direction:column;background:#F8F7F3}
.y{background:#FFDA1A;color:#18191B;padding:52px 24px 30px;border-radius:0 0 34px 34px;display:flex;flex-direction:column}
.y img{width:44px;margin-bottom:26px}
.mono{font-family:"JetBrains Mono",monospace;font-weight:500;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.y h1{font-family:Figtree;font-size:46px;font-weight:700;letter-spacing:-.04em;line-height:1;margin-top:12px}
.y p{font-size:16px;line-height:1.5;margin-top:14px;color:#3a3720}
.btnp{margin-top:24px;background:#18191B;color:#F8F7F3;border-radius:14px;padding:16px;font-weight:600;font-size:17px;text-align:center}
.fine{font-size:12.5px;text-align:center;margin-top:12px;color:#3a3720;line-height:1.5}
.b{padding:24px 24px 0;display:flex;flex-direction:column;gap:18px}
.pc{display:flex;gap:14px;align-items:center}
.pc h2{font-family:Figtree;font-size:28px;font-weight:700;letter-spacing:-.03em;color:hsl(150 55% 30%);line-height:1}
.pc small{display:block;font-size:13px;color:var(--muted);margin-top:4px}
.who{display:flex;align-items:center;gap:12px;font-size:14.5px;line-height:1.4;color:var(--muted)}.who b{color:var(--ink);font-weight:600}
.note{border:1.5px solid var(--line);border-radius:16px;padding:14px 16px;font-size:14px;line-height:1.5;color:var(--muted);text-align:left}
"""

def c_invite():
    body = '''<div class="y"><img src="../assets/squeak-duck-mono-ink-512.png" alt=""><div class="mono">An invitation for a***@gmail.com</div>
<h1>Sibhi invited you to greenroom</h1><p>A shared place where people and coding Ducks work on the same project, together in one Room.</p>
<div class="btnp">Join in your browser</div><div class="fine">Sign up with Zoho, Google or email. Nothing to install.</div></div>
<div class="b"><div class="pc pa" style="--h:150">%s<div><h2>greenroom</h2><small>Sibhi’s Pond · until 3 December</small></div></div>
<div class="who">%s<span><b>Sibhi, Dev and Meera</b> are waiting for you</span></div>
<div class="note">As a Member you can read and post in the Room, start Ducks and answer the questions they ask. Sibhi approves new Tasks.</div></div>''' % (
        tile("G", 150, 56), avs(["Sibhi", "Dev", "Meera"], 34))
    page("c", "phone-invite", body, C_INV_CSS, w=390, h=844)

if __name__ == "__main__":
    for dark in (False, True):
        a_room(dark); b_room(dark); c_room(dark)
    a_empty(); b_empty(); c_empty()
    a_phone_room(); b_phone_room(); c_phone_room()
    a_invite(); b_invite(); c_invite()
    print("ok")
