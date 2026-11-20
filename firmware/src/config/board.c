#include <esp_flash.h>
#include <esp_psram.h>

#include "app/zephyrforge.h"
#include "platform/boot_config.h"
#include "platform/zf_platform.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/devicetree.h>
#include <zephyr/dt-bindings/pinctrl/esp-pinctrl-common.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/kernel.h>
#include <zephyr/linker/linker-defs.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/reboot.h>

#define RAM_TOTAL_BYTES (512u * 1024u)
/* Report 1 UID prefix: the six-byte eFuse base MAC; the remaining UID bytes stay zero. */
#define UID_MAC_SIZE 6u
#define SD_PINCTRL DT_PHANDLE_BY_IDX(DT_ALIAS(zephyrforge_sd), pinctrl_0, 0)
#define SD_SPI_PINCTRL DT_PHANDLE_BY_IDX(DT_PARENT(DT_ALIAS(zephyrforge_sd)), pinctrl_0, 0)
#define GPIO_FROM_MUX(node, index) (DT_PROP_BY_IDX(node, pinmux, index) & ESP32_PIN_NUM_MASK)

LOG_MODULE_REGISTER(zf_board, LOG_LEVEL_INF);
extern char _ext_ram_start[];
extern char _ext_ram_end[];

K_MUTEX_DEFINE(app_lock);

static uint8_t uid[ZF_UID_SIZE];
static char serial[2 * ZF_UID_SIZE + 1];
static uint8_t reset_cause;
static zf_memory_inventory_t memory_inventory;

void zf_lock(void)
{
	(void)k_mutex_lock(&app_lock, K_FOREVER);
}

void zf_unlock(void)
{
	(void)k_mutex_unlock(&app_lock);
}

void zf_board_init(void)
{
	uint32_t cause = 0;
	ssize_t length = hwinfo_get_device_id(uid, UID_MAC_SIZE);

	if (length < 0) {
		memset(uid, 0, sizeof(uid));
	}
	zf_uid_hex(uid, serial);
	if (hwinfo_get_reset_cause(&cause) == 0) {
		reset_cause = zf_reset_cause(cause);
		(void)hwinfo_clear_reset_cause();
	}
	memory_inventory.psram_available = esp_psram_is_initialized();
	if (memory_inventory.psram_available) {
		memory_inventory.psram_total_bytes = esp_psram_get_size();
		memory_inventory.psram_reserved_bytes = (uintptr_t)_ext_ram_end - (uintptr_t)_ext_ram_start;
	} else {
		LOG_ERR("PSRAM inventory unavailable: external RAM is not initialized");
	}
	int err = esp_flash_get_physical_size(esp_flash_default_chip, &memory_inventory.flash_total_bytes);

	memory_inventory.flash_available = err == ESP_OK;
	if (err != ESP_OK) {
		memory_inventory.flash_total_bytes = 0;
		LOG_ERR("Module flash capacity read failed: %d", err);
	}
}

const uint8_t *zf_board_uid(void)
{
	return uid;
}

const char *zf_board_serial(void)
{
	return serial;
}

static void parse_version(uint8_t out[3])
{
	const char *text = ZEPHYRFORGE_VERSION;

	for (int i = 0; i < 3; ++i) {
		char *end;
		unsigned long part = strtoul(text, &end, 10);

		out[i] = part > 255 ? 255 : (uint8_t)part;
		text = *end == '.' ? end + 1 : end;
	}
}

void zf_identity_report(uint8_t out[ZF_IDENTITY_SIZE])
{
	zf_identity_t identity = {
		.ram_total_bytes = RAM_TOTAL_BYTES,
		.ram_reserved_bytes = (uint32_t)((uintptr_t)_image_ram_end - (uintptr_t)_image_ram_start),
	};

	memcpy(identity.uid, uid, sizeof(uid));
	parse_version(identity.firmware);
	zf_report_identity(&identity, out);
}

void zf_memory_report(uint8_t out[ZF_MEMORY_SIZE])
{
	zf_report_memory(&memory_inventory, out);
}

void zf_config_report(uint8_t out[ZF_CONFIG_SIZE])
{
	zf_config_t config = {
		.reset_cause = reset_cause,
		.card_detect_available = true,
		.card_detect_gpio = DT_GPIO_PIN(DT_PATH(zephyr_user), sd_detect_gpios),
		.msc_supported = IS_ENABLED(CONFIG_USBD_MSC_CLASS),
		.led_available = true,
		.led_gpio = DT_PROP_BY_IDX(DT_CHILD(DT_NODELABEL(zephyrforge_led_default), mosi), pinmux, 0)
			    & ESP32_PIN_NUM_MASK,
#if ZF_STORAGE_SPI
		.storage_gpios = {
			GPIO_FROM_MUX(DT_CHILD(SD_SPI_PINCTRL, clock), 0),
			GPIO_FROM_MUX(DT_CHILD(SD_SPI_PINCTRL, data), 0),
			GPIO_FROM_MUX(DT_CHILD(SD_SPI_PINCTRL, data), 1),
			DT_GPIO_PIN(DT_PARENT(DT_ALIAS(zephyrforge_sd)), cs_gpios),
			ZF_GPIO_UNASSIGNED, ZF_GPIO_UNASSIGNED,
		},
#else
		.storage_gpios = {
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, clock), 0),
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, command_data), 0),
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, command_data), 1),
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, command_data), 2),
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, command_data), 3),
			GPIO_FROM_MUX(DT_CHILD(SD_PINCTRL, command_data), 4),
		},
#endif
	};

	zf_lock();
	config.stored_clock_mhz = zf_sysclk_profile_mhz(zf_boot_config_sysclk());
	config.stored_radios = zf_boot_config_radios();
	zf_unlock();
	zf_report_config(&config, out);
}

static void reboot_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	sys_reboot(SYS_REBOOT_COLD);
}

K_WORK_DELAYABLE_DEFINE(reboot_work, reboot_handler);

int zf_platform_schedule_reboot(void)
{
	return k_work_reschedule(&reboot_work, K_MSEC(ZF_REBOOT_DELAY_MS)) < 0 ? -EIO : 0;
}
