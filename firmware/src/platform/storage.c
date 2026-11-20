#include "app/zephyrforge.h"
#include "app/storage/storage.h"
#include "platform/zf_platform.h"

#include <errno.h>
#include <ff.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/disk_access.h>
#include <zephyr/usb/class/usbd_msc.h>

LOG_MODULE_REGISTER(zf_storage, LOG_LEVEL_INF);

#define DISK_NAME "SD"
#define USB_DISK_NAME "USB_SD"
#if ZF_STORAGE_SPI
#define BUS_CLOCK_HZ DT_PROP(DT_ALIAS(zephyrforge_sd), spi_max_frequency)
#else
#define BUS_CLOCK_HZ DT_PROP(DT_ALIAS(zephyrforge_sd), max_bus_freq)
#endif
#define STORAGE_POLL_MS 50
/* Far below the host's 30 s SCSI command timeout; the worker holds the lock only briefly while the card is exported. */
#define USB_LOCK_WAIT_MS 1000

/* SCSI INQUIRY limits the vendor to eight bytes, so use the short project name. */
USBD_DEFINE_MSC_LUN(zephyrforge_sd, USB_DISK_NAME, "ZForge", "SD card", "1.00");
K_MUTEX_DEFINE(media_lock);
K_MUTEX_DEFINE(snapshot_lock);
K_MSGQ_DEFINE(requests, sizeof(int), 1, sizeof(int));

static const struct gpio_dt_spec detect = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), sd_detect_gpios);
static FATFS fatfs;
static struct fs_mount_t mount = {
	.type = FS_FATFS,
	.fs_data = &fatfs,
	.mnt_point = "/" DISK_NAME ":",
	.flags = FS_MOUNT_FLAG_NO_FORMAT,
};
static bool mounted;
static bool media_started;
static zf_storage_t snapshot;
static bool request_pending;
static uint8_t request_transaction;
static int64_t request_ready_at;
static uint32_t media_generation;
static uint32_t request_generation;
static bool last_presence;

#if ZF_ENABLE_STORAGE_BENCHMARK
/** Queue action reserved for the optional file benchmark. */
#define BENCHMARK_REQUEST 2
/** Reserved path is created exclusively and never overwrites an existing entry. */
#define BENCHMARK_PATH DISK_NAME ":/EFTEST.BIN"
static FIL benchmark_file;
static zf_benchmark_t benchmark;
static bool benchmark_active;
static bool benchmark_cancelled;
static bool benchmark_media_lost;
static uint8_t benchmark_filesystem_result;

/** Latch removal before another filesystem call can touch replacement media. */
static bool benchmark_media_ready(void)
{
	int present = gpio_pin_get_dt(&detect);

	if (present <= 0 && !benchmark_media_lost) {
		LOG_ERR("Benchmark media lost: card detection %d", present);
		benchmark_media_lost = true;
		k_mutex_lock(&snapshot_lock, K_FOREVER);
		++media_generation;
		last_presence = false;
		k_mutex_unlock(&snapshot_lock);
	}
	return !benchmark_media_lost;
}

static int benchmark_result(FRESULT result)
{
	if (result == FR_OK) {
		return 0;
	}
	LOG_ERR("Benchmark filesystem failure: %d", result);
	if (benchmark_filesystem_result == 0) {
		benchmark_filesystem_result = result;
	}
	return result == FR_EXIST ? -EEXIST : result == FR_NOT_READY ? -ENOMEDIUM : -EIO;
}

int zf_platform_benchmark_preflight(uint32_t size_mib)
{
	FILINFO info;
	FATFS *filesystem;
	DWORD free_clusters;
	FRESULT result;

	if (!benchmark_media_ready()) {
		return ZF_BENCHMARK_ERROR_CARD;
	}
	result = f_stat(BENCHMARK_PATH, &info);
	if (result == FR_OK) {
		return ZF_BENCHMARK_ERROR_EXISTS;
	}
	if (result != FR_NO_FILE) {
		(void)benchmark_result(result);
		return ZF_BENCHMARK_ERROR_IO;
	}
	result = f_getfree(DISK_NAME ":", &free_clusters, &filesystem);
	if (result != FR_OK) {
		(void)benchmark_result(result);
		return ZF_BENCHMARK_ERROR_IO;
	}
	uint64_t free_bytes = (uint64_t)free_clusters * filesystem->csize * 512u;

	return free_bytes < (uint64_t)size_mib * 1024u * 1024u + ZF_BENCHMARK_CHUNK_SIZE
		? ZF_BENCHMARK_ERROR_SPACE : 0;
}

