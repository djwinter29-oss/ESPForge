#include "app/espforge.h"

#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/drivers/clock_control.h>
#include <zephyr/drivers/clock_control/esp32_clock_control.h>

int system_clock_apply(uint16_t mhz)
{
	const struct device *clock = DEVICE_DT_GET(DT_NODELABEL(clock));
	struct esp32_clock_config config = {
		.cpu = {
			.clk_src = DT_PROP(DT_NODELABEL(cpu0), clock_source),
			.cpu_freq = mhz,
			.xtal_freq = DT_PROP(DT_NODELABEL(cpu0), xtal_freq),
		},
	};

	if (mhz == 0 || mhz * 1000000u == DT_PROP(DT_NODELABEL(cpu0), clock_frequency)) {
		return 0;
	}
	if (!device_is_ready(clock)) {
		return -ENODEV;
	}
	return clock_control_configure(clock, (clock_control_subsys_t)ESP32_CLOCK_CONTROL_SUBSYS_CPU, &config);
}
