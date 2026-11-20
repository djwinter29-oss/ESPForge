#include "unity.h"
#include "storage.h"

#include <errno.h>
#include <string.h>

static zf_storage_t published;
static int open_result;
static int close_result;
static int refresh_result;
static unsigned opens;
static unsigned closes;
static unsigned refreshes;
static bool opened_usb;
static bool mount_failed;
static int64_t completed_at;

void zf_storage_publish(const zf_storage_t *storage)
{
	published = *storage;
}

int zf_storage_media_open(bool usb, zf_storage_t *storage)
{
	TEST_ASSERT_TRUE(published.busy);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++opens;
	opened_usb = usb;
	storage->initialized = open_result == 0;
	storage->block_count = storage->initialized ? 12345 : 0;
	storage->cid_valid = storage->initialized;
	memset(storage->cid, storage->initialized ? 0x1b : 0, sizeof(storage->cid));
	storage->bus_clock_hz = storage->initialized ? 25000000 : 0;
	storage->filesystem_format = storage->initialized && !usb && !mount_failed ? 3 : 0;
	return open_result != 0 ? open_result : mount_failed && !usb ? -ENODEV : 0;
}

int64_t zf_storage_media_time(void)
{
	return completed_at;
}

int zf_storage_media_close(void)
{
	TEST_ASSERT_TRUE(published.busy);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++closes;
	return close_result;
}

int zf_storage_usb_refresh(void)
{
	TEST_ASSERT_TRUE(published.msc_transition_pending);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++refreshes;
	return refresh_result;
}

void setUp(void)
{
	memset(&published, 0, sizeof(published));
	open_result = close_result = refresh_result = 0;
	opens = closes = refreshes = 0;
	opened_usb = false;
	mount_failed = false;
	completed_at = 0;
	zf_storage_policy_init(true, false, 0);
}

void tearDown(void)
{
}