int zf_platform_benchmark_open(bool writing)
{
	return benchmark_media_ready()
		? benchmark_result(f_open(&benchmark_file, BENCHMARK_PATH,
					 writing ? FA_WRITE | FA_CREATE_NEW : FA_READ)) : -ENOMEDIUM;
}

int zf_platform_benchmark_transfer(bool writing, uint8_t *data, uint32_t size, uint32_t *transferred)
{
	UINT count = 0;
	FRESULT result;

	*transferred = 0;
	if (!benchmark_media_ready()) {
		return -ENOMEDIUM;
	}
	result = writing ? f_write(&benchmark_file, data, size, &count) : f_read(&benchmark_file, data, size, &count);
	*transferred = count;
	return benchmark_result(result);
}

int zf_platform_benchmark_close(void)
{
	return benchmark_media_ready() ? benchmark_result(f_close(&benchmark_file)) : -ENOMEDIUM;
}

int zf_platform_benchmark_remove(void)
{
	return benchmark_media_ready() ? benchmark_result(f_unlink(BENCHMARK_PATH)) : -ENOMEDIUM;
}

uint32_t zf_platform_benchmark_time(void)
{
	return (uint32_t)k_uptime_get();
}

bool zf_platform_benchmark_update(const zf_benchmark_t *status)
{
	bool present = benchmark_media_ready();
	bool proceed;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	benchmark = *status;
	benchmark.flags |= mounted && present ? ZF_BENCHMARK_MOUNTED : 0;
	benchmark.filesystem_result = status->error == ZF_BENCHMARK_ERROR_IO ||
				     status->error == ZF_BENCHMARK_ERROR_CLEANUP ? benchmark_filesystem_result : 0;
	proceed = !benchmark_cancelled;
	k_mutex_unlock(&snapshot_lock);
	/* Removal must be an error, not a successful user cancellation. The next I/O records ENOMEDIUM. */
	return proceed;
}
#endif

int zf_platform_benchmark_request(bool start, uint32_t size_mib)
{
#if ZF_ENABLE_STORAGE_BENCHMARK
	int action = BENCHMARK_REQUEST;
	int detail = 0;

	if (start ? size_mib == 0 || size_mib > ZF_BENCHMARK_MAX_MIB : size_mib != 0) {
		return ZF_BENCHMARK_ERROR_SIZE;
	}
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	if (!start) {
		benchmark_cancelled = benchmark_active;
	} else if (request_pending || snapshot.busy || benchmark_active) {
		detail = ZF_BENCHMARK_ERROR_BUSY;
	} else if (snapshot.msc_enabled) {
		detail = ZF_BENCHMARK_ERROR_USB;
	} else if (!snapshot.sample_valid || !snapshot.initialized || snapshot.filesystem_format == 0) {
		detail = ZF_BENCHMARK_ERROR_CARD;
	} else {
		zf_storage_t previous = snapshot;
		zf_benchmark_t previous_benchmark = benchmark;

		benchmark = (zf_benchmark_t){.state = ZF_BENCHMARK_QUEUED,
					    .target_bytes = size_mib * 1024u * 1024u};
		benchmark_active = true;
		benchmark_cancelled = false;
		benchmark_media_lost = false;
		benchmark_filesystem_result = 0;
		snapshot.busy = true;
		snapshot.sample_valid = false;
		if (k_msgq_put(&requests, &action, K_NO_WAIT) != 0) {
			LOG_ERR("Benchmark queue failed");
			benchmark_active = false;
			benchmark = previous_benchmark;
			snapshot = previous;
			detail = ZF_BENCHMARK_ERROR_BUSY;
		}
	}
	k_mutex_unlock(&snapshot_lock);
	return detail;
#else
	ARG_UNUSED(start);
	ARG_UNUSED(size_mib);
	return -ENOTSUP;
#endif
}

