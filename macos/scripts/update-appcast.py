#!/usr/bin/env python3
"""Adds (or replaces) one <item> in a Sparkle appcast, keeping every other item.

usage: update-appcast.py <existing-or-missing appcast> <out> <version> <build> <dmg-url>
                         <release-notes-url> <length> <ed-signature>
"""
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import format_datetime

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE)
S = "{%s}" % SPARKLE

src, out, version, build, url, notes, length, sig = sys.argv[1:9]

try:
    tree = ET.parse(src)
    channel = tree.getroot().find("channel")
    assert channel is not None
except (OSError, ET.ParseError, AssertionError):
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Squeak"
    ET.SubElement(channel, "link").text = "https://sibhimanyu.github.io/squeak/"
    ET.SubElement(channel, "description").text = "Squeak for Mac updates"
    ET.SubElement(channel, "language").text = "en"
    tree = ET.ElementTree(rss)

for item in channel.findall("item"):
    v = item.find(S + "version")
    if v is not None and v.text == build:
        channel.remove(item)

item = ET.Element("item")
ET.SubElement(item, "title").text = "Squeak " + version
ET.SubElement(item, "pubDate").text = format_datetime(datetime.now(timezone.utc))
ET.SubElement(item, S + "version").text = build
ET.SubElement(item, S + "shortVersionString").text = version
ET.SubElement(item, S + "minimumSystemVersion").text = "14.0"
ET.SubElement(item, S + "releaseNotesLink").text = notes
ET.SubElement(item, "enclosure", {
    "url": url, "length": length, "type": "application/octet-stream", S + "edSignature": sig,
})

items = channel.findall("item") + [item]
for i in channel.findall("item"):
    channel.remove(i)
items.sort(key=lambda i: int(i.find(S + "version").text), reverse=True)
for i in items:
    channel.append(i)

ET.indent(tree, space="  ")
tree.write(out, encoding="utf-8", xml_declaration=True)
