#include "app/espforge.h"

#include <ff.h>
#include <zephyr/devicetree.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/disk_access.h>

LOG_MODULE_REGISTER(ef_storage, LOG_LEVEL_INF);

#define DISK_NAME "SD"
#define BUS_CLOCK_HZ DT_PROP(DT_NODELABEL(espforge_sd), spi_max_frequency)

static FATFS fatfs;
static struct fs_mount_t mount = {
	.type = FS_FATFS,
	.fs_data = &fatfs,
	.mnt_point = "/" DISK_NAME ":",
};

/* Written once by ef_storage_init() before the transports start. */
static bool mounted;
static uint32_t sector_count;
static uint8_t filesystem_format;

void ef_storage_init(void)
{
	int err = fs_mount(&mount);

	if (err != 0) {
		LOG_WRN("SD card mount failed: %d", err);
		return;
	}
	mounted = true;
	/* FatFs FS_FAT12..FS_EXFAT are 1..4, the Report 10 filesystem_format values. */
	filesystem_format = fatfs.fs_type <= 4 ? fatfs.fs_type : 0;
	if (disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_COUNT, &sector_count) != 0) {
		sector_count = 0;
	}
	LOG_INF("SD card mounted: %u sectors", sector_count);
}

void ef_storage_report(uint8_t sequence, uint8_t out[EF_STORAGE_SIZE])
{
	ef_storage_t storage = {
		.sequence = sequence,
		.initialized = mounted,
		.capacity_valid = mounted && sector_count != 0,
		.bus_clock_hz = mounted ? BUS_CLOCK_HZ : 0,
		.block_count = sector_count,
		.filesystem_format = filesystem_format,
	};

	ef_report_storage(&storage, out);
}