void zf_benchmark_report(uint8_t sequence, uint8_t out[ZF_BENCHMARK_SIZE])
{
	zf_benchmark_t status = {0};

#if ZF_ENABLE_STORAGE_BENCHMARK
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	status = benchmark;
	k_mutex_unlock(&snapshot_lock);
#endif
	status.sequence = sequence;
	zf_report_benchmark(&status, out);
}

void zf_storage_publish(const zf_storage_t *storage)
{
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	snapshot = *storage;
	if (request_pending) {
		snapshot.busy = true;
		snapshot.sample_valid = false;
		snapshot.msc_transition_pending = true;
	}
	k_mutex_unlock(&snapshot_lock);
}

int zf_storage_media_close(void)
{
	int err;

	if (mounted) {
		err = fs_unmount(&mount);
		if (err != 0) {
			LOG_ERR("SD unmount failed: %d", err);
			return err;
		}
		mounted = false;
	}
	if (media_started) {
		/* This service is the sole initializer; reset all references, including a failed FatFs mount. */
		bool force = true;

		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_CTRL_DEINIT, &force);
		if (err != 0) {
			LOG_ERR("SD deinitialization failed: %d", err);
			return err;
		}
		media_started = false;
	}
	return 0;
}

int64_t zf_storage_media_time(void)
{
	return k_uptime_get();
}

int zf_storage_media_open(bool usb, zf_storage_t *storage)
{
	uint32_t sector_size = 0;
	int err = zf_storage_media_close();

	storage->initialized = false;
	storage->capacity_valid = false;
	storage->cid_valid = false;
	memset(storage->cid, 0, sizeof(storage->cid));
	storage->block_count = 0;
	storage->bus_clock_hz = 0;
	storage->filesystem_format = 0;
	if (err != 0) {
		return err;
	}
	media_started = true;
	err = disk_access_init(DISK_NAME);
	if (err == 0) {
		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_COUNT, &storage->block_count);
	}
	if (err == 0) {
		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_SIZE, &sector_size);
	}
	if (err == 0 && (storage->block_count == 0 || sector_size != 512)) {
		err = -EINVAL;
	}
	if (err != 0) {
		LOG_ERR("SD hardware initialization failed: %d", err);
		storage->block_count = 0;
		(void)zf_storage_media_close();
		return err;
	}
	storage->initialized = true;
	storage->capacity_valid = true;
	storage->bus_clock_hz = BUS_CLOCK_HZ;
	err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SD_CID, storage->cid);
	if (err == 0) {
		storage->cid_valid = true;
	} else {
		memset(storage->cid, 0, sizeof(storage->cid));
		LOG_ERR("SD CID unavailable: %d", err);
	}
	if (!usb) {
		err = fs_mount(&mount);
		if (err != 0) {
			LOG_ERR("SD mount failed: %d", err);
			/* FatFs may retain its registration even when Zephyr did not register the mount. */
			FRESULT result = f_mount(NULL, DISK_NAME ":", 0);

			if (result != FR_OK) {
				LOG_ERR("SD failed-mount cleanup failed: %d", result);
			}
			return err;
		}
		mounted = true;
		storage->filesystem_format = fatfs.fs_type <= 4 ? fatfs.fs_type : 0;
	}
	LOG_INF("SD %s: %u sectors", usb ? "export ready" : "mounted", storage->block_count);
	return 0;
}

/** Snapshot-only admission; SD I/O is never performed under the application lock. */
int zf_platform_storage_request(bool usb, uint8_t transaction)
{
	int action = usb ? 1 : 0;
	int err = 0;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	if (request_pending || snapshot.busy) {
		err = -EBUSY;
	} else if (usb == snapshot.msc_enabled) {
		/* Repeating a confirmed owner request is a no-op, not a replayed block write. */
		err = 0;
	} else if (usb && (!snapshot.sample_valid || !snapshot.initialized || !snapshot.block_count)) {
		err = -ENOMEDIUM;
	} else {
		zf_storage_t previous = snapshot;

		request_generation = media_generation;
		request_transaction = transaction;
		request_ready_at = k_uptime_get() + ZF_REBOOT_DELAY_MS;
		request_pending = true;
		snapshot.busy = true;
		snapshot.sample_valid = false;
		snapshot.msc_transition_pending = true;
		err = k_msgq_put(&requests, &action, K_NO_WAIT);
		if (err != 0) {
			LOG_ERR("SD ownership queue failed: %d", err);
			request_pending = false;
			snapshot = previous;
		}
	}
	k_mutex_unlock(&snapshot_lock);
	return err;
}

