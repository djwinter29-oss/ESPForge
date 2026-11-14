"""Exercise LED startup against a simulated SPI first-transfer disturbance."""

from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
STUBS = r"""
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

struct device { int unused; };
struct led_rgb { uint8_t r, g, b; };
struct k_work { void (*handler)(struct k_work *); };
static const struct device test_device;
static bool ready = true;
static unsigned transfers, fail_at, logs;
static struct led_rgb latched;

#define DEVICE_DT_GET(node) (&test_device)
#define K_MUTEX_DEFINE(name) static int name
#define K_FOREVER 0
#define ARG_UNUSED(arg) (void)(arg)
#define LOG_LEVEL_INF 0
#define LOG_MODULE_REGISTER(...)
#define LOG_ERR(...) (++logs)
#define K_WORK_DEFINE(name, callback) static struct k_work name = { callback }

static bool device_is_ready(const struct device *dev) { (void)dev; return ready; }
static void k_mutex_lock(int *lock, int timeout) { (void)lock; (void)timeout; }
static void k_mutex_unlock(int *lock) { (void)lock; }
static int k_work_submit(struct k_work *work) { work->handler(work); return 1; }
static int led_strip_update_rgb(const struct device *dev, struct led_rgb *pixel, size_t count)
{
    (void)dev;
    (void)count;
    ++transfers;
    if (transfers == fail_at) return -5;
    if (transfers == 1) latched.g = 16;
    else latched = *pixel;
    return 0;
}
"""
CHECKS = r"""
#include <assert.h>

static void reset(void)
{
    ready = true;
    transfers = fail_at = logs = 0;
    latched = (struct led_rgb){0};
}

int main(void)
{
    bool available;
    uint8_t colour;
    ef_platform_led_init();
    ef_platform_led_status(&colour, &available);
    assert(available && colour == 0);
    assert(latched.r == 0 && latched.g == 0 && latched.b == 0);
    assert(ef_platform_led_request(4) == 0);
    ef_platform_led_status(&colour, &available);
    assert(available && colour == 4 && latched.b == 16);

    for (unsigned failure = 1; failure <= 2; ++failure) {
        reset();
        fail_at = failure;
        ef_platform_led_init();
        ef_platform_led_status(&colour, &available);
        assert(!available && colour == 0 && logs == 1);
        assert(transfers == failure);
        assert(ef_platform_led_request(4) == -ENODEV);
    }

    reset();
    ready = false;
    ef_platform_led_init();
    ef_platform_led_status(&colour, &available);
    assert(!available && colour == 0 && transfers == 0 && logs == 1);
    return 0;
}
"""


class LedStartupTests(unittest.TestCase):
    def test_startup_clears_first_transfer_colour_and_reports_failures(self):
        with tempfile.TemporaryDirectory(prefix="espforge-led-") as directory:
            temp = Path(directory)
            for name in ("device.h", "drivers/led_strip.h", "kernel.h", "logging/log.h"):
                header = temp / "zephyr" / name
                header.parent.mkdir(parents=True, exist_ok=True)
                header.touch()
            source = temp / "test_led.c"
            source.write_text(STUBS + '\n#include "platform/led.c"\n' + CHECKS)
            executable = temp / "test_led"
            subprocess.run(["gcc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-I", str(temp), "-I", str(ROOT / "firmware/src"),
                            str(source), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)
