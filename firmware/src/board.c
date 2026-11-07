#include "espforge.h"
#include "boot_config.h"
#include "ef_platform.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/kernel.h>
#include <zephyr/linker/linker-defs.h>
#include <zephyr/sys/reboot.h>

#define RAM_TOTAL_BYTES (512u * 1024u)

K_MUTEX_DEFINE(app_lock);

static uint8_t uid[EF_UID_SIZE];
static char serial[2 * EF_UID_SIZE + 1];
static uint8_t reset_cause;

void ef_lock(void)
{
	(void)k_mutex_lock(&app_lock, K_FOREVER);
}

void ef_unlock(void)
{
	(void)k_mutex_unlock(&app_lock);
}

void ef_board_init(void)
{
	uint32_t cause = 0;
	ssize_t length = hwinfo_get_device_id(uid, 6);

	if (length < 0) {
		memset(uid, 0, sizeof(uid));
	}
	ef_uid_hex(uid, serial);
	if (hwinfo_get_reset_cause(&cause) == 0) {
		reset_cause = ef_reset_cause(cause);
		(void)hwinfo_clear_reset_cause();
	}
}

const uint8_t *ef_board_uid(void)
{
	return uid;
}

const char *ef_board_serial(void)
{
	return serial;
}

static void parse_version(uint8_t out[3])
{
	const char *text = ESPFORGE_VERSION;

	for (int i = 0; i < 3; ++i) {
		char *end;
		unsigned long part = strtoul(text, &end, 10);

		out[i] = part > 255 ? 255 : (uint8_t)part;
		text = *end == '.' ? end + 1 : end;
	}
}

void ef_identity_report(uint8_t out[EF_IDENTITY_SIZE])
{
	ef_identity_t identity = {
		.ram_total_bytes = RAM_TOTAL_BYTES,
		.ram_reserved_bytes = (uint32_t)((uintptr_t)_image_ram_end - (uintptr_t)_image_ram_start),
	};

	memcpy(identity.uid, uid, sizeof(uid));
	parse_version(identity.firmware);
	ef_report_identity(&identity, out);
}

void ef_config_report(uint8_t out[EF_CONFIG_SIZE])
{
	ef_config_t config = {.reset_cause = reset_cause};

	ef_lock();
	config.stored_clock_mhz = ef_sysclk_profile_mhz(ef_boot_config_sysclk());
	config.stored_radios = ef_boot_config_radios();
	ef_unlock();
	ef_report_config(&config, out);
}

static void reboot_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	sys_reboot(SYS_REBOOT_COLD);
}

K_WORK_DELAYABLE_DEFINE(reboot_work, reboot_handler);

int ef_platform_schedule_reboot(void)
{
	return k_work_reschedule(&reboot_work, K_MSEC(EF_REBOOT_DELAY_MS)) < 0 ? -EIO : 0;
}
