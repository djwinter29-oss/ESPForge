/**
 * @file control.h
 * @brief USB Feature 20 and Bluetooth control dispatcher with separate per-transport result slots.
 *
 * Implements the opcode table, validation order and wireless command rules of docs/reference/usb-hid.md as adapted
 * by docs/reference/espforge-profile.md. Not thread-safe: callers serialize every call with one lock.
 */
#ifndef ESPFORGE_CONTROL_H
#define ESPFORGE_CONTROL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "hid_reports.h"

#define EF_STATUS_IDLE 0u
#define EF_STATUS_PENDING 1u
#define EF_STATUS_COMPLETED 2u
#define EF_STATUS_INVALID 3u
#define EF_STATUS_UNSUPPORTED 4u
#define EF_STATUS_BUSY 5u
#define EF_STATUS_FAILED 6u

#define EF_ERROR_NONE 0u
#define EF_ERROR_MALFORMED 1u
#define EF_ERROR_CONFIRMATION 2u
#define EF_ERROR_ARGUMENT 3u
#define EF_ERROR_CAPABILITY 4u
#define EF_ERROR_BUSY 5u
#define EF_ERROR_FAILED 6u
#define EF_ERROR_OPCODE 7u

#define EF_OP_LED 1u
#define EF_OP_REBOOT 2u
#define EF_OP_MSC 3u
#define EF_OP_BENCHMARK 4u
#define EF_OP_SAVE 5u
#define EF_OP_STAGE_SSID 6u
#define EF_OP_STAGE_PASSWORD 7u
#define EF_OP_STAGE_KEY 8u
#define EF_OP_TEST_WIFI 9u
#define EF_OP_CANCEL_TEST 10u
#define EF_OP_SCAN 11u
#define EF_OP_SCAN_ENTRY 12u
#define EF_OP_TCP_PROOF 13u

#define EF_DETAIL_CONFLICT 1u
#define EF_DETAIL_SCAN_STALE 22u
#define EF_DETAIL_SCAN_INDEX 23u
#define EF_DETAIL_TEST_ACTIVE 25u
#define EF_DETAIL_SCAN_ACTIVE 26u
#define EF_DETAIL_COMMIT_FLAG 27u
#define EF_DETAIL_USB_STAGED 28u

void ef_control_init(void);

/** Handle a USB Feature 20 SET payload (report ID removed). Returns false for a rejected envelope. */
bool ef_control_usb_set(const uint8_t *payload, size_t size, int64_t now_ms);
void ef_control_usb_get(uint8_t out[EF_CONTROL_SIZE]);

/** True when a 9-byte BLE request has a valid envelope (length, version, nonzero transaction ID). */
bool ef_control_ble_envelope(const uint8_t *request, size_t size);

/** Execute an authorized BLE request with a valid envelope; replaces the BLE result slot. */
void ef_control_ble_execute(const uint8_t request[EF_BLE_CONTROL_SIZE], int64_t now_ms);
void ef_control_ble_get(uint8_t out[EF_BLE_CONTROL_SIZE]);

/** Expire staged values; cancels a candidate test when they expire. */
void ef_control_tick(int64_t now_ms);

/** The current candidate test joined successfully. */
void ef_control_test_joined(int64_t now_ms);

/** Feature 12 staging flags (bits 4-7) and staged_state. */
void ef_control_stage_status(uint8_t *flags, uint8_t *staged_state);

#endif
