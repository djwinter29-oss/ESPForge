#include "app/espforge.h"
#include "platform/boot_config.h"
#include "app/control/control.h"

#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#define POLL_PERIOD_MS 20

int main(void)
{
	uint8_t radios;
	int err;

	ef_board_init();
	ef_lock();
	ef_boot_config_load();
	ef_control_init();
	radios = ef_boot_config_boot_radios();
	ef_unlock();
	printk("ESPForge %s (%s)\n", ESPFORGE_VERSION, ef_board_serial());

	err = system_clock_apply(ef_sysclk_profile_mhz(ef_boot_config_boot_sysclk()));
	if (err) {
		printk("CPU clock change failed: %d\n", err);
	}
	ef_telemetry_init();
	ef_storage_init();
	ef_wifi_init((radios & EF_WIRELESS_WIFI) != 0);
	ef_ble_init((radios & EF_WIRELESS_BLE) != 0);
	if (ef_usb_init() != 0) {
		printk("USB HID unavailable\n");
	}

	while (true) {
		ef_lock();
		ef_control_tick(k_uptime_get());
		ef_unlock();
		ef_wifi_poll();
		ef_telemetry_poll();
		ef_usb_poll();
		k_sleep(K_MSEC(POLL_PERIOD_MS));
	}
	return 0;
}