void zf_storage_result_read(uint8_t transaction)
{
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	if (request_pending && request_transaction == transaction) {
		int64_t ready_at = k_uptime_get() + 50;

		if (ready_at < request_ready_at) {
			request_ready_at = ready_at;
		}
	}
	k_mutex_unlock(&snapshot_lock);
}

bool zf_platform_storage_busy(void)
{
	bool busy;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	busy = snapshot.busy || snapshot.msc_enabled;
	k_mutex_unlock(&snapshot_lock);
	return busy;
}

void zf_storage_report(uint8_t sequence, uint8_t out[ZF_STORAGE_SIZE])
{
	zf_storage_t storage;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	storage = snapshot;
	k_mutex_unlock(&snapshot_lock);
	storage.sequence = sequence;
	zf_report_storage(&storage, out);
}

static bool usb_ready(uint32_t *blocks)
{
	bool ready;
	int present = gpio_pin_get_dt(&detect);

	if (present < 0) {
		LOG_ERR("SD card-detect read failed: %d", present);
		return false;
	}
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	ready = present && snapshot.msc_enabled && !snapshot.busy && snapshot.block_count != 0;
	if (blocks != NULL) {
		*blocks = snapshot.block_count;
	}
	k_mutex_unlock(&snapshot_lock);
	return ready;
}

static int usb_status(struct disk_info *disk)
{
	ARG_UNUSED(disk);
	return usb_ready(NULL) ? DISK_STATUS_OK : DISK_STATUS_NOMEDIA;
}

static int usb_init(struct disk_info *disk)
{
	ARG_UNUSED(disk);
	return usb_ready(NULL) ? 0 : -ENOMEDIUM;
}

/**
 * @brief Lock the exported card for one MSC batch and check ownership again under the lock.
 *
 * Fails instead of waiting while the storage worker owns the card. An MSC command parked behind a benchmark or
 * remount makes the host time out and reset the device, which can eventually leave it unable to enumerate.
 *
 * @param blocks Receives the exported block count when not NULL.
 * @return true with media_lock held, or false without it.
 */
static bool usb_lock(uint32_t *blocks)
{
	if (!usb_ready(NULL) || k_mutex_lock(&media_lock, K_MSEC(USB_LOCK_WAIT_MS)) != 0) {
		return false;
	}
	if (usb_ready(blocks)) {
		return true;
	}
	k_mutex_unlock(&media_lock);
	return false;
}

static int usb_read(struct disk_info *disk, uint8_t *buffer, uint32_t sector, uint32_t count)
{
	int err;
	uint32_t blocks;

	ARG_UNUSED(disk);
	if (!usb_lock(&blocks)) {
		return -ENOMEDIUM;
	}
	if (buffer == NULL || count == 0 || sector >= blocks || count > blocks - sector) {
		err = -EINVAL;
	} else {
		err = disk_access_read(DISK_NAME, buffer, sector, count);
	}
	if (err != 0) {
		LOG_ERR("USB SD read failed: %d", err);
	}
	k_mutex_unlock(&media_lock);
	return err;
}

static int usb_write(struct disk_info *disk, const uint8_t *buffer, uint32_t sector, uint32_t count)
{
	int err;
	uint32_t blocks;

	ARG_UNUSED(disk);
	if (!usb_lock(&blocks)) {
		return -ENOMEDIUM;
	}
	if (buffer == NULL || count == 0 || sector >= blocks || count > blocks - sector) {
		err = -EINVAL;
	} else {
		err = disk_access_write(DISK_NAME, buffer, sector, count);
	}
	if (err != 0) {
		LOG_ERR("USB SD write failed: %d", err);
	}
	k_mutex_unlock(&media_lock);
	return err;
}

