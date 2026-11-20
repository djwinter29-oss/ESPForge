#include "app/zephyrforge.h"
#include "platform/boot_config.h"
#include "app/control/control.h"
#include "platform/zf_platform.h"

#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#define POLL_PERIOD_MS 20

int main(void)
{
	uint8_t radios;
	int err;

	zf_board_init();
	zf_lock();
	zf_boot_config_load();
	zf_control_init();
	radios = zf_boot_config_boot_radios();
	zf_unlock();
	printk("ZephyrForge %s (%s)\n", ZEPHYRFORGE_VERSION, zf_board_serial());

	err = zf_system_clock_apply(zf_sysclk_profile_mhz(zf_boot_config_boot_sysclk()));
	if (err) {
		printk("CPU clock change failed: %d\n", err);
	}
	zf_telemetry_init();
	zf_platform_led_init();
	zf_storage_init();
	zf_wifi_init((radios & ZF_WIRELESS_WIFI) != 0);
	zf_ble_init((radios & ZF_WIRELESS_BLE) != 0);
	if (zf_usb_init() != 0) {
		printk("USB HID unavailable\n");
	}

	while (true) {
		zf_lock();
		zf_control_tick(k_uptime_get());
		zf_unlock();
		zf_wifi_poll();
		zf_telemetry_poll();
		zf_usb_poll();
		k_sleep(K_MSEC(POLL_PERIOD_MS));
	}
	return 0;
}
