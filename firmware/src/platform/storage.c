#include "app/espforge.h"
#include "app/storage/storage.h"
#include "platform/ef_platform.h"

#include <errno.h>
#include <ff.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/disk_access.h>
#include <zephyr/usb/class/usbd_msc.h>

LOG_MODULE_REGISTER(ef_storage, LOG_LEVEL_INF);

#define DISK_NAME "SD"
#define USB_DISK_NAME "USB_SD"
#define BUS_CLOCK_HZ DT_PROP(DT_NODELABEL(espforge_sd), max_bus_freq)
#define STORAGE_POLL_MS 50

USBD_DEFINE_MSC_LUN(espforge_sd, USB_DISK_NAME, "ESPForge", "SD card", "1.00");
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
static ef_storage_t snapshot;
static bool request_pending;
static uint8_t request_transaction;
static int64_t request_ready_at;
static uint32_t media_generation;
static uint32_t request_generation;
static bool last_presence;

void ef_storage_publish(const ef_storage_t *storage)
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

int ef_storage_media_close(void)
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

int ef_storage_media_open(bool usb, uint32_t *blocks, uint8_t *format)
{
	uint32_t sector_size = 0;
	int err = ef_storage_media_close();

	if (err != 0) {
		return err;
	}
	media_started = true;
	*blocks = 0;
	*format = 0;
	err = usb ? disk_access_init(DISK_NAME) : fs_mount(&mount);
	if (err == 0 && !usb) {
		mounted = true;
		*format = fatfs.fs_type <= 4 ? fatfs.fs_type : 0;
	}
	if (err == 0) {
		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_COUNT, blocks);
	}
	if (err == 0) {
		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_SIZE, &sector_size);
	}
	if (err == 0 && (*blocks == 0 || sector_size != 512)) {
		err = -EINVAL;
	}
	if (err != 0) {
		LOG_ERR("SD %s failed: %d", usb ? "export initialization" : "mount", err);
		if (!mounted && !usb) {
			/* A failed Zephyr mount can leave FatFs registered even though fs_mount never registered it. */
			FRESULT result = f_mount(NULL, DISK_NAME ":", 0);

			if (result != FR_OK) {
				LOG_ERR("SD failed-mount cleanup failed: %d", result);
			}
		}
		(void)ef_storage_media_close();
		return err;
	}
	LOG_INF("SD %s: %u sectors", usb ? "export ready" : "mounted", *blocks);
	return 0;
}

/** Snapshot-only admission; SD I/O is never performed under the application lock. */
int ef_platform_storage_request(bool usb, uint8_t transaction)
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
		request_generation = media_generation;
		request_transaction = transaction;
		request_ready_at = k_uptime_get() + EF_REBOOT_DELAY_MS;
		request_pending = true;
		snapshot.busy = true;
		snapshot.sample_valid = false;
		snapshot.msc_transition_pending = true;
		err = k_msgq_put(&requests, &action, K_NO_WAIT);
		if (err != 0) {
			LOG_ERR("SD ownership queue failed: %d", err);
			request_pending = false;
			snapshot.busy = false;
			snapshot.msc_transition_pending = false;
		}
	}
	k_mutex_unlock(&snapshot_lock);
	return err;
}

void ef_storage_result_read(uint8_t transaction)
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

bool ef_platform_storage_busy(void)
{
	bool busy;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	busy = snapshot.busy || snapshot.msc_enabled;
	k_mutex_unlock(&snapshot_lock);
	return busy;
}

void ef_storage_report(uint8_t sequence, uint8_t out[EF_STORAGE_SIZE])
{
	ef_storage_t storage;

	k_mutex_lock(&snapshot_lock, K_FOREVER);
	storage = snapshot;
	k_mutex_unlock(&snapshot_lock);
	storage.sequence = sequence;
	storage.bus_clock_hz = storage.initialized ? BUS_CLOCK_HZ : 0;
	ef_report_storage(&storage, out);
}

