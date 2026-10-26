#!/usr/bin/env python3
"""Puts the changelog into a Sparkle appcast as inline <description> HTML.

Sparkle shows an item's <description> in its update window; a releaseNotesLink to a GitHub
release page shows GitHub's own chrome instead. Every item whose version has a `## <version>`
section in CHANGELOG.md gets that section as HTML (and loses its releaseNotesLink); an item
with no section keeps its link. Sparkle shows only the chosen item's description, so the newest
item also carries the previous 4 versions under "Also in <version>", for someone skipping versions.

usage: appcast-notes.py <CHANGELOG.md> <appcast in> <appcast out>
       appcast-notes.py --self-test
stdlib only; no external loads, no scripts in the HTML.
"""
import html
import re
import sys
import xml.etree.ElementTree as ET

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
S = "{%s}" % SPARKLE
ALSO = 4

CSS = (
    "html{color-scheme:light dark}"
    "body{font:13px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;"
    "color:#18181b;background:transparent;margin:0;padding:4px 2px}"
    "ul{margin:0 0 10px;padding-left:18px}li{margin:0 0 6px}p{margin:0 0 10px}"
    "h4{font-size:12px;font-weight:600;color:#52525b;margin:16px 0 6px;"
    "padding-top:10px;border-top:1px solid rgba(0,0,0,.08)}"
    "code{font:12px ui-monospace,'SF Mono',monospace;background:rgba(0,0,0,.06);"
    "padding:1px 4px;border-radius:6px}"
    "@media (prefers-color-scheme:dark){body{color:#f4f4f5}h4{color:#a1a1aa;"
    "border-top-color:rgba(255,255,255,.12)}code{background:rgba(255,255,255,.1)}}"
)


def sections(changelog):
    """{version: markdown body} from `## <version>` headings."""
    out, cur, buf = {}, None, []
    for line in changelog.splitlines():
        m = re.match(r"^## (\S+)\s*$", line)
        if m:
            if cur is not None:
                out[cur] = "\n".join(buf).strip()
            cur, buf = m.group(1), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out[cur] = "\n".join(buf).strip()
    return out


def inline(text):
    t = html.escape(text, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)


def md_to_html(md):
    """Bullets become <ul><li>, other text paragraphs; everything is escaped first."""
    out, items, para = [], [], []

    def flush_items():
        if items:
            out.append("<ul>" + "".join("<li>%s</li>" % inline(" ".join(i)) for i in items) + "</ul>")
            items.clear()

    def flush_para():
        if para:
            out.append("<p>%s</p>" % inline(" ".join(para)))
            para.clear()

    for line in md.splitlines():
        s = line.strip()
        if not s:
            flush_items(); flush_para()
        elif re.match(r"^[-*] ", s):
            flush_para()
            items.append([s[2:].strip()])
        elif items and line[:1] in (" ", "\t"):
            items[-1].append(s)
        else:
            flush_items(); para.append(s)
    flush_items(); flush_para()
    return "".join(out)


def document(body):
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>%s</style></head><body>%s</body></html>" % (CSS, body)


def cdata(text):
    return "<![CDATA[" + text.replace("]]>", "]]]]><![CDATA[>") + "]]>"


def apply(changelog, appcast_in, appcast_out):
    secs = sections(open(changelog, encoding="utf-8").read())
    ET.register_namespace("sparkle", SPARKLE)
    tree = ET.parse(appcast_in)
    channel = tree.getroot().find("channel")
    items = channel.findall("item")
    items.sort(key=lambda i: int(i.find(S + "version").text), reverse=True)
    ver = lambda i: i.find(S + "shortVersionString").text
    placeholders = {}
    for n, item in enumerate(items):
        v = ver(item)
        if not secs.get(v):
            continue
        body = md_to_html(secs[v])
        if n == 0:
            older = [ver(i) for i in items[1:] if secs.get(ver(i))][:ALSO]
            for o in older:
                body += "<h4>Also in %s</h4>%s" % (html.escape(o), md_to_html(secs[o]))
        for tag in ("description", S + "releaseNotesLink"):
            for e in item.findall(tag):
                item.remove(e)
        key = "@@NOTES-%s@@" % v
        placeholders[key] = cdata(document(body))
        d = ET.Element("description")
        d.text = key
        # after minimumSystemVersion, before the enclosure
        item.insert(list(item).index(item.find("enclosure")), d)
    ET.indent(tree, space="  ")
    xml = ET.tostring(tree.getroot(), encoding="unicode")
    for k, v in placeholders.items():
        xml = xml.replace(k, v)
    with open(appcast_out, "w", encoding="utf-8") as f:
        f.write("<?xml version='1.0' encoding='utf-8'?>\n" + xml + "\n")
    ET.parse(appcast_out)  # must stay valid


def self_test():
    md = "- First <b>one</b> with `code`\n  continued line.\n- Second **bold** ]]> end\n\nA paragraph & more."
    h = md_to_html(md)
    assert h == ("<ul><li>First &lt;b&gt;one&lt;/b&gt; with <code>code</code> continued line.</li>"
                 "<li>Second <strong>bold</strong> ]]&gt; end</li></ul><p>A paragraph &amp; more.</p>"), h
    assert "<script" not in md_to_html("<script>x</script>")
    assert cdata("a]]>b") == "<![CDATA[a]]]]><![CDATA[>b]]>"
    s = sections("# C\n\n## 2.0.0\n\n- a\n\n## 1.0.0\n\n- b\n")
    assert s == {"2.0.0": "- a", "1.0.0": "- b"}, s
    import tempfile, os
    d = tempfile.mkdtemp()
    cl, ai, ao = (os.path.join(d, n) for n in ("c.md", "a.xml", "o.xml"))
    open(cl, "w").write("## 3.0.0\n\n- three ]]> x\n\n## 2.0.0\n\n- two\n")
    items = "".join(
        "<item><title>Squeak %s</title><sparkle:version>%s</sparkle:version>"
        "<sparkle:shortVersionString>%s</sparkle:shortVersionString>"
        "<sparkle:releaseNotesLink>https://x/%s</sparkle:releaseNotesLink>"
        "<enclosure url=\"u\" length=\"1\" sparkle:edSignature=\"sig\"/></item>" % (v, b, v, v)
        for v, b in (("3.0.0", "30000"), ("2.0.0", "20000"), ("1.0.0", "10000")))
    open(ai, "w").write('<rss xmlns:sparkle="%s" version="2.0"><channel>%s</channel></rss>' % (SPARKLE, items))
    apply(cl, ai, ao)
    got = ET.parse(ao).getroot().find("channel").findall("item")
    d3, d2, d1 = got
    assert "three ]]&gt; x" in d3.find("description").text and "Also in 2.0.0" in d3.find("description").text
    assert "Also in" not in d2.find("description").text and "two" in d2.find("description").text
    assert d1.find("description") is None and d1.find(S + "releaseNotesLink") is not None
    assert d3.find(S + "releaseNotesLink") is None
    assert d3.find("enclosure").get(S + "edSignature") == "sig"
    print("appcast-notes self-test ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif len(sys.argv) == 4:
        apply(*sys.argv[1:])
    else:
        sys.exit(__doc__)