void test_insertion_is_debounced_then_mounted_and_removal_clears_all_card_facts(void)
{
	zf_storage_policy_poll(2, 10, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(false, 60, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 100, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 199, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(0, opens);
	zf_storage_policy_poll(true, 200, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_TRUE(published.present);
	TEST_ASSERT_TRUE(published.initialized);
	TEST_ASSERT_TRUE(published.capacity_valid);
	TEST_ASSERT_EQUAL_UINT8(3, published.filesystem_format);
	zf_storage_policy_poll(false, 250, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(false, 350, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.present);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
	TEST_ASSERT_EQUAL_UINT8(0, published.filesystem_format);
	TEST_ASSERT_FALSE(published.cid_valid);
	TEST_ASSERT_EACH_EQUAL_UINT8(0, published.cid, sizeof(published.cid));
	TEST_ASSERT_EQUAL_UINT32(0, published.bus_clock_hz);
}

void test_boot_mount_and_failed_mount_retry_are_paced(void)
{
	zf_storage_policy_init(true, true, 0);
	open_result = -EIO;
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_TRUE(published.present);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
	zf_storage_policy_poll(true, ZF_STORAGE_RETRY_MS - 1, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	open_result = 0;
	zf_storage_policy_poll(true, ZF_STORAGE_RETRY_MS, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(2, opens);
	TEST_ASSERT_TRUE(published.initialized);
}

void test_usb_export_invalidates_sd_sample_and_replacement_does_not_reexport(void)
{
	zf_storage_policy_init(true, true, 0);
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 1, 1);
	TEST_ASSERT_TRUE(opened_usb);
	TEST_ASSERT_EQUAL_UINT(1, refreshes);
	TEST_ASSERT_TRUE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.msc_transition_pending);
	zf_storage_policy_poll(false, 10, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(false, 110, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.msc_enabled);
	zf_storage_policy_poll(true, 200, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 300, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_TRUE(published.sample_valid);
}

void test_confirmed_return_remounts_and_failed_handoff_does_not_claim_a_new_owner(void)
{
	zf_storage_policy_init(true, true, 0);
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 1, 1);
	zf_storage_policy_poll(true, 2, 0);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_TRUE(published.initialized);
	refresh_result = -EIO;
	zf_storage_policy_poll(true, 3, 1);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
}

void test_card_changed_before_an_admitted_request_cancels_it_without_media_io(void)
{
	zf_storage_policy_poll(false, 100, ZF_STORAGE_CANCEL_REQUEST);
	TEST_ASSERT_EQUAL_UINT(0, opens);
	TEST_ASSERT_EQUAL_UINT(0, refreshes);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	TEST_ASSERT_FALSE(published.msc_transition_pending);
}

void test_detect_error_revokes_usb_and_recovery_remounts_only_after_debounce(void)
{
	zf_storage_policy_init(true, true, 0);
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 1, 1);
	zf_storage_policy_poll(-EIO, 2, ZF_STORAGE_CANCEL_REQUEST);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.presence_known);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	unsigned before = opens;

	zf_storage_policy_poll(true, 10, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_EQUAL_UINT(before, opens);
	zf_storage_policy_poll(2, 110, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_TRUE(published.sample_valid);
	TEST_ASSERT_TRUE(published.initialized);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
}

void test_brief_removal_revokes_export_and_replacement_waits_for_stable_insertion(void)
{
	zf_storage_policy_init(true, true, 0);
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 1, 1);
	unsigned before = opens;

	zf_storage_policy_poll(false, 10, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_FALSE(published.sample_valid);
	zf_storage_policy_poll(true, 20, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(true, 119, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(before, opens);
	zf_storage_policy_poll(true, 120, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(before + 1, opens);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
}

void test_failed_mount_retains_hardware_identity_and_retries_from_completion(void)
{
	zf_storage_policy_init(true, true, 0);
	mount_failed = true;
	completed_at = 5000;
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_TRUE(published.sample_valid);
	TEST_ASSERT_TRUE(published.initialized);
	TEST_ASSERT_TRUE(published.capacity_valid);
	TEST_ASSERT_TRUE(published.cid_valid);
	TEST_ASSERT_EACH_EQUAL_UINT8(0x1b, published.cid, sizeof(published.cid));
	TEST_ASSERT_EQUAL_UINT32(12345, published.block_count);
	TEST_ASSERT_EQUAL_UINT32(25000000, published.bus_clock_hz);
	TEST_ASSERT_EQUAL_UINT8(0, published.filesystem_format);
	zf_storage_policy_poll(true, 6999, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	mount_failed = false;
	zf_storage_policy_poll(true, 7000, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(2, opens);
	TEST_ASSERT_EQUAL_UINT8(3, published.filesystem_format);
}

void test_unmounted_card_can_export_only_on_request_and_failed_export_clears_identity(void)
{
	zf_storage_policy_init(true, true, 0);
	mount_failed = true;
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.msc_enabled);
	zf_storage_policy_poll(true, 1, 1);
	TEST_ASSERT_TRUE(published.msc_enabled);
	zf_storage_policy_poll(true, 2, 0);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_TRUE(published.initialized);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	TEST_ASSERT_EQUAL_UINT8(0, published.filesystem_format);
	refresh_result = -EIO;
	zf_storage_policy_poll(true, 3, 1);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_FALSE(published.cid_valid);
	TEST_ASSERT_EACH_EQUAL_UINT8(0, published.cid, sizeof(published.cid));
	TEST_ASSERT_EQUAL_UINT32(0, published.bus_clock_hz);
}

void test_detection_error_clears_unmounted_card_identity(void)
{
	zf_storage_policy_init(true, true, 0);
	mount_failed = true;
	zf_storage_policy_poll(true, 0, ZF_STORAGE_NO_REQUEST);
	zf_storage_policy_poll(-EIO, 1, ZF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.cid_valid);
	TEST_ASSERT_EACH_EQUAL_UINT8(0, published.cid, sizeof(published.cid));
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
}
