#include "app/espforge.h"

#include <zephyr/device.h>
#include <zephyr/drivers/clock_control.h>
#include <zephyr/drivers/clock_control/esp32_clock_control.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/kernel.h>

#define LOAD_WINDOW_MS 250
#define TEMPERATURE_PERIOD_MS 1000

static const struct device *const temperature_sensor = DEVICE_DT_GET_OR_NULL(DT_NODELABEL(coretemp));

static bool temperature_valid;
static int16_t temperature_centi_c;
static int64_t temperature_at;
static uint16_t core0_load = EF_LOAD_UNAVAILABLE;
static uint64_t window_busy;
static uint64_t window_total;
static int64_t window_at;
K_MUTEX_DEFINE(telemetry_lock);

uint32_t system_clock_hz(void)
{
	const struct device *clock = DEVICE_DT_GET(DT_NODELABEL(clock));
	uint32_t rate = 0;

	if (!device_is_ready(clock) ||
	    clock_control_get_rate(clock, (clock_control_subsys_t)ESP32_CLOCK_CONTROL_SUBSYS_CPU, &rate) != 0) {
		return DT_PROP(DT_NODELABEL(cpu0), clock_frequency);
	}
	return rate;
}

static bool cpu_cycles(uint64_t *busy, uint64_t *total)
{
	k_thread_runtime_stats_t stats;

	if (k_thread_runtime_stats_cpu_get(0, &stats) != 0) {
		return false;
	}
	*busy = stats.total_cycles;
	*total = stats.execution_cycles;
	return true;
}

static void read_temperature(void)
{
	struct sensor_value value;
	bool valid = false;
	int16_t centi = 0;

	if (temperature_sensor != NULL && device_is_ready(temperature_sensor) &&
	    sensor_sample_fetch(temperature_sensor) == 0 &&
	    sensor_channel_get(temperature_sensor, SENSOR_CHAN_DIE_TEMP, &value) == 0) {
		int64_t micro = sensor_value_to_micro(&value);

		centi = (int16_t)CLAMP(micro / 10000, INT16_MIN, INT16_MAX);
		valid = true;
	}
	k_mutex_lock(&telemetry_lock, K_FOREVER);
	temperature_valid = valid;
	temperature_centi_c = centi;
	k_mutex_unlock(&telemetry_lock);
}

void ef_telemetry_init(void)
{
	window_at = k_uptime_get();
	(void)cpu_cycles(&window_busy, &window_total);
	read_temperature();
	temperature_at = window_at;
}

void ef_telemetry_poll(void)
{
	int64_t now = k_uptime_get();
	uint64_t busy;
	uint64_t total;

	if (now - window_at >= LOAD_WINDOW_MS && cpu_cycles(&busy, &total)) {
		uint16_t load = ef_load_basis_points(busy - window_busy, total - window_total);

		k_mutex_lock(&telemetry_lock, K_FOREVER);
		core0_load = load;
		k_mutex_unlock(&telemetry_lock);
		window_busy = busy;
		window_total = total;
		window_at = now;
	}
	if (now - temperature_at >= TEMPERATURE_PERIOD_MS) {
		read_temperature();
		temperature_at = now;
	}
}

void ef_telemetry_report(uint8_t sequence, uint8_t out[EF_TELEMETRY_SIZE])
{
	ef_telemetry_t telemetry = {
		.uptime_ms = (uint64_t)k_uptime_get(),
		.system_clock_hz = system_clock_hz(),
		.sequence = sequence,
		.usb_configured = ef_usb_configured(),
	};

	k_mutex_lock(&telemetry_lock, K_FOREVER);
	telemetry.temperature_valid = temperature_valid;
	telemetry.temperature_centi_c = temperature_centi_c;
	telemetry.core0_load = core0_load;
	k_mutex_unlock(&telemetry_lock);
	ef_report_telemetry(&telemetry, out);
}