static int usb_ioctl(struct disk_info *disk, uint8_t command, void *buffer)
{
	int err;

	ARG_UNUSED(disk);
	if (command == DISK_IOCTL_CTRL_DEINIT) {
		/* Releasing proxy references must not deinitialize the storage worker's medium. */
		return 0;
	}
	if (!usb_lock(NULL)) {
		return -ENOMEDIUM;
	}
	if (command == DISK_IOCTL_CTRL_INIT) {
		err = 0;
	} else if (command == DISK_IOCTL_CTRL_SYNC) {
		err = disk_access_ioctl(DISK_NAME, command, buffer);
	} else if (command == DISK_IOCTL_GET_SECTOR_COUNT || command == DISK_IOCTL_GET_SECTOR_SIZE ||
		   command == DISK_IOCTL_GET_ERASE_BLOCK_SZ) {
		err = buffer == NULL ? -EINVAL : disk_access_ioctl(DISK_NAME, command, buffer);
	} else {
		err = -ENOTSUP;
	}
	if (err != 0 && err != -ENOMEDIUM) {
		LOG_ERR("USB SD ioctl %u failed: %d", command, err);
	}
	k_mutex_unlock(&media_lock);
	return err;
}

static const struct disk_operations usb_ops = {
	.init = usb_init,
	.status = usb_status,
	.read = usb_read,
	.write = usb_write,
	.ioctl = usb_ioctl,
};
static struct disk_info usb_disk = {.name = USB_DISK_NAME, .ops = &usb_ops};

static void storage_worker(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);
	while (true) {
		int present = gpio_pin_get_dt(&detect);
		int action = ZF_STORAGE_NO_REQUEST;
		int64_t now = k_uptime_get();
#if ZF_ENABLE_STORAGE_BENCHMARK
		uint32_t benchmark_mib = 0;
#endif

		if (present < 0) {
			LOG_ERR("SD card-detect read failed: %d", present);
		}
		k_mutex_lock(&snapshot_lock, K_FOREVER);
		if (present < 0 || (present != 0) != last_presence) {
			last_presence = present > 0;
			++media_generation;
		}
		if (request_pending && now >= request_ready_at && k_msgq_get(&requests, &action, K_NO_WAIT) == 0) {
			if (request_generation != media_generation) {
				action = ZF_STORAGE_CANCEL_REQUEST;
				LOG_WRN("SD ownership request cancelled: card changed");
			}
			request_pending = false;
		}
#if ZF_ENABLE_STORAGE_BENCHMARK
		if (benchmark_active && k_msgq_get(&requests, &action, K_NO_WAIT) == 0) {
			benchmark_mib = benchmark.target_bytes / (1024u * 1024u);
		}
#endif
		k_mutex_unlock(&snapshot_lock);
		k_mutex_lock(&media_lock, K_FOREVER);
#if ZF_ENABLE_STORAGE_BENCHMARK
		if (benchmark_mib != 0) {
			zf_benchmark_run(benchmark_mib);
			k_mutex_lock(&snapshot_lock, K_FOREVER);
			benchmark_active = false;
			k_mutex_unlock(&snapshot_lock);
			if (benchmark_media_lost) {
				zf_storage_policy_poll(0, k_uptime_get(), ZF_STORAGE_NO_REQUEST);
			}
			present = gpio_pin_get_dt(&detect);
			now = k_uptime_get();
			action = ZF_STORAGE_NO_REQUEST;
		}
#endif
		zf_storage_policy_poll(present, now, action);
		k_mutex_unlock(&media_lock);
		k_sleep(K_MSEC(present < 0 ? ZF_STORAGE_RETRY_MS : STORAGE_POLL_MS));
	}
}

K_THREAD_STACK_DEFINE(storage_stack, 4096);
static struct k_thread storage_thread;

void zf_storage_init(void)
{
	int err = gpio_is_ready_dt(&detect) ? gpio_pin_configure_dt(&detect, GPIO_INPUT) : -ENODEV;
	int present = err == 0 ? gpio_pin_get_dt(&detect) : err;

	if (err == 0) {
		err = present < 0 ? present : disk_access_register(&usb_disk);
	}
	if (err != 0) {
		LOG_ERR("SD service setup failed: %d", err);
		zf_storage_policy_init(false, false, k_uptime_get());
		return;
	}
	last_presence = present != 0;
	zf_storage_policy_init(true, last_presence, k_uptime_get());
	zf_storage_policy_poll(last_presence, k_uptime_get(), ZF_STORAGE_NO_REQUEST);
	k_thread_create(&storage_thread, storage_stack, K_THREAD_STACK_SIZEOF(storage_stack),
			storage_worker, NULL, NULL, NULL, 5, 0, K_NO_WAIT);
	k_thread_name_set(&storage_thread, "sd-storage");
}
