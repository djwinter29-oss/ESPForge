/**
 * @file boot_flash.h
 * @brief Settings record backend: the first page of the `storage_partition` flash area.
 */

#ifndef ESPFORGE_BOOT_FLASH_H
#define ESPFORGE_BOOT_FLASH_H

#include <stddef.h>
#include <stdint.h>

/**
 * @brief Read the start of the settings sector.
 * @return 0 on success, otherwise a negative errno.
 */
int boot_flash_read(uint8_t *record, size_t size);

/**
 * @brief Erase the settings sector, program the record and verify it by readback.
 * @return 0 when readback matched, otherwise a negative errno.
 */
int boot_flash_write(const uint8_t *record, size_t size);

#endif
