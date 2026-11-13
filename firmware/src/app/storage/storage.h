/**
 * @file storage.h
 * @brief Serialized SD lifecycle policy and its platform operations.
 */
#ifndef ESPFORGE_STORAGE_H
#define ESPFORGE_STORAGE_H

#include "app/usb/hid_reports.h"

/** Presence debounce period; a raw absence already prevents USB disk I/O. */
#define EF_STORAGE_DEBOUNCE_MS 100
/** Pace failed initialization and mount attempts. */
#define EF_STORAGE_RETRY_MS 2000
/** No ownership request in this worker iteration. */
#define EF_STORAGE_NO_REQUEST (-1)
/** Cancel an admitted request whose card changed before execution. */
#define EF_STORAGE_CANCEL_REQUEST (-2)

/** Initialize policy before transports start; subsequent calls belong to the storage worker. */
void ef_storage_policy_init(bool configured, bool present, int64_t now_ms);
/** Debounce presence, retry mounting and execute one request (0 firmware, 1 USB, or a sentinel). */
void ef_storage_policy_poll(bool present, int64_t now_ms, int request);

/** Publish a coherent snapshot without holding the application lock or exposing live mutable state. */
void ef_storage_publish(const ef_storage_t *storage);
/**
 * @brief Reset the previous medium and open it for exactly one owner.
 * @param usb True initializes raw blocks; false mounts the existing FAT volume without formatting.
 * @param blocks Receives the capacity in 512-byte sectors on success.
 * @param format Receives the filesystem format, or zero for raw USB access.
 * @return Zero on success, otherwise a platform error; failed cleanup prevents a new owner.
 */
int ef_storage_media_open(bool usb, uint32_t *blocks, uint8_t *format);
/** Unmount and deinitialize the medium; failures must be logged and returned. */
int ef_storage_media_close(void);
/** Restart native USB before a new export so an OS-ejected LUN can be loaded again. */
int ef_storage_usb_refresh(void);

#endif
