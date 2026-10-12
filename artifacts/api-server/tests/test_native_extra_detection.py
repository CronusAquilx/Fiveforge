import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from native_assets import diffuse_texture_slot, extra_part_from_name, material_color, vehicle_extra_parts


class NativeExtraDetectionTests(unittest.TestCase):
    def test_detects_numeric_and_word_number_extras(self):
        self.assertEqual(extra_part_from_name("extra_01")["id"], "extra:1:normal")
        self.assertEqual(extra_part_from_name("extra_ten")["id"], "extra:10:normal")
        self.assertEqual(extra_part_from_name("extra11")["id"], "extra:11:normal")

    def test_detects_flipped_reversed_and_mirrored_variants(self):
        cases = {
            "extra1flipped": "extra:1:flipped",
            "flipped_extra_2": "extra:2:flipped",
            "extra_flipped_3": "extra:3:flipped",
            "extra_4_reversed": "extra:4:reversed",
            "extra5mirror": "extra:5:mirrored",
        }
        for name, expected_id in cases.items():
            with self.subTest(name=name):
                self.assertEqual(extra_part_from_name(name)["id"], expected_id)

    def test_does_not_treat_unrelated_words_as_extras(self):
        self.assertIsNone(extra_part_from_name("extraordinary"))

    def test_collects_names_from_bones_and_all_drawable_meshes(self):
        drawable = SimpleNamespace(
            name="vehicle",
            skeleton=SimpleNamespace(bones=[SimpleNamespace(name="extra_1")]),
            iter_models=lambda: [
                SimpleNamespace(meshes=[SimpleNamespace(name="extra2flipped")]),
                SimpleNamespace(meshes=[SimpleNamespace(name="extra_3_reversed")]),
            ],
        )
        results = vehicle_extra_parts([SimpleNamespace(name="drawable", drawable=drawable)])
        self.assertEqual(
            {part["id"] for part in results},
            {"extra:1:normal", "extra:2:flipped", "extra:3:reversed"},
        )

    def test_vehicle_paint_uses_the_second_diffuse_sampler_as_its_color_layer(self):
        slots = {
            "DiffuseSampler": "vehicle_generic_smallspecmap",
            "DiffuseSampler2": "jesko_sign_4",
        }
        self.assertEqual(diffuse_texture_slot("vehicle_paint3", slots), "DiffuseSampler2")
        self.assertEqual(material_color(None, "vehicle_paint3"), [1.0, 1.0, 1.0])

    def test_vehicle_paint_uses_a_matched_sampler_before_an_unmatched_one(self):
        slots = {
            "DiffuseSampler2": "missing_livery",
            "DiffuseSampler": "body_color",
        }
        self.assertEqual(
            diffuse_texture_slot("vehicle_paint3", slots, lambda name: name == "body_color"),
            "DiffuseSampler",
        )

    def test_other_shaders_keep_the_standard_base_color_sampler_order(self):
        slots = {
            "DiffuseSampler": "generic",
            "BaseColorSampler": "painted_body",
        }
        self.assertEqual(diffuse_texture_slot("vehicle_mesh", slots), "BaseColorSampler")


if __name__ == "__main__":
    unittest.main()
