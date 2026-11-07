#include "espforge.h"

#include <errno.h>
#include <ff.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>

static FATFS fatfs;
static struct fs_mount_t mount = {
	.type = FS_FATFS,
	.fs_data = &fatfs,
	.mnt_point = "/SD:",
};
static int mount_error = -EAGAIN;
K_MUTEX_DEFINE(storage_lock);

void storage_init(void)
{
	int result = fs_mount(&mount);

	k_mutex_lock(&storage_lock, K_FOREVER);
	mount_error = result;
	k_mutex_unlock(&storage_lock);
}

int storage_error(void)
{
	int result;

	k_mutex_lock(&storage_lock, K_FOREVER);
	result = mount_error;
	k_mutex_unlock(&storage_lock);
	return result;
}
