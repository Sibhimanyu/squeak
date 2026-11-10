import importlib.util
from pathlib import Path
import tempfile
import sys
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("deltas", Path(__file__).with_name("appcast-deltas.py"))
sys.dont_write_bytecode = True
deltas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deltas)


class DeltaManifestTests(unittest.TestCase):
    def enclosure(self, **attrs):
        return ET.Element("enclosure", {"url": deltas.PREFIX + "Squeak21803-21802.delta",
                          deltas.S + "edSignature": "signed", deltas.S + "deltaFrom": "21802", "length": "100", **attrs})

    def test_rejects_unsigned_wrong_origin_and_traversal(self):
        for attrs in [{deltas.S + "edSignature": ""}, {deltas.S + "deltaFrom": ""},
                      {"length": "0"}, {"url": "https://example.com/Squeak.delta"},
                      {"url": deltas.PREFIX + "Squeak%2F..%2Ffoo.delta"}]:
            with self.subTest(attrs=attrs), self.assertRaises(ValueError):
                deltas.delta_name(self.enclosure(**attrs))

    def test_selects_two_previous_versions_numerically_and_ignores_future(self):
        with tempfile.TemporaryDirectory() as temp:
            for v in ["2.9.0", "2.18.1", "2.18.2", "2.18.3", "2.19.0"]:
                Path(temp, f"Squeak-{v}.zip").touch()
            self.assertEqual([p.name for p in deltas.baselines(temp, "2.18.3")], ["Squeak-2.18.2.zip", "Squeak-2.18.1.zip"])
            self.assertEqual(deltas.baselines(temp, "2.0.0"), [])

    def test_lists_patches_for_all_retained_items_without_full_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = ET.Element("rss")
            channel = ET.SubElement(root, "channel")
            for _ in range(2):
                item = ET.SubElement(channel, "item")
                ET.SubElement(item, "enclosure", {"url": "full.dmg"})
                ET.SubElement(item, deltas.S + "deltas").append(self.enclosure())
            feed = Path(temp, "appcast.xml")
            ET.ElementTree(root).write(feed)
            self.assertEqual(deltas.paths(feed), ["squeak/download/Squeak21803-21802.delta"])

    def test_fresh_release_machine_keeps_the_full_feed_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            feed = Path(temp, "appcast.xml")
            original = b'<rss><channel><item><enclosure url="full.dmg"/></item></channel></rss>'
            feed.write_bytes(original)
            deltas.generate(temp, "2.18.3", "21803")
            self.assertEqual(feed.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
