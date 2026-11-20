/**
 * @file control.h
 * @brief USB Feature 20 and Bluetooth control dispatcher with separate per-transport result slots.
 *
 * Not thread-safe: callers serialize every call with one lock.
 */
#ifndef ZEPHYRFORGE_CONTROL_H
#define ZEPHYRFORGE_CONTROL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app/usb/hid_reports.h"

/** Result status values. */
#define ZF_STATUS_IDLE 0u
#define ZF_STATUS_PENDING 1u
#define ZF_STATUS_COMPLETED 2u
#define ZF_STATUS_INVALID 3u
#define ZF_STATUS_UNSUPPORTED 4u
#define ZF_STATUS_BUSY 5u
#define ZF_STATUS_FAILED 6u

/** Result error_reason values. */
#define ZF_ERROR_NONE 0u
#define ZF_ERROR_MALFORMED 1u
#define ZF_ERROR_CONFIRMATION 2u
#define ZF_ERROR_ARGUMENT 3u
#define ZF_ERROR_CAPABILITY 4u
#define ZF_ERROR_BUSY 5u
#define ZF_ERROR_FAILED 6u
#define ZF_ERROR_OPCODE 7u

/** Assigned opcodes; 3, 4 and 6-13 are USB-only. */
#define ZF_OP_LED 1u
#define ZF_OP_REBOOT 2u
#define ZF_OP_MSC 3u
#define ZF_OP_BENCHMARK 4u
#define ZF_OP_SAVE 5u
#define ZF_OP_STAGE_SSID 6u
#define ZF_OP_STAGE_PASSWORD 7u
#define ZF_OP_STAGE_KEY 8u
#define ZF_OP_TEST_WIFI 9u
#define ZF_OP_CANCEL_TEST 10u
#define ZF_OP_SCAN 11u
#define ZF_OP_SCAN_ENTRY 12u
#define ZF_OP_TCP_PROOF 13u

/*
 * Dispatcher-owned result details. Staging owns details 16-21; benchmark admission returns its own
 * zf_benchmark_error_t values, which share the same wire namespace.
 */
#define ZF_DETAIL_CONFLICT 1u /**< Storage worker busy or USB owns the medium. */
#define ZF_DETAIL_SCAN_STALE 22u /**< Scan generation is stale or incomplete. */
#define ZF_DETAIL_SCAN_INDEX 23u /**< Scan index is out of range. */
#define ZF_DETAIL_TEST_ACTIVE 25u /**< A candidate Wi-Fi test is active. */
#define ZF_DETAIL_SCAN_ACTIVE 26u /**< A Wi-Fi scan is active. */
#define ZF_DETAIL_COMMIT_FLAG 27u /**< Staged values exist but the save commit flag is clear. */
#define ZF_DETAIL_USB_STAGED 28u /**< Unexpired USB staging blocks a BLE save or reboot. */

void zf_control_init(void);

/** Handle a USB Feature 20 SET payload (report ID removed). Returns false for a rejected envelope. */
bool zf_control_usb_set(const uint8_t *payload, size_t size, int64_t now_ms);
void zf_control_usb_get(uint8_t out[ZF_CONTROL_SIZE]);

/** True when a 9-byte BLE request has a valid envelope (length, version, nonzero transaction ID). */
bool zf_control_ble_envelope(const uint8_t *request, size_t size);

/** Execute an authorized BLE request with a valid envelope; replaces the BLE result slot. */
void zf_control_ble_execute(const uint8_t request[ZF_BLE_CONTROL_SIZE], int64_t now_ms);
void zf_control_ble_get(uint8_t out[ZF_BLE_CONTROL_SIZE]);

/** Expire staged values; cancels a candidate test when they expire. */
void zf_control_tick(int64_t now_ms);

/** The current candidate test joined successfully. */
void zf_control_test_joined(int64_t now_ms);

/** Feature 12 staging flags (bits 4-7) and staged_state. */
void zf_control_stage_status(uint8_t *flags, uint8_t *staged_state);

#endif
