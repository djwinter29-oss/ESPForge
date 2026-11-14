"""Regression checks for the alternate storage image's generated hardware contract."""

import runpy
import tempfile
import unittest
from pathlib import Path

CHECK = runpy.run_path(str(Path(__file__).resolve().parents[3] / "tools/check_firmware_config.py"))

SPI_DTS = """
spi3: spi@60024000 {
    status = "okay";
    pinctrl-0 = < &espforge_sd_spi_default >;
    cs-gpios = < &gpio0 0xa 0x1 >;
    espforge_sd_spi: sdhc@0 {
        compatible = "zephyr,sdhc-spi-slot";
        spi-max-frequency = < 0x17d7840 >;
    };
};
espforge_sd_spi_default: espforge_sd_spi_default {
    clock { pinmux = < 12 >; };
    data { pinmux = < 11 >, < 13 >; bias-pull-up; };
};
espforge_sd: sdhc@0 {
    status = "disabled";
    mmc { status = "disabled"; };
};
"""


class FirmwareConfigTests(unittest.TestCase):
    def test_spi_wiring_and_disabled_native_disk_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            dts = build / "zephyr.dts"
            dts.write_text(SPI_DTS)
            self.assertEqual(CHECK["sd_spi_failures"](build), [])
            for old, new in (("< 12 >", "< 35 >"), ("0xa 0x1", "0xa 0x0"),
                             ("bias-pull-up;", ""), ("0x17d7840", "0x2faf080"),
                             ('mmc { status = "disabled";', 'mmc { status = "okay";')):
                with self.subTest(change=old):
                    dts.write_text(SPI_DTS.replace(old, new))
                    self.assertTrue(CHECK["sd_spi_failures"](build))

    def test_card_detect_requires_inserted_high_gpio8_with_pulldown(self):
        self.assertEqual(CHECK["card_detect_failures"]("sd-detect-gpios = < &gpio0 0x8 0x20 >;"), [])
        for value in ("", "sd-detect-gpios = < &gpio0 8 0x21 >;", "sd-detect-gpios = < &gpio0 9 0x20 >;"):
            with self.subTest(value=value):
                self.assertTrue(CHECK["card_detect_failures"](value))


if __name__ == "__main__":
    unittest.main()