/** The MSC thread holds media_lock for the entire batch and checks ownership again after acquiring it. */
static bool usb_ready(void)
{
	bool ready;
	int present = gpio_pin_get_dt(&detect);

	if (present < 0) {
		LOG_ERR("SD card-detect read failed: %d", present);
		return false;
	}
	k_mutex_lock(&snapshot_lock, K_FOREVER);
	ready = present && snapshot.msc_enabled && !snapshot.busy && snapshot.block_count != 0;
	k_mutex_unlock(&snapshot_lock);
	return ready;
}

static int usb_status(struct disk_info *disk)
{
	ARG_UNUSED(disk);
	return usb_ready() ? DISK_STATUS_OK : DISK_STATUS_NOMEDIA;
}

static int usb_read(struct disk_info *disk, uint8_t *buffer, uint32_t sector, uint32_t count)
{
	int err;

	ARG_UNUSED(disk);
	k_mutex_lock(&media_lock, K_FOREVER);
	err = usb_ready() ? disk_access_read(DISK_NAME, buffer, sector, count) : -ENOMEDIUM;
	if (err != 0) {
		LOG_ERR("USB SD read failed: %d", err);
	}
	k_mutex_unlock(&media_lock);
	return err;
}

static int usb_write(struct disk_info *disk, const uint8_t *buffer, uint32_t sector, uint32_t count)
{
	int err;

	ARG_UNUSED(disk);
	k_mutex_lock(&media_lock, K_FOREVER);
	err = usb_ready() ? disk_access_write(DISK_NAME, buffer, sector, count) : -ENOMEDIUM;
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
	k_mutex_lock(&media_lock, K_FOREVER);
	if (!usb_ready()) {
		err = -ENOMEDIUM;
	} else if (command == DISK_IOCTL_CTRL_INIT) {
		err = 0;
	} else {
		err = disk_access_ioctl(DISK_NAME, command, buffer);
	}
	if (err != 0 && command == DISK_IOCTL_CTRL_SYNC) {
		LOG_ERR("USB SD sync failed: %d", err);
	}
	k_mutex_unlock(&media_lock);
	return err;
}

static const struct disk_operations usb_ops = {
	.init = usb_status,
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
		int action = EF_STORAGE_NO_REQUEST;
		int64_t now = k_uptime_get();

		if (present < 0) {
			LOG_ERR("SD card-detect read failed: %d", present);
			k_sleep(K_MSEC(EF_STORAGE_RETRY_MS));
			continue;
		}
		k_mutex_lock(&snapshot_lock, K_FOREVER);
		if ((present != 0) != last_presence) {
			last_presence = present != 0;
			++media_generation;
		}
		if (request_pending && now >= request_ready_at && k_msgq_get(&requests, &action, K_NO_WAIT) == 0) {
			if (request_generation != media_generation) {
				action = EF_STORAGE_CANCEL_REQUEST;
				LOG_WRN("SD ownership request cancelled: card changed");
			}
			request_pending = false;
		}
		k_mutex_unlock(&snapshot_lock);
		k_mutex_lock(&media_lock, K_FOREVER);
		ef_storage_policy_poll(present != 0, now, action);
		k_mutex_unlock(&media_lock);
		k_sleep(K_MSEC(STORAGE_POLL_MS));
	}
}

K_THREAD_STACK_DEFINE(storage_stack, 4096);
static struct k_thread storage_thread;

void ef_storage_init(void)
{
	int err = gpio_is_ready_dt(&detect) ? gpio_pin_configure_dt(&detect, GPIO_INPUT) : -ENODEV;
	int present = err == 0 ? gpio_pin_get_dt(&detect) : err;

	if (err == 0) {
		err = present < 0 ? present : disk_access_register(&usb_disk);
	}
	if (err != 0) {
		LOG_ERR("SD service setup failed: %d", err);
		ef_storage_policy_init(false, false, k_uptime_get());
		return;
	}
	last_presence = present != 0;
	ef_storage_policy_init(true, last_presence, k_uptime_get());
	ef_storage_policy_poll(last_presence, k_uptime_get(), EF_STORAGE_NO_REQUEST);
	k_thread_create(&storage_thread, storage_stack, K_THREAD_STACK_SIZEOF(storage_stack),
			storage_worker, NULL, NULL, NULL, 5, 0, K_NO_WAIT);
	k_thread_name_set(&storage_thread, "sd-storage");
}
