#!/usr/bin/env python3
"""Add Sparkle-generated, signed incremental updates to the current appcast.

Uses the last two local release ZIPs; a clean release machine without baselines
keeps the full DMG fallback. --list emits the exact Pages paths the feed needs.
"""
import copy
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

S = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
PREFIX = "https://sibhimanyu.github.io/squeak/download/"
ET.register_namespace("sparkle", S[1:-1])


def delta_name(enclosure):
    url = enclosure.get("url", "")
    name = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    if url != PREFIX + name or not re.fullmatch(r"Squeak[\w.-]+\.delta", name, flags=re.ASCII):
        raise ValueError(f"Unexpected delta URL: {url}")
    if not enclosure.get(S + "edSignature") or not enclosure.get(S + "deltaFrom", "").isdigit():
        raise ValueError("Delta must be signed and identify its source build")
    if not enclosure.get("length", "").isdigit() or int(enclosure.get("length")) <= 0:
        raise ValueError("Delta must have a positive byte length")
    return name


def paths(feed):
    return sorted({"squeak/download/" + delta_name(e)
                   for e in ET.parse(feed).getroot().findall(f"./channel/item/{S}deltas/enclosure")})


def baselines(directory, version):
    key = lambda value: tuple(map(int, value.split(".")))
    found = []
    for archive in Path(directory).glob("Squeak-*.zip"):
        match = re.fullmatch(r"Squeak-(\d+\.\d+\.\d+)\.zip", archive.name)
        if match and key(match[1]) < key(version):
            found.append((key(match[1]), archive))
    return [p for _, p in sorted(found, reverse=True)[:2]]


def generate(directory, version, build):
    directory = Path(directory).resolve()
    previous = baselines(directory, version)
    if not previous:
        print("delta updates: no previous local release archives; keeping the full download")
        return
    macos = Path(__file__).resolve().parent.parent
    tool = macos / ".build/artifacts/sparkle/Sparkle/bin/generate_appcast"
    key = Path.home() / "Library/Application Support/squeak/sparkle-ed25519-private.key"
    feed = directory / "appcast.xml"
    tree = ET.parse(feed)
    current = next(i for i in tree.getroot().findall("./channel/item") if i.findtext(S + "version") == build)
    full = directory / f"Squeak-{version}.dmg"
    with tempfile.TemporaryDirectory(prefix="deltas-", dir=directory) as temp:
        stage = Path(temp)
        # The DMG also contains the uninstaller app. Sparkle's generator needs the
        # single-app ZIPs; only its delta enclosures are merged into our DMG feed.
        for archive in [directory / f"Squeak-{version}.zip", *previous]:
            os.link(archive, stage / archive.name)
        subprocess.run([str(tool), "--ed-key-file", str(key), "--download-url-prefix", PREFIX,
                        "--versions", build, "--maximum-deltas", "2", str(stage)], check=True)
        generated = ET.parse(stage / "appcast.xml")
        item = next(i for i in generated.getroot().findall("./channel/item") if i.findtext(S + "version") == build)
        deltas = item.find(S + "deltas")
        if deltas is None:
            print("delta updates: Sparkle found no suitable smaller patches; keeping the full download")
            return
        for enclosure in deltas.findall("enclosure"):
            name = delta_name(enclosure)
            artifact = stage / name
            size = artifact.stat().st_size
            if size != int(enclosure.get("length")) or size >= full.stat().st_size:
                raise ValueError(f"Invalid or oversized delta: {name}")
            os.replace(artifact, directory / name)
            print(f"delta updates: {name}: {size:,} bytes instead of {full.stat().st_size:,}")
        old = current.find(S + "deltas")
        if old is not None:
            current.remove(old)
        current.append(copy.deepcopy(deltas))
        ET.indent(tree, space="  ")
        pending = stage / "merged.xml"
        tree.write(pending, encoding="utf-8", xml_declaration=True)
        os.replace(pending, feed)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--list":
        print("\n".join(paths(sys.argv[2])))
    else:
        generate(*sys.argv[1:4])
